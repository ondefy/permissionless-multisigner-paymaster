
## Permissionless Multisigner Paymaster
- This paymaster aims to be a public good singular paymaster for any dapps/accounts to provide 100% gas sponsorship to users/related accounts by gatekeeping through signature verification in a permissionless way. 
- Any account(manager) can deposit gas funds and add signers upon which signature validation is done.
- The signer can be maintained by the manager or a trusted party like Zyfi. The manager can itself be a signer too.
- The signer signs the data (i.e. user address, gas price, expiration time etc) and provides a signature. This is expected to be managed off-chain. 
- The gas sponsorship from the manager's funds in paymaster can only be accessed if the signature provided by the user is valid. 
- Hence, this is a one stop solution for a signature based gated paymaster, available to the whole ZKsync ecosystem


## Why is the paymaster needed?  What problem does it solve? 
- The main problem solved by this paymaster is allowing Dapps to have signature based gate-keeping for gas sponsoring without the need to deploy new paymaster itself. 
- This allows Dapps to have custom business logic for gas sponsorship embedded in their back-end server. Being signature based, the paymaster solely needs correct signature from the signer.
- It also allows Dapps to have the flexibility of managing multiple signers.

## Target Audience 
- Major target audience : Dapps/Protocols looking to sponsor gas for their users using custom off-chain logic. 
- User accounts who wants to manage gas sponsorship for their related accounts. 

## User Roles / Actors
- Manager, Signers, Users, Zyfi Treasury Account

### Manager
1. Manager is the address managed by the Dapp/protcol or individual for gas sponsorship.
2. One-to-many relationship with Signers, i.e. A manager can add or remove multiple signers as desired. 
3. Manages funds for gas sponsorship. A manager can deposit/withdraw as needed. 
4. Manager can itself be a signer. 
5. All added signers are allowed access to the funds deposited by the manager. 

### Signers 
1. Signers are the addresses whose signatures are verified for gas sponsorship. Basically, only signers can allow gas sponsorship in the paymaster.
2. Signers are added and removed by the manager. Signers are expected to be trusted by the manager.
3. Only one manager is related to a signer at a time. 
4. The signers and signing part is managed offline by Dapps or can even be delegated to the Zyfi API for convenience for the Dapp/protocol.
5. A signer can revoke itself if required. 

### Users 
1. Users are the end-users that will receive a sponsored transaction from the Dapp to sign. They will be easily able to verify that the transaction does not require any gas payment from their side.

### Zyfi Treasury
1. Zyfi Treasury address to rescue any ERC-20 token (other than ETH) that mistakenly is sent to the paymaster address.
2. To collect markup fee. This functionality is optional for Zyfi API only, Dapps are expected to set the markupPercent to 0 unless they want to donate.

### One-to-many relationship between signers and managers
![image](./img/image.png)

## Signature 
Signer shall create signature based on the below given data.

#### EIP-712 type signature
- EIP-712 type signature allowed structured data format to be signed to improve readability.

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
    _gasLimit,
    _markupPercent
))
```
#### _from :
- The user address the signer wants to sponsor.

#### _to : 
- The target contract user address is interacting i.e. Dapp's contract.

#### _expirationTime :
- Timestamp post which the signature expires.

#### _maxNonce :
- Nonce of the user post which signature cannot be replayed.
- Allows flexibility for Dapps to allow replaying signature since transaction.to(Dapp's contract) will be same.
- Setting _maxNonce to currentNonce of the user ensures no replays. [More details here](https://docs.zyfi.org/).

#### _maxFeePerGas : 
- Current gas price returned by the provider.

#### _gasLimit :
- Gas limit required by the transaction.
- Paymaster cost 60K gas overhead. Hence, should be considered while setting gasLimit. 

#### _markupPercent :
- Optional markup charge on the total gas funds required(_gasLimit * _maxFeePerGas). For Zyfi Api use only.
- Dapps should ensure it's set to 0, or else will be considered donation. 

## Refunds
- ZKsync refunds the amount for the unused gas initially charged to the paymaster.
- In this paymaster, refunds are managed through internal `updateRefund` function.
- Due to `_maxRefundedGas` in `postTransaction()` not being accurate, **the refund is processed in the next transaction**. 

### Integration flow
- For integration, check out [./deploy/utils.ts](./deploy/utils.ts), [./test/utils.ts](./test/utils.ts) & [documentation](https://docs.zyfi.org)

![image](./img/integration.jpg)

## Gas 

Paymaster approx gas overhead - 48K - 58K

- Simple mint transaction : Transaction total gas : 390_107 | Gas used : 134_228
> ![image](./img/gas-withoutPaymaster1.png)
---
- With Paymaster overhead : Transaction total gas : 667_043 | Gas used : 182_490 (48k difference)
> ![image](./img/gas-paymaster-withoutMarkup.png)
---
- With Paymaster overhead and markup : Transaction total gas : 466_751 | Gas used : 192_922 (58k difference)
> ![image](./img/gas-paymaster-withMarkup.png)