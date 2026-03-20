// ============================================================================
//  04_superquorum.test.ts — Test SuperQuorum
// ============================================================================

import { expect } from "chai";
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { GovernanceToken, MyGovernor, Treasury, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("SuperQuorum — Approvazione rapida", function () {
    let token: GovernanceToken;
    let treasury: Treasury;
    let timelock: TimelockController;
    let governor: MyGovernor;
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

        const Governor = await ethers.getContractFactory("MyGovernor");
        governor = await Governor.deploy(
            await token.getAddress(), await timelock.getAddress(),
            VOTING_DELAY, VOTING_PERIOD, 0, 20, 70
        );
        await governor.waitForDeployment();

        const governorAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
        await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);
    });

    async function createDummyProposal(desc: string) {
        const tokenAddr = await token.getAddress();
        const calldata = token.interface.encodeFunctionData("decimals");
        const tx = await governor.propose([tokenAddr], [0n], [calldata], desc);
        const receipt = await tx.wait();
        return receipt!.logs
            .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
            .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;
    }

    it("superquorum → Succeeded prima della fine del period", async function () {
        // Deployer ha 100% della supply → supera il 70% superquorum
        await token.joinDAO({ value: ethers.parseEther("10") });
        await token.delegate(deployer.address);
        await mine(1);

        const proposalId = await createDummyProposal("Test superquorum");
        await mine(VOTING_DELAY + 1);
        await governor.castVote(proposalId, 1);
        expect(await governor.state(proposalId)).to.equal(4); // Succeeded
    });

    it("sotto superquorum → resta Active fino alla fine del period", async function () {
        // Deployer ha 30%, Alice ha 70% → deployer sopra il quorum (20%) ma sotto il 70% superquorum
        await token.joinDAO({ value: ethers.parseEther("3") });
        await token.connect(alice).joinDAO({ value: ethers.parseEther("7") });
        await token.delegate(deployer.address);
        await token.connect(alice).delegate(alice.address);
        await mine(1);

        const proposalId = await createDummyProposal("Test sotto superquorum");
        await mine(VOTING_DELAY + 1);
        await governor.castVote(proposalId, 1); // 30% FOR
        expect(await governor.state(proposalId)).to.equal(1); // Active (sotto superquorum)

        await mine(VOTING_PERIOD + 1);
        expect(await governor.state(proposalId)).to.equal(4); // Succeeded (quorum raggiunto)
    });
});
