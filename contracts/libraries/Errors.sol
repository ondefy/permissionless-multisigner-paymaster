// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.19;
library Errors {
    /*//////////////////////////////////////////////////////////////
                              PAYMASTER
    //////////////////////////////////////////////////////////////*/

    error NotFromBootloader();
    error ShortPaymasterInput();
    error UnsupportedPaymasterFlow();
    error TransactionExpired();
    error InvalidNonce();
    error InvalidSignature();
    error InsufficientBalance();
    error InvalidAddress();
    error FailedTransferToBootloader();
    error FailedTransfer();

    error SignerNotRegistered();
    error SignerAlreadyRegistered();

    error InvalidManager();

}