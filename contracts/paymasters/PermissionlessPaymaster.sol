// SPDX-License-Identifier: GPL-3.0
// Disclaimer: Users are solely responsible for ensuring that their design, implementation, and use of this paymaster smart contract
// complies with all applicable laws, including but not limited to money transmission, anti-money laundering (AML), and
// payment processing regulations.
// The developers and publishers of this contract disclaim any liability for any legal issues that may arise from its use.

//        @@@@%%%%%%%@@@
//      @@@%%%%%%%%%%%%@@@             @%%%%%%%%%%@@                 @@@  @@
//    @@%%%%%%%%%%%%%%%%%%@@          @%%%%%%%%%%@@               @@@%%@@%%@@
//   @@%%%%%%%@@  @%%%%%%%%@@                  @%@@               @%@     @@
//  @@%%%%%%@@@    @@%%%%%%%@@               @@%@@                @%@
//  @%%%%%@@@        @@%%%%%%@              @@@@   @%@@       @@%%@%@%%@@@%@@
//  @%%%%@@            @%%%%%@             @@@@     @@@@     @@%@@@%@@@@ @%@@
//  @%%%%%%%%%@@    @%%%%%%%%@            @@@@      @@%@     @%@@ @%@    @%@@
//  @@%%%%%%%%%%@   @%%%%%%%%@           @@@@        @@@@   @@@@  @%@    @%@@
//   @%%%%%%%@@%%@@ @%%%%%%%@@          @@@@          @@@@ @@@@   @%@    @%@@
//   @@%%%%%%@@@%@@@@%%%%%%@@          @@@@            @@@@@@@    @%@    @%@@
//     @%%%%%@ @@%%%@%%%%%@           @%@@@@@@@@@@@     @%%%@     @%@    @%@@
//      @@@@%@   @@%%%@@@@           @@@@@@@@@@@@@@     @@@@      @@@    @@@@
//         @@@    @@@@@                                 @@@@
//                                                     @@@@
//                                                    @@%@

pragma solidity ^0.8.19;

import {IPaymaster, ExecutionResult, PAYMASTER_VALIDATION_SUCCESS_MAGIC} from "@matterlabs/zksync-contracts/l2/system-contracts/interfaces/IPaymaster.sol";
import {IPaymasterFlow} from "@matterlabs/zksync-contracts/l2/system-contracts/interfaces/IPaymasterFlow.sol";
import {TransactionHelper, Transaction} from "@matterlabs/zksync-contracts/l2/system-contracts/libraries/TransactionHelper.sol";

import "@matterlabs/zksync-contracts/l2/system-contracts/Constants.sol";

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {Errors} from "../libraries/Errors.sol";

/// @title A Permissionless multisigner paymaster
/// @author https://x.com/Hoshiyari420 <> https://zyfi.org
/// @notice This smart contract is a singular permissionless multi-signer paymaster allowing multiple dapps/accounts
/// to seamlessly sponsor gas for their respective users/related accounts through signature verification.
contract PermissionlessPaymaster is IPaymaster, EIP712 {
    using ECDSA for bytes32;

    // Using OpenZeppelin's SafeERC20 library to perform token transfers
    using SafeERC20 for IERC20;

    /// @notice Denomination for the markup percent
    uint256 constant DENOMINATION = 1e4;

    /// @notice Type hash used when encoding data for validation signature
    bytes32 public constant SIGNATURE_TYPEHASH =
        keccak256(
            "PermissionLessPaymaster(address from,address to,uint256 expirationTime,uint256 maxNonce,uint256 maxFeePerGas,uint256 gasLimit,uint256 markupPercent)"
        );

    /// @notice Rescue address managed by Zyfi to rescue mistakenly sent ERC20 tokens and to collect markup fee/donation.
    address public zyfi_treasury;

    /// @notice Get manager of a signer address
    /// Stores manager address of a respective signer. Unregitered signers will have address(0) as mansager.
    /// @dev One-to-many relation between manager and signers. Managers can be signers too.
    mapping(address signer => address manager) public managers;

    /// @notice Get funds of manager
    /// @dev All signers added by the manager have access to that manager's deposited funds.
    mapping(address manager => uint ethBalance) public managerBalances;

    /// @notice Track the previous manager for processing refunds
    address public previousManager;

    /// @notice Track the previous total balance of paymaster for processing refunds
    uint public previousTotalBalance;

    /// @notice Event to be emitted when a signer is added
    event SignerAdded(address indexed manager, address indexed signer);
    /// @notice Event to be emitted when a signer is removed
    event SignerRemoved(address indexed manager, address indexed signer);
    /// @notice Event to be emitted when a signer is replaced
    event SignerReplaced(
        address indexed manager,
        address indexed oldSigner,
        address indexed newSigner
    );
    /// @notice Event to be emitted when a signer revokes itself
    event SignerRevoked(address indexed manager, address indexed signer);
    /// @notice Event to be emitted when funds are deposited
    event Deposit(address indexed manager, uint amount);
    /// @notice Event to be emitted when funds are withdrawn
    event Withdraw(address indexed manager, uint amount);
    /// @notice Event to be emitted when a transaction is successfully sponsored
    event Sponsor(
        address indexed manager,
        address indexed signer,
        uint amount,
        uint markup
    );
    /// @notice Event to be emitted when zyfi_treasury is changed
    event TreasuryChanged(
        address indexed oldTreasury,
        address indexed newTreasury
    );

    /// @param zyfi_address - Rescue address managed by Zyfi to rescue ERC-20 tokens & collect markup if any.
    constructor(
        address zyfi_address
    ) EIP712("Permissionless Paymaster", "1.0") {
        require(zyfi_address != address(0), "Address cannot be zero");
        zyfi_treasury = zyfi_address;
    }

    /// @notice Modifier to ensure function is only called by bootloader
    modifier onlyBootloader() {
        if (msg.sender != BOOTLOADER_FORMAL_ADDRESS) {
            revert Errors.PM_NotFromBootloader();
        }
        // Continue execution if called from the bootloader.
        _;
    }
    /**
    @notice Internal function to process refunds on each paymaster interaction.
    @dev - In Zksync, paymaster is refunded with remaining gas amount at the end of transaction. 
    This contract ensures that refunds are efficiently updated to respective managers in the NEXT transaction. 
    To achieve this, it tracks previousManager - last manager that used paymaster &
    previousTotalBalance - balance before refund arrives.
    It adds the difference between the actual balance & previous total balance to the balance of previous manager.
    @param amount - Amount to be considered in case of deposit or withdraw transaction
    @param isWithdraw - Bool to check whether it is deposit or withdraw
    */
    function updateRefund(uint amount, bool isWithdraw) internal {
        uint _previousTotalBalance = previousTotalBalance;
        // Note, Incase of deposit, address(this).balance is already updated with msg.value
        // Hence, previousTotalBalance needs to be updated first
        if (!isWithdraw) {
            _previousTotalBalance += amount;
        }
        // Note, if false then there is no refund or refund is already updated.
        if (address(this).balance != _previousTotalBalance) {
            managerBalances[previousManager] =
                managerBalances[previousManager] +
                (address(this).balance - _previousTotalBalance);
        }
        // Incase of consecutive deposits and withdrawals, previousTotalBalance needs to be updated.
        if (isWithdraw) {
            previousTotalBalance = address(this).balance - amount;
        } else {
            // For deposit, address(this).balance is already updated.
            previousTotalBalance = address(this).balance;
        }
    }
    /// @inheritdoc IPaymaster
    function validateAndPayForPaymasterTransaction(
        bytes32,
        bytes32,
        Transaction calldata _transaction
    )
        external
        payable
        onlyBootloader
        returns (bytes4 magic, bytes memory context)
    {
        // Update refund first.
        // Since amount = 0, isWithdrawal true/false doesn't matter except true saves a bit gas.
        updateRefund(0, true);
        // By default we consider the transaction as accepted.
        magic = PAYMASTER_VALIDATION_SUCCESS_MAGIC;
        // Revert if standard paymaster input is shorter than 4 bytes
        if (_transaction.paymasterInput.length < 4)
            revert Errors.PM_ShortPaymasterInput();

        bytes4 paymasterInputSelector = bytes4(
            _transaction.paymasterInput[0:4]
        );
        if (paymasterInputSelector == IPaymasterFlow.general.selector) {
            // Decoding innerInput data to bytes
            bytes memory innerInputs = abi.decode(
                _transaction.paymasterInput[4:],
                (bytes)
            );
            /**
             * Decode the additional information for signature validation.
             * expirationTime - the block.timestamp at which the transaction expires
             * maxNonce - the maximum user nonce that the user can use for the transaction
             * markupPercent - optional markup fee to be added Zyfi address
             * signerAddress - the address of the signer that will sign for sponsoring the transaction.
             * signature - the message signed by the signer constructed with all the parameters
             @dev maxNonce provides flexibility to dapps to replay signature. It is expected that maxNonce &
            expirtationTime is signed with utmost care by the signer as per their requirement. 
             @dev markupPercent - is optional for Zyfi API future use case only, ensure it's 0 if signature is managed by Dapp, or else it will be considered donation.
            */
            (
                uint expirationTime,
                uint maxNonce,
                uint markupPercent,
                address signerAddress,
                bytes memory signature
            ) = abi.decode(innerInputs, (uint, uint, uint, address, bytes));

            // Validate that the transaction generated by the API is not expired
            if (block.timestamp > expirationTime)
                revert Errors.PM_SignatureExpired();
            // Validate that the nonce is not higher than the maximum allowed
            if (_transaction.nonce > maxNonce) revert Errors.PM_InvalidNonce();

            address userAddress = address(uint160(_transaction.from));
            // Validate that the message was signed by the given signer
            if (
                !_isValidSignature(
                    signature,
                    signerAddress,
                    userAddress,
                    address(uint160(_transaction.to)),
                    expirationTime,
                    maxNonce,
                    _transaction.maxFeePerGas,
                    _transaction.gasLimit,
                    markupPercent
                )
            ) {
                /// @dev While this means that the transaction was not generated by the given signer,
                /// and the transaction should not be accepted,
                /// magic is set to 0 so it fails on mainnet while still allowing for gas estimation
                magic = bytes4(0);
            }
            // Note, that while the minimal amount of ETH needed is tx.gasPrice * tx.gasLimit,
            // neither paymaster nor account are allowed to access this context variable.
            uint256 requiredETH = _transaction.gasLimit *
                _transaction.maxFeePerGas;
            uint256 totalDeductETH = requiredETH;
            // Only move forward if markupPercent > 0, saves SSTORE, SLOAD calls.
            if (markupPercent > 0) {
                /// @dev if the markup percent exceeds 100%, we don't revert, we simply adjust the markup to 100%
                if (markupPercent > DENOMINATION) {
                    markupPercent = DENOMINATION;
                }
                /// @dev Percent denominator is 100_00 instead of 100. So, for 10% = 1000 markupPercent, for 33.33% = 3333 markupPercent, for 0.01% = 1 markupPercent
                uint256 markup = (requiredETH * markupPercent) / DENOMINATION;
                // Add the markup to the zyfi_treasury balance
                managerBalances[zyfi_treasury] += markup;
                // Add to the total ETH amount to be deducted from the manager
                totalDeductETH += markup;
            }
            // Get the manager of the signer
            address _manager = managers[signerAddress];
            if (_manager == address(0)) revert Errors.PM_SignerNotRegistered();
            // Get the balance of manager
            uint _balance = managerBalances[_manager];
            if (_balance < totalDeductETH)
                revert Errors.PM_InsufficientBalance();
            // Required funds withdrawn from manager's balance
            managerBalances[_manager] = _balance - totalDeductETH;
            // Track manager for refund in the NEXT transaction
            previousManager = _manager;
            // Track balance before refund is added
            previousTotalBalance = address(this).balance - requiredETH;
            // emit sponsor event to keep track off-chain
            emit Sponsor(
                _manager,
                signerAddress,
                requiredETH,
                totalDeductETH - requiredETH
            );
            // The bootloader never returns any data, so it can safely be ignored here.
            (bool success, ) = payable(BOOTLOADER_FORMAL_ADDRESS).call{
                value: requiredETH
            }("");
            if (!success) revert Errors.PM_FailedTransfer();
        } else {
            revert Errors.PM_UnsupportedPaymasterFlow();
        }
    }
    /// @inheritdoc IPaymaster
    function postTransaction(
        bytes calldata _context,
        Transaction calldata _transaction,
        bytes32,
        bytes32,
        ExecutionResult _txResult,
        uint256 _maxRefundedGas
    ) external payable override onlyBootloader {}

    /**
     * @notice Checks the validity of the signature.
     * @param _signature The signature to be validated.
     * @param _signerAddress The address of the signer.
     * @param _from The address of the sender.
     * @param _to The address of the recipient.
     * @param _expirationTime The expiration time for the transaction.
     * @param _maxNonce The maximum nonce for the transaction.
     * @param _maxFeePerGas The maximum fee per gas for the transaction.
     * @param _gasLimit The gas limit for the transaction.
     * @param _markupPercent The markup percent as decided by the signer.
     * @return A boolean indicating whether the signature is valid or not.
     */
    function _isValidSignature(
        bytes memory _signature,
        address _signerAddress,
        address _from,
        address _to,
        uint256 _expirationTime,
        uint256 _maxNonce,
        uint256 _maxFeePerGas,
        uint256 _gasLimit,
        uint256 _markupPercent
    ) internal view returns (bool) {
        bytes32 messageHash = keccak256(
            abi.encode(
                SIGNATURE_TYPEHASH,
                _from,
                _to,
                _expirationTime,
                _maxNonce,
                _maxFeePerGas,
                _gasLimit,
                _markupPercent
            )
        );

        bytes32 ethSignedMessageHash = _hashTypedDataV4(messageHash);

        (
            address recoveredAddress,
            ECDSA.RecoverError error2
        ) = ethSignedMessageHash.tryRecover(_signature);
        if (error2 != ECDSA.RecoverError.NoError) {
            return false;
        }
        return recoveredAddress == _signerAddress;
    }
    /**
     * @notice Allows manager(caller) to add a signer
     * @param _signer Address of signer to be added
     */
    function addSigner(address _signer) public {
        if (_signer == address(0)) revert Errors.PM_InvalidAddress();
        // Signer should not be registered
        if (managers[_signer] != address(0))
            revert Errors.PM_SignerAlreadyRegistered();
        managers[_signer] = msg.sender;
        emit SignerAdded(msg.sender, _signer);
    }
    /**
     * @notice Allows manager(caller) to remove a signer
     * @param _signer - Address of signer to be removed
     */
    function removeSigner(address _signer) public {
        if (_signer == address(0)) revert Errors.PM_InvalidAddress();
        // Signer should be register with manager
        if (managers[_signer] != msg.sender)
            revert Errors.PM_UnauthorizedManager();
        managers[_signer] = address(0);
        emit SignerRemoved(msg.sender, _signer);
    }
    /**
     * @notice Allows manager(caller) to replace a signer
     * @param _oldSigner Old signer address to be removed
     * @param _newSigner New signer address to be added
     */
    function replaceSigner(address _oldSigner, address _newSigner) public {
        if (_newSigner == address(0) || _oldSigner == address(0))
            revert Errors.PM_InvalidAddress();
        // New signer should not be registered
        if (managers[_newSigner] != address(0))
            revert Errors.PM_SignerAlreadyRegistered();
        // Old signer should be registered with manager
        if (managers[_oldSigner] != msg.sender)
            revert Errors.PM_UnauthorizedManager();
        managers[_newSigner] = msg.sender;
        managers[_oldSigner] = address(0);
        emit SignerReplaced(msg.sender, _oldSigner, _newSigner);
    }
    /**
     * @notice Allow signer(caller) to self revoke
     * @dev To reduce impact of griefing attacks where a malicious manager frontruns and adds unrelated signer
     */
    function selfRevokeSigner() public {
        previousManager = managers[msg.sender];
        managers[msg.sender] = address(0);
        emit SignerRevoked(previousManager, msg.sender);
    }
    /**
     * @notice Allow manager to add multiple signers
     * @param _signers - Array of signer addresses to be added
     */
    function batchAddSigners(address[] memory _signers) public {
        uint length = _signers.length;
        for (uint i = 0; i < length; ) {
            if (_signers[i] == address(0)) revert Errors.PM_InvalidAddress();
            // Signers should not be registered
            if (managers[_signers[i]] != address(0))
                revert Errors.PM_SignerAlreadyRegistered();
            managers[_signers[i]] = msg.sender;
            emit SignerAdded(msg.sender, _signers[i]);
            unchecked {
                ++i;
            }
        }
    }
    /**
     * @notice Allow manager to remove multiple signers
     * @param _signers - Array of signer addresses to be removed
     */
    function batchRemoveSigners(address[] memory _signers) public {
        uint length = _signers.length;
        for (uint i = 0; i < length; ) {
            if (_signers[i] == address(0)) revert Errors.PM_InvalidAddress();
            // Signers should be registered with manager
            if (managers[_signers[i]] != msg.sender)
                revert Errors.PM_UnauthorizedManager();
            managers[_signers[i]] = address(0);
            emit SignerRemoved(msg.sender, _signers[i]);
            unchecked {
                ++i;
            }
        }
    }
    /**
     * @notice Allows manager(caller) to deposit funds
     */
    function deposit() public payable {
        updateRefund(msg.value, false);
        managerBalances[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }
    /**
     * @notice Allows manager(caller) to deposit and add signer
     * @param _signer - Address of signer to be added
     */
    function depositAndAddSigner(address _signer) public payable {
        updateRefund(msg.value, false);
        if (_signer == address(0)) revert Errors.PM_InvalidAddress();
        // Signer should not be registered
        if (managers[_signer] != address(0))
            revert Errors.PM_SignerAlreadyRegistered();
        managerBalances[msg.sender] += msg.value;
        managers[_signer] = msg.sender;
        emit Deposit(msg.sender, msg.value);
        emit SignerAdded(msg.sender, _signer);
    }
    /**
     * @notice Allows anyone to deposit funds on behalf
     * @param _manager - Address of manager to whom funds will be added
     */
    function depositOnBehalf(address _manager) public payable {
        updateRefund(msg.value, false);
        if (_manager == address(0)) revert Errors.PM_InvalidAddress();
        managerBalances[_manager] += msg.value;
        emit Deposit(_manager, msg.value);
    }
    /**
     * @notice Allows manager to withdraw funds
     * @param amount Amount to be withdrawn
     */
    function withdraw(uint amount) public {
        updateRefund(amount, true);
        managerBalances[msg.sender] -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert Errors.PM_FailedTransfer();
        emit Withdraw(msg.sender, amount);
    }
    /**
     * @notice Allows manager to withdraw all funds
     * @dev In a scenario, where previous manager is msg.sender.
     * withdrawFull function is called through paymaster.
     * Current refunds still remain which is expected behavior
     */
    function withdrawFull() public {
        uint balance = managerBalances[msg.sender];
        updateRefund(balance, true);
        managerBalances[msg.sender] -= balance;
        (bool success, ) = payable(msg.sender).call{value: balance}("");
        if (!success) revert Errors.PM_FailedTransfer();
        emit Withdraw(msg.sender, balance);
    }
    /**
     * @notice Allows manager to withdraw funds and remove signers
     * @param amount Amount to be withdrawn
     * @param _signers Array of signer addresses to be removed
     */
    function withdrawAndRemoveSigners(
        uint amount,
        address[] memory _signers
    ) public {
        updateRefund(amount, true);
        managerBalances[msg.sender] -= amount;
        uint length = _signers.length;
        for (uint i = 0; i < length; ) {
            if (_signers[i] == address(0)) revert Errors.PM_InvalidAddress();
            // Signers should be registered with manager
            if (managers[_signers[i]] != msg.sender)
                revert Errors.PM_UnauthorizedManager();
            managers[_signers[i]] = address(0);
            emit SignerRemoved(msg.sender, _signers[i]);
            unchecked {
                ++i;
            }
        }
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert Errors.PM_FailedTransfer();
        emit Withdraw(msg.sender, amount);
    }
    /**
     * @notice Rescue ERC-20 tokens mistakenly sent to this paymaster.
     * @param _tokens Array of token addresses
     */
    function rescueTokens(address[] memory _tokens) public {
        uint length = _tokens.length;
        for (uint i = 0; i < length; ) {
            if (
                _tokens[i] == address(ETH_TOKEN_SYSTEM_CONTRACT) ||
                _tokens[i] == address(0)
            ) revert Errors.PM_InvalidAddress();
            IERC20(_tokens[i]).safeTransfer(
                zyfi_treasury,
                IERC20(_tokens[i]).balanceOf(address(this))
            );
            unchecked {
                ++i;
            }
        }
    }
    /**
     * @notice Function to view domain separator
     */
    function domainSeparator() public view returns (bytes32) {
        return _domainSeparatorV4();
    }
    /**
     * @notice Update rescue address
     * @dev Only zyfi_treasury can call this method
     */
    function updateTreasuryAddress(address _newAddress) public {
        address _oldTreasury = zyfi_treasury;
        if (msg.sender != _oldTreasury) revert Errors.PM_Unauthorized();
        if (_newAddress == address(0)) revert Errors.PM_InvalidAddress();
        updateRefund(0, false);
        // Transfer the balance to the new address
        uint balance = managerBalances[_oldTreasury];
        managerBalances[_oldTreasury] = 0;
        managerBalances[_newAddress] += balance;
        zyfi_treasury = _newAddress;
        emit TreasuryChanged(_oldTreasury, _newAddress);
    }
    /**
     * @notice Function to view latest balance of manager including refund if any.
     * @param _manager - Address of manager
     * @return balance of manager including refunds if any
     */
    function getLatestManagerBalance(
        address _manager
    ) public view returns (uint balance) {
        if (_manager == previousManager) {
            balance =
                managerBalances[_manager] +
                (address(this).balance - previousTotalBalance);
        } else {
            balance = managerBalances[_manager];
        }
    }
    /**
     * @notice Function to view balance of manager associated with a signer address
     * @param _signer - Address of signer
     * @return balance of manager associated with signer
     */
    function getLatestManagerBalanceViaSigner(
        address _signer
    ) public view returns (uint) {
        return getLatestManagerBalance(managers[_signer]);
    }
}
