// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.19;
library Errors {
    /*//////////////////////////////////////////////////////////////
                              PAYMASTER
    //////////////////////////////////////////////////////////////*/

    error PM_NotFromBootloader(); // 0xae917251
    error PM_ShortPaymasterInput(); // 0x27d55a93
    error PM_UnsupportedPaymasterFlow(); // 0xa6eb6873
    error PM_SignatureExpired(); // 0x1f731be8
    error PM_InvalidNonce(); // 0xc607a643
    error PM_InvalidSignature(); // 0x2d4b72a2
    error PM_InsufficientBalance(); // 0x9625287c
    error PM_InvalidAddress(); // 0x02876945
    error PM_FailedTransferToBootloader(); // 0x004e409a
    error PM_FailedTransfer(); // 0xf1ba1f21
    error PM_SignerNotRegistered(); // 0x81c0c5d4
    error PM_SignerAlreadyRegistered(); // 0xdbae7908
    error PM_UnauthorizedManager(); // 0xce37a54d
    error PM_Unauthorized(); // 0x5001df4c
}