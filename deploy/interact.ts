import * as hre from "hardhat";
import { createPaymasterParams, getProvider, getWallet } from "./utils";
import { ethers, BigNumber} from "ethers";
import { Contract, Wallet, utils, Provider } from "zksync-ethers";
import dotenv from "dotenv";

dotenv.config();
// Address of the contract to interact with
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CONTRACT_ADDRESS = "";
const ERC20_ADDRESS = "0xe1134444211593Cfda9fc9eCc7B43208615556E2" // UNI ADDRESS ON SEPOLIA
if (!CONTRACT_ADDRESS) throw "⛔️ Provide address of the contract to interact with!";


export default async function () {
  console.log(`\n Running script to interact with contract ${CONTRACT_ADDRESS}`);

  // Load compiled contract info
  const paymasterArtifact = await hre.artifacts.readArtifact("PermissionlessPaymaster");
  const erc20Artifact = await hre.artifacts.readArtifact("MyERC20Token");

  // Load the manager & signer
  const manager = getWallet();
  const signer = getWallet(process.env.SIGNER_PRIVATE_KEY);

  // Create random user
  const random = Wallet.createRandom();
  const user = getWallet(random.privateKey);
  console.log(`\nCreating random user to interact with paymaster: ${user.address} \nPrivate Key of random user- ${user.privateKey}\n`);
  // Initialize contract instance for interaction
  const paymaster = new Contract(
    CONTRACT_ADDRESS,
    paymasterArtifact.abi,
    getWallet() // Interact with the contract on behalf of this wallet
  );

  const erc20 = new Contract(
    ERC20_ADDRESS,
    erc20Artifact.abi,
    getWallet()
  );


  const response = await paymaster.managerBalances(manager.address);
  console.log(`Current balance of manager: ${ethers.utils.formatEther(response)} \n`);
  if(ethers.utils.parseEther("0.005").gt(response)){
    const tx = await paymaster.deposit({value: ethers.utils.parseEther("0.01")});
    console.log(`Depositing 0.01 ether in paymaster - Transaction hash: ${tx.hash} \n`);
    await tx.wait();
    const response1 = await paymaster.managerBalances(manager.address);
    console.log(`Current balance of manager is now: ${ethers.utils.formatEther(response1)} \n`);
  }
  
  console.log(`Total balance of paymaster: ${ethers.utils.formatEther(await getProvider().getBalance(paymaster.address))}\n`);

  const currentManager = await paymaster.managers(signer.address);
  if(currentManager == ZERO_ADDRESS && currentManager != manager.address){

    const transaction = await paymaster.addSigner(signer.address);
    console.log(`Adding signer: ${signer.address} in the paymaster - Transaction hash: ${transaction.hash}\n`);
    // Wait until transaction is processed
    await transaction.wait();

  }
  else {
    console.log("Signer already registered");
  }

  let paymasterParams, gasPrice, gasLimit;
  [paymasterParams, gasPrice, gasLimit] = await createPaymasterParams(paymaster, user, erc20, signer);
  // Execute user transaction - Approve 10 UNI tokens
  let userTransaction;
  userTransaction= await erc20.connect(user).approve(manager.address, ethers.utils.parseEther("10"),{
      maxFeePerGas: gasPrice,
      gasLimit: gasLimit,
      customData: {
        paymasterParams,
        gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
      }
    });
  console.log(`User successfully sending approve transaction #1 using paymaster \n`);
  console.log(`User Transaction hash: ${userTransaction.hash}\n`);
  await userTransaction.wait();
  console.log(`Deducted from manager balance in paymaster ${ethers.utils.formatEther(await paymaster.managerBalances(manager.address))} \n`);
  userTransaction = await erc20.connect(user).approve(manager.address, ethers.utils.parseEther("0"),{
    maxFeePerGas: gasPrice,
    gasLimit: gasLimit,
    customData: {
      paymasterParams,
      gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
    }
  });
  console.log(`User successfully sending approve transaction #2 using paymaster \n`);
  console.log(`User Transaction hash: ${userTransaction.hash}\n`);
  await userTransaction.wait();
  console.log(`Deducted from manager balance in paymaster ${ethers.utils.formatEther(await paymaster.managerBalances(manager.address))} \n`);

  const withdrawAmount = await paymaster.managerBalances(manager.address);
  const withdrawAmountLatest = await paymaster.getLatestManagerBalance(manager.address);
  console.log(`Get Latest balance includes refunds to be added: ${withdrawAmountLatest} \n`);
  const withdrawTransaction = await paymaster.withdrawAndRemoveSigners(withdrawAmount, [signer.address]);
  console.log(`Manager calls withdraw with current managerBalance : ${withdrawAmount} and removing signer - Transaction hash: ${withdrawTransaction.hash} \n`);
  await withdrawTransaction.wait();
  const previousRefund = await paymaster.managerBalances(manager.address);
  console.log(`Only previous refund remaining in paymaster manager balance: ${ethers.utils.formatEther(previousRefund)} \n`);

  const withdrawFullTransaction = await paymaster.withdrawFull();
  console.log(`Manager withdraws all funds - Transaction hash: ${withdrawFullTransaction.hash} \n`);
  await withdrawFullTransaction.wait();

  console.log(`Refund amount also withdrawn - Current Balance in paymaster:  ${ethers.utils.formatEther(await paymaster.managerBalances(manager.address))} \n`);
  console.log(`Total balance of paymaster: ${ethers.utils.formatEther(await getProvider().getBalance(paymaster.address))}\n`);
}
