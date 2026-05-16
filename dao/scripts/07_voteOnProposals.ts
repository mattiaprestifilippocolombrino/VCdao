/*
07_voteOnProposals.ts — Votazione + Queue delle proposte multi-topic
ESECUZIONE: npx hardhat run scripts/07_voteOnProposals.ts --network localhost

PREREQUISITI: 06_createProposals.ts già eseguito (proposalState.json presente).

LOGICA DI VOTO MULTI-TOPIC:
  Il VP di ogni membro durante il voto è composto da due parti:
    VP_totale = VP_stake(account, snapshot) + VP_skill(account, topicId, snapshot)

  VP_stake  = token ERC20Votes al blocco di snapshot (checkpoint ERC20Votes)
  VP_skill  = checkpoint skill del membro per il topic della proposta

  Il topicId viene iniettato automaticamente dal contratto MyGovernor._castVote():
  il chiamante usa castVote() normalmente; il Governor legge proposalTopic[proposalId]
  e lo passa a _getVotes() come parametro.

DISTRIBUZIONE VP PER TOPIC (pesi 50/50, post-upgrade):
  Signer  Grado        deposit  VP_stake   CS score  CE score  EE score
  ──────────────────────────────────────────────────────────────────────
  0       ProfessorCS  100 ETH  50 COMP    100       75        75
  1       ProfessorCS  80 ETH   40 COMP    100       75        75
  2       ProfessorCS  90 ETH   45 COMP    100       75        75
  3       ProfessorCE  70 ETH   35 COMP    75        100       75
  4       ProfessorEE  60 ETH   30 COMP    75        75        100
  5       PhDCS        30 ETH   15 COMP    75        50        50
  6       PhDCS        25 ETH   12.5 COMP  75        50        50
  7       PhDCE        20 ETH   10 COMP    50        75        50
  8       MasterCS     15 ETH   7.5 COMP   50        25        25
  9       MasterCS     10 ETH   5 COMP     50        25        25
  10      MasterCE     8 ETH    4 COMP     25        50        25
  11      BachelorCS   5 ETH    2.5 COMP   25        0         0
  12      BachelorCS   6 ETH    3 COMP     25        0         0

RISULTATO ATTESO:
  A (CS):  SUPERQUORUM → Succeeded early   (ProfessorCS dominano: 100% su CS)
  B (CE):  Succeeded a fine periodo         (FOR > AGAINST, quorum raggiunto)
  C (EE):  Defeated                         (AGAINST > FOR, nonostante quorum)
  D (CS):  Defeated                         (sotto quorum, solo Bachelor votano)
*/

import { ethers } from "hardhat";
import { mine }   from "@nomicfoundation/hardhat-network-helpers";
import * as fs    from "fs";
import * as path  from "path";

const FOR     = 1;  // Voto favorevole
const AGAINST = 0;  // Voto contrario

// Mappa degli stati interi del Governor agli stati testuali.
const STATES: Record<number, string> = {
    0: "Pending", 1: "Active",    2: "Canceled",
    3: "Defeated", 4: "Succeeded", 5: "Queued",
    6: "Expired",  7: "Executed",
};

const TOPIC_LABELS: Record<number, string> = { 0: "CS", 1: "CE", 2: "EE" };

async function main() {
    const signers = await ethers.getSigners();

    console.log("══════════════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Votazione + Queue proposte multi-topic");
    console.log("══════════════════════════════════════════════════════════\n");

    // Carica gli indirizzi e lo stato delle proposte.
    const addresses = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8")
    );
    const governor  = await ethers.getContractAt("MyGovernor",      addresses.governor);
    const treasury  = await ethers.getContractAt("Treasury",        addresses.treasury);
    const token     = await ethers.getContractAt("GovernanceToken", addresses.token);
    const pState    = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "proposalState.json"), "utf8")
    );
    const startupId = BigInt(addresses.mockStartupId ?? 0);
    const [pA, pB, pC, pD] = pState.proposals;

    // ── Snapshot supply pre-voto ──────────────────────────────────────────────
    // Stampiamo la supply stake e skill per ogni topic: sono la base su cui
    // vengono calcolati quorum e superquorum.
    const stakeSupply = await token.totalSupply();
    console.log(`📊 Supply totale stake: ${ethers.formatEther(stakeSupply)} COMP`);
    for (let t = 0; t < 3; t++) {
        const skillSup = await token.getTotalSkillSupply(t);
        console.log(`   Supply skill ${TOPIC_LABELS[t]}: ${ethers.formatEther(skillSup)} VP`);
    }
    console.log();

    // ── Avanzamento del voting delay ─────────────────────────────────────────
    // Il Governor impone un VOTING_DELAY di 1 blocco tra la creazione della proposta
    // e l'inizio della finestra di voto. Avanziamo 2 blocchi per sicurezza.
    console.log("⏳ Avanzamento votingDelay (2 blocchi)...\n");
    await mine(2);

    // Helper: stampa lo stato attuale di una proposta con voti e percentuale FOR.
    async function printProposalStatus(label: string, proposal: any) {
        const [against, forV, abstain] = await governor.proposalVotes(proposal.id);
        const total = forV + against + abstain;
        const state = STATES[Number(await governor.state(proposal.id))];
        const pctFor = total > 0n ? Number((forV * 100n) / total) : 0;
        console.log(
            `   📊 ${label} [topic=${TOPIC_LABELS[proposal.topicId]}]: ` +
            `FOR=${ethers.formatEther(forV)} | AGAINST=${ethers.formatEther(against)} | ` +
            `ABSTAIN=${ethers.formatEther(abstain)} | ${pctFor}% FOR → ${state}`
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PROPOSTA A — topic CS — SUPERQUORUM
    //  I tre ProfessorCS (signers 0,1,2) e ProfessorCE (signer 3, 75% su CS)
    //  cumulano abbastanza VP_CS da superare immediatamente il superquorum (70%).
    //  Resultado atteso: Succeeded PRIMA della fine del voting period.
    // ══════════════════════════════════════════════════════════════════════════
    console.log("🅰️  PROPOSTA A — topic CS — SUPERQUORUM:");
    await governor.connect(signers[0]).castVote(pA.id, FOR);  // ProfessorCS 1 (100% su CS)
    await governor.connect(signers[1]).castVote(pA.id, FOR);  // ProfessorCS 2 (100% su CS)
    await governor.connect(signers[2]).castVote(pA.id, FOR);  // ProfessorCS 3 (100% su CS)
    await governor.connect(signers[3]).castVote(pA.id, FOR);  // ProfessorCE   (75% su CS)
    await printProposalStatus("Proposta A", pA);

    // ══════════════════════════════════════════════════════════════════════════
    //  PROPOSTA B — topic CE — Quorum + maggioranza FOR
    //  ProfessorCE (signer 3, 100% su CE), PhDCE (signer 7, 75%) e MasterCE
    //  (signer 10, 50%) votano FOR. ProfessorCS (signer 0, 75% su CE) vota AGAINST.
    //  Risultato atteso: Succeeded a fine periodo.
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n🅱️  PROPOSTA B — topic CE — Quorum + maggioranza FOR:");
    await governor.connect(signers[3]).castVote(pB.id, FOR);     // ProfessorCE  (100% su CE)
    await governor.connect(signers[7]).castVote(pB.id, FOR);     // PhDCE        (75% su CE)
    await governor.connect(signers[10]).castVote(pB.id, FOR);    // MasterCE     (50% su CE)
    await governor.connect(signers[0]).castVote(pB.id, AGAINST); // ProfessorCS  (75% su CE)
    await printProposalStatus("Proposta B", pB);

    // ══════════════════════════════════════════════════════════════════════════
    //  PROPOSTA C — topic EE — Quorum raggiunto, ma AGAINST vince
    //  ProfessorEE (signer 4, 100% su EE) e PhDCS (signer 5, 50% su EE) → FOR.
    //  I tre ProfessorCS (signers 0,1,2, ciascuno 75% su EE) → AGAINST.
    //  Risultato atteso: Defeated (quorum raggiunto, ma FOR < AGAINST).
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n🅲  PROPOSTA C — topic EE — Quorum raggiunto, AGAINST vince:");
    await governor.connect(signers[4]).castVote(pC.id, FOR);     // ProfessorEE  (100% su EE)
    await governor.connect(signers[5]).castVote(pC.id, FOR);     // PhDCS        (50% su EE)
    await governor.connect(signers[0]).castVote(pC.id, AGAINST); // ProfessorCS  (75% su EE)
    await governor.connect(signers[1]).castVote(pC.id, AGAINST); // ProfessorCS  (75% su EE)
    await governor.connect(signers[2]).castVote(pC.id, AGAINST); // ProfessorCS  (75% su EE)
    await printProposalStatus("Proposta C", pC);

    // ══════════════════════════════════════════════════════════════════════════
    //  PROPOSTA D — topic CS — Sotto quorum
    //  Solo BachelorCS (signers 11,12) votano FOR. Il loro VP è troppo basso
    //  per raggiungere il quorum (20% della supply topic CS).
    //  Risultato atteso: Defeated (sotto quorum).
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n🅳  PROPOSTA D — topic CS — Sotto quorum:");
    await governor.connect(signers[11]).castVote(pD.id, FOR); // BachelorCS (25% su CS)
    await governor.connect(signers[12]).castVote(pD.id, FOR); // BachelorCS (25% su CS)
    await printProposalStatus("Proposta D", pD);

    // ── Fine voting period ────────────────────────────────────────────────────
    // Avanziamo 51 blocchi per coprire il voting period (50 blocchi).
    // Dopo questo punto le proposte passano allo stato finale (Succeeded/Defeated).
    console.log("\n⏳ Avanzamento voting period (51 blocchi)...\n");
    await mine(51);

    // ── Stato finale ──────────────────────────────────────────────────────────
    const LABELS = ["A", "B", "C", "D"];
    const proposals = [pA, pB, pC, pD];
    console.log("📊 Stato finale proposte:");
    for (let i = 0; i < 4; i++) {
        const stateNum = Number(await governor.state(proposals[i].id));
        const icon = stateNum === 4 ? "✅" : (stateNum === 7 ? "🚀" : "❌");
        console.log(`   ${icon} Proposta ${LABELS[i]} [topic=${TOPIC_LABELS[proposals[i].topicId]}]: ${STATES[stateNum]}`);
    }

    // ── Queue delle proposte vincenti ────────────────────────────────────────
    // Solo le proposte in stato Succeeded (4) vengono messe in coda nel Timelock.
    // La queue ricostruisce lo stesso calldata usato in proposeWithTopic().
    console.log("\n🔒 Queue proposte Succeeded nel Timelock:");
    for (let i = 0; i < 4; i++) {
        const p = proposals[i];
        if (Number(await governor.state(p.id)) !== 4) continue;

        // Il calldata deve essere identico a quello della proposta originale.
        const calldata = treasury.interface.encodeFunctionData("investStartup", [
            startupId, ethers.parseEther(p.amount),
        ]);
        // descriptionHash è l'ethers.id() (keccak256) della stringa descrizione.
        await governor.queue([addresses.treasury], [0n], [calldata], ethers.id(p.desc));
        console.log(`   🔒 Proposta ${LABELS[i]} [topic=${TOPIC_LABELS[p.topicId]}] → Queued`);
    }

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  ✅ Votazione e queue completate! Prossimo: 08_executeProposals.ts");
    console.log("══════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
