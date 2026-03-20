// ============================================================================
//  05_competenceUpgrade.test.ts — Upgrade competenza via governance
// ============================================================================

import { expect } from "chai";
import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { GovernanceToken, MyGovernor, Treasury, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Competence Upgrade — via governance", function () {
    let token: GovernanceToken;
    let treasury: Treasury;
    let timelock: TimelockController;
    let governor: MyGovernor;
    let deployer: HardhatEthersSigner;
    let member: HardhatEthersSigner;

    const VOTING_DELAY = 1;
    const VOTING_PERIOD = 50;
    const TIMELOCK_DELAY = 3600;

    beforeEach(async function () {
        [deployer, member] = await ethers.getSigners();

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

        await token.joinDAO({ value: ethers.parseEther("10") }); // 10.000 COMP
        await token.delegate(deployer.address);

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

        // Il membro entra con 5 ETH → 5.000 COMP base
        await token.connect(member).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(member).delegate(member.address);
        await mine(1);
    });

    // Helper: esegue un upgrade completo via governance
    async function doUpgrade(target: HardhatEthersSigner, grade: number, proof: string) {
        const tokenAddr = await token.getAddress();
        const calldata = token.interface.encodeFunctionData("upgradeCompetence", [
            target.address, grade, proof
        ]);
        const targets = [tokenAddr];
        const values = [0n];
        const calldatas = [calldata];
        const description = `Upgrade ${target.address} a grado ${grade}: ${proof}`;

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
    }

    it("upgrade da Student a PhD: 5.000 × (4-1) = 15.000 aggiuntivi → 20.000 totali", async function () {
        await doUpgrade(member, 3, "PhD in AI, Politecnico di Milano, 2024");

        expect(await token.balanceOf(member.address)).to.equal(ethers.parseUnits("20000", 18));
        expect(await token.getMemberGrade(member.address)).to.equal(3); // PhD
        expect(await token.competenceProof(member.address)).to.equal("PhD in AI, Politecnico di Milano, 2024");
    });

    it("upgrade da Student a Professor: 5.000 × (5-1) = 20.000 aggiuntivi → 25.000 totali", async function () {
        await doUpgrade(member, 4, "Professore Ordinario, UniMi");

        expect(await token.balanceOf(member.address)).to.equal(ethers.parseUnits("25000", 18));
        expect(await token.getMemberGrade(member.address)).to.equal(4);
    });

    it("upgrade progressivo: Student → Bachelor → Professor", async function () {
        // Student → Bachelor: 5.000 × (2-1) = 5.000 aggiuntivi → 10.000
        await doUpgrade(member, 1, "Laurea Triennale, 2022");
        expect(await token.balanceOf(member.address)).to.equal(ethers.parseUnits("10000", 18));

        // Bachelor → Professor: 5.000 × (5-2) = 15.000 aggiuntivi → 25.000
        await doUpgrade(member, 4, "Professore, 2024");
        expect(await token.balanceOf(member.address)).to.equal(ethers.parseUnits("25000", 18));
    });

    it("non è possibile fare downgrade", async function () {
        await doUpgrade(member, 3, "PhD");

        const tokenAddr = await token.getAddress();
        const calldata = token.interface.encodeFunctionData("upgradeCompetence", [
            member.address, 1, "Downgrade a Bachelor"
        ]);
        const targets = [tokenAddr];
        const values = [0n];
        const calldatas = [calldata];
        const description = "Tentativo downgrade";

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

        await expect(
            governor.execute(targets, values, calldatas, descHash)
        ).to.be.reverted;
    });

    it("il membro upgraded ha più voting power", async function () {
        const votesBefore = await token.getVotes(member.address);
        await doUpgrade(member, 4, "Professor");
        await token.connect(member).delegate(member.address); // Re-delega per aggiornare

        const votesAfter = await token.getVotes(member.address);
        expect(votesAfter).to.be.greaterThan(votesBefore);
        expect(votesAfter).to.equal(ethers.parseUnits("25000", 18));
    });
});
