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
import { DEFAULT_GAS_PER_PUBDATA_LIMIT } from "zksync-ethers/build/utils";
dotenv.config();

const provider = getProvider();
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const abiCoder = new ethers.utils.AbiCoder();

describe("PermissionlessPaymaster", () => {
    let zyfi_dao_manager: Wallet; // Rescue wallet maintained by Zyfi, Also the deployer
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
    let erc20: Contract;
    const deployPaymaster = async () => {
        paymaster = await deployContract(
            "PermissionlessPaymaster",
            [zyfi_dao_manager.address],
            {
                silent: true,
                noVerify: true,
                proxy: false,
                wallet: zyfi_dao_manager,
            }
        );
        return paymaster;
    };
    const getPaymasterParams = async (paymaster: Contract, from: Wallet, signer: Wallet) => {
        const gasPrice = await provider.getGasPrice();
        const sig = await getEIP712Signature(from.address, paymaster.address, BigNumber.from(10000000000000), BigNumber.from(1000), gasPrice, BigNumber.from(10000000), signer, paymaster);
        const innerInputs = getInnerInputs(BigNumber.from(10000000000000), BigNumber.from(1000), signer.address, sig);
        const paymasterParams = utils.getPaymasterParams(
            paymaster.address.toString(),
            {
                type: "General",
                innerInput: innerInputs
            }
        );
        return [paymasterParams, gasPrice];

    };
    const initializeWallets = () => {
        if (hre.network.name == "zkSyncTestnet") {
            // This means we will need private keys from dotenv -
            zyfi_dao_manager = getWallet(process.env.zyfi_dao_managerS);
            Manager1 = getWallet(process.env.MANAGER1);
            Manager2 = getWallet(process.env.MANAGER2);
            Manager3 = getWallet(process.env.MANAGER3);
            signer1 = getWallet(process.env.SIGNER1);
            signer2 = getWallet(process.env.SIGNER2);
            signer3 = getWallet(process.env.SIGNER3);
            user1 = getWallet(process.env.USER1);
            user2 = getWallet(process.env.USER2);
        } else {
            zyfi_dao_manager = getWallet(LOCAL_RICH_WALLETS[0].privateKey);
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

        erc20 = await deployContract("MyERC20Token", [], {
            silent: true,
            noVerify: true,
            proxy: false,
            wallet: zyfi_dao_manager,
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
                .connect(zyfi_dao_manager)
                .depositOnBehalf(Manager3.address, {
                    value: ethers.utils.parseEther("0.1"),
                });
            const balanceAfter = await paymaster.managerBalances(Manager3.address);
            expect(balanceAfter.sub(balanceBefore)).to.be.equal(
                ethers.utils.parseEther("0.1")
            );
            await expect(
                paymaster
                    .connect(zyfi_dao_manager)
                    .depositOnBehalf(ZERO_ADDRESS, {
                        value: ethers.utils.parseEther("0.1"),
                    })
            ).to.be.rejectedWith("0x02876945");
        });
        it("should maintain previousManager & previousTotalBalance initial state", async () => {
            expect(await paymaster.previousManager()).to.be.eq(ZERO_ADDRESS);
            expect(await paymaster.previousTotalBalance()).to.be.eq(await provider.getBalance(paymaster.address));
            expect(await paymaster.managerBalances(ZERO_ADDRESS)).to.be.eq(BigNumber.from(0));
            await paymaster.connect(Manager2).withdraw(ethers.utils.parseEther("0.1"));
            expect(await paymaster.previousTotalBalance()).to.be.eq(await provider.getBalance(paymaster.address));
            expect(await paymaster.previousTotalBalance()).to.be.eq(await provider.getBalance(paymaster.address));
            expect(await paymaster.managerBalances(ZERO_ADDRESS)).to.be.eq(BigNumber.from(0));
            // Back to original state
            await paymaster.connect(Manager2).deposit({ value: ethers.utils.parseEther("0.1") });
            expect(await paymaster.previousTotalBalance()).to.be.eq(await provider.getBalance(paymaster.address));
            expect(await paymaster.managerBalances(ZERO_ADDRESS)).to.be.eq(BigNumber.from(0));
        });
    });

    //// -----------------------------------------------
    //// Update Refunds Test 
    //// -----------------------------------------------

    describe("Update refund test", async () => {
        let previousTotalBalance;
        let currentPaymasterBalance;
        let previousPaymasterBalance;
        let tx: any;
        let eventData;
        let txCost;

        it("should calculate refunds and update balance correctly including deposit and withdraw functions", async () => {
            // Manager1 uses paymaster
            previousPaymasterBalance = await provider.getBalance(paymaster.address);
            let balanceBeforeM1 = await paymaster.managerBalances(Manager1.address);
            tx = await executeERC20Transaction(erc20, paymaster, user1, signer1);
            eventData = abiCoder.decode(["uint256","uint256"],(tx.events.at(0).data));
            txCost = eventData[0].add(eventData[1]);
            const refund1 = BigNumber.from(tx.events.at(-1).data);
            currentPaymasterBalance = await provider.getBalance(paymaster.address)
            previousTotalBalance = await paymaster.previousTotalBalance();
            expect(await paymaster.previousManager()).to.be.eq(Manager1.address);
            expect(previousTotalBalance).to.be.equal(previousPaymasterBalance.sub(txCost));
            expect(await paymaster.managerBalances(Manager1.address)).to.be.eq(balanceBeforeM1.sub(txCost));
            expect(currentPaymasterBalance).to.be.eq(previousPaymasterBalance.sub(txCost).add(refund1));
            expect(currentPaymasterBalance.sub(previousTotalBalance)).to.be.eq(refund1);

            // Manager2 uses paymaster with 2 signers, Manager1 get refunds. 
            balanceBeforeM1 = await paymaster.managerBalances(Manager1.address);
            let balanceBeforeM2 = await paymaster.managerBalances(Manager2.address);
            previousPaymasterBalance = currentPaymasterBalance;
            tx = await executeERC20Transaction(erc20, paymaster, user1, signer2);
            eventData = abiCoder.decode(["uint256","uint256"],(tx.events.at(0).data));
            txCost = eventData[0].add(eventData[1]);
            const refund2 = BigNumber.from(tx.events.at(-1).data);
            currentPaymasterBalance = await provider.getBalance(paymaster.address);
            previousTotalBalance = await paymaster.previousTotalBalance();
            expect(await paymaster.previousManager()).to.be.equal(Manager2.address);
            expect(await paymaster.managerBalances(Manager1.address)).to.be.eq(balanceBeforeM1.add(refund1));
            expect(previousTotalBalance).to.be.equal(previousPaymasterBalance.sub(txCost));
            expect(await paymaster.managerBalances(Manager2.address)).to.be.eq(balanceBeforeM2.sub(txCost));
            expect(currentPaymasterBalance).to.be.eq(previousPaymasterBalance.sub(txCost).add(refund2));
            expect(currentPaymasterBalance.sub(previousTotalBalance)).to.be.eq(refund2);

            // Manager3 deposits/withdraws paymaster and it should update correctly. 
            balanceBeforeM2 = await paymaster.managerBalances(Manager2.address);
            let balanceBeforeM3 = await paymaster.managerBalances(Manager3.address);
            previousPaymasterBalance = currentPaymasterBalance;
            tx = await paymaster.connect(Manager3).deposit({ value: ethers.utils.parseEther("0.1") });
            currentPaymasterBalance = await provider.getBalance(paymaster.address);
            expect(await paymaster.previousManager()).to.be.equal(Manager2.address); // previous manager should not change in deposit
            expect(await paymaster.managerBalances(Manager2.address)).to.be.eq(balanceBeforeM2.add(refund2));
            expect(await paymaster.managerBalances(Manager3.address)).to.be.eq(balanceBeforeM3.add(ethers.utils.parseEther("0.1")));
            // If now paymaster is called it should not update previousManager balance; i.e.manager2 balance
            previousTotalBalance = await paymaster.previousTotalBalance();
            balanceBeforeM2 = await paymaster.managerBalances(Manager2.address);
            tx = await paymaster.connect(Manager3).withdraw(ethers.utils.parseEther("0.1"));
            expect(await paymaster.managerBalances(Manager2.address)).to.be.eq(balanceBeforeM2);
            expect(await paymaster.previousTotalBalance()).to.be.equal(previousTotalBalance.sub(ethers.utils.parseEther("0.1")));

            // validate function should not also update the balance of previous manager
            balanceBeforeM2 = await paymaster.managerBalances(Manager2.address);
            balanceBeforeM3 = await paymaster.managerBalances(Manager3.address);
            tx = await executeERC20Transaction(erc20, paymaster, user1, Manager3);
            eventData = abiCoder.decode(["uint256","uint256"],(tx.events.at(0).data));
            txCost = eventData[0].add(eventData[1]);
            const refund3 = BigNumber.from(tx.events.at(-1).data);
            currentPaymasterBalance = await provider.getBalance(paymaster.address);
            previousTotalBalance = await paymaster.previousTotalBalance();
            expect(await paymaster.previousManager()).to.be.equal(Manager3.address);
            expect(await paymaster.managerBalances(Manager2.address)).to.be.eq(balanceBeforeM2);
            expect(previousTotalBalance).to.be.equal(previousPaymasterBalance.sub(txCost));
            expect(await paymaster.managerBalances(Manager3.address)).to.be.eq(balanceBeforeM3.sub(txCost));
            expect(currentPaymasterBalance).to.be.eq(previousPaymasterBalance.sub(txCost).add(refund3));
            expect(currentPaymasterBalance.sub(previousTotalBalance)).to.be.eq(refund3);

            // Manager 3 refund correctly on withdraw
            previousTotalBalance = await paymaster.previousTotalBalance();
            previousPaymasterBalance = currentPaymasterBalance;
            balanceBeforeM3 = await paymaster.managerBalances(Manager3.address);
            tx = await paymaster.connect(Manager3).withdraw(ethers.utils.parseEther("0.01"));
            currentPaymasterBalance = await provider.getBalance(paymaster.address);
            expect(await paymaster.managerBalances(Manager3.address)).to.be.eq(balanceBeforeM3.sub(ethers.utils.parseEther("0.01")).add(refund3));
            expect(await paymaster.previousTotalBalance()).to.be.eq(previousTotalBalance.sub(ethers.utils.parseEther("0.01")).add(refund3));
            expect(currentPaymasterBalance).to.be.eq(previousPaymasterBalance.sub(ethers.utils.parseEther("0.01")));
            expect(await paymaster.previousTotalBalance()).to.be.eq(currentPaymasterBalance);

        });

        it("should update refunds correctly during deposit and withdraw using paymaster itself", async () => {
            // There is no refund remaining right now. 
            previousTotalBalance = await paymaster.previousTotalBalance();
            currentPaymasterBalance = await provider.getBalance(paymaster.address);
            expect(previousTotalBalance).to.be.eq(currentPaymasterBalance);

            // Paymaster call 
            tx = await executeERC20Transaction(erc20, paymaster, user1, signer1);
            eventData = abiCoder.decode(["uint256","uint256"],(tx.events.at(0).data));
            txCost = eventData[0].add(eventData[1]);
            const refund1 = BigNumber.from(tx.events.at(-1).data);
            previousTotalBalance = await paymaster.previousTotalBalance();
            currentPaymasterBalance = await provider.getBalance(paymaster.address);
            expect(currentPaymasterBalance.sub(previousTotalBalance)).to.be.eq(refund1);
            expect(await paymaster.previousManager()).to.be.eq(Manager1.address);
            // Manager 1 has refund remaining as of now. 
            // Deposit is being called from paymaster itself. 
            let beforeBalanceM1 = await paymaster.managerBalances(Manager1.address);
            let [paymasterParams, gasPrice] = await getPaymasterParams(paymaster, Manager1, signer1);
            tx = await (await paymaster.connect(Manager1).deposit({
                value: ethers.utils.parseEther("0.1"),
                maxPriorityFeePerGas: BigNumber.from(0),
                maxFeePerGas: gasPrice,
                gasLimit: 10000000,
                customData: {
                    paymasterParams,
                    gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
                }
            })).wait();

            eventData = abiCoder.decode(["uint256","uint256"],(tx.events.at(0).data));
            txCost = eventData[0].add(eventData[1]);
            const refund2 = BigNumber.from(tx.events.at(-1).data);
            currentPaymasterBalance = await provider.getBalance(paymaster.address);
            expect(await paymaster.managerBalances(Manager1.address)).to.be.eq(beforeBalanceM1.sub(txCost).add(ethers.utils.parseEther("0.1")).add(refund1));
            expect(await paymaster.previousTotalBalance()).to.be.eq(previousTotalBalance.add(refund1).sub(txCost).add(ethers.utils.parseEther("0.1")));
            expect(currentPaymasterBalance.sub(await paymaster.previousTotalBalance())).to.be.eq(refund2);
            // Manager 1 has refund remaining. Manager2 will call withdraw() using paymaster
            // Refund should be done correctly. PreviousManager should be updated to manager2

            previousPaymasterBalance = await provider.getBalance(paymaster.address);
            previousTotalBalance = await paymaster.previousTotalBalance();
            beforeBalanceM1 = await paymaster.managerBalances(Manager1.address);
            let balanceBeforeM2 = await paymaster.managerBalances(Manager2.address);
            [paymasterParams, gasPrice] = await getPaymasterParams(paymaster, Manager2, signer2);
            tx = await (await paymaster.connect(Manager2).withdraw(ethers.utils.parseEther("0.1"), {
                maxPriorityFeePerGas: BigNumber.from(0),
                maxFeePerGas: gasPrice,
                gasLimit: 10000000,
                customData: {
                    paymasterParams,
                    gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
                }
            })).wait();
            eventData = abiCoder.decode(["uint256","uint256"],(tx.events.at(0).data));
            txCost = eventData[0].add(eventData[1]);
            const refund3 = BigNumber.from(tx.events.at(-1).data);
            currentPaymasterBalance = await provider.getBalance(paymaster.address);
            expect(await paymaster.previousManager()).to.be.eq(Manager2.address);
            expect(await paymaster.managerBalances(Manager1.address)).to.be.eq(beforeBalanceM1.add(refund2));
            expect(await paymaster.previousTotalBalance()).to.be.eq(previousTotalBalance.add(refund2).sub(txCost).sub(ethers.utils.parseEther("0.1")));
            expect(currentPaymasterBalance.sub(await paymaster.previousTotalBalance())).to.be.eq(refund3);
            // Expect refunds to be completed
            await paymaster.connect(Manager2).deposit({ value: ethers.utils.parseEther("0.1") });
            expect(await paymaster.previousTotalBalance()).to.be.eq(await provider.getBalance(paymaster.address));

            // Expect no change in Manager2 balance because refund is completed. 
            balanceBeforeM2 = await paymaster.managerBalances(Manager2.address);
            await executeERC20Transaction(erc20, paymaster, user1, signer1);
            expect(await paymaster.managerBalances(Manager2.address)).to.be.eq(balanceBeforeM2);
        });
    });

    //// -----------------------------------------------
    //// Invalid Signature & Gas Estimation Test
    //// -----------------------------------------------

    describe("Gas estimate test", async () => {
        it("should not decrease ETH balance on invalid signature", async () => {
            const balanceBefore = await provider.getBalance(paymaster.address);
            await expect(executeERC20Transaction(erc20, paymaster, user1, signer1,
                {
                    invalidSignature: true
                }
            )).to.be.rejected;
            const balanceAfter = await provider.getBalance(paymaster.address);
            await expect(balanceAfter).to.be.equal(balanceBefore);
        });
        it("should estimate gas correctly", async () => {
            const gasEstimate_CorrectSig = await executeERC20Transaction(erc20, paymaster, user1, signer1, {
                estimateGas: true,
            });
            const gasEstimate_InCorrectSig = await executeERC20Transaction(erc20, paymaster, user1, signer1, {
                invalidSignature: true,
                estimateGas: true,
            });
            expect(gasEstimate_CorrectSig).to.be.greaterThanOrEqual(gasEstimate_InCorrectSig);
        })
    });

    //// -----------------------------------------------
    //// Paymaster Transaction and Signature Test
    //// -----------------------------------------------

    describe("Paymaster validations test", async () => {
        it("should validate and pay for the transaction", async () => {
            const balanceBefore = await erc20.balanceOf(user1.address);
            const tx = await executeERC20Transaction(
                erc20,
                paymaster,
                user1,
                signer1
            );
            //console.log(user1.address);
            //console.log(tx.events);
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
                executeERC20Transaction(erc20, paymaster, user1, signer2, {
                    type: "approval",
                })
            ).to.be.rejectedWith("0xa6eb6873");
        });

        it("should reject incorrect paymaster input", async () => {
            await expect(
                executeERC20Transaction(erc20, paymaster, user1, signer2, {
                    invalidInnerInput: true,
                })
            ).to.be.rejectedWith("0x");
        });

        it("should not allow expired signature", async () => {
            await expect(executeERC20Transaction(erc20, paymaster, user1, signer1,
                {
                    expiredtx: true
                }
            )).to.be.rejectedWith("0x1f731be8");
        });

        it("should not allow expired nonce", async () => {
            await expect(executeERC20Transaction(erc20, paymaster, user1, signer1,
                {
                    usedNonce: true
                }
            )).to.be.rejectedWith("0xc607a643");
        });

        it("should not allow invalid signature", async () => {
            await expect(executeERC20Transaction(erc20, paymaster, user1, signer1,
                {
                    invalidSignature: true
                }
            )).to.be.rejected;
        });

        it("should not allow signers that are not registered", async () => {
            // zyfi_dao_manager is not registered
            await expect(executeERC20Transaction(erc20, paymaster, user1, zyfi_dao_manager)).to.be.rejectedWith("0x81c0c5d4");
        });

        it("should not allow to proceed with insufficient manager balance", async () => {
            const currentBalance = await paymaster.managerBalances(Manager1.address);
            await paymaster.connect(Manager1).withdraw(currentBalance.sub(100));
            // Currently is sufficient balance of Manager1
            await expect(executeERC20Transaction(erc20, paymaster, user1, signer1)).to.be.rejectedWith("0x9625287c");
            expect(await paymaster.managerBalances(Manager1.address)).to.be.eq(BigNumber.from("100"));
            // For upcoming test
            await paymaster.connect(Manager1).deposit({ value: currentBalance.sub(100) });
        });

        it("should allow manager with multiple added signer to work as expected", async () => {
            const beforeBalance = await paymaster.managerBalances(Manager2.address);
            const gasPrice1 = await provider.getGasPrice();
            const tx1 = await expect(executeERC20Transaction(erc20, paymaster, user1, signer2)).not.to.be.rejected;
            const afterBalance1 = await paymaster.managerBalances(Manager2.address);
            const gasPrice2 = await provider.getGasPrice();
            currentRefund = tx1.events.at(-1).args.value;
            const tx2 = await expect(executeERC20Transaction(erc20, paymaster, user1, signer3)).not.to.be.rejected;
            const afterBalance2 = await paymaster.managerBalances(Manager2.address);
            expect(beforeBalance.sub(gasPrice1.mul(BigNumber.from("10000000")))).to.be.equal(afterBalance1);
            expect(afterBalance1.add(currentRefund).sub(gasPrice2.mul(BigNumber.from("10000000")))).to.be.equal(afterBalance2);
            expect(await paymaster.previousManager()).to.be.equal(Manager2.address);
        });

        it("should allow manager as a signer to use paymaster as expected", async () => {
            const beforeBalance = await paymaster.managerBalances(Manager3.address);
            await expect(executeERC20Transaction(erc20, paymaster, user1, Manager3)).not.to.be.rejected;
            expect(await paymaster.managerBalances(Manager3.address)).to.be.lessThan(beforeBalance);
        });
    });

    //// -----------------------------------------------
    //// Markup cost and Zyfi dao balance test
    //// -----------------------------------------------

    describe("Paymaster markup charge test", async () => {
        it("should only allow Dao manager to update markup percent", async () => {
            const prevMarkupPercent = await paymaster.markupPercent();
            await expect(paymaster.connect(Manager1).updateMarkupPercent(100)).to.be.rejectedWith("0x5001df4c");
            await expect(paymaster.connect(zyfi_dao_manager).updateMarkupPercent(100000)).to.be.rejectedWith("0x5001df4c");
            await expect(paymaster.connect(zyfi_dao_manager).updateMarkupPercent(1000)).not.to.be.rejected;
            expect(await paymaster.markupPercent()).not.to.be.equal(prevMarkupPercent);
            expect(await paymaster.markupPercent()).to.be.equal(1000);
        });
        it("should deduct markup cost correctly with view function test", async () => {
            const daoAddress = await paymaster.zyfi_dao_manager();
            const markupPercent = await paymaster.markupPercent()
            const daoBalance = await paymaster.managerBalances(daoAddress);
            let tx = await executeERC20Transaction(
                erc20,
                paymaster,
                user1,
                signer1
            );
            let eventData = tx.events.at(0).data;
            let eventDataDecoded = abiCoder.decode(["uint256","uint256"],eventData);
            let txCost = eventDataDecoded[0];
            const markUpCost1 = eventDataDecoded[1];  
            expect(await paymaster.managerBalances(daoAddress)).to.be.eq(daoBalance.add(markUpCost1));
            expect(markUpCost1).to.be.equal(txCost.mul(markupPercent).div(10000));
            // Changing markupPercent
            await paymaster.connect(zyfi_dao_manager).updateMarkupPercent(5000);
            const newMarkupPercent = await paymaster.markupPercent();
            tx = await executeERC20Transaction(
                erc20,
                paymaster,
                user1,
                signer1
            );
            eventData = tx.events.at(0).data;
            eventDataDecoded = abiCoder.decode(["uint256","uint256"],eventData);
            txCost = eventDataDecoded[0];
            const markUpCost2 = eventDataDecoded[1]; 
            expect(await paymaster.managerBalances(daoAddress)).to.be.eq(daoBalance.add(markUpCost1).add(markUpCost2));
            expect(markUpCost2).to.be.eq(txCost.mul(newMarkupPercent).div(10000));
            
            // View functions test 
            const previousTotalBalance = await paymaster.previousTotalBalance();
            const currentBalance = await provider.getBalance(paymaster.address);
            const refund = currentBalance.sub(previousTotalBalance);
            const manager1Balance = await paymaster.managerBalances(Manager1.address);
            expect(await paymaster.getLatestManagerBalance(Manager1.address)).to.be.eq(manager1Balance.add(refund));
            expect(await paymaster.getLatestManagerBalanceViaSigner(signer1.address)).to.be.eq(manager1Balance.add(refund));

        });
        it("should not deduct markup more than 100%", async() => {
            const daoAddress = await paymaster.zyfi_dao_manager();
            const daoBalance = await paymaster.managerBalances(daoAddress);
            await expect(paymaster.connect(zyfi_dao_manager).updateMarkupPercent(100000)).to.be.rejectedWith("0x5001df4c");
            await paymaster.connect(zyfi_dao_manager).updateMarkupPercent(10000);
            const markupPercent = await paymaster.markupPercent();
            const tx = await executeERC20Transaction(
                erc20,
                paymaster,
                user1,
                signer1
            );
            const eventData = tx.events.at(0).data;
            const eventDataDecoded = abiCoder.decode(["uint256","uint256"],eventData);
            const txCost = eventDataDecoded[0];
            const markUpCost = eventDataDecoded[1];  
            expect(await paymaster.managerBalances(daoAddress)).to.be.eq(daoBalance.add(markUpCost));
            expect(markUpCost).to.be.equal(txCost);
        });
        it("should update balance correctly while changing Zyfi Dao address ", async () => {
            const daoAddress = await paymaster.zyfi_dao_manager();
            const daoBalance = await paymaster.managerBalances(daoAddress);
            // Should not multiply if daoAddress is changed to same address
            await expect(paymaster.connect(zyfi_dao_manager).updateDaoManager(zyfi_dao_manager.address)).not.to.be.rejected;
            expect(await paymaster.managerBalances(daoAddress)).to.be.equal(daoBalance);
            const signerBalance = await paymaster.managerBalances(signer3.address);
            await expect(paymaster.connect(zyfi_dao_manager).updateDaoManager(signer3.address)).not.to.be.rejected;
            expect(await paymaster.managerBalances(signer3.address)).to.be.equal(daoBalance);
            await expect(paymaster.connect(zyfi_dao_manager).updateDaoManager(zyfi_dao_manager.address)).to.be.rejectedWith("0x5001df4c");
            expect(await paymaster.managerBalances(zyfi_dao_manager.address)).to.be.equal(0);
            await expect(paymaster.connect(signer3).updateDaoManager(zyfi_dao_manager.address)).not.to.be.rejected;
            expect(await paymaster.managerBalances(zyfi_dao_manager.address)).to.be.equal(daoBalance);
            expect(await paymaster.managerBalances(signer3.address)).to.be.equal(0);
            const paymasterBalance = await provider.getBalance(paymaster.address);
            const tx = await(await paymaster.connect(zyfi_dao_manager).withdrawFull()).wait();
            const withdrawAmount = BigNumber.from(tx.events.at(-2).data);
            expect(withdrawAmount).to.be.eq(daoBalance);
            expect(await provider.getBalance(paymaster.address)).to.be.eq(paymasterBalance.sub(daoBalance));
        });
    });
    
    //// -----------------------------------------------
    //// Add / Remove Signers Functionality Test
    //// -----------------------------------------------

    describe("Manager functionalities test", async () => {
        let newSigner = Wallet.createRandom();
        let newSigner1 = Wallet.createRandom();
        let newSigner2 = Wallet.createRandom();
        it("should add signer correctly", async () => {
            const tx = await (await paymaster.connect(Manager1).addSigner(newSigner.address)).wait();
            expect(tx.events[2].event).to.be.equal("SignerAdded");
            expect(await paymaster.managers(newSigner.address)).to.be.equal(Manager1.address);
            await expect(executeERC20Transaction(erc20, paymaster, user1, newSigner)).not.to.be.rejected;
            // Failure test
            await expect(paymaster.connect(Manager1).addSigner(ZERO_ADDRESS)).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager1).addSigner(newSigner.address)).to.be.rejectedWith("0xdbae7908");
            await expect(paymaster.connect(Manager1).addSigner(signer3.address)).to.be.rejectedWith("0xdbae7908");
        });
        it("should batch add signers correctly", async () => {
            //console.log(newSigner1,newSigner2);
            const tx = await (await paymaster.connect(Manager1).batchAddSigners([newSigner1.address.toString(), newSigner2.address.toString()])).wait();
            expect(tx.events.at(2).event).to.be.equal("SignerAdded");
            await expect(executeERC20Transaction(erc20, paymaster, user1, newSigner1)).not.to.be.rejected;
            await expect(executeERC20Transaction(erc20, paymaster, user1, newSigner2)).not.to.be.rejected;
            // Failure test
            await expect(paymaster.connect(Manager1).batchAddSigners([ZERO_ADDRESS, ZERO_ADDRESS])).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager1).batchAddSigners([newSigner1.address, ZERO_ADDRESS])).to.be.rejectedWith("0xdbae7908");
            await expect(paymaster.connect(Manager1).batchAddSigners([signer3.address, newSigner1.address])).to.be.rejectedWith("0xdbae7908");


        });
        it("should replace signer correctly", async () => {
            const newSigner = Wallet.createRandom();
            await expect(executeERC20Transaction(erc20, paymaster, user1, signer2)).not.to.be.rejected;
            await paymaster.connect(Manager2).replaceSigner(signer2.address, newSigner.address);
            await expect(executeERC20Transaction(erc20, paymaster, user1, signer2)).to.be.rejectedWith("0x81c0c5d4");
            await expect(executeERC20Transaction(erc20, paymaster, user1, newSigner)).not.to.be.rejected;
            expect(await paymaster.managers(signer2.address)).to.be.equal(ZERO_ADDRESS);
            await paymaster.connect(Manager2).replaceSigner(newSigner.address, signer2.address);
            // Failure test
            await expect(executeERC20Transaction(erc20, paymaster, user1, newSigner)).to.be.rejectedWith("0x81c0c5d4");
            await expect(paymaster.connect(Manager2).replaceSigner(signer2.address, ZERO_ADDRESS)).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager2).replaceSigner(ZERO_ADDRESS, newSigner.address)).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager2).replaceSigner(signer1.address, newSigner.address)).to.be.rejectedWith("0xce37a54d");
            await expect(paymaster.connect(Manager2).replaceSigner(signer2.address, signer1.address)).to.be.rejectedWith("0xdbae7908");
        });
        it("should remove signer correctly", async () => {
            const tx = await (await paymaster.connect(Manager1).removeSigner(newSigner.address)).wait();
            expect(tx.events[2].event).to.be.equal("SignerRemoved");
            expect(await paymaster.managers(newSigner.address)).to.be.equal(ZERO_ADDRESS);
            await expect(executeERC20Transaction(erc20, paymaster, user1, newSigner)).to.be.rejectedWith("0x81c0c5d4");
            // Failure test
            await expect(paymaster.connect(Manager1).removeSigner(ZERO_ADDRESS)).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager1).removeSigner(newSigner.address)).to.be.rejectedWith("0xce37a54d");
            await expect(paymaster.connect(Manager1).removeSigner(signer3.address)).to.be.rejectedWith("0xce37a54d");
        });
        it("should batch remove signers correctly", async () => {
            await expect(executeERC20Transaction(erc20, paymaster, user1, newSigner1)).not.to.be.rejected;
            await expect(executeERC20Transaction(erc20, paymaster, user1, newSigner2)).not.to.be.rejected;
            const tx = await (await paymaster.connect(Manager1).batchRemoveSigners([newSigner1.address.toString(), newSigner2.address.toString()])).wait();
            expect(tx.events.at(2).event).to.be.equal("SignerRemoved");
            await expect(executeERC20Transaction(erc20, paymaster, user1, newSigner1)).to.be.rejectedWith("0x81c0c5d4");
            await expect(executeERC20Transaction(erc20, paymaster, user1, newSigner2)).to.be.rejectedWith("0x81c0c5d4");
            // Failure test
            await expect(paymaster.connect(Manager1).batchRemoveSigners([ZERO_ADDRESS, ZERO_ADDRESS])).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager1).batchRemoveSigners([newSigner1.address, ZERO_ADDRESS])).to.be.rejectedWith("0xce37a54d");
            await expect(paymaster.connect(Manager1).batchRemoveSigners([signer3.address, newSigner1.address])).to.be.rejectedWith("0xce37a54d");
        });

        it("should allow signers to revoke self", async () => {
            await expect(executeERC20Transaction(erc20, paymaster, user1, signer1)).not.to.be.rejected;
            await paymaster.connect(signer1).selfRevokeSigner();
            await expect(executeERC20Transaction(erc20, paymaster, user1, signer1)).to.be.rejectedWith("0x81c0c5d4");

            // Resetting the state
            await paymaster.connect(Manager1).addSigner(signer1.address);
        });
    });

    //// -----------------------------------------------
    //// Withdraw Functions Test
    //// -----------------------------------------------

    describe("Withdraw Functions test", async () => {
        it("should withdraw funds correctly and updateRefund correctly", async () => {
            let paymasterEthBalance: any = await provider.getBalance(paymaster.address);
            const previousTotalBalance = await paymaster.previousTotalBalance();
            paymasterEthBalance = await provider.getBalance(paymaster.address);

            const previousRefund = paymasterEthBalance.sub(previousTotalBalance);
            const balanceInPaymaster = await paymaster.managerBalances(Manager1.address);
            let ethBalanceM1 = await provider.getBalance(Manager1.address);
            await expect(paymaster.connect(Manager1).withdraw(balanceInPaymaster.add(previousRefund).add(1))).to.be.rejectedWith("0x4e487b71"); // Panic error
            await expect(paymaster.connect(Manager1).withdraw(0)).not.to.be.rejected;
            expect(await paymaster.previousTotalBalance()).to.be.eq(paymasterEthBalance);
            expect(await paymaster.managerBalances(Manager1.address)).to.be.eq(balanceInPaymaster.add(previousRefund));
            ethBalanceM1 = await provider.getBalance(Manager1.address);
            const tx = await (await paymaster.connect(Manager1).withdraw(balanceInPaymaster.add(previousRefund))).wait();
            const preTxPaid = BigNumber.from(tx.events.at(-5).data);
            const txRefund1 = BigNumber.from(tx.events.at(-4).data);
            const txRefund2 = BigNumber.from(tx.events.at(-1).data);
            const gasUsed = tx.gasUsed;
            const gasPrice = tx.effectiveGasPrice;
            expect(await provider.getBalance(Manager1.address)).to.be.eq((ethBalanceM1.add(balanceInPaymaster).add(previousRefund).sub(preTxPaid).add(txRefund1).add(txRefund2))); // gas
            expect(await provider.getBalance(Manager1.address)).to.be.eq(ethBalanceM1.add(balanceInPaymaster).add(previousRefund).sub((gasUsed.mul(gasPrice))));
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
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(balanceInPaymaster.add(1), [signer2.address])).to.be.rejectedWith("0x4e487b71");
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(balanceInPaymaster.sub(1000), [])).not.to.be.rejected;
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(1000, [signer2.address])).not.to.be.rejected;
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(0, [signer3.address])).not.to.be.rejected;
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(1, [])).to.be.rejectedWith("0x4e487b71");

            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(0, [ZERO_ADDRESS])).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(0, [signer1.address])).to.be.rejectedWith("0xce37a54d");
            await expect(paymaster.connect(Manager2).withdrawAndRemoveSigners(0, [signer3.address])).to.be.rejectedWith("0xce37a54d");
        });
    });

    //// -----------------------------------------------
    //// Rescue Wallet/ Zyfi dao update Test 
    //// -----------------------------------------------    

    describe("Rescue Token tests", async () => {
        it("initial parameters are correctly set", async () => {
            expect(await paymaster.zyfi_dao_manager()).to.be.equal(
                zyfi_dao_manager.address
            );
        });
        it("rescue wallet update test", async () => {
            await expect(
                paymaster.connect(Manager1).updateDaoManager(Manager1.address)
            ).to.be.rejectedWith("0x5001df4c");
            await paymaster
                .connect(zyfi_dao_manager)
                .updateDaoManager(Manager2.address);
            expect(await paymaster.zyfi_dao_manager()).to.be.equal(
                Manager2.address
            );
            await expect(paymaster.connect(zyfi_dao_manager).updateDaoManager(zyfi_dao_manager.address)).to.be.rejected;
            //await paymaster.connect(Manager2).updateDaoManager(zyfi_dao_manager.address);
        });
        it("should rescue dropped token", async () => {
            await erc20.connect(zyfi_dao_manager).transfer(paymaster.address, 5);
            expect(await erc20.balanceOf(paymaster.address)).to.be.equal(5);
            await expect(paymaster.connect(Manager2).rescueTokens([erc20.address, ZERO_ADDRESS])).to.be.rejectedWith("0x02876945");
            await expect(paymaster.connect(Manager2).rescueTokens([erc20.address, Manager1.address])).to.be.rejected;
            await expect(paymaster.connect(Manager2).rescueTokens([erc20.address])).not.to.be.rejected;
            expect(await erc20.balanceOf(await paymaster.zyfi_dao_manager())).to.be.equal(5);
        });
    });

    //// -----------------------------------------------
    //// Post audit -  fix test
    //// -----------------------------------------------
    
    describe("Post audit fix test", async () => {
        it("self revoke should not update previousManager", async () => {
            // Setup
            await paymaster.connect(Manager2).depositAndAddSigner(signer2.address,{
                value: ethers.utils.parseEther("0.1")
            });
            await executeERC20Transaction(erc20, paymaster, user1, signer2);
            expect(await paymaster.previousManager()).to.be.eq(Manager2.address);
            // Self revoke signer call
            await paymaster.connect(signer2).selfRevokeSigner();
            // Checks
            await expect(executeERC20Transaction(erc20, paymaster, user1, signer2)).to.be.rejectedWith("0x81c0c5d4");
            expect(await paymaster.previousManager()).to.be.eq(Manager2.address);
            expect(await paymaster.managers(signer2.address)).to.be.eq(ZERO_ADDRESS);
        });
    });
});
