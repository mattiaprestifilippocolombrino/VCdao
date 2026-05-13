// ============================================================================
//  08_votingPowerComposite.test.ts — Test modello Voting Power Composto Multi-Topic
//
//  Verifica la formula VP implementata nel MyGovernor:
//    VP = getPastVotes(account) + getPastSkillVotes(account, topicId)
// ============================================================================

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { GovernanceToken, MyGovernor, Treasury, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

function hashLegacyProof(proof: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(proof));
}

async function callAsTimelock(
    timelock: TimelockController,
    funder: HardhatEthersSigner,
    fn: (signer: HardhatEthersSigner) => Promise<any>
): Promise<any> {
    const addr = await timelock.getAddress();
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
    await funder.sendTransaction({ to: addr, value: ethers.parseEther("1") });
    const signer = await ethers.getSigner(addr);
    const result = await fn(signer);
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [addr] });
    return result;
}

describe("Voting Power Composto Multi-Topic", function () {
    let deployer: HardhatEthersSigner;
    let alice: HardhatEthersSigner;
    let token: GovernanceToken;
    let governor: MyGovernor;
    let timelock: TimelockController;

    beforeEach(async function () {
        [deployer, alice] = await ethers.getSigners();

        const Timelock = await ethers.getContractFactory("TimelockController");
        timelock = await Timelock.deploy(3600, [], [], deployer.address);
        await timelock.waitForDeployment();

        const Token = await ethers.getContractFactory("GovernanceToken");
        token = await Token.deploy(await timelock.getAddress(), 5000n, 5000n);
        await token.waitForDeployment();

        const Treasury_ = await ethers.getContractFactory("Treasury");
        const treasury = await Treasury_.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();

        await token.setTreasury(await treasury.getAddress());

        const Governor = await ethers.getContractFactory("MyGovernor");
        governor = await Governor.deploy(
            await token.getAddress(), await timelock.getAddress(),
            1, 50, 0, 0, 70
        );
        await governor.waitForDeployment();

        const govAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), govAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
    });

    describe("1. Funzioni Score sul Token", function () {
        it("getSkillScoreForTopic: assegna i target prefissati e penalità cross-topic", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });

            // Student = 0
            expect(await token.getSkillScoreForTopic(alice.address, 0)).to.equal(0n);

            // BachelorCS = 25 su topic 0, 0 su topic 1
            await callAsTimelock(timelock, deployer, s => token.connect(s).upgradeSkill(alice.address, 1, hashLegacyProof("")));
            expect(await token.getSkillScoreForTopic(alice.address, 0)).to.equal(25n);
            expect(await token.getSkillScoreForTopic(alice.address, 1)).to.equal(0n);

            // ProfessorCS = 100 su topic 0, 75 su topic 1
            await callAsTimelock(timelock, deployer, s => token.connect(s).upgradeSkill(alice.address, 4, hashLegacyProof("")));
            expect(await token.getSkillScoreForTopic(alice.address, 0)).to.equal(100n);
            expect(await token.getSkillScoreForTopic(alice.address, 1)).to.equal(75n);
        });

        it("getStakeScore: calcolo in base al CAP di 100 ETH", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
            expect(await token.getStakeScore(alice.address)).to.equal(10n);

            await token.connect(alice).increaseStake({ value: ethers.parseEther("40") });
            expect(await token.getStakeScore(alice.address)).to.equal(50n);

            await token.connect(alice).increaseStake({ value: ethers.parseEther("50") });
            expect(await token.getStakeScore(alice.address)).to.equal(100n);
        });
    });

    describe("2. Integrazione MyGovernor (VP composito)", function () {
        it("castVote conteggia sia lo stake VP che lo skill VP per il topic corretto", async function () {
            // Alice deposit 40 ETH (stakeScore=40 -> stake VP = 40 * 5000/10000 = 20)
            await token.connect(alice).joinDAO({ value: ethers.parseEther("40") });
            // Upgrade ProfessorCS (score=100 -> skillVP = 100 * 5000/10000 = 50 per CS)
            // skillVP per CE (topic 1) = (100 - 25) * 5000/10000 = 37.5
            await callAsTimelock(timelock, deployer, s => token.connect(s).upgradeSkill(alice.address, 4, hashLegacyProof("")));
            
            await token.connect(alice).delegate(alice.address);
            await mine(1);

            // Proposta CS (topic 0)
            await governor.connect(alice).proposeWithTopic([ethers.ZeroAddress], [0], ["0x"], "Prop CS", 0);
            const logs = await governor.queryFilter(governor.filters.ProposalCreated(), -1);
            const proposalId = logs[0].args.proposalId;
            
            await mine(2);
            await governor.connect(alice).castVote(proposalId, 1);
            const { forVotes } = await governor.proposalVotes(proposalId);

            // Stake (20) + Skill CS (50) = 70
            expect(forVotes).to.equal(ethers.parseEther("70"));
        });
    });
});
