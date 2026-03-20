/* 
07_voteOnProposals.ts — Votazione e Queue delle proposte

Script che avanza il votingDelay (1 blocco) per entrare nella fase di voto, 
i membri votano sulle 4 proposte create nello script precedente, 
avanza il votingPeriod (50 blocchi) per chiudere le votazioni e 
mette in coda le proposte vincenti nel Timelock.

SUPPLY TOTALE: ~3.507.000 COMP (dopo upgrade + mint)
QUORUM (20%):       ~701.400 COMP — minimo di voti FOR per validità
SUPERQUORUM (70%): ~2.454.900 COMP — soglia per approvazione immediata

SCENARIO DI VOTO:
────────────────
A — SUPERQUORUM (70%): Prof1 (750k) + Prof2 (600k) + Prof3 (675k) + Prof4 (525k)
                          = 2.550.000 FOR (72.7%) → supera il 70% → Succeeded subito!
B — ~63% WIN:    Prof1 (750k) + PhD1 (160k) votano FOR (910.000)
                   Prof5 (450k) + PhD3 (80k) votano AGAINST (530.000)
                   → 63% FOR, quorum raggiunto → approvata a fine period
C — QUORUM MA PERDE: Prof5 (450k) + PhD1 (160k) + PhD2 (132k) votano FOR (742.000)
                   Prof1 (750k) + Prof2 (600k) votano AGAINST (1.350.000)
                   → 35% FOR → bocciata
D — SOTTO QUORUM: Bachelor2 (10k) + Bachelor3 (12k) + Student1 (2k) + Student2 (1k)
                   = 25.000 FOR → molto sotto il 20% → bocciata

VALORI DI VOTO: 0 = AGAINST (contrario), 1 = FOR (favorevole)

ESECUZIONE: npx hardhat run scripts/07_voteOnProposals.ts --network localhost
*/
import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";

// Costanti per i voti (OpenZeppelin GovernorCountingSimple)
const FOR = 1, AGAINST = 0;

// Mappa degli stati delle proposte (enum ProposalState in Governor)
const STATES: Record<number, string> = {
    0: "Pending", 1: "Active", 3: "Defeated", 4: "Succeeded", 5: "Queued", 7: "Executed",
};

async function main() {
    const signers = await ethers.getSigners();

    console.log("══════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Votazione + Queue");
    console.log("══════════════════════════════════════════════════\n");

    // Carica indirizzi contratti e stato delle proposte
    const addresses = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8"));
    const governor = await ethers.getContractAt("MyGovernor", addresses.governor);
    const treasury = await ethers.getContractAt("Treasury", addresses.treasury);
    const token = await ethers.getContractAt("GovernanceToken", addresses.token);
    const pState = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "proposalState.json"), "utf8"));
    const [pA, pB, pC, pD] = pState.proposals;

    // Stampa supply e soglie calcolate
    const supply = await token.totalSupply();
    console.log(`📊 Supply totale: ${ethers.formatUnits(supply, 18)} COMP`);
    console.log(`   Quorum (20%):       ${ethers.formatUnits(supply * 20n / 100n, 18)} COMP`);
    console.log(`   Superquorum (70%):  ${ethers.formatUnits(supply * 70n / 100n, 18)} COMP\n`);

    // Avanziamo il votingDelay (1 blocco + 1) per entrare nella fase Active
    console.log("⏳ Avanzamento votingDelay...");
    await mine(2);

    // ══════════════════════════════════════════════════════════════════════
    //  PROPOSTA A — SUPERQUORUM (approvazione immediata con >70% FOR)
    // ══════════════════════════════════════════════════════════════════════
    //  4 Professors votano FOR:
    //    Prof1 (750k) + Prof2 (600k) + Prof3 (675k) + Prof4 (525k) = 2.550.000
    //    2.550.000 / 3.507.000 = 72.7% → supera il superquorum del 70%!
    console.log("\n🅰️  PROPOSTA A — Superquorum (70%):");
    await governor.connect(signers[0]).castVote(pA.id, FOR);  // Prof1: 750k
    console.log("   🗳️ Prof 1 vota FOR (750.000)");
    await governor.connect(signers[1]).castVote(pA.id, FOR);  // Prof2: 600k
    console.log("   🗳️ Prof 2 vota FOR (600.000)");
    await governor.connect(signers[2]).castVote(pA.id, FOR);  // Prof3: 675k
    console.log("   🗳️ Prof 3 vota FOR (675.000)");
    await governor.connect(signers[3]).castVote(pA.id, FOR);  // Prof4: 525k
    console.log("   🗳️ Prof 4 vota FOR (525.000)");

    // proposalVotes() restituisce [againstVotes, forVotes, abstainVotes]
    const [, fA] = await governor.proposalVotes(pA.id);
    const pctA = Number(fA * 100n / supply);
    const stateA = STATES[Number(await governor.state(pA.id))];
    console.log(`   📊 Totale FOR: ${ethers.formatUnits(fA, 18)} (${pctA}%) → Stato: ${stateA}`);

    // ══════════════════════════════════════════════════════════════════════
    //  PROPOSTA B — Quorum raggiunto + maggioranza FOR (~63%)
    // ══════════════════════════════════════════════════════════════════════
    //  FOR: Prof1 (750k) + PhD1 (160k) = 910.000 → supera quorum 20% (701.400)
    //  AGAINST: Prof5 (450k) + PhD3 (80k) = 530.000
    //  FOR% = 910k / 1.440k = 63% → approvata a fine period
    console.log("\n🅱️  PROPOSTA B — Quorum + ~63% FOR:");
    await governor.connect(signers[0]).castVote(pB.id, FOR);     // Prof1: 750k
    await governor.connect(signers[5]).castVote(pB.id, FOR);     // PhD1: 160k
    await governor.connect(signers[4]).castVote(pB.id, AGAINST); // Prof5: 450k
    await governor.connect(signers[7]).castVote(pB.id, AGAINST); // PhD3: 80k

    const [agB, fB] = await governor.proposalVotes(pB.id);
    console.log(`   FOR: ${ethers.formatUnits(fB, 18)} | AGAINST: ${ethers.formatUnits(agB, 18)} (${Number(fB * 100n / (fB + agB))}% FOR)`);

    // ══════════════════════════════════════════════════════════════════════
    //  PROPOSTA C — Quorum raggiunto, ma la maggioranza vota AGAINST
    // ══════════════════════════════════════════════════════════════════════
    //  FOR: Prof5 (450k) + PhD1 (160k) + PhD2 (132k) = 742.000 → supera quorum (701.400)
    //  AGAINST: Prof1 (750k) + Prof2 (600k) = 1.350.000 → maggioranza contraria
    //  FOR% = 742k / 2.092k = 35% → Defeated
    console.log("\n🅲  PROPOSTA C — Quorum raggiunto, ma perde:");
    await governor.connect(signers[4]).castVote(pC.id, FOR);     // Prof5: 450k
    await governor.connect(signers[5]).castVote(pC.id, FOR);     // PhD1: 160k
    await governor.connect(signers[6]).castVote(pC.id, FOR);     // PhD2: 132k
    await governor.connect(signers[0]).castVote(pC.id, AGAINST); // Prof1: 750k
    await governor.connect(signers[1]).castVote(pC.id, AGAINST); // Prof2: 600k

    const [agC, fC] = await governor.proposalVotes(pC.id);
    console.log(`   FOR: ${ethers.formatUnits(fC, 18)} | AGAINST: ${ethers.formatUnits(agC, 18)} (${Number(fC * 100n / (fC + agC))}% FOR)`);

    // ══════════════════════════════════════════════════════════════════════
    //  PROPOSTA D — Sotto quorum (partecipazione insufficiente)
    // ══════════════════════════════════════════════════════════════════════
    //  FOR: Bachelor2 (10k) + Bachelor3 (12k) + Student1 (2k) + Student2 (1k) = 25.000
    //  25.000 / 3.507.000 = 0.7% → molto sotto il quorum del 20% (701.400)
    console.log("\n🅳  PROPOSTA D — Sotto quorum:");
    await governor.connect(signers[11]).castVote(pD.id, FOR);    // Bachelor2: 10k
    await governor.connect(signers[12]).castVote(pD.id, FOR);    // Bachelor3: 12k
    await governor.connect(signers[13]).castVote(pD.id, FOR);    // Student1: 2k
    await governor.connect(signers[14]).castVote(pD.id, FOR);    // Student2: 1k

    const [, fD] = await governor.proposalVotes(pD.id);
    console.log(`   FOR: ${ethers.formatUnits(fD, 18)} (${Number(fD * 100n / supply)}% — sotto quorum del 20%)`);

    // ── Fine del voting period ──
    // Avanziamo di 51 blocchi per chiudere le votazioni.
    // Solo dopo la chiusura le proposte cambiano stato: Succeeded o Defeated.
    console.log("\n⏳ Avanzamento voting period (50 blocchi)...");
    await mine(51);

    // ── Stampa lo stato finale di ogni proposta ──
    const LABELS = ["A", "B", "C", "D"];
    console.log("\n📊 Stato finale:");
    for (let i = 0; i < 4; i++) {
        const s = Number(await governor.state(pState.proposals[i].id));
        const icon = s === 4 ? "✅" : "❌";
        console.log(`   ${icon} Proposta ${LABELS[i]}: ${STATES[s]}`);
    }

    // ── Queue delle proposte vincenti (A e B) ──
    // Solo le proposte con stato Succeeded (4) possono essere messe in coda.
    // Il queue() inserisce la proposta nel Timelock con il delay configurato (1 ora).
    console.log("\n🔒 Queue delle proposte vincenti...");
    for (let i = 0; i < 2; i++) {
        const p = pState.proposals[i];
        if (Number(await governor.state(p.id)) !== 4) continue; // Salta se non Succeeded

        // Ricostruiamo il calldata per la queue (deve essere identico alla proposta)
        const calldata = treasury.interface.encodeFunctionData("invest", [
            addresses.mockStartup, ethers.parseEther(p.amount),
        ]);
        // Il descHash (keccak256 della descrizione) identifica univocamente la proposta
        await governor.queue([addresses.treasury], [0n], [calldata], ethers.id(p.desc));
        console.log(`   🔒 Proposta ${LABELS[i]} in coda`);
    }

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ Voto e queue completati! Prossimo: 08_executeProposals.ts");
    console.log("══════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
