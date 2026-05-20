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

I topic e gli score sono definiti in SkillCalculator:
  0 Web3 Infrastructure, 1 AI Products, 2 Digital Health, 3 Enterprise Software.
Le VC assegnano skill realistiche come smart-contracts, tokenomics,
machine-learning, digital-health, data-analysis e backend-java.
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

const TOPIC_LABELS: Record<number, string> = {
    0: "Web3",
    1: "AI",
    2: "Health",
    3: "Enterprise",
};

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
    for (let t = 0; t < 4; t++) {
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
    //  PROPOSTA A — topic Web3
    //  Votano i membri con skill forti su smart contracts e tokenomics.
    // ══════════════════════════════════════════════════════════════════════════
    console.log("🅰️  PROPOSTA A — topic Web3:");
    await governor.connect(signers[0]).castVote(pA.id, FOR);  // web3 lead
    await governor.connect(signers[1]).castVote(pA.id, FOR);  // web3 lead
    await governor.connect(signers[2]).castVote(pA.id, FOR);  // protocol analyst
    await governor.connect(signers[10]).castVote(pA.id, FOR); // tokenomics analyst
    await printProposalStatus("Proposta A", pA);

    // ══════════════════════════════════════════════════════════════════════════
    //  PROPOSTA B — topic AI
    //  Votano i membri con machine-learning e data-analysis.
    //  Risultato atteso: Succeeded a fine periodo.
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n🅱️  PROPOSTA B — topic AI:");
    await governor.connect(signers[3]).castVote(pB.id, FOR);     // ai product lead
    await governor.connect(signers[6]).castVote(pB.id, FOR);     // ml engineer
    await governor.connect(signers[8]).castVote(pB.id, FOR);     // data analyst
    await governor.connect(signers[0]).castVote(pB.id, AGAINST); // web3 lead
    await printProposalStatus("Proposta B", pB);

    // ══════════════════════════════════════════════════════════════════════════
    //  PROPOSTA C — topic Digital Health
    //  I membri health votano FOR, altri gruppi votano AGAINST.
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n🅲  PROPOSTA C — topic Digital Health:");
    await governor.connect(signers[4]).castVote(pC.id, FOR);     // health tech lead
    await governor.connect(signers[7]).castVote(pC.id, FOR);     // health analyst
    await governor.connect(signers[0]).castVote(pC.id, AGAINST); // web3 lead
    await governor.connect(signers[1]).castVote(pC.id, AGAINST); // web3 lead
    await governor.connect(signers[2]).castVote(pC.id, AGAINST); // protocol analyst
    await printProposalStatus("Proposta C", pC);

    // ══════════════════════════════════════════════════════════════════════════
    //  PROPOSTA D — topic Enterprise
    //  Votano solo membri con VP limitato sul topic.
    // ══════════════════════════════════════════════════════════════════════════
    console.log("\n🅳  PROPOSTA D — topic Enterprise:");
    await governor.connect(signers[9]).castVote(pD.id, FOR);  // backend engineer
    await governor.connect(signers[12]).castVote(pD.id, FOR); // junior data analyst
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
