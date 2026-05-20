// ============================================================================
//  03_governor.test.ts — Test del ciclo di vita delle proposte in MyGovernor
//
//  Verifica:
//    - proposeWithTopic: salva correttamente il topicId, revert su topic invalido
//    - propose() standard: deve revertare (UseProposeWithTopic)
//    - Ciclo completo: proposeWithTopic → vote → queue → execute (skill upgrade)
//    - Proposta sconfitta: voto Against + voto For pareggio → Defeated
//    - quorumForProposal: calcolo sul topic della proposta
//    - _getVotes: VP composito stake+skill usato nel voto
//    - SuperQuorum: Succeeded early se i voti FOR superano il superquorum topic
//    - SuperQuorum: resta Active se sotto soglia, poi Succeeded a fine period
//    - proposalVotes: registra correttamente For, Against, Abstain
// ============================================================================

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import {
    GovernanceToken,
    MyGovernor,
    Treasury,
    TimelockController,
    SkillCalculator,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ────────────────────────────────────────────────────────────────────────────
//  Helper: impersona il Timelock (per upgradeSkill diretto nei test)
// ────────────────────────────────────────────────────────────────────────────
async function asTimelock(
    timelock: TimelockController,
    funder:   HardhatEthersSigner,
    fn:       (s: HardhatEthersSigner) => Promise<any>
) {
    const addr = await timelock.getAddress();
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
    await funder.sendTransaction({ to: addr, value: ethers.parseEther("1") });
    const signer = await ethers.getSigner(addr);
    await fn(signer);
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [addr] });
}

// Helper: estrae il proposalId dai log di una transazione di proposta
async function getProposalId(
    governor: MyGovernor,
    tx: any
): Promise<bigint> {
    const receipt = await tx.wait();
    return receipt!.logs
        .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
        .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;
}

// ────────────────────────────────────────────────────────────────────────────
//  Suite
// ────────────────────────────────────────────────────────────────────────────
describe("MyGovernor — Ciclo vita proposte, VP composito, Quorum, SuperQuorum", function () {
    let token:    GovernanceToken;
    let governor: MyGovernor;
    let treasury: Treasury;
    let timelock: TimelockController;
    let deployer: HardhatEthersSigner;
    let alice:    HardhatEthersSigner;
    let bob:      HardhatEthersSigner;

    // Parametri di governance usati in tutti i test
    const VOTING_DELAY  = 1;
    const VOTING_PERIOD = 50;
    const TIMELOCK_DELAY = 3600;
    // quorum 20%, superquorum 70%
    const QUORUM_NUM   = 20;
    const SQ_NUM       = 70;
    const skillIds = (names: string[]) => names.map((name) => ethers.id(name));

    beforeEach(async function () {
        [deployer, alice, bob] = await ethers.getSigners();

        // 1. Timelock
        const TL = await ethers.getContractFactory("TimelockController");
        timelock = await TL.deploy(TIMELOCK_DELAY, [], [], deployer.address);
        await timelock.waitForDeployment();

        // 2. Token (pesi 50/50)
        const TK = await ethers.getContractFactory("GovernanceToken");
        token = await TK.deploy(await timelock.getAddress(), 5000n, 5000n);
        await token.waitForDeployment();

        // 3. Treasury
        const TR = await ethers.getContractFactory("Treasury");
        treasury = await TR.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();
        await token.setTreasury(await treasury.getAddress());

        // 3b. SkillCalculator
        const SC = await ethers.getContractFactory("SkillCalculator");
        const calculator: SkillCalculator = await SC.deploy();
        await calculator.waitForDeployment();
        await token.setSkillCalculator(await calculator.getAddress());

        // 4. Governor
        const GV = await ethers.getContractFactory("MyGovernor");
        governor = await GV.deploy(
            await token.getAddress(),
            await timelock.getAddress(),
            VOTING_DELAY, VOTING_PERIOD, 0,
            QUORUM_NUM, SQ_NUM
        );
        await governor.waitForDeployment();

        // 5. Setup ruoli Timelock
        const govAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), govAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
        await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

        // 6. Deployer entra nella DAO con 100 ETH (max) → 50 token
        await token.joinDAO({ value: ethers.parseEther("100") });
        await token.delegate(deployer.address);
        await mine(1);
    });

    // ========================================================================
    //  SEZIONE 1 — proposeWithTopic e validazione topicId
    // ========================================================================
    describe("1. proposeWithTopic()", function () {

        it("salva correttamente il topicId per una proposta CS (0)", async function () {
            const tx = await governor.proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "Test CS", 0
            );
            const pid = await getProposalId(governor, tx);
            expect(await governor.proposalTopic(pid)).to.equal(0n);
        });

        it("salva correttamente il topicId per una proposta EE (2)", async function () {
            const tx = await governor.proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "Test EE", 2
            );
            const pid = await getProposalId(governor, tx);
            expect(await governor.proposalTopic(pid)).to.equal(2n);
        });

        it("emette ProposalTopicSet con proposalId e topicId corretti", async function () {
            const tx  = await governor.proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "Test Event", 1
            );
            const pid = await getProposalId(governor, tx);
            // Cerca l'evento ProposalTopicSet nei log
            const receipt = await tx.wait();
            const log = receipt!.logs
                .map((l: any) => { try { return governor.interface.parseLog(l); } catch { return null; } })
                .find((p: any) => p?.name === "ProposalTopicSet");
            expect(log?.args?.topicId).to.equal(1n);
            expect(log?.args?.proposalId).to.equal(pid);
        });

        it("revert InvalidTopicId se topicId >= NUM_TOPICS (4)", async function () {
            await expect(
                governor.proposeWithTopic([ethers.ZeroAddress], [0n], ["0x"], "Bad", 4)
            ).to.be.revertedWithCustomError(governor, "InvalidTopicId");
        });

        it("revert UseProposeWithTopic se si chiama propose() standard", async function () {
            await expect(
                governor.propose([ethers.ZeroAddress], [0n], ["0x"], "Standard")
            ).to.be.revertedWithCustomError(governor, "UseProposeWithTopic");
        });
    });

    // ========================================================================
    //  SEZIONE 2 — Ciclo completo: propose → vote → queue → execute
    // ========================================================================
    describe("2. Ciclo completo di una proposta", function () {

        it("ciclo completo skill upgrade: proposta CS passata e eseguita", async function () {
            // Alice entra con 5 ETH
            await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            await token.connect(alice).delegate(alice.address);
            await mine(1);

            // Proposta: upgrade alice a PhDCS (grado 3) sul topic CS (0)
            const calldata = token.interface.encodeFunctionData("upgradeSkill", [
                alice.address, skillIds(["smart-contracts", "machine-learning"]), ethers.keccak256(ethers.toUtf8Bytes("skills proof"))
            ]);
            const desc = "Upgrade alice skill CS";
            const tx   = await governor.proposeWithTopic(
                [await token.getAddress()], [0n], [calldata], desc, 0
            );
            const pid  = await getProposalId(governor, tx);

            // Aspetta il voting delay, poi vota FOR
            await mine(VOTING_DELAY + 1);
            expect(await governor.state(pid)).to.equal(1); // Active
            await governor.castVote(pid, 1); // deployer vota FOR (50 token)

            // Aspetta la fine del voting period
            await mine(VOTING_PERIOD + 1);
            expect(await governor.state(pid)).to.equal(4); // Succeeded

            // Queue nel timelock
            await governor.queue(
                [await token.getAddress()], [0n], [calldata], ethers.id(desc)
            );
            expect(await governor.state(pid)).to.equal(5); // Queued

            // Aspetta il delay del timelock ed esegue
            await time.increase(TIMELOCK_DELAY + 1);
            await governor.execute(
                [await token.getAddress()], [0n], [calldata], ethers.id(desc)
            );
            expect(await governor.state(pid)).to.equal(7); // Executed

            // Alice deve ora avere le skill aggiornate e VP skill su CS > 0
            const skills = await token.getMemberSkills(alice.address);
            expect(skills.length).to.be.gt(0);
            expect(await token.getSkillVotes(alice.address, 0)).to.be.gt(0n);
        });

        it("proposta Defeated se la maggioranza vota Against", async function () {
            // Alice entra con 100 ETH → stessa supply del deployer (50+50 pareggio)
            // Con 50 FOR e 50 AGAINST il voto non viene vinto → Defeated
            await token.connect(alice).joinDAO({ value: ethers.parseEther("100") });
            await token.connect(alice).delegate(alice.address);
            await mine(1);

            const tx  = await governor.proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "Pareggio", 0
            );
            const pid = await getProposalId(governor, tx);

            await mine(VOTING_DELAY + 1);
            await governor.castVote(pid, 1);              // deployer: FOR
            await governor.connect(alice).castVote(pid, 0); // alice:    AGAINST

            await mine(VOTING_PERIOD + 1);
            expect(await governor.state(pid)).to.equal(3); // Defeated
        });

        it("proposta Defeated se quorum non raggiunto (nessun voto)", async function () {
            // Con quorum al 20% e nessun voto, la proposta deve fallire
            const tx  = await governor.proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "No votes", 0
            );
            const pid = await getProposalId(governor, tx);

            await mine(VOTING_DELAY + 1);
            // Nessuno vota
            await mine(VOTING_PERIOD + 1);
            expect(await governor.state(pid)).to.equal(3); // Defeated
        });
    });

    // ========================================================================
    //  SEZIONE 3 — VP Composito (Stake + Skill) nel voto
    // ========================================================================
    describe("3. VP composito stake+skill nel castVote", function () {

        it("i voti FOR contano sia stake che skill del topic della proposta", async function () {
            // alice: 40 ETH stake → 20 token; ProfessorCS → 50 VP skill su CS
            // VP totale su topic CS = 20 + 50 = 70 token
            await token.connect(alice).joinDAO({ value: ethers.parseEther("40") });
            await token.connect(alice).delegate(alice.address);
            await asTimelock(timelock, deployer,
                s => token.connect(s).upgradeSkill(alice.address, skillIds(["smart-contracts", "tokenomics", "data-analysis"]), "0x"));
            await mine(1);

            // Proposta su topic CS
            const tx  = await governor.connect(alice).proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "CS prop", 0
            );
            const pid = await getProposalId(governor, tx);

            await mine(VOTING_DELAY + 1);
            await governor.connect(alice).castVote(pid, 1);

            const { forVotes } = await governor.proposalVotes(pid);
            // Stake: 40e18×100×5000×1e18/(100e18×10000) = 20e18
            // Skill Web3: smart-contracts + tokenomics + data-analysis + boost = capped 100 → VP=50e18
            expect(forVotes).to.equal(ethers.parseEther("70"));
        });

        it("i voti su topic AI & Data usano skill topic-specifiche", async function () {
            // ProfessorCS su topic CE ha cross-topic penalty: score = 100-25 = 75
            // VP skill CE = 75×5000/10000×1e18 = 37.5e18
            await token.connect(alice).joinDAO({ value: ethers.parseEther("40") });
            await token.connect(alice).delegate(alice.address);
            await asTimelock(timelock, deployer,
                s => token.connect(s).upgradeSkill(alice.address, skillIds(["data-analysis"]), "0x"));
            await mine(1);

            // Proposta su topic CE (1)
            const tx  = await governor.connect(alice).proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "CE prop", 1
            );
            const pid = await getProposalId(governor, tx);

            await mine(VOTING_DELAY + 1);
            await governor.connect(alice).castVote(pid, 1);

            const { forVotes } = await governor.proposalVotes(pid);
            // Stake 20e18 + skill AI data-analysis=30 → VP = 20 + 15 = 35 COMP
            expect(forVotes).to.equal(ethers.parseEther("35"));
        });
    });

    // ========================================================================
    //  SEZIONE 4 — Quorum topic-aware
    // ========================================================================
    describe("4. quorumForProposal (topic-aware)", function () {

        it("quorumForProposal = quorumNumerator% × (stakeSupply + skillSupply topic)", async function () {
            // Dopo joinDAO del deployer (100 ETH → 50 token stake)
            // Nessuna skill → skillSupply = 0
            // Supply totale topic CS = 50e18
            // Quorum 20% → 10e18
            const tx  = await governor.proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "Q test", 0
            );
            const pid = await getProposalId(governor, tx);
            await mine(VOTING_DELAY + 1);
            const q   = await governor.quorumForProposal(pid);
            // stakeSupply = 50 token, quorum 20% → 10 token
            expect(q).to.equal(ethers.parseEther("10"));
        });

        it("quorum aumenta quando la skillSupply del topic cresce", async function () {
            // Aggiungi skill a alice → skillSupply CS cresce → quorum cresce
            await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
            await token.connect(alice).delegate(alice.address);
            await asTimelock(timelock, deployer,
                s => token.connect(s).upgradeSkill(alice.address, skillIds(["smart-contracts"]), "0x"));
            await mine(1);

            const tx  = await governor.proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "Q skill", 0
            );
            const pid = await getProposalId(governor, tx);
            await mine(VOTING_DELAY + 1);
            const q   = await governor.quorumForProposal(pid);

            // stakeSupply = deployer(50) + alice(5), skillSupply topic 0 = smart-contracts(40)*50% = 20
            // totale = 75e18; quorum 20% = 15e18
            expect(q).to.equal(ethers.parseEther("15"));
        });
    });

    // ========================================================================
    //  SEZIONE 5 — SuperQuorum topic-aware
    // ========================================================================
    describe("5. SuperQuorum topic-aware", function () {

        it("Succeeded early se i voti FOR superano il superquorum del topic", async function () {
            // Deployer ha 100% della supply stake → supera qualsiasi soglia
            const tx  = await governor.proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "SuperQ pass", 0
            );
            const pid = await getProposalId(governor, tx);

            await mine(VOTING_DELAY + 1);
            await governor.castVote(pid, 1); // deployer vota FOR (50 token = 100%)

            // Deve essere Succeeded immediatamente (prima della fine del period)
            expect(await governor.state(pid)).to.equal(4); // Succeeded
        });

        it("resta Active se i FOR sono sopra quorum ma sotto superquorum", async function () {
            // Deployer 30%, alice 70% → deployer vota FOR ma non supera SQ (70%)
            // (Nota: deployer < 70% perché alice ha più token)

            // Ricrea la suite con supply bilanciata
            await token.connect(alice).joinDAO({ value: ethers.parseEther("70") });
            await token.connect(alice).delegate(alice.address);
            await mine(1);
            // Ora deployer ha 50 token (100 ETH), alice ha 35 token (70 ETH)
            // Total = 85. 70% SQ = 59.5 token. Deployer ha 50 → sotto SQ

            const tx  = await governor.proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "SuperQ partial", 0
            );
            const pid = await getProposalId(governor, tx);

            await mine(VOTING_DELAY + 1);
            await governor.castVote(pid, 1); // deployer FOR (50 token, sotto SQ)

            // Deve restare Active (non ha raggiunto il superquorum)
            expect(await governor.state(pid)).to.equal(1); // Active

            // Alla fine del period, deve essere Succeeded (quorum 20% superato)
            await mine(VOTING_PERIOD + 1);
            expect(await governor.state(pid)).to.equal(4); // Succeeded
        });

        it("superQuorumForProposal = superQuorumNumerator% × totalVotingPowerTopic", async function () {
            const tx  = await governor.proposeWithTopic(
                [ethers.ZeroAddress], [0n], ["0x"], "SQ getter", 0
            );
            const pid = await getProposalId(governor, tx);
            await mine(VOTING_DELAY + 1);
            const sq  = await governor.superQuorumForProposal(pid);

            // stakeSupply = 50 token, SQ 70% → 35 token
            expect(sq).to.equal(ethers.parseEther("35"));
        });
    });

    // ========================================================================
    //  SEZIONE 6 — Parametri di governance e Clock
    // ========================================================================
    describe("6. Parametri di governance", function () {

        it("nome governatore corretto", async function () {
            expect(await governor.name()).to.equal("MyGovernor");
        });

        it("votingDelay, votingPeriod e proposalThreshold correttamente impostati", async function () {
            expect(await governor.votingDelay()).to.equal(VOTING_DELAY);
            expect(await governor.votingPeriod()).to.equal(VOTING_PERIOD);
            expect(await governor.proposalThreshold()).to.equal(0n);
        });

        it("quorumDenominator = 100 (percentuali intere)", async function () {
            expect(await governor.quorumDenominator()).to.equal(100n);
        });
    });
});
