/*
 08_executeProposals.ts — Esecuzione delle proposte approvate + riepilogo

Script che avanza il tempo di 1 ora (delay del Timelock), esegue le proposte vincenti (A e B) 
messe in coda nello script precedente e mostra un riepilogo finale: stato proposte, bilanci Treasury e Startup.
Viene avanzato il tempo di 1 ora per far passare il delay del Timelock.
Trascorso il delay, chiunque può chiamare execute() per eseguire la proposta. 
Viene ricostruito il calldata (deve essere identico a quello della proposta) e inviato al Timelock.
L'execute() chiama la funzione della proposta, treasury.invest(startup, importo) che trasferisce ETH alla startup.


//  RISULTATO ATTESO:
//  ────────────────
//  - Proposta A: ESEGUITA — 10 ETH investiti nella startup
//  - Proposta B: ESEGUITA — 3 ETH investiti nella startup
//  - Proposta C: BOCCIATA — quorum raggiunto, ma la maggioranza ha votato AGAINST
//  - Proposta D: BOCCIATA — non ha raggiunto il quorum minimo (20%)
//
//  ESECUZIONE: npx hardhat run scripts/08_executeProposals.ts --network localhost
// ============================================================================
*/
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";

// Mappa degli stati delle proposte
const STATES: Record<number, string> = {
    0: "Pending", 1: "Active", 3: "Defeated", 4: "Succeeded", 5: "Queued", 7: "Executed",
};

async function main() {
    console.log("══════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Esecuzione proposte");
    console.log("══════════════════════════════════════════════════\n");

    // Carica indirizzi contratti e stato proposte
    const addresses = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8"));
    const governor = await ethers.getContractAt("MyGovernor", addresses.governor);
    const treasury = await ethers.getContractAt("Treasury", addresses.treasury);
    const mockStartup = await ethers.getContractAt("MockStartup", addresses.mockStartup);
    const pState = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "proposalState.json"), "utf8"));

    // Saldo Treasury PRIMA dell'esecuzione (per calcolare quanto è stato investito)
    const balBefore = await treasury.getBalance();
    console.log(`🏦 Treasury PRIMA: ${ethers.formatEther(balBefore)} ETH\n`);

    // Avanziamo il tempo di 1 ora + 1 secondo (delay del Timelock)
    // Questo è necessario perché il Timelock impedisce l'esecuzione immediata
    // per dare tempo alla comunità di reagire in caso di proposte malevole.
    console.log("⏳ Avanzamento delay Timelock (1 ora)...");
    await time.increase(3601);

    // ── Esecuzione delle proposte vincenti ──
    // Proviamo a eseguire le prime 2 proposte (A e B).
    // Solo quelle con stato Queued (5) vengono eseguite.
    // L'execute() ricostruisce la stessa chiamata invest() e la invia via Timelock.
    const LABELS = ["A", "B", "C", "D"];
    for (let i = 0; i < 4; i++) {
        const p = pState.proposals[i];

        // Verifica che la proposta sia in stato Queued (5)
        if (Number(await governor.state(p.id)) !== 5) continue;

        // Ricostruisci il calldata (deve essere identico a quello della proposta)
        const calldata = treasury.interface.encodeFunctionData("invest", [
            addresses.mockStartup, ethers.parseEther(p.amount),
        ]);

        // Esegui la proposta: il Governor chiede al Timelock di eseguire invest()
        await governor.execute([addresses.treasury], [0n], [calldata], ethers.id(p.desc));
        console.log(`   🚀 Proposta ${LABELS[i]} ESEGUITA — ${p.amount} ETH investiti`);
    }

    // ── RIEPILOGO FINALE ──
    console.log("\n══════════════════════════════════════════════════");
    console.log("  📋 RIEPILOGO FINALE");
    console.log("══════════════════════════════════════════════════\n");

    // Stato finale di tutte le 4 proposte
    console.log("📊 Stato proposte:");
    for (let i = 0; i < 4; i++) {
        const s = Number(await governor.state(pState.proposals[i].id));
        const icon = s === 7 ? "✅" : "❌";  // ✅ se Executed, ❌ altrimenti
        console.log(`   ${icon} ${LABELS[i]} (${pState.proposals[i].amount} ETH): ${STATES[s]}`);
    }

    // Bilanci finali: quanto è rimasto nel Treasury e quanto ha ricevuto la startup
    const balAfter = await treasury.getBalance();
    const startupBal = await mockStartup.getBalance();
    console.log(`\n💰 Bilanci:`);
    console.log(`   🏦 Treasury:    ${ethers.formatEther(balAfter)} ETH`);
    console.log(`   🏢 Startup:     ${ethers.formatEther(startupBal)} ETH`);
    console.log(`   📉 Investito:   ${ethers.formatEther(balBefore - balAfter)} ETH`);

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ Pipeline completata!");
    console.log("══════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
