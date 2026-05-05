/*
07_voteOnProposals.ts — Votazione + Queue delle proposte multi-topic

Il voting power di ogni membro dipende dal topic della proposta:
  VP = stakeVP + skillVP(topic)

Il voto viene emesso con castVote() — il topicId viene iniettato automaticamente
dal contratto MyGovernor._castVote() a partire da proposalTopic[proposalId].

Distribuzione signer post-upgrade (signerIndex → grado → VP per topic):
  0: ProfessorCS → CS:100%, CE:75%, EE:75% score
  1: ProfessorCS → idem
  2: ProfessorCS → idem
  3: ProfessorCE → CE:100%, CS:75%, EE:75%
  4: ProfessorEE → EE:100%, CS:75%, CE:75%
  5: PhDCS       → CS:75%, CE:50%, EE:50%
  6: PhDCS       → idem
  7: PhDCE       → CE:75%, CS:50%, EE:50%
  8: MasterCS    → CS:50%, CE:25%, EE:25%
  9: MasterCS    → idem
  10: MasterCE   → CE:50%, CS:25%, EE:25%
  11: BachelorCS → CS:25%, CE:0%, EE:0%
  12: BachelorCS → idem

Supply stimate (con pesoSoldi=pesoCompetenze=5000bp, 100ETH deposito):
  Stake supply: 50 COMP × 13 = 650 COMP (per comodità esempio)
  Skill supply varia per topic.

ESECUZIONE: npx hardhat run scripts/07_voteOnProposals.ts --network localhost
*/

import { ethers } from "hardhat";
import { mine }   from "@nomicfoundation/hardhat-network-helpers";
import * as fs    from "fs";
import * as path  from "path";

const FOR     = 1;
const AGAINST = 0;

const STATES: Record<number, string> = {
  0: "Pending", 1: "Active", 2: "Canceled",
  3: "Defeated", 4: "Succeeded", 5: "Queued",
  6: "Expired",  7: "Executed",
};

const TOPIC_LABELS: Record<number, string> = { 0: "CS", 1: "CE", 2: "EE" };

async function main() {
  const signers = await ethers.getSigners();

  console.log("══════════════════════════════════════════════════");
  console.log("  CompetenceDAO — Votazione + Queue (multi-topic)");
  console.log("══════════════════════════════════════════════════\n");

  const addresses = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8"));
  const governor  = await ethers.getContractAt("MyGovernor",      addresses.governor);
  const treasury  = await ethers.getContractAt("Treasury",        addresses.treasury);
  const token     = await ethers.getContractAt("GovernanceToken", addresses.token);
  const pState    = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "proposalState.json"), "utf8"));
  const [pA, pB, pC, pD] = pState.proposals;

  // Stampa supply e quorum stimati (su base stake only, per display).
  const stakeSupply = await token.totalSupply();
  console.log(`📊 Supply stake totale: ${ethers.formatUnits(stakeSupply, 18)} COMP`);
  for (let t = 0; t < 3; t++) {
    const skillSup = await token.getTotalSkillSupply(t);
    console.log(`   Supply skill ${TOPIC_LABELS[t]}: ${ethers.formatUnits(skillSup, 18)} VP`);
  }
  console.log();

  // Avanzamento del votingDelay.
  console.log("⏳ Avanzamento votingDelay (1 blocco)...");
  await mine(2);

  // Helper: stampa stato proposta.
  async function printProposalStatus(label: string, proposal: any) {
    const [against, forV, abstain] = await governor.proposalVotes(proposal.id);
    const total = forV + against;
    const state = STATES[Number(await governor.state(proposal.id))];
    const pct   = total > 0n ? Number((forV * 100n) / total) : 0;
    console.log(`   📊 ${label} [topic ${TOPIC_LABELS[proposal.topicId]}]: FOR=${ethers.formatUnits(forV,18)} AGAINST=${ethers.formatUnits(against,18)} (${pct}% FOR) → ${state}`);
  }

  // ══════════════════════════════════════════════════════════════════════
  //  PROPOSTA A — topic CS — SUPERQUORUM
  //  ProfessorCS (signers 0,1,2) hanno VP massimo su CS → superquorum atteso
  // ══════════════════════════════════════════════════════════════════════
  console.log("🅰️  PROPOSTA A — topic CS — Superquorum:");
  await governor.connect(signers[0]).castVote(pA.id, FOR);  // ProfessorCS 1
  await governor.connect(signers[1]).castVote(pA.id, FOR);  // ProfessorCS 2
  await governor.connect(signers[2]).castVote(pA.id, FOR);  // ProfessorCS 3
  await governor.connect(signers[3]).castVote(pA.id, FOR);  // ProfessorCE (75% su CS)
  await printProposalStatus("Proposta A", pA);

  // ══════════════════════════════════════════════════════════════════════
  //  PROPOSTA B — topic CE — Quorum + >50% FOR
  //  ProfessorCE (signer 3) e PhDCE (signer 7) → FOR
  //  ProfessorCS (signer 0) vota AGAINST (ha 75% su CE)
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n🅱️  PROPOSTA B — topic CE — Quorum raggiunto + maggioranza FOR:");
  await governor.connect(signers[3]).castVote(pB.id, FOR);    // ProfessorCE
  await governor.connect(signers[7]).castVote(pB.id, FOR);    // PhDCE
  await governor.connect(signers[10]).castVote(pB.id, FOR);   // MasterCE
  await governor.connect(signers[0]).castVote(pB.id, AGAINST);// ProfessorCS (75% su CE)
  await printProposalStatus("Proposta B", pB);

  // ══════════════════════════════════════════════════════════════════════
  //  PROPOSTA C — topic EE — Quorum raggiunto ma AGAINST vince
  //  ProfessorEE (signer 4) → FOR
  //  ProfessorCS (signers 0,1,2) → AGAINST (hanno 75% su EE)
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n🅲  PROPOSTA C — topic EE — Quorum raggiunto, perde:");
  await governor.connect(signers[4]).castVote(pC.id, FOR);     // ProfessorEE
  await governor.connect(signers[5]).castVote(pC.id, FOR);     // PhDCS (50% su EE)
  await governor.connect(signers[0]).castVote(pC.id, AGAINST); // ProfessorCS (75% su EE)
  await governor.connect(signers[1]).castVote(pC.id, AGAINST); // ProfessorCS (75% su EE)
  await governor.connect(signers[2]).castVote(pC.id, AGAINST); // ProfessorCS (75% su EE)
  await printProposalStatus("Proposta C", pC);

  // ══════════════════════════════════════════════════════════════════════
  //  PROPOSTA D — topic CS — Sotto quorum
  //  Solo BachelorCS (signers 11,12) votano FOR — partecipazione insufficiente
  // ══════════════════════════════════════════════════════════════════════
  console.log("\n🅳  PROPOSTA D — topic CS — Sotto quorum:");
  await governor.connect(signers[11]).castVote(pD.id, FOR); // BachelorCS
  await governor.connect(signers[12]).castVote(pD.id, FOR); // BachelorCS
  await printProposalStatus("Proposta D", pD);

  // Avanza il voting period.
  console.log("\n⏳ Avanzamento voting period (50 blocchi)...");
  await mine(51);

  // Stato finale.
  console.log("\n📊 Stato finale:");
  const LABELS = ["A", "B", "C", "D"];
  for (let i = 0; i < 4; i++) {
    const s    = Number(await governor.state(pState.proposals[i].id));
    const icon = s === 4 ? "✅" : "❌";
    console.log(`   ${icon} Proposta ${LABELS[i]} [${TOPIC_LABELS[pState.proposals[i].topicId]}]: ${STATES[s]}`);
  }

  // Queue delle proposte vincenti.
  console.log("\n🔒 Queue delle proposte vincenti...");
  for (let i = 0; i < 4; i++) {
    const p = pState.proposals[i];
    if (Number(await governor.state(p.id)) !== 4) continue;

    const calldata = treasury.interface.encodeFunctionData("invest", [
      addresses.mockStartup, ethers.parseEther(p.amount),
    ]);
    await governor.queue([addresses.treasury], [0n], [calldata], ethers.id(p.desc));
    console.log(`   🔒 Proposta ${LABELS[i]} [${TOPIC_LABELS[p.topicId]}] in coda`);
  }

  console.log("\n══════════════════════════════════════════════════");
  console.log("  ✅ Voto e queue completati! Prossimo: 08_executeProposals.ts");
  console.log("══════════════════════════════════════════════════");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
