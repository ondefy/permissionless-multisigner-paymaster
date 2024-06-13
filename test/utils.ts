import { Deployer } from "@matterlabs/hardhat-zksync-deploy";
import { BigNumber, BigNumberish, ethers } from "ethers";
import { formatEther } from "ethers/lib/utils";
import * as hre from "hardhat";
import { Contract, Provider, Wallet, utils } from "zksync-ethers";

import "@matterlabs/hardhat-zksync-node/dist/type-extensions";
import "@matterlabs/hardhat-zksync-verify/dist/src/type-extensions";
import { Address } from "zksync-ethers/build/types";
const GAS_LIMIT = 10_000_000;
const MAX_FEE_PER_GAS = 50000;
const TX_EXPIRATION = 30 * 60; //30 minute
const abiCoder = new ethers.utils.AbiCoder();
export const getProvider = () => {
  const rpcUrl = hre.network.config.url;
  if (!rpcUrl)
    throw `⛔️ RPC URL wasn't found in "${hre.network.name}"! Please add a "url" field to the network config in hardhat.config.ts`;

  // Initialize zkSync Provider
  const provider = new Provider(rpcUrl);

  return provider;
};

export const getWallet = (privateKey?: string) => {
  if (!privateKey) {
    // Get wallet private key from .env file
    if (!process.env.WALLET_PRIVATE_KEY)
      throw "⛔️ Wallet private key wasn't found in .env file!";
  }

  const provider = getProvider();

  // Initialize zkSync Wallet
  const wallet = new Wallet(
    // biome-ignore lint/style/noNonNullAssertion: A check is performed above
    privateKey ?? process.env.WALLET_PRIVATE_KEY!,
    provider
  );

  return wallet;
};

export async function fundAccount(
  wallet: Wallet,
  address: string,
  amount: string
) {
  await (
    await wallet.sendTransaction({
      to: address,
      value: ethers.utils.parseEther(amount),
    })
  ).wait();
  console.log(`Funded ${address} with ${amount} ETH`);
}

export const verifyEnoughBalance = async (
  wallet: Wallet,
  amount: BigNumberish
) => {
  // Check if the wallet has enough balance
  const balance = await wallet.getBalance();
  if (balance.lt(amount))
    throw `⛔️ Wallet balance is too low! Required ${formatEther(
      amount
    )} ETH, but current ${wallet.address} balance is ${formatEther(
      balance
    )} ETH`;
};

/**
 * @param {string} data.contract The contract's path and name. E.g., "contracts/Greeter.sol:Greeter"
 */
export const verifyContract = async (data: {
  address: string;
  contract: string;
  constructorArguments: string;
  bytecode: string;
}) => {
  const verificationRequestId: number = await hre.run("verify:verify", {
    ...data,
    noCompile: true,
  });
  return verificationRequestId;
};

type DeployContractOptions = {
  /**
   * If true, the deployment process will not print any logs
   */
  silent?: boolean;
  /**
   * If true, the contract will not be verified on Block Explorer
   */
  noVerify?: boolean;
  /**
   * If specified, the contract will be deployed using this wallet
   */
  wallet?: Wallet;
  /**
   * If specified, the ownership of the contract will be transferred to this address
   */
  transferOwnership?: Address;
  /**
   * If true, the contract will be deployed using a deployProxy
   */
  proxy?: boolean;
};
export const deployContract = async (
  contractArtifactName: string,
  constructorArguments?: any[],
  options?: DeployContractOptions,
  _customData?: any
) => {
  const log = (message: string) => {
    if (!options?.silent) console.log(message);
  };
  log(`\nStarting deployment process of "${contractArtifactName}"...`);

  const isLocalNetwork =
    hre.network.name === "zkSyncEraTestNode" ||
    hre.network.name === "inMemoryNode";
  const defaultPrivateKey = isLocalNetwork
    ? LOCAL_RICH_WALLETS[0].privateKey
    : undefined;
  const wallet: Wallet = options?.wallet ?? getWallet(defaultPrivateKey);

  const deployer = new Deployer(hre, wallet);
  const artifact = await deployer
    .loadArtifact(contractArtifactName)
    .catch((error) => {
      if (
        error?.message?.includes(
          `Artifact for contract "${contractArtifactName}" not found.`
        )
      ) {
        console.error(error.message);
        throw "⛔️ Please make sure you have compiled your contracts or specified the correct contract name!";
      }
      throw error;
    });

  let contract: Contract;

  if (!options?.proxy) {
    // Estimate contract deployment fee
    const deploymentFee = await deployer.estimateDeployFee(
      artifact,
      constructorArguments || []
    );
    log(`Estimated deployment cost: ${formatEther(deploymentFee)} ETH`);

    // Check if the wallet has enough balance
    await verifyEnoughBalance(wallet, deploymentFee);

    // Deploy the contract to zkSync
    if(_customData != null){
      contract = await deployer.deploy(artifact, constructorArguments, {
        customData:{
          _customData
        }
      });
    }
    else{
      contract = await deployer.deploy(artifact, constructorArguments);
    }

    const constructorArgs =
      contract.interface.encodeDeploy(constructorArguments);
    const fullContractSource = `${artifact.sourceName}:${artifact.contractName}`;

    // Display contract deployment info
    log(`\n"${artifact.contractName}" was successfully deployed:`);
    log(` - Contract address: ${contract.address}`);
    log(` - Contract source: ${fullContractSource}`);
    log(` - Encoded constructor arguments: ${constructorArgs}\n`);

    if (!options?.noVerify && hre.network.config.verifyURL) {
      log("Requesting contract verification...");
      await verifyContract({
        address: contract.address,
        contract: fullContractSource,
        constructorArguments: constructorArgs,
        bytecode: artifact.bytecode,
      });
    }

    if (options?.transferOwnership) {
      log(`Transferring ownership to ${options.transferOwnership}...`);
      await contract.transferOwnership(options.transferOwnership);
    }
  } // Proxy path
  else {
    // // Estimate contract deployment fee - Only for mainnet
    // const deploymentFee = await hre.zkUpgrades.estimation.estimateGasProxy(
    // 	deployer,
    // 	artifact,
    // 	[],
    // 	{ kind: "uups" },
    // );

    // console.log(`Estimated deployment cost: ${formatEther(deploymentFee)} ETH`);

    // // Check if the wallet has enough balance
    // await verifyEnoughBalance(wallet, deploymentFee);

    // Deploy the contract to zkSync
    contract = await hre.zkUpgrades.deployProxy(
      deployer.zkWallet,
      artifact,
      constructorArguments,
      {
        initializer: "initialize",
      }
    );
    await contract.deployed();
  }

  return contract;
};

export async function getUserNonce(address) {
  // This assumes you have already set up your Hardhat environment and you're calling this within an async function

  // Get the provider from Hardhat's environment
  const provider = getProvider();

  // Use the provider to get the nonce for the specified address
  const nonce = await provider.getTransactionCount(address);

  // console.log(`Nonce for address ${address} is: ${nonce}`);
  return nonce;
}
export async function getMessageHash(
    _from: Address,
    _to: Address,
    _token: Address,
    _amount: BigNumber,
    _expirationTime: BigNumber,
    _maxFeePerGas: BigNumber,
    _gasLimit: BigNumber
  ) {
    return ethers.utils.solidityKeccak256(
      [
        "address",
        "address",
        "address",
        "uint256",
        "uint64",
        "uint256",
        "uint256",
      ],
      [_from, _to, _token, _amount, _expirationTime, _maxFeePerGas, _gasLimit]
    );
  }
  
  export async function getMessageHashSponsor(
    _from: Address,
    _to: Address,
    _token: Address,
    _amount: BigNumber,
    _expirationTime: BigNumber,
    _maxNonce: BigNumber,
    _protocolAddress: Address,
    _sponsorshipRatio: BigNumber,
    _maxFeePerGas: BigNumber,
    _gasLimit: BigNumber
  ) {
    return ethers.utils.solidityKeccak256(
      [
        "address",
        "address",
        "address",
        "uint256",
        "uint64",
        "uint256",
        "address",
        "uint16",
        "uint256",
        "uint256",
      ],
      [
        _from,
        _to,
        _token,
        _amount,
        _expirationTime,
        _maxNonce,
        _protocolAddress,
        _sponsorshipRatio,
        _maxFeePerGas,
        _gasLimit,
      ]
    );
  }
  type executeTransactionOptions = {
    // Define the paymaster type
    type?: "approval", 
    // If true, indicates that innerInput field should be incorrect
    invalidInnerInput?: boolean;
    // If true, indicates that a invalid signature should be generated
    invalidSignature?: boolean;
    // If true, indicates that a wrong signature should be generated that reproduces different signer
    wrongSignature?: boolean;
    // If true, indicates that a wrong signerAddress should be provided in paymaster parameters, signature will be as it is. 
    wrongSigner?: Address;
    // If true, indicates that the transaction should be expired
    expiredtx?: boolean;
    // If true, set a used nonce
    usedNonce?: boolean;
  };

  export function getInnerInputs(
    expiration: BigNumber,
    maxNonce: BigNumber,
    signerAddress: string,
    signature: string
  ){
    const innerInput = ethers.utils.arrayify(
      abiCoder.encode(["uint256", "uint256", "address", "bytes"], [expiration, maxNonce, signerAddress, signature]),
    );
    return innerInput;
  }
  export async function getEIP712Signature(
    from: string,
    to: string | undefined,
    expirationTime: BigNumber,
    maxNonce: BigNumber,
    maxFeePerGas: BigNumber,
    gasLimit: BigNumber,
    signer: Wallet,
    paymaster: Contract
  ){
    const eip712Domain = await paymaster.eip712Domain();
    const domain = {
      name: eip712Domain[1],
      version: eip712Domain[2],
      chainId: eip712Domain[3],
      verifyingContract: eip712Domain[4],
    }
    const types = {
      PermissionLessPaymaster: [
        { name: "from", type: "address"},
        { name: "to", type: "address"},
        { name: "expirationTime", type: "uint256"},
        { name: "maxNonce", type: "uint256"},
        { name: "maxFeePerGas", type: "uint256"},
        { name: "gasLimit", type: "uint256"}
      ]
    };
    const values = {
      from,
      to,
      expirationTime,
      maxNonce,
      maxFeePerGas,
      gasLimit
    }

    return (await signer._signTypedData(domain, types, values));

  };
  export async function executeERC20Transaction(
    to: Contract | null, 
    paymaster: Contract,
    provider: Provider,
    user: Wallet,
    signer: Wallet,
    options?: executeTransactionOptions
  ) {
    const gasPrice = await provider.getGasPrice();
    let _signer = signer;
    let _signerAddress = signer.address;
    //// const minimalAllowance = ethers.utils.parseEther("1");
    //const minimalAllowance = BigNumber.from(GAS_LIMIT)
    //  .mul(gasPrice)
    //  .mul(ratio)
    //  .mul(BigNumber.from(1e4).sub(sponsorshipRatio))
    //  .div(1e8)
    //  .div(1e4); //Sponsorship denominator
    //// console.log("minimalAllowance", minimalAllowance.toString());

    const currentTimestamp = BigNumber.from((await provider.getBlock("latest")).timestamp);

    let expiration: BigNumber;

    // Check if the transaction is intended to be expired
    if (options?.expiredtx) {
      expiration = BigNumber.from(currentTimestamp.sub(1));
    } else {
      expiration = BigNumber.from(currentTimestamp.add(TX_EXPIRATION));
    }

    //
    const maxNonce = BigNumber.from(
      options?.usedNonce ? 0 : ( await provider.getTransactionCount(user.address)) + 50
    );

    if(options?.wrongSigner){
      _signer = Wallet.createRandom();
  }

    let signature = await getEIP712Signature(
      user.address,
      to?.address,
      expiration,
      maxNonce,
      gasPrice,
      BigNumber.from(GAS_LIMIT),
      _signer,
      paymaster   
    )

    if (options?.invalidSignature) {
      signature = signature.replace(/b/g,`a`);
    }
    if(options?.wrongSigner){
      _signerAddress = Wallet.createRandom().address;
    }
    const innerInput = getInnerInputs(expiration, maxNonce, _signerAddress, signature);

    let paymasterParams;
    if(options?.type){
      paymasterParams= utils.getPaymasterParams(
        paymaster.address.toString(),
        {
          type: "ApprovalBased",
          token: String(to?.address),
          minimalAllowance : BigNumber.from(1),
          innerInput
        }
      );
      //console.log(paymasterParams);
    }
    else {
      paymasterParams = utils.getPaymasterParams(
        paymaster.address.toString(),
        {
          type: "General",
          innerInput
        }
      )
    }
    if(options?.invalidInnerInput){
      paymasterParams.paymasterInput = paymasterParams.paymasterInput.substring(0,584)
    }
    //console.log(await paymaster.SIGNATURE_TYPEHASH());
    //console.log(user.address);
    //console.log(to?.address);
    //console.log(BigNumber.from(expiration));
    //console.log(BigNumber.from(maxNonce));
    //console.log(BigNumber.from(gasPrice));
    //console.log(BigNumber.from(GAS_LIMIT));


    return await (
      await to?.connect(user).mint(user.address, 5, {
        maxPriorityFeePerGas: BigNumber.from(0),
        maxFeePerGas: gasPrice,
        gasLimit: GAS_LIMIT,
        customData: {
          paymasterParams,
          gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
        },
      })
    ).wait();
  }
  /**
   * Rich wallets can be used for testing purposes.
   * Available on zkSync In-memory node and Dockerized node.
   */
  
  export const LOCAL_RICH_WALLETS = [
    {
      address: "0x36615Cf349d7F6344891B1e7CA7C72883F5dc049",
      privateKey:
        "0x7726827caac94a7f9e1b160f7ea819f172f7b6f9d2a97f992c38edeab82d4110",
    },
    {
      address: "0xa61464658AfeAf65CccaaFD3a512b69A83B77618",
      privateKey:
        "0xac1e735be8536c6534bb4f17f06f6afc73b2b5ba84ac2cfb12f7461b20c0bbe3",
    },
    {
      address: "0x0D43eB5B8a47bA8900d84AA36656c92024e9772e",
      privateKey:
        "0xd293c684d884d56f8d6abd64fc76757d3664904e309a0645baf8522ab6366d9e",
    },
    {
      address: "0xA13c10C0D5bd6f79041B9835c63f91de35A15883",
      privateKey:
        "0x850683b40d4a740aa6e745f889a6fdc8327be76e122f5aba645a5b02d0248db8",
    },
    {
      address: "0x8002cD98Cfb563492A6fB3E7C8243b7B9Ad4cc92",
      privateKey:
        "0xf12e28c0eb1ef4ff90478f6805b68d63737b7f33abfa091601140805da450d93",
    },
    {
      address: "0x4F9133D1d3F50011A6859807C837bdCB31Aaab13",
      privateKey:
        "0xe667e57a9b8aaa6709e51ff7d093f1c5b73b63f9987e4ab4aa9a5c699e024ee8",
    },
    {
      address: "0xbd29A1B981925B94eEc5c4F1125AF02a2Ec4d1cA",
      privateKey:
        "0x28a574ab2de8a00364d5dd4b07c4f2f574ef7fcc2a86a197f65abaec836d1959",
    },
    {
      address: "0xedB6F5B4aab3dD95C7806Af42881FF12BE7e9daa",
      privateKey:
        "0x74d8b3a188f7260f67698eb44da07397a298df5427df681ef68c45b34b61f998",
    },
    {
      address: "0xe706e60ab5Dc512C36A4646D719b889F398cbBcB",
      privateKey:
        "0xbe79721778b48bcc679b78edac0ce48306a8578186ffcb9f2ee455ae6efeace1",
    },
    {
      address: "0xE90E12261CCb0F3F7976Ae611A29e84a6A85f424",
      privateKey:
        "0x3eb15da85647edd9a1159a4a13b9e7c56877c4eb33f614546d4db06a51868b1c",
    },
  ];