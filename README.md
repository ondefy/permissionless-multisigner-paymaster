# Permissionless Multi Signer Paymaster
A singular permissionless multi-signer paymaster allowing multiple dapps to seamlessly sponsor gas for their users through signature verification. 

## Install dependencies
```
yarn install
```

## To run tests

### - Local Hardhat

```
    yarn test
```

### - Fork environment

#### 1. Start inMemoryNode with Era_test_node in terminal. [See installation here](https://docs.zksync.io/build/test-and-debug/in-memory-node#install-and-set-up-era_test_node) 

```
    era_test_node fork mainnet
```
#### 2. Run below command in another terminal
```
    yarn test-local
```