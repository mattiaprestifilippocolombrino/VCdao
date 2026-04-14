// ============================================================================
//  08_votingPowerComposite.test.ts — Test modello Voting Power Composto (VPC)
//
//  Verifica la formula imposta dal professore:
//    ScoreTotale = pesoCompetenze × scoreCompetenze + pesoSoldi × scoreSoldi
//
//  Proprietà testate:
//    • scoreCompetenze ∈ {0, 25, 50, 75, 100} in base al grado.
//    • scoreSoldi = min(ethDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100].
//    • Il Governor conta i voti sovrascrivendo _countVote(..., totalWeight).
// ============================================================================

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import { GovernanceToken, MyGovernor, Treasury, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Impersona per bypassare la governance
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

describe("Voting Power Composto (Formula Tesi) — Override _countVote", function () {
    let deployer: HardhatEthersSigner;
    let alice: HardhatEthersSigner;
    let token: GovernanceToken;
    let governor: MyGovernor;
    let timelock: TimelockController;

    // Configura l'ambiente con pesi 50/50
    beforeEach(async function () {
        [deployer, alice] = await ethers.getSigners();

        const Timelock = await ethers.getContractFactory("TimelockController");
        timelock = await Timelock.deploy(3600, [], [], deployer.address);
        await timelock.waitForDeployment();

        const Token = await ethers.getContractFactory("GovernanceToken");
        token = await Token.deploy(await timelock.getAddress());
        await token.waitForDeployment();

        const Treasury_ = await ethers.getContractFactory("Treasury");
        const treasury = await Treasury_.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();

        await token.setTreasury(await treasury.getAddress());

        const Governor = await ethers.getContractFactory("MyGovernor");
        // Deploy governor con Pesi: 50% competenza, 50% soldi
        governor = await Governor.deploy(
            await token.getAddress(), await timelock.getAddress(),
            1, 50, 0, 0, 70, 5000n, 5000n
        );
        await governor.waitForDeployment();

        const govAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), govAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
    });

    describe("1. Funzioni Score sul Token", function () {
        it("getScoreCompetenze: assegna i target prefissati [0, 25, 50, 75, 100]", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("1") });

            // Student = 0
            expect(await token.getScoreCompetenze(alice.address)).to.equal(0n);

            // Bachelor = 25
            await callAsTimelock(timelock, deployer, s => token.connect(s).upgradeCompetence(alice.address, 1, ""));
            expect(await token.getScoreCompetenze(alice.address)).to.equal(25n);

            // Professor = 100
            await callAsTimelock(timelock, deployer, s => token.connect(s).upgradeCompetence(alice.address, 4, ""));
            expect(await token.getScoreCompetenze(alice.address)).to.equal(100n);
        });

        it("getScoreSoldi: calcolo in base al CAP di 100 ETH", async function () {
            // Join con 10 ETH (10% del CAP => score 10)
            await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
            expect(await token.getScoreSoldi(alice.address)).to.equal(10n);

            // Mint successivi sommano gli ETH: 40 ETH in più (Totale 50 ETH = 50% => score 50)
            await token.connect(alice).mintTokens({ value: ethers.parseEther("40") });
            expect(await token.getScoreSoldi(alice.address)).to.equal(50n);

            // Cap massimo (100 ETH => score 100)
            await token.connect(alice).mintTokens({ value: ethers.parseEther("50") });
            expect(await token.getScoreSoldi(alice.address)).to.equal(100n);
        });

        it("reverta se si supera il MAX_DEPOSIT (CAP)", async function () {
            await token.connect(alice).joinDAO({ value: ethers.parseEther("99") });
            await expect(
                token.connect(alice).mintTokens({ value: ethers.parseEther("2") }) // > 100 (101)
            ).to.be.revertedWithCustomError(token, "ExceedsMaxDeposit");
        });
    });

    describe("2. Integrazione MyGovernor (Override _countVote)", function () {
        it("castVote usa il sistema a punti bypassando il balance del token ERC20", async function () {
            // Alice entra con 10 ETH. scoreSoldi = 10, scoreCompetenze = 0 (Student).
            // Pesi = 50/50. Formulazione: (5000*0 + 5000*10)/10000 = 5.
            await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
            await token.connect(alice).delegate(alice.address);
            await mine(1);

            const propTargets = [await token.getAddress()];
            const propValues = [0n];
            const propCalldatas = ["0x00"];
            
            await governor.connect(alice).propose(propTargets, propValues, propCalldatas, "Prop 1");
            const filter = governor.filters.ProposalCreated();
            const logs = await governor.queryFilter(filter, -1);
            const proposalId = logs[0].args.proposalId;

            await mine(2); // Supera il voting delay

            // Alice vota "For" (support=1)
            await governor.connect(alice).castVote(proposalId, 1);

            // Verifichiamo i voti registrati
            const { againstVotes, forVotes, abstainVotes } = await governor.proposalVotes(proposalId);
            
            // Il token balance di alice è 10.000 ether, ma il governor ha considerato il VPC!
            // VPC = 5.
            expect(forVotes).to.equal(ethers.parseEther("5"));
            expect(againstVotes).to.equal(0n);
        });

        it("castVote riflette il nuovo score dopo upgrade a Professore", async function () {
            // Alice deposita 40 ETH (scoreSoldi = 40).
            await token.connect(alice).joinDAO({ value: ethers.parseEther("40") });
            // Alice diventa professoressa (scoreCompetenze = 100).
            await callAsTimelock(timelock, deployer, s => token.connect(s).upgradeCompetence(alice.address, 4, ""));
            await token.connect(alice).delegate(alice.address);
            
            // Punti totali = (5000*100 + 5000*40) / 10000 = 70.
            await mine(1);
            await governor.connect(alice).propose([ethers.ZeroAddress], [0], ["0x"], "Prop 2");
            const logs = await governor.queryFilter(governor.filters.ProposalCreated(), -1);
            const proposalId = logs[0].args.proposalId;
            
            await mine(2);
            await governor.connect(alice).castVote(proposalId, 1);
            const { forVotes } = await governor.proposalVotes(proposalId);

            // Verifica che il voto pesi 70 punti precisi.
            expect(forVotes).to.equal(ethers.parseEther("70"));
        });
    });
});
