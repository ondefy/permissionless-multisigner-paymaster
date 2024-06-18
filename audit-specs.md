## Assets in scope 
- ./contracts/paymasters/PermissionlessPaymaster.sol

## Permissionless Multisigner Paymaster Overview
- This paymaster aims to be a public good singular paymaster for any dapps/accounts to provide 100% gas sponsorship to users/related accounts by gatekeeping through signature verification in a permissionless way. 
- Any account(manager) can deposit funds that will sponsor gas and also a signer upon which signature validation is done. 
- The signer can be maintained by the manager or trusted party like Zyfi or manager can itself be a signer.
- The signer signs the data like users address, gas price, expiration time etc and provides a signature. This is expected to be managed off-chain. 
- The gas sponsorship from the manager's funds can only be accessed if signature provided by the user is valid. 
- The amount is then deducted from the manager account related to the signer. 
- Hence, one stop solution for signature based gated paymaster - A generalized signature based paymaster. 

### One-to-many relationship between signers and managers
![image](./img/image.png)

### Flowchart 
![image](./img/flowchart.png)

## Why is the paymaster needed?  What problem does it solve? 
- The main problem solved by this paymaster is allowing Dapps to have signature based gate-keeping for gas sponsoring without the need to deploy new paymaster itself. 
- This allows Dapps to have custom gas sponsorship logic embedded in their server. While only signature is required from the correct signer. 
- It also allows Dapps to have flexibility of having multiple signers.

## Target Audience 
- Major target audience : Dapps/Protocols looking to sponsor gas for users using custom logic. 
- User accounts who wants to manage gas sponsorship for their related accounts. 

## User roles 
- Manager, Signers, Users, Zyfi Token Rescue Account

### Manager
1. Manager is the address managed by the Dapp/protcol or individual for gas sponsorship.
2. One-to-many relationship with Signers, i.e. A manager can add or remove multiple signers as per requirement. 
3. Manages funds for gas sponsorship. A manager can deposit/withdraw as per need. 
4. Manager can itself be signer. 
5. All signers are cummulatively allowed access to the funds added by manager. 

### Signers 
1. Signers are the addresses whose signatures are verified for gas sponsorship. Basically, only signers can allow gas sponsorship in the paymaster.
2. Signers are added by manager. Signers are expected to trusted by the managers.
3. Only one manager is related to a signer at a time. 
4. The signers and signing part is managed offline by Dapps or can even be delegated to Zyfi API for convenience for the Dapp/protocol.
5. Signers can revoke itself if required. 

### Users 
1. Users are the end-users that will avail the gas sponsorship from the paymaster by providing valid signature. 
2. Valid signature provided from the signers must be related to a manager and also have enough funds to sponsor the transaction. 

### Zyfi Token Rescue Account 
1. Zyfi managed address to rescue any ERC-20 token (Other than ETH) that mistakenly is sent to paymaster address.

## Signature 

#### EIP-712 type signature
- To allow flexibility over time if Zyfi ever decides to create a dashboard for manager and signers to sign. Using this EIP, metamask like wallets can represent signature data in a more readable format. 

#### What data would the signers sign? 
```
(_domainSeparator +
hash(
    SIGNATURE_TYPEHASH,
    _from,
    _to,
    _expirationTime,
    _maxNonce,
    _maxFeePerGas,
    _gasLimit
))
```

## Refunds
- Zksync refunds the amount for un-used gas earlier charged by the paymaster.
- In this paymaster, refunds are managed through internal `updateRefund` functions.
- Due to ambiguous nature of the exact refund amounts, refunds of particular manager are processed in the next transaction. 

## Main invariants

1. Balance of paymaster is always greater than or equal sum of manager balances in paymaster at any given point of time. 

```
Balance_of_paymaster ≥ (Σ Manager_Balances_in_paymaster)
```

## Area of concerns 

1. Manipulation of update refunds. Infaltion of `previousTotalBalance` in any manner. 
2. Gas griefing attacks that drains the paymaster. For eg: Invalid signature returns magic = bytes4(0) instead of reverting. Could this be used to drain paymaster funds in future? 
3. Funds being stuck in paymaster.
4. Any particular way that affects the reputation of paymaster in future as mentioned [here](https://docs.zksync.io/build/developer-reference/account-abstraction/paymasters#paymaster-verification-rules) 
5. Signature replay attacks

## Known issues/ Expected behaviour

#### 1. Dependency on `transaction.nonce`:
- Zksync might shift to non-sequential arbitary nonce ordering which could lead to signature replay attacks. 
- Zyfi will be closely watching this development and eventually will notify transfer funds to new version of paymaster. 
- The main reason to be dependent on `transaction.nonce` is to save gas and allow flexbility to same users across multiple dapps using the same paymaster. Curious to discuss more on this. 

#### 2. Griefing attacks while adding signers
- `depositAndAddSigner`, `addSigner`, `batchAddSigners` are subject to griefing attacks. 
- While this in-evitable scenario, we have `selfRevokeSigner` to minimalize the impact. Since signers can be any address, the impact reduces further.  

#### 3. Eth sent using self-destruct is rewarded to `previousManager`. 
- Expected behaviour

#### 4. Eth sent by self-destructing manager to paymaster using paymaster itself are stuck forever.
- Expected behaviour

#### 5. No 2-step transfer for `ZYFI_RESCUE_TOKEN_ADDRESS` 
- The chances of tokens mistakenly sent to the paymaster are already low. 
- Hence, we have decided to keep the design simple.


