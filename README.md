# Permissionless Multi Signer Paymaster
A singular permissionless multi-signer paymaster allowing multiple dapps to seamlessly sponsor gas for their users through signature verification. 

## Install 
```
yarn install
```

## To run tests

### 1. Run era_test_node first

```
    era_test_node run // For network --inMemoryNode
```

### 2. Run below command in new terminal

```
    yarn test
```

```
    yarn test-local // For network --inMemoryNode
```