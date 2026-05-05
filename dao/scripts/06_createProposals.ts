/*
06_createProposals.ts — Crea proposte di governance con topic specifico

Le proposte ora sono associate a un topic (0=CS, 1=CE, 2=EE) tramite proposeWithTopic().
Il topic influenza il voting power skill di ogni membro durante la votazione.

Proposte create (3 topic, 4 proposte):
  A — "Lab AI"       (10 ETH) → topic CS → vince con SUPERQUORUM
  B — "Robotica"     (5 ETH)  → topic CE → vince a fine periodo
  C — "Sensori EE"   (7 ETH)  → topic EE → quorum raggiunto, ma perde (AGAINST > FOR)
  D — "Fondo Gen."   (1 ETH)  → topic CS → sotto quorum

Gli ID e i topic delle proposte vengono salvati in proposalState.json.

ESECUZIONE: npx hardhat run scripts/06_createProposals.ts --network localhost
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";

// Topic IDs — devono corrispondere alle costanti in GovernanceToken.
const TOPIC_CS = 0;
const TOPIC_CE = 1;
const TOPIC_EE = 2;
const TOPIC_LABELS: Record<number, string> = { 0: "CS", 1: "CE", 2: "EE" };

async function main() {
  console.log("══════════════════════════════════════════════════");
  console.log("  CompetenceDAO — Creazione proposte multi-topic");
  console.log("══════════════════════════════════════════════════\n");

  const addresses = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8"));
  const treasury  = await ethers.getContractAt("Treasury",   addresses.treasury);
  const governor  = await ethers.getContractAt("MyGovernor", addresses.governor);

  // Definizione delle proposte con topic associato.
  const proposals = [
    { amount: "10", topicId: TOPIC_CS, desc: "Proposta A: Investire 10 ETH in Laboratorio AI (Computer Science)" },
    { amount: "5",  topicId: TOPIC_CE, desc: "Proposta B: Investire 5 ETH in Progetto Robotica (Computer Engineering)" },
    { amount: "7",  topicId: TOPIC_EE, desc: "Proposta C: Investire 7 ETH in Sensori EE (Electronic Engineering)" },
    { amount: "1",  topicId: TOPIC_CS, desc: "Proposta D: Investire 1 ETH in Fondo Generale (Computer Science)" },
  ];

  const proposalIds: string[] = [];

  for (const p of proposals) {
    // Codifica la chiamata invest(startup, importo) come calldata.
    const calldata = treasury.interface.encodeFunctionData("invest", [
      addresses.mockStartup, ethers.parseEther(p.amount),
    ]);

    // Usa proposeWithTopic() per associare il topic alla proposta.
    const tx      = await governor.proposeWithTopic(
      [addresses.treasury], [0n], [calldata], p.desc, p.topicId
    );
    const receipt = await tx.wait();

    // Estrae il proposalId dall'evento ProposalCreated.
    const id = receipt!.logs
      .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
      .find((pr: any) => pr?.name === "ProposalCreated")?.args?.proposalId;

    proposalIds.push(id.toString());
    console.log(`   📝 ${p.desc}`);
    console.log(`      Topic: ${TOPIC_LABELS[p.topicId]} (${p.topicId}) | ID: ${id}`);
  }

  // Salva stato proposte per gli script successivi.
  const state = {
    proposals: proposals.map((p, i) => ({
      ...p,
      id:      proposalIds[i],
      topicId: p.topicId,
    })),
  };
  fs.writeFileSync(path.join(__dirname, "..", "proposalState.json"), JSON.stringify(state, null, 2));

  console.log("\n══════════════════════════════════════════════════");
  console.log("  ✅ Proposte create! Prossimo: 07_voteOnProposals.ts");
  console.log("══════════════════════════════════════════════════");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
