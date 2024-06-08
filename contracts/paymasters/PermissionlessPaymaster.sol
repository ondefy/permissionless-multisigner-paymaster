// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {IPaymaster, ExecutionResult, PAYMASTER_VALIDATION_SUCCESS_MAGIC} from "@matterlabs/zksync-contracts/l2/system-contracts/interfaces/IPaymaster.sol";
import {IPaymasterFlow} from "@matterlabs/zksync-contracts/l2/system-contracts/interfaces/IPaymasterFlow.sol";
import {TransactionHelper, Transaction} from "@matterlabs/zksync-contracts/l2/system-contracts/libraries/TransactionHelper.sol";

import "@matterlabs/zksync-contracts/l2/system-contracts/Constants.sol";

import {IERC20, SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

import {Errors} from "../libraries/Errors.sol";

contract PermissionlessPaymaster is IPaymaster, EIP712 {

    using ECDSA for bytes32;
    using SafeERC20 for IERC20;

    address public ZYFI_RESCUE_ADDRESS; 
    bytes32 public constant SIGNATURE_TYPEHASH = keccak256(
    "PermissionLessPaymaster(address userAddress,uint256 lastTimestamp,uint256 nonces)"
    );

    mapping(address signer => address manager) public managers;
    
    mapping(address manager => uint ethBalance) public managerBalances; 

    address public previousManager;
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
            revert Errors.PM_NotFromBootloader();
        }
        // Continue execution if called from the bootloader.
        _;
    }
    function updateRefund(uint amount, bool isWithdraw) internal {
        if(previousManager != address(0)){
            managerBalances[previousManager] = managerBalances[previousManager] + (address(this).balance - previousTotalBalance);
            previousManager = address(0);
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
            revert Errors.PM_ShortPaymasterInput();

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
                revert Errors.PM_TransactionExpired();
            
            if(_transaction.nonce > maxNonce)
                revert Errors.PM_InvalidNonce();

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
                revert Errors.PM_InvalidSignature();
            }
            uint256 requiredETH = _transaction.gasLimit *
                _transaction.maxFeePerGas;

            address _manager = managers[signerAddress];
            if(_manager == address(0))
                revert Errors.PM_SignerNotRegistered();
            uint _balance = managerBalances[_manager];
            if(_balance < requiredETH)
                revert Errors.PM_InsufficientBalance();
            managerBalances[_manager] = _balance - requiredETH;
            previousManager = _manager;
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
            revert Errors.PM_UnsupportedPaymasterFlow();
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
                SIGNATURE_TYPEHASH,
                _from,
                _to,
                _expirationTime,
                _maxNonce,
                _maxFeePerGas,
                _gasLimit
            )
        );

        bytes32 ethSignedMessageHash = _hashTypedDataV4(messageHash);

        (address recoveredAddress, ECDSA.RecoverError error2) = ethSignedMessageHash.tryRecover(_signature);
        if (error2 != ECDSA.RecoverError.NoError) {
            return false;
        }
        return recoveredAddress == _signerAddress;
    }
   function addSigner(address _signer) public {
        if(_signer == address(0))
            revert Errors.PM_InvalidAddress();
        if(managers[_signer] != address(0))
            revert Errors.PM_SignerAlreadyRegistered();
        managers[_signer] = msg.sender;
        emit SignerAdded(msg.sender, _signer);
   }

    function removeSigner(address _signer) public {
        if(_signer == address(0))
            revert Errors.PM_InvalidAddress();
        if(managers[_signer] != msg.sender)
            revert Errors.PM_UnauthorizedManager();
        managers[_signer] = address(0);
        emit SignerRemoved(msg.sender, _signer);
    }
    function replaceSigner(address _oldSigner, address _newSigner) public {
        if(_newSigner == address(0) || _oldSigner == address(0))
            revert Errors.PM_InvalidAddress();
        if(managers[_newSigner] != address(0))
            revert Errors.PM_SignerAlreadyRegistered();
        if(managers[_oldSigner] != msg.sender)
            revert Errors.PM_UnauthorizedManager();
        managers[_newSigner] = msg.sender;
        managers[_oldSigner] = address(0);
    }

    function selfRevokeSigner() public{
        managers[msg.sender] = address(0);
    }
    function batchAddSigners(address[] memory _signers) public{
        uint i;
        for(; i< _signers.length; ){
            if(_signers[i] == address(0))
                revert Errors.PM_InvalidAddress();
            if(managers[_signers[i]] != address(0))
                revert Errors.PM_SignerAlreadyRegistered();
            managers[_signers[i]] = msg.sender;            
            ++i;
            emit SignerAdded(msg.sender, _signers[i]);

        }
    }

    function batchRemoveSigners(address[] memory _signers) public{
        uint i;
        for(;i < _signers.length;){
            if(_signers[i] == address(0))
                revert Errors.PM_InvalidAddress();
            if(managers[_signers[i]] != msg.sender)
                revert Errors.PM_UnauthorizedManager();
            managers[_signers[i]] = address(0);
            ++i;
            emit SignerRemoved(msg.sender, _signers[i]);
        }
    }
    function deposit() public payable {
        updateRefund(msg.value, false);
        managerBalances[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }
    function depositAndAddSigner(address _signer) public payable{
        updateRefund(msg.value, false);
        if(_signer == address(0))
            revert Errors.PM_InvalidAddress();
        if(managers[_signer] != address(0))
            revert Errors.PM_SignerAlreadyRegistered();
        managerBalances[msg.sender] += msg.value;
        managers[_signer] = msg.sender;
        emit Deposit(msg.sender, msg.value);
        emit SignerAdded(msg.sender, _signer);
    }
    function depositOnBehalf(address _manager) public payable{
        updateRefund(msg.value, false);
        if(_manager == address(0))
            revert Errors.PM_InvalidAddress();
        managerBalances[_manager] += msg.value;
        emit Deposit(_manager, msg.value);
    }
    function withdraw(uint amount) public {
        updateRefund(amount, true);        
        managerBalances[msg.sender] -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Failed to withdraw funds from paymaster.");
        emit Withdraw(msg.sender, amount);
    }
    /// @dev refund is still possible in a edge case scenario. 
    // In a scenario, where previous manager is msg.sender. 
    // withdrawFull function is called through paymaster. 
    // In that scenario, some refunds still remain. 
    
    function withdrawFull() public {
        uint balance = managerBalances[msg.sender];
        updateRefund(balance, true);
        managerBalances[msg.sender] -= balance; 
        (bool success, ) = payable(msg.sender).call{value: balance}("");
        require(success, "Failed to withdraw funds from paymaster.");
        emit Withdraw(msg.sender, balance);
    }

    function withdrawAndRemoveSigners(uint amount, address[] memory _signers) public{
        updateRefund(amount, true);
        managerBalances[msg.sender] -= amount;
        uint i;
        for(; i< _signers.length;){
            if(_signers[i] == address(0))
                revert Errors.PM_InvalidAddress();
            if(managers[_signers[i]] != msg.sender)
                revert Errors.PM_UnauthorizedManager();
            managers[_signers[i]] = address(0);
            ++i;
            emit SignerRemoved(msg.sender, _signers[i]);
        }
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Failed to withdraw funds from paymaster.");
        emit Withdraw(msg.sender, amount);
    }

    function rescueTokens(address[] memory tokens) public{
        uint i;
        for(;i<tokens.length;){
            if(tokens[i] == address(ETH_TOKEN_SYSTEM_CONTRACT) || tokens[i] == address(0))
                revert Errors.PM_InvalidAddress();
            IERC20(tokens[i]).safeTransfer(ZYFI_RESCUE_ADDRESS, IERC20(tokens[i]).balanceOf(address(this)));
        }
    }
    function domainSeparator() public view returns(bytes32) {
        return _domainSeparatorV4();
    }
    function updateRescueAddress(address _newAddress) public {
        if(msg.sender != ZYFI_RESCUE_ADDRESS)
            revert Errors.PM_Unauthorized();
        if(_newAddress == address(0))
            revert Errors.PM_InvalidAddress();
        ZYFI_RESCUE_ADDRESS = _newAddress;
    }

    function getManagerBalance_via_Signer(address _signer) public view returns(uint){
        return managerBalances[managers[_signer]];
    }
}
