// ============================================================================
//  03_treasuryInvestmentFlow.test.ts — Flusso investimento Treasury
// ============================================================================

import { expect } from "chai";
import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { GovernanceToken, MyGovernor, Treasury, MockStartup, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Treasury + Investment Flow", function () {
    let token: GovernanceToken;
    let timelock: TimelockController;
    let governor: MyGovernor;
    let treasury: Treasury;
    let mockStartup: MockStartup;
    let deployer: HardhatEthersSigner;
    let alice: HardhatEthersSigner;

    const VOTING_DELAY = 1;
    const VOTING_PERIOD = 50;
    const TIMELOCK_DELAY = 3600;

    beforeEach(async function () {
        [deployer, alice] = await ethers.getSigners();

        const Timelock = await ethers.getContractFactory("TimelockController");
        timelock = await Timelock.deploy(TIMELOCK_DELAY, [], [], deployer.address);
        await timelock.waitForDeployment();

        const Token = await ethers.getContractFactory("GovernanceToken");
        token = await Token.deploy(await timelock.getAddress());
        await token.waitForDeployment();

        const Treasury_ = await ethers.getContractFactory("Treasury");
        treasury = await Treasury_.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();

        await token.setTreasury(await treasury.getAddress());

        // Deployer entra con 10 ETH → 10.000 COMP (ETH vanno nel Treasury)
        await token.joinDAO({ value: ethers.parseEther("10") });
        await token.delegate(deployer.address);

        const Governor = await ethers.getContractFactory("MyGovernor");
        governor = await Governor.deploy(
            await token.getAddress(), await timelock.getAddress(),
            VOTING_DELAY, VOTING_PERIOD, 0, 20, 70
        );
        await governor.waitForDeployment();

        const MS = await ethers.getContractFactory("MockStartup");
        mockStartup = await MS.deploy();
        await mockStartup.waitForDeployment();

        const governorAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
        await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);
    });

    it("accetta depositi ETH tramite deposit()", async function () {
        // Il Treasury ha già 10 ETH dal joinDAO() del deployer
        await treasury.deposit({ value: ethers.parseEther("5") });
        expect(await treasury.getBalance()).to.equal(ethers.parseEther("15"));
    });

    it("invest() reverta se non dal Timelock", async function () {
        await treasury.deposit({ value: ethers.parseEther("1") });
        await expect(
            treasury.invest(alice.address, ethers.parseEther("1"))
        ).to.be.revertedWithCustomError(treasury, "OnlyTimelock");
    });

    it("flusso completo: deposito → proposta → voto → queue → execute", async function () {
        await treasury.deposit({ value: ethers.parseEther("5") });

        const treasuryAddr = await treasury.getAddress();
        const startupAddr = await mockStartup.getAddress();
        const calldata = treasury.interface.encodeFunctionData("invest", [
            startupAddr, ethers.parseEther("1"),
        ]);
        const targets = [treasuryAddr];
        const values = [0n];
        const calldatas = [calldata];
        const description = "Investire 1 ETH nella startup";

        const tx = await governor.propose(targets, values, calldatas, description);
        const receipt = await tx.wait();
        const proposalId = receipt!.logs
            .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
            .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;

        await mine(VOTING_DELAY + 1);
        await governor.castVote(proposalId, 1);
        await mine(VOTING_PERIOD + 1);

        const descHash = ethers.id(description);
        await governor.queue(targets, values, calldatas, descHash);
        await time.increase(TIMELOCK_DELAY + 1);
        await governor.execute(targets, values, calldatas, descHash);

        // Treasury: 10 (joinDAO) + 5 (deposit) - 1 (investimento) = 14 ETH
        expect(await treasury.getBalance()).to.equal(ethers.parseEther("14"));
        expect(await mockStartup.totalReceived()).to.equal(ethers.parseEther("1"));
    });
});
