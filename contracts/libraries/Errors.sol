// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.19;
library Errors {
    /*//////////////////////////////////////////////////////////////
                              PAYMASTER
    //////////////////////////////////////////////////////////////*/

    error PM_NotFromBootloader();
    error PM_ShortPaymasterInput();
    error PM_UnsupportedPaymasterFlow();
    error PM_TransactionExpired();
    error PM_InvalidNonce();
    error PM_InvalidSignature();
    error PM_InsufficientBalance();
    error PM_InvalidAddress();
    error PM_FailedTransferToBootloader();
    error PM_FailedTransfer();
    error PM_SignerNotRegistered();
    error PM_SignerAlreadyRegistered();
    error PM_UnauthorizedManager();

}