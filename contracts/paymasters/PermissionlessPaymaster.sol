// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IPaymaster, ExecutionResult, PAYMASTER_VALIDATION_SUCCESS_MAGIC} from "@matterlabs/zksync-contracts/l2/system-contracts/interfaces/IPaymaster.sol";
import {IPaymasterFlow} from "@matterlabs/zksync-contracts/l2/system-contracts/interfaces/IPaymasterFlow.sol";
import {TransactionHelper, Transaction} from "@matterlabs/zksync-contracts/l2/system-contracts/libraries/TransactionHelper.sol";

import "@matterlabs/zksync-contracts/l2/system-contracts/Constants.sol";

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/draft-EIP712.sol";

import {Errors} from "../libraries/Errors.sol";

contract PermissionlessPaymaster is IPaymaster, EIP712 {

    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    address public immutable ZYFI_RESCUE_ADDRESS; 
    bytes32 public constant SIGNATURE_TYPEHASH = keccak256(
    "PermissionLessPaymaster(address userAddress,uint256 lastTimestamp,uint256 nonces)"
    );

    mapping(address signer => address protocolManager) public protocolManagers;
    
    mapping(address protocolManager => uint ethBalance) public protocolBalances; 

    address public previousProtocol;
    uint public previousTotalBalance; 
    uint public totalBalance; 

    event SignerAdded(address indexed protocolManager, address indexed signer);
    event SignerRemoved(address indexed protocolManager, address indexed signer);
    event Deposit(address indexed protocolManager, uint amount);
    event Withdraw(address indexed protocolManager, uint amount); 

    constructor(address zyfi_address) EIP712("PermissionLessPaymaster","1.0") {
        require(zyfi_address != address(0), "Address cannot be zero");
        ZYFI_RESCUE_ADDRESS = zyfi_address;
    }

    modifier onlyBootloader() {
        if (msg.sender != BOOTLOADER_FORMAL_ADDRESS) {
            revert Errors.NotFromBootloader();
        }
        // Continue execution if called from the bootloader.
        _;
    }
    function updateRefund(uint amount, bool isWithdraw) internal {
        if(previousProtocol != address(0)){
            protocolBalances[previousProtocol] = protocolBalances[previousProtocol] + (address(this).balance - previousTotalBalance);
            previousProtocol = address(0);
            if(isWithdraw){
                previousTotalBalance = address(this).balance - amount;
            }
            else{
                previousTotalBalance = address(this).balance + amount;
            }
        }
    }

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
        updateRefund(0,false);
        // By default we consider the transaction as accepted.
        magic = PAYMASTER_VALIDATION_SUCCESS_MAGIC;
        if (_transaction.paymasterInput.length < 4)
            revert Errors.ShortPaymasterInput();

        bytes4 paymasterInputSelector = bytes4(
            _transaction.paymasterInput[0:4]
        );
        if (paymasterInputSelector == IPaymasterFlow.general.selector) {
            // Note, that while the minimal amount of ETH needed is tx.gasPrice * tx.gasLimit,
            // neither paymaster nor account are allowed to access this context variable.
            (bytes memory innerInputs) = abi.decode(
                _transaction.paymasterInput[4:],
                (bytes)
            );
            (
                uint expirationTime, 
                uint maxNonce,
                address signerAddress,
                bytes memory signature
            ) = abi.decode(innerInputs,(uint, uint, address, bytes));

            if(block.timestamp > expirationTime )
                revert Errors.TransactionExpired();
            
            if(_transaction.nonce > maxNonce)
                revert Errors.InvalidNonce();

            address userAddress = address(uint160(_transaction.from));
            if (
            !_isValidSignature(
                signature,
                signerAddress,
                userAddress,
                address(uint160(_transaction.to)),
                expirationTime,
                maxNonce,
                _transaction.maxFeePerGas,
                _transaction.gasLimit
            )
            ) {
                revert Errors.InvalidSignature();
            }
            uint256 requiredETH = _transaction.gasLimit *
                _transaction.maxFeePerGas;

            address _protocolManager = protocolManagers[signerAddress];
            if(_protocolManager == address(0))
                revert Errors.SignerNotRegistered();
            uint _balance = protocolBalances[_protocolManager];
            if(_balance < requiredETH)
                revert Errors.InsufficientBalance();
            protocolBalances[_protocolManager] = _balance - requiredETH;
            previousProtocol = _protocolManager;
            previousTotalBalance = address(this).balance - requiredETH;
            // The bootloader never returns any data, so it can safely be ignored here.
            (bool success, ) = payable(BOOTLOADER_FORMAL_ADDRESS).call{
                value: requiredETH
            }("");
            require(
                success,
                "Failed to transfer tx fee to the Bootloader. Paymaster balance might not be enough."
            );
        } else {
            revert Errors.UnsupportedPaymasterFlow();
        }
    }

    function postTransaction(
        bytes calldata _context,
        Transaction calldata _transaction,
        bytes32,
        bytes32,
        ExecutionResult _txResult,
        uint256 _maxRefundedGas
    ) external payable override onlyBootloader {

    }
    function _isValidSignature(
        bytes memory _signature,
        address _signerAddress,
        address _from,
        address _to,
        uint256 _expirationTime,
        uint256 _maxNonce,
        uint256 _maxFeePerGas,
        uint256 _gasLimit
    ) internal view returns (bool) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                _from,
                _to,
                _expirationTime,
                _maxNonce,
                _maxFeePerGas,
                _gasLimit
            )
        );

        bytes32 ethSignedMessageHash = ECDSA.toEthSignedMessageHash(
            messageHash
        );

        (address recoveredAddress, ECDSA.RecoverError error2) = ECDSA
            .tryRecover(ethSignedMessageHash, _signature);
        if (error2 != ECDSA.RecoverError.NoError) {
            return false;
        }
        return recoveredAddress == _signerAddress;
    }
   function addSigner(address _signer) public {
        if(_signer == address(0))
            revert Errors.InvalidAddress();
        if(protocolManagers[_signer] != address(0))
            revert Errors.SignerAlreadyRegistered();
        protocolManagers[_signer] = msg.sender;
        emit SignerAdded(msg.sender, _signer);
   }

    function removeSigner(address _signer) public {
        if(_signer == address(0))
            revert Errors.InvalidAddress();
        if(protocolManagers[_signer] != msg.sender)
            revert Errors.InvalidManager();
        protocolManagers[_signer] = address(0);
        emit SignerRemoved(msg.sender, _signer);
    }

    function batchAddSigners(address[] memory _signers) public{
        uint i;
        for(; i< _signers.length; ){
            if(_signers[i] == address(0))
                revert Errors.InvalidAddress();
            if(protocolManagers[_signers[i]] != address(0))
                revert Errors.SignerAlreadyRegistered();
            protocolManagers[_signers[i]] = msg.sender;            
            ++i;
            emit SignerAdded(msg.sender, _signers[i]);

        }
    }

    function batchRemoveSigners(address[] memory _signers) public{
        uint i;
        for(;i < _signers.length;){
            if(_signers[i] == address(0))
                revert Errors.InvalidAddress();
            if(protocolManagers[_signers[i]] != msg.sender)
                revert Errors.InvalidManager();
            protocolManagers[_signers[i]] = address(0);
            ++i;
            emit SignerRemoved(msg.sender, _signers[i]);
        }
    }
    function deposit() public payable {
        updateRefund(msg.value, false);
        protocolBalances[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }
    function depositWithSigner(address _signer) public payable{
        updateRefund(msg.value, false);
        if(_signer == address(0))
            revert Errors.InvalidAddress();
        if(protocolManagers[_signer] != address(0))
            revert Errors.SignerAlreadyRegistered();
        protocolBalances[msg.sender] += msg.value;
        protocolManagers[_signer] = msg.sender;
        emit Deposit(msg.sender, msg.value);
        emit SignerAdded(msg.sender, _signer);
    }
    function depositOnBehalf(address _protocolManager) public payable{
        updateRefund(msg.value, false);
        if(_protocolManager == address(0))
            revert Errors.InvalidAddress();
        protocolBalances[_protocolManager] += msg.value;
        emit Deposit(_protocolManager, msg.value);
    }
    function withdraw(uint amount) public {
        updateRefund(amount, true);        
        protocolBalances[msg.sender] -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Failed to withdraw funds from paymaster.");
        emit Withdraw(msg.sender, amount);
    }
    /// @dev refund is still possible in a edge case scenario. 
    // In a scenario, where previousProtocol is msg.sender. 
    // withdrawFull function is called through paymaster. 
    // In that scenario, some refunds still remain. 

    function withdrawFull() public {
        uint balance = protocolBalances[msg.sender];
        updateRefund(balance, true);
        protocolBalances[msg.sender] -= balance; 
        (bool success, ) = payable(msg.sender).call{value: balance}("");
        require(success, "Failed to withdraw funds from paymaster.");
        emit Withdraw(msg.sender, balance);
    }

    function rescueTokens(address[] memory tokens) public{
        uint i;
        for(;i<tokens.length;){
            if(tokens[i] == address(ETH_TOKEN_SYSTEM_CONTRACT))
                revert Errors.InvalidAddress();
            IERC20(tokens[i]).safeTransfer(ZYFI_RESCUE_ADDRESS, IERC20(tokens[i]).balanceOf(address(this)));
        }
    }
}
