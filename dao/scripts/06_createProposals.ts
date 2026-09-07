/*
06_createProposals.ts — Crea 4 proposte di investimento multi-topic
ESECUZIONE: npx hardhat run scripts/06_createProposals.ts --network localhost

PREREQUISITI: 05_depositTreasury.ts già eseguito.

FLUSSO DI UNA PROPOSTA:
  proposeWithTopic() → (votingDelay) → Active → castVote() →
  (votingPeriod) → Succeeded/Defeated → queue() → (timelockDelay) → execute()

Le proposte sono associate a un topicId tramite proposeWithTopic().
Il topicId influenza il VP skill usato nel voto e il calcolo del quorum.

PROPOSTE CREATE:
  A — Piattaforma AI decisionale  (10 ETH, topic AI & Data)
  B — Infrastruttura zero-trust    (5 ETH,  topic Cloud & Cybersecurity)
  C — Protocollo pagamenti         (7 ETH,  topic FinTech & Blockchain)
  D — Piattaforma ERP SaaS         (1 ETH,  topic Enterprise Software)

Gli ID e i parametri delle proposte vengono salvati in proposalState.json
per essere letti dagli script 07 e 08.
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";
import {
    TOPIC_AI_DATA,
    TOPIC_CLOUD_CYBERSECURITY,
    TOPIC_ENTERPRISE_SOFTWARE,
    TOPIC_FINTECH_BLOCKCHAIN,
    TOPIC_LABELS,
} from "../../veramo/types/credentials";

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
            topicId: TOPIC_AI_DATA,
            desc:    "Proposta A: Investire 10 ETH in una piattaforma AI decisionale",
            // Risultato atteso: SUPERQUORUM → Succeeded early
        },
        {
            amount:  "5",
            topicId: TOPIC_CLOUD_CYBERSECURITY,
            desc:    "Proposta B: Investire 5 ETH in infrastruttura cloud zero-trust",
            // Risultato atteso: Succeeded a fine periodo (quorum raggiunto, FOR > AGAINST)
        },
        {
            amount:  "7",
            topicId: TOPIC_FINTECH_BLOCKCHAIN,
            desc:    "Proposta C: Investire 7 ETH in un protocollo di pagamenti decentralizzato",
            // Risultato atteso: Defeated (quorum raggiunto, ma AGAINST > FOR)
        },
        {
            amount:  "1",
            topicId: TOPIC_ENTERPRISE_SOFTWARE,
            desc:    "Proposta D: Investire 1 ETH in una piattaforma ERP SaaS",
            // Risultato atteso: Defeated (sotto quorum — pochi membri votano)
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
