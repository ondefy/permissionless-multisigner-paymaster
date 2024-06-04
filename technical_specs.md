# Permissionless multi-signer paymaster

## User roles 
 Manager, Signer, Zyfi Token Rescue Account

### Manager 
- Protocol manager is the address managed by the protocol or individual for gas sponsorship. 
- One-to-many relationship with Signers; i.e. A protocol manager can add or remove multiple signers as per requirement. 
- Manages funds(deposit/withdraw) for gas sponsorship. 
- Protocol manager can itself be a signer. 
- All added signers are cummulatively allowed access to the funds added by protocol manager. 
- Can also add or remove signers. 

### Signers 
- Signers are the addresses whose signatures are verified for gas sponsorship. 
- Signers are added by protocol managers. 
- Only one protocol manager is related to a signer at a time. 
- The signers and signing part can be managed offline by protocol or can be even delegated to Zyfi API for convenience for the protocol. 

### Zyfi token rescue account 
- Zyfi managed address to rescue any ERC-20 token that mistakenly is sent to paymaster address. 
- Mistakenly sent ETH to paymaster address are locked as of current design. 

## Signature 

### EIP-712 type signatures used. 
- To allow flexibility over time if Zyfi ever decides to create a dashboard to protocol manager to sign. Using this EIP, metamask like wallets can represent signatures in a more readable format to the users. 

### What data would the signers sign? 
- Work in progress. 
- We want to ensure it's as minimal as possible for protocol to integrate and save gas on users while also covering all important security concerns. 

## Refund 
- Refunds are managed by internal `updateRefund()` function. 
- Due to ambiguous nature of the exact refund amounts, refunds of particular sponsorer are processed in the next transaction. 




