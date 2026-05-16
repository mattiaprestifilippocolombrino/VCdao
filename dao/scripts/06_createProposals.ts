/*
06_createProposals.ts — Crea 4 proposte di investimento multi-topic
ESECUZIONE: npx hardhat run scripts/06_createProposals.ts --network localhost

PREREQUISITI: 05_depositTreasury.ts già eseguito.

FLUSSO DI UNA PROPOSTA:
  proposeWithTopic() → (votingDelay) → Active → castVote() →
  (votingPeriod) → Succeeded/Defeated → queue() → (timelockDelay) → execute()

Le proposte sono associate a un topicId (0=CS, 1=CE, 2=EE) tramite proposeWithTopic().
Il topicId influenza il VP skill usato nel voto e il calcolo del quorum.

PROPOSTE CREATE:
  A — "Lab AI"      (10 ETH, topic CS) → vince con SUPERQUORUM (ProfessorCS dominanti)
  B — "Robotica"    (5 ETH,  topic CE) → vince a fine periodo (maggioranza FOR)
  C — "Sensori EE"  (7 ETH,  topic EE) → quorum raggiunto, ma AGAINST > FOR → Defeated
  D — "Fondo Gen."  (1 ETH,  topic CS) → sotto quorum (solo BachelorCS votano) → Defeated

Gli ID e i parametri delle proposte vengono salvati in proposalState.json
per essere letti dagli script 07 e 08.
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";

// Costanti topic — devono corrispondere alle costanti di GovernanceToken.sol
const TOPIC_CS = 0;
const TOPIC_CE = 1;
const TOPIC_EE = 2;
const TOPIC_LABELS: Record<number, string> = { 0: "CS", 1: "CE", 2: "EE" };

async function main() {
    console.log("══════════════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Creazione proposte multi-topic");
    console.log("══════════════════════════════════════════════════════════\n");

    // Carica gli indirizzi persistiti dal deploy.
    const addresses = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8")
    );
    const treasury  = await ethers.getContractAt("Treasury",   addresses.treasury);
    const governor  = await ethers.getContractAt("MyGovernor", addresses.governor);
    const startupId = BigInt(addresses.mockStartupId ?? 0);

    // ── Definizione proposte ──────────────────────────────────────────────────
    // Ogni proposta chiama Treasury.investStartup(startupId, amount) tramite il Timelock.
    // Le proposte vengono associate al topic tramite proposeWithTopic().
    const proposals = [
        {
            amount:  "10",
            topicId: TOPIC_CS,
            desc:    "Proposta A: Investire 10 ETH in Laboratorio AI (Computer Science)",
            // Risultato atteso: SUPERQUORUM → Succeeded early
        },
        {
            amount:  "5",
            topicId: TOPIC_CE,
            desc:    "Proposta B: Investire 5 ETH in Progetto Robotica (Computer Engineering)",
            // Risultato atteso: Succeeded a fine periodo (quorum raggiunto, FOR > AGAINST)
        },
        {
            amount:  "7",
            topicId: TOPIC_EE,
            desc:    "Proposta C: Investire 7 ETH in Sensori EE (Electronic Engineering)",
            // Risultato atteso: Defeated (quorum raggiunto, ma AGAINST > FOR)
        },
        {
            amount:  "1",
            topicId: TOPIC_CS,
            desc:    "Proposta D: Investire 1 ETH in Fondo Generale (Computer Science)",
            // Risultato atteso: Defeated (sotto quorum — solo Bachelor votano)
        },
    ];

    const proposalIds: string[] = [];

    for (const p of proposals) {
        // Codifica il calldata per la chiamata investStartup(startupId, amount).
        // Il calldata è identico a quello che verrà eseguito dal Timelock dopo l'approvazione.
        const calldata = treasury.interface.encodeFunctionData("investStartup", [
            startupId, ethers.parseEther(p.amount),
        ]);

        // proposeWithTopic() sostituisce il propose() standard.
        // Salva internamente il topicId in proposalTopic[proposalId] e lo usa
        // durante il voto per calcolare il VP e il quorum del topic.
        const tx      = await governor.proposeWithTopic(
            [addresses.treasury],  // target: Treasury
            [0n],                  // value: 0 ETH (nessun ETH inviato al target)
            [calldata],            // calldata: investStartup codificato
            p.desc,                // descrizione (hash usato per queue/execute)
            p.topicId              // topicId della proposta
        );
        const receipt = await tx.wait();

        // Estrae il proposalId dall'evento ProposalCreated emesso dal Governor.
        const proposalId = receipt!.logs
            .map((log: any) => {
                try { return governor.interface.parseLog(log); } catch { return null; }
            })
            .find((pr: any) => pr?.name === "ProposalCreated")?.args?.proposalId;

        proposalIds.push(proposalId.toString());

        console.log(`   📝 ${p.desc}`);
        console.log(`      Topic: ${TOPIC_LABELS[p.topicId]} (ID=${p.topicId}) | ProposalID: ${proposalId}`);
        console.log(`      Calldata: investStartup(startupId=${startupId}, amount=${p.amount} ETH)\n`);
    }

    // Salva lo stato completo delle proposte in proposalState.json.
    // Gli script 07 e 08 leggeranno questo file per votare ed eseguire.
    const state = {
        proposals: proposals.map((p, i) => ({
            ...p,
            id: proposalIds[i],
        })),
    };
    fs.writeFileSync(
        path.join(__dirname, "..", "proposalState.json"),
        JSON.stringify(state, null, 2)
    );

    console.log("══════════════════════════════════════════════════════════");
    console.log("  ✅ 4 proposte create! Prossimo: 07_voteOnProposals.ts");
    console.log("══════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
