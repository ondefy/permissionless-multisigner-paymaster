import { expect } from "chai";
import { BigNumber, ethers } from "ethers";
import { Contract, Wallet, utils, Provider } from "zksync-ethers";
import * as hre from "hardhat";

import {
    LOCAL_RICH_WALLETS,
    deployContract,
    fundAccount,
    getProvider,
    getUserNonce,
    getWallet,
    getInnerInputs,
    getEIP712Signature,
    executeERC20Transaction,
} from "../utils";
import dotenv from "dotenv";
import { string } from "hardhat/internal/core/params/argumentTypes";
import { zeroPad } from "ethers/lib/utils";
dotenv.config();

const provider = getProvider();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";


describe("PermissionlessPaymaster", () => {
    let zyfi_rescue_wallet: Wallet; // Rescue wallet maintained by Zyfi, Also the deployer
    let Manager1: Wallet; //  Manager with single signer
    let Manager2: Wallet; //  Manager with multple signers
    let Manager3: Wallet; //  Manager as signer itself
    let signer1: Wallet; // Managed by Manager1
    let signer2: Wallet; // Managed by Manager2
    let signer3: Wallet; // Managed by Manager2

    let user1: Wallet;
    let user2: Wallet;

    let currentRefund: BigNumber;
    let paymaster: Contract;
    let greeter: Contract;
    let erc20: Contract;
    const deployPaymaster = async () => {
        paymaster = await deployContract(
            "PermissionlessPaymaster",
            [zyfi_rescue_wallet.address],
            {
                silent: true,
                noVerify: true,
                proxy: false,
                wallet: zyfi_rescue_wallet,
            }
        );
        return paymaster;
    };
    const initializeWallets = () => {
        if (hre.network.name == "zkSyncTestnet") {
            // This means we will need private keys from dotenv -
            zyfi_rescue_wallet = getWallet(process.env.ZYFI_RESCUE_WALLETS);
            Manager1 = getWallet(process.env.MANAGER1);
            Manager2 = getWallet(process.env.MANAGER2);
            Manager3 = getWallet(process.env.MANAGER3);
            signer1 = getWallet(process.env.SIGNER1);
            signer2 = getWallet(process.env.SIGNER2);
            signer3 = getWallet(process.env.SIGNER3);
            user1 = getWallet(process.env.USER1);
            user2 = getWallet(process.env.USER2);
        } else {
            zyfi_rescue_wallet = getWallet(LOCAL_RICH_WALLETS[0].privateKey);
            Manager1 = getWallet(LOCAL_RICH_WALLETS[1].privateKey);
            Manager2 = getWallet(LOCAL_RICH_WALLETS[2].privateKey);
            Manager3 = getWallet(LOCAL_RICH_WALLETS[3].privateKey);
            signer1 = getWallet(LOCAL_RICH_WALLETS[4].privateKey);
            signer2 = getWallet(LOCAL_RICH_WALLETS[5].privateKey);
            signer3 = getWallet(LOCAL_RICH_WALLETS[6].privateKey);
            user1 = getWallet(Wallet.createRandom().privateKey);
            user2 = getWallet(Wallet.createRandom().privateKey);
        }
    };
    before(async () => {
        initializeWallets();
        // Deploy paymaster;
        paymaster = await deployPaymaster();
        console.log("Paymaster address : ", paymaster.address);
        greeter = await deployContract("Greeter", ["Hello World"], {
            silent: true,
            noVerify: true,
            proxy: false,
            wallet: zyfi_rescue_wallet,
        });
        erc20 = await deployContract("MyERC20Token", [], {
            silent: true,
            noVerify: true,
            proxy: false,
            wallet: zyfi_rescue_wallet,
        });
    });
    //// -----------------------------------------------
    //// Deposit Functions Test
    //// -----------------------------------------------

    describe("Deposit functions test", async () => {
        it("should deposit funds in paymaster", async () => {
            await paymaster
                .connect(Manager1)
                .deposit({ value: ethers.utils.parseEther("0.1") });
            await paymaster
                .connect(Manager2)
                .deposit({ value: ethers.utils.parseEther("0.1") });
            expect(
                (await paymaster.managerBalances(Manager1.address)).toString()
            ).to.be.eq(ethers.utils.parseEther("0.1").toString());
            expect(
                (await paymaster.managerBalances(Manager2.address)).toString()
            ).to.be.eq(ethers.utils.parseEther("0.1").toString());
        });

        it("should deposit funds and add signer", async () => {
            await paymaster
                .connect(Manager1)
                .depositAndAddSigner(signer1.address, {
                    value: ethers.utils.parseEther("0.1"),
                });
            await paymaster
                .connect(Manager2)
                .depositAndAddSigner(signer2.address, {
                    value: ethers.utils.parseEther("0.1"),
                });
            await paymaster.connect(Manager2).depositAndAddSigner(signer3.address, {
                value: ethers.utils.parseEther("0.1"),
            });
            await paymaster
                .connect(Manager3)
                .depositAndAddSigner(Manager3.address, {
                    value: ethers.utils.parseEther("0.1"),
                });
            // Expected failure
            await expect(
                paymaster
                    .connect(Manager2)
                    .depositAndAddSigner(signer1.address, {
                        value: ethers.utils.parseEther("0.1"),
                    })
            ).to.be.rejectedWith("0xdbae7908");
            await expect(
                paymaster
                    .connect(Manager2)
                    .depositAndAddSigner(ZERO_ADDRESS, {
                        value: ethers.utils.parseEther("0.1"),
                    })
            ).to.be.rejectedWith("0x02876945");
            await expect(
                paymaster
                    .connect(Manager3)
                    .depositAndAddSigner(Manager3.address, {
                        value: ethers.utils.parseEther("0.1"),
                    })
            ).to.be.rejectedWith("0xdbae7908");
        });
        it("should deposit on behalf", async () => {
            const balanceBefore = await paymaster.managerBalances(Manager3.address);
            await paymaster
                .connect(zyfi_rescue_wallet)
                .depositOnBehalf(Manager3.address, {
                    value: ethers.utils.parseEther("0.1"),
                });
            const balanceAfter = await paymaster.managerBalances(Manager3.address);
            expect(balanceAfter.sub(balanceBefore)).to.be.equal(
                ethers.utils.parseEther("0.1")
            );
            await expect(
                paymaster
                    .connect(zyfi_rescue_wallet)
                    .depositOnBehalf(ZERO_ADDRESS, {
                        value: ethers.utils.parseEther("0.1"),
                    })
            ).to.be.rejectedWith("0x02876945");
        });
    });

    //// -----------------------------------------------
    //// Paymaster Transaction and Signature Tests
    //// -----------------------------------------------


    describe("Paymaster validations test", async () => {
        it("should validate and pay for the transaction", async () => {
            const balanceBefore = await erc20.balanceOf(user1.address);
            const tx = await executeERC20Transaction(
                erc20,
                paymaster,
                provider,
                user1,
                signer1
            );
            //console.log(tx.events.at(-1).args.value);
            currentRefund = tx.events.at(-1).args.value;
            const balanceAfter = await erc20.balanceOf(user1.address);
            const refundAddress = await paymaster.previousManager();
            expect(balanceAfter.sub(balanceBefore)).to.be.eq(BigNumber.from(5));
            expect(refundAddress).to.be.eq(await paymaster.managers(signer1.address));
        });
        it("should calculate refund correctly", async () => {
            const currentBalance = await provider.getBalance(paymaster.address);
            const previousBalance = await paymaster.previousTotalBalance();
            expect(currentRefund).to.be.equal(currentBalance.sub(previousBalance));
            const beforeManagerBalance = await paymaster.managerBalances(
                Manager1.address
            );
            const tx = await executeERC20Transaction(
                erc20,
                paymaster,
                provider,
                user1,
                signer2
            );
            const afterManagerBalance = await paymaster.managerBalances(
                Manager1.address
            );
            expect(afterManagerBalance.sub(beforeManagerBalance)).to.be.eq(
                currentRefund
            );
            expect(await paymaster.previousManager()).to.be.eq(
                await paymaster.managers(signer2.address)
            );
            currentRefund = tx.events.at(-1).args.value;
        });

        it("should only be called by bootloader", async () => {
            await expect(
                paymaster.validateAndPayForPaymasterTransaction(
                    ethers.utils.formatBytes32String("0"),
                    ethers.utils.formatBytes32String("0"),
                    [
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        0,
                        [0, 0, 0, 0],
                        ethers.utils.formatBytes32String("0"),
                        ethers.utils.formatBytes32String("0"),
                        [ethers.utils.formatBytes32String("0")],
                        ethers.utils.formatBytes32String("0"),
                        ethers.utils.formatBytes32String("0"),
                    ]
                )
            ).to.be.rejectedWith("0xae917251");
        });

        it("should only allow general flow", async () => {
            await expect(
                executeERC20Transaction(erc20, paymaster, provider, user1, signer2, {
                    type: "approval",
                })
            ).to.be.rejectedWith("0xa6eb6873");
        });

        it("should reject incorrect paymaster input", async () => {
            await expect(
                executeERC20Transaction(erc20, paymaster, provider, user1, signer2, {
                    invalidInnerInput: true,
                })
            ).to.be.rejectedWith("0x");
        });

        it("should not allow expired signature", async () => {
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, signer1,
                {
                    expiredtx: true
                }
            )).to.be.rejectedWith("0x1f731be8");
        });

        it("should not allow expired nonce", async () => {
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, signer1,
                {
                    usedNonce: true
                }
            )).to.be.rejectedWith("0xc607a643");
        });

        it("should not allow invalid signature", async () => {
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, signer1,
                {
                    invalidSignature: true
                }
            )).to.be.rejectedWith("0x2d4b72a2");
        });

        it("should not allow signers that are not registered", async () => {
            // zyfi_rescue_wallet is not registered
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, zyfi_rescue_wallet)).to.be.rejectedWith("0x81c0c5d4");
        });

        it("should not allow to proceed with insufficient manager balance", async () => {
            const currentBalance = await paymaster.managerBalances(Manager1.address);
            await paymaster.connect(Manager1).withdraw(currentBalance.sub(100));
            // Currently is sufficient balance of Manager1
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, signer1)).to.be.rejectedWith("0x9625287c");
            expect(await paymaster.managerBalances(Manager1.address)).to.be.eq(BigNumber.from("100"));
            // For upcoming test
            await paymaster.connect(Manager1).deposit({value: currentBalance.sub(100)});
        });

        it("should allow manager with multiple added signer to work as expected", async () => {
            const beforeBalance = await paymaster.managerBalances(Manager2.address);
            const gasPrice1 = await provider.getGasPrice();
            const tx1 = await expect(executeERC20Transaction(erc20, paymaster, provider, user1, signer2)).not.to.be.rejected;
            const afterBalance1 = await paymaster.managerBalances(Manager2.address);
            const gasPrice2 = await provider.getGasPrice();
            currentRefund = tx1.events.at(-1).args.value;
            const tx2 = await expect(executeERC20Transaction(erc20, paymaster, provider, user1, signer3)).not.to.be.rejected;
            const afterBalance2 = await paymaster.managerBalances(Manager2.address);
            expect(beforeBalance.sub(gasPrice1.mul(BigNumber.from("10000000")))).to.be.equal(afterBalance1);
            expect(afterBalance1.add(currentRefund).sub(gasPrice2.mul(BigNumber.from("10000000")))).to.be.equal(afterBalance2);
            expect(await paymaster.previousManager()).to.be.equal(Manager2.address);
        });

        it("should allow manager as a signer to use paymaster as expected", async () => {
            const beforeBalance = await paymaster.managerBalances(Manager3.address);
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, Manager3)).not.to.be.rejected;
            expect(await paymaster.managerBalances(Manager3.address)).to.be.lessThan(beforeBalance);
        });
    });
    describe("Manager functionalities tests", async() => {
        let newSigner = Wallet.createRandom();
        let newSigner1 = Wallet.createRandom();
        let newSigner2 = Wallet.createRandom();
        it("should add signer correctly", async ()=> {
            const tx = await (await paymaster.connect(Manager1).addSigner(newSigner.address)).wait();
            expect(tx.events[2].event).to.be.equal("SignerAdded");
            expect(await paymaster.managers(newSigner.address)).to.be.equal(Manager1.address);
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, newSigner)).not.to.be.rejected;
            // Failure test
            await expect(paymaster.connect(Manager1).addSigner(ZERO_ADDRESS)).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager1).addSigner(newSigner.address)).to.be.rejectedWith("0xdbae7908");
            await expect(paymaster.connect(Manager1).addSigner(signer3.address)).to.be.rejectedWith("0xdbae7908");
        });
        it("should batch add signers correctly", async () => {
            //console.log(newSigner1,newSigner2);
            const tx = await (await paymaster.connect(Manager1).batchAddSigners([newSigner1.address.toString(), newSigner2.address.toString()])).wait();
            expect(tx.events.at(2).event).to.be.equal("SignerAdded");
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, newSigner1)).not.to.be.rejected;
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, newSigner2)).not.to.be.rejected;
            // Failure test
            await expect(paymaster.connect(Manager1).batchAddSigners([ZERO_ADDRESS, ZERO_ADDRESS])).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager1).batchAddSigners([newSigner1.address, ZERO_ADDRESS])).to.be.rejectedWith("0xdbae7908");
            await expect(paymaster.connect(Manager1).batchAddSigners([signer3.address, newSigner1.address])).to.be.rejectedWith("0xdbae7908");

            
        });
        it("should replace signer correctly", async () => {
            const newSigner = Wallet.createRandom();
            await expect(executeERC20Transaction(erc20,paymaster, provider, user1, signer2)).not.to.be.rejected;
            await paymaster.connect(Manager2).replaceSigner(signer2.address, newSigner.address);
            await expect(executeERC20Transaction(erc20,paymaster, provider, user1, signer2)).to.be.rejectedWith("0x81c0c5d4");
            await expect(executeERC20Transaction(erc20,paymaster, provider, Manager1, newSigner)).not.to.be.rejected;
            expect(await paymaster.managers(signer2.address)).to.be.equal(ZERO_ADDRESS);
            await paymaster.connect(Manager2).replaceSigner(newSigner.address, signer2.address);
            // Failure test
            await expect(executeERC20Transaction(erc20,paymaster, provider, user1, newSigner)).to.be.rejectedWith("0x81c0c5d4");
            await expect(paymaster.connect(Manager2).replaceSigner(signer2.address, ZERO_ADDRESS)).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager2).replaceSigner(ZERO_ADDRESS, newSigner.address)).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager2).replaceSigner(signer1.address, newSigner.address)).to.be.rejectedWith("0xce37a54d");
            await expect(paymaster.connect(Manager2).replaceSigner(signer2.address, signer1.address)).to.be.rejectedWith("0xdbae7908");
        });
        it("should remove signer correctly", async () => {
            const tx = await (await paymaster.connect(Manager1).removeSigner(newSigner.address)).wait();
            expect(tx.events[2].event).to.be.equal("SignerRemoved");
            expect(await paymaster.managers(newSigner.address)).to.be.equal(ZERO_ADDRESS);
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, newSigner)).to.be.rejectedWith("0x81c0c5d4");
            // Failure test
            await expect(paymaster.connect(Manager1).removeSigner(ZERO_ADDRESS)).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager1).removeSigner(newSigner.address)).to.be.rejectedWith("0xce37a54d");
            await expect(paymaster.connect(Manager1).removeSigner(signer3.address)).to.be.rejectedWith("0xce37a54d");
        });
        it("should batch remove signers correctly", async () => {
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, newSigner1)).not.to.be.rejected;
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, newSigner2)).not.to.be.rejected;
            const tx = await (await paymaster.connect(Manager1).batchRemoveSigners([newSigner1.address.toString(), newSigner2.address.toString()])).wait();
            expect(tx.events.at(2).event).to.be.equal("SignerRemoved");
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, newSigner1)).to.be.rejectedWith("0x81c0c5d4");
            await expect(executeERC20Transaction(erc20, paymaster, provider, user1, newSigner2)).to.be.rejectedWith("0x81c0c5d4");
            // Failure test
            await expect(paymaster.connect(Manager1).batchRemoveSigners([ZERO_ADDRESS, ZERO_ADDRESS])).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager1).batchRemoveSigners([newSigner1.address, ZERO_ADDRESS])).to.be.rejectedWith("0xce37a54d");
            await expect(paymaster.connect(Manager1).batchRemoveSigners([signer3.address, newSigner1.address])).to.be.rejectedWith("0xce37a54d");
        })
    });
    //// -----------------------------------------------
    //// Withdraw Functions Test
    //// -----------------------------------------------
    describe("Withdraw Functions test", async ()=> {
        it("should withdraw funds correctly and updateRefund correctly", async() => {
            const previousTotalBalance = await paymaster.previousTotalBalance();
            const paymasterEthBalance = await provider.getBalance(paymaster.address);
            const previousRefund = paymasterEthBalance.sub(previousTotalBalance);
            const balanceInPaymaster = await paymaster.managerBalances(Manager1.address);
            const ethBalance = await provider.getBalance(Manager1.address);
            await expect(paymaster.connect(Manager1).withdraw(balanceInPaymaster.add(previousRefund).add(1))).to.be.rejectedWith("0x4e487b71"); // Panic error
            await expect(paymaster.connect(Manager1).withdraw(0)).not.to.be.rejected;
            const gasPrice = await provider.getGasPrice();
            const tx = await (await paymaster.connect(Manager1).withdraw(balanceInPaymaster)).wait();
            expect(await provider.getBalance(Manager1.address)).to.be.greaterThan((ethBalance).add(balanceInPaymaster).add(previousRefund).sub(ethers.utils.parseEther("0.0003"))); // gas
        });
        it("should withdraw full funds correctly", async () => {
            const balanceInPaymaster = await paymaster.managerBalances(Manager3.address);
            const ethBalance = await paymaster.managerBalances(Manager3.address);
            await expect(paymaster.connect(Manager3).withdrawFull()).not.to.be.rejected;
            expect(await provider.getBalance(Manager3.address)).to.be.greaterThan((ethBalance).add(balanceInPaymaster).sub(ethers.utils.parseEther("0.0003")));
   
        });
        it("should withdraw and remove signers correctly", async () => {
            const balanceInPaymaster = await paymaster.managerBalances(Manager2.address);
            const ethBalance = await provider.getBalance(Manager2.address);
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(balanceInPaymaster.add(1),[signer2.address])).to.be.rejectedWith("0x4e487b71");
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(balanceInPaymaster.sub(1000),[])).not.to.be.rejected;
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(1000,[signer2.address])).not.to.be.rejected;
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(0,[signer3.address])).not.to.be.rejected;
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(1,[])).to.be.rejectedWith("0x4e487b71");

            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(0,[ZERO_ADDRESS])).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(0,[signer1.address])).to.be.rejectedWith("0xce37a54d");
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(0, [signer3.address])).to.be.rejectedWith("0xce37a54d");
        });
    });

    describe("Rescue Wallet tests", async () => {
        it("Initial parameters are correctly set", async () => {
            expect(await paymaster.ZYFI_RESCUE_ADDRESS()).to.be.equal(
                zyfi_rescue_wallet.address
            );
        });
        it("Rescue wallet update test", async () => {
            await expect(
                paymaster.connect(Manager1).updateRescueAddress(Manager1.address)
            ).to.be.rejectedWith("0x5001df4c");
            await paymaster
                .connect(zyfi_rescue_wallet)
                .updateRescueAddress(Manager2.address);
            expect(await paymaster.ZYFI_RESCUE_ADDRESS()).to.be.equal(
                Manager2.address
            );
        });
        it("Should rescue dropped token", async () => {
            await erc20.connect(Manager1).transfer(paymaster.address,5);
            expect(await erc20.balanceOf(paymaster.address)).to.be.equal(5);
            await expect(paymaster.connect(Manager2).rescueTokens([erc20.address, ZERO_ADDRESS])).to.be.revertedWith("0x02876945");
        });
    });
});
