// ============================================================================
//  02_governorLifecycle.test.ts — Ciclo di vita proposta con upgrade competenza
// ============================================================================

import { expect } from "chai";
import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { GovernanceToken, MyGovernor, Treasury, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("MyGovernor — Ciclo di vita delle proposte", function () {
    let token: GovernanceToken;
    let treasury: Treasury;
    let timelock: TimelockController;
    let governor: MyGovernor;
    let deployer: HardhatEthersSigner;
    let voter: HardhatEthersSigner;

    const VOTING_DELAY = 1;
    const VOTING_PERIOD = 50;
    const PROPOSAL_THRESHOLD = 0;
    const QUORUM_PERCENT = 20;
    const SUPER_QUORUM = 70;
    const TIMELOCK_DELAY = 3600;

    beforeEach(async function () {
        [deployer, voter] = await ethers.getSigners();

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

        // Deployer entra nella DAO con 10 ETH → 10.000 COMP
        await token.joinDAO({ value: ethers.parseEther("10") });
        await token.delegate(deployer.address);

        const Governor = await ethers.getContractFactory("MyGovernor");
        governor = await Governor.deploy(
            await token.getAddress(), await timelock.getAddress(),
            VOTING_DELAY, VOTING_PERIOD, PROPOSAL_THRESHOLD,
            QUORUM_PERCENT, SUPER_QUORUM
        );
        await governor.waitForDeployment();

        const governorAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
        await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);
    });

    it("deploy corretto: parametri di governance impostati", async function () {
        expect(await governor.name()).to.equal("MyGovernor");
        expect(await governor.votingDelay()).to.equal(VOTING_DELAY);
        expect(await governor.votingPeriod()).to.equal(VOTING_PERIOD);
    });

    it("ciclo completo: propose → vote → queue → execute (upgrade competenza)", async function () {
        // Voter entra nella DAO con 5 ETH
        await token.connect(voter).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(voter).delegate(voter.address);
        await mine(1);

        // Proposta: upgrade voter a PhD
        const tokenAddr = await token.getAddress();
        const calldata = token.interface.encodeFunctionData("upgradeCompetence", [
            voter.address, 3, "PhD in Computer Science, 2024"
        ]);
        const targets = [tokenAddr];
        const values = [0n];
        const calldatas = [calldata];
        const description = "Upgrade voter a PhD";

        const tx = await governor.propose(targets, values, calldatas, description);
        const receipt = await tx.wait();
        const proposalId = receipt!.logs
            .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
            .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;

        await mine(VOTING_DELAY + 1);
        await governor.castVote(proposalId, 1); // FOR
        await mine(VOTING_PERIOD + 1);
        expect(await governor.state(proposalId)).to.equal(4); // Succeeded

        const descHash = ethers.id(description);
        await governor.queue(targets, values, calldatas, descHash);
        await time.increase(TIMELOCK_DELAY + 1);
        await governor.execute(targets, values, calldatas, descHash);
        expect(await governor.state(proposalId)).to.equal(7); // Executed

        // Voter ora ha: 5.000 base × 4 (PhD) = 20.000 COMP
        expect(await token.balanceOf(voter.address)).to.equal(ethers.parseUnits("20000", 18));
        expect(await token.getMemberGrade(voter.address)).to.equal(3); // PhD
    });

    it("proposta bocciata se la maggioranza vota contro", async function () {
        await token.connect(voter).joinDAO({ value: ethers.parseEther("10") });
        await token.connect(voter).delegate(voter.address);
        await mine(1);

        const tokenAddr = await token.getAddress();
        const calldata = token.interface.encodeFunctionData("upgradeCompetence", [
            voter.address, 4, "Professor" // dummy
        ]);
        const targets = [tokenAddr];
        const values = [0n];
        const calldatas = [calldata];
        const description = "Upgrade bocciato";

        const tx = await governor.propose(targets, values, calldatas, description);
        const receipt = await tx.wait();
        const proposalId = receipt!.logs
            .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
            .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;

        await mine(VOTING_DELAY + 1);
        await governor.connect(voter).castVote(proposalId, 0); // AGAINST
        await governor.castVote(proposalId, 1); // FOR (50/50 since equal tokens)
        await mine(VOTING_PERIOD + 1);

        expect(await governor.state(proposalId)).to.equal(3); // Defeated
    });
});
