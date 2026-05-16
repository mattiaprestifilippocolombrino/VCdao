/*
08_executeProposals.ts — Esecuzione proposte approvate + riepilogo finale
ESECUZIONE: npx hardhat run scripts/08_executeProposals.ts --network localhost

PREREQUISITI: 07_voteOnProposals.ts già eseguito (proposte A e B in stato Queued).

FLUSSO DI ESECUZIONE:
  1. Viene avanzato il tempo di 1 ora + 1 secondo (delay del Timelock).
     Il Timelock impedisce l'esecuzione immediata per dare alla comunità
     il tempo di reagire a proposte potenzialmente malevole.
  2. Per ogni proposta in stato Queued (5), viene ricostruito il calldata
     identico a quello della proposta originale e si chiama execute().
  3. Il Governor invia il calldata al Timelock, che lo esegue chiamando
     Treasury.investStartup(startupId, amount).
  4. Il Treasury verifica che la startup sia attiva nel registry e trasferisce
     gli ETH al wallet della startup.
  5. Viene stampato il riepilogo finale: stato proposte, bilanci Treasury
     e startup, storico investedIn del Treasury.

RISULTATO ATTESO:
  - Proposta A: ESEGUITA — 10 ETH investiti nella MockStartup
  - Proposta B: ESEGUITA —  5 ETH investiti nella MockStartup
  - Proposta C: DEFEATED  — quorum raggiunto, but AGAINST > FOR
  - Proposta D: DEFEATED  — sotto quorum
*/

import { ethers } from "hardhat";
import { time }   from "@nomicfoundation/hardhat-network-helpers";
import * as fs    from "fs";
import * as path  from "path";

// Mappa degli stati interi del Governor agli stati testuali.
const STATES: Record<number, string> = {
    0: "Pending", 1: "Active",    2: "Canceled",
    3: "Defeated", 4: "Succeeded", 5: "Queued",
    6: "Expired",  7: "Executed",
};

const TOPIC_LABELS: Record<number, string> = { 0: "CS", 1: "CE", 2: "EE" };

async function main() {
    console.log("══════════════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Esecuzione proposte + Riepilogo finale");
    console.log("══════════════════════════════════════════════════════════\n");

    // Carica indirizzi e stato proposte dai file JSON persistiti.
    const addresses = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8")
    );
    const governor   = await ethers.getContractAt("MyGovernor",   addresses.governor);
    const treasury   = await ethers.getContractAt("Treasury",     addresses.treasury);
    const mockStartup = await ethers.getContractAt("MockStartup", addresses.mockStartup);
    const pState     = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "proposalState.json"), "utf8")
    );
    const startupId  = BigInt(addresses.mockStartupId ?? 0);
    const LABELS     = ["A", "B", "C", "D"];

    // Saldo del Treasury PRIMA dell'esecuzione (per calcolare il delta finale).
    const balBefore = await treasury.getBalance();
    console.log(`🏦 Treasury PRIMA dell'esecuzione: ${ethers.formatEther(balBefore)} ETH\n`);

    // ── Avanzamento delay Timelock ────────────────────────────────────────────
    // Il Timelock è configurato con un delay di 1 ora (3600 secondi).
    // Aggiungiamo 1 secondo extra per sicurezza contro off-by-one del timestamp.
    // In produzione questo è il periodo durante il quale i detentori di token
    // possono analizzare la proposta e uscire dalla DAO se non d'accordo.
    console.log("⏳ Avanzamento delay Timelock (1 ora + 1 secondo)...");
    await time.increase(3601);
    console.log("   ✔  Delay trascorso. Proposte pronte per l'esecuzione.\n");

    // ── Esecuzione delle proposte in coda ─────────────────────────────────────
    // Solo le proposte in stato Queued (5) possono essere eseguite.
    // execute() è chiamabile da chiunque (EXECUTOR_ROLE = address(0)):
    // questa è la caratteristica "permissionless execution" del Timelock.
    console.log("🚀 Esecuzione proposte vincenti:");
    let executedCount = 0;
    for (let i = 0; i < 4; i++) {
        const p = pState.proposals[i];

        // Controlla che la proposta sia effettivamente in stato Queued.
        const currentState = Number(await governor.state(p.id));
        if (currentState !== 5) {
            console.log(`   ⏭️  Proposta ${LABELS[i]} [${TOPIC_LABELS[p.topicId]}]: saltata (${STATES[currentState]})`);
            continue;
        }

        // Ricostruisce il calldata identico a quello della proposta originale.
        // Il calldata deve essere bit-per-bit identico: il Timelock verifica
        // l'operationId come keccak256(targets, values, calldatas, descriptionHash).
        const calldata = treasury.interface.encodeFunctionData("investStartup", [
            startupId, ethers.parseEther(p.amount),
        ]);

        // execute() chiede al Timelock di eseguire investStartup() sul Treasury.
        // Il Treasury verifica che la startup sia attiva e trasferisce gli ETH.
        const tx      = await governor.execute(
            [addresses.treasury], [0n], [calldata], ethers.id(p.desc)
        );
        const receipt = await tx.wait();

        console.log(
            `   🚀 Proposta ${LABELS[i]} [topic=${TOPIC_LABELS[p.topicId]}]: ESEGUITA — ` +
            `${p.amount} ETH investiti | gas usato: ${receipt!.gasUsed.toLocaleString()}`
        );
        executedCount++;
    }

    // ── Riepilogo finale ──────────────────────────────────────────────────────
    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  📋 RIEPILOGO FINALE — Pipeline governance completata");
    console.log("══════════════════════════════════════════════════════════\n");

    // Stato finale di ogni proposta.
    console.log("📊 Stato finale di tutte le proposte:");
    for (let i = 0; i < 4; i++) {
        const p = pState.proposals[i];
        const stateNum = Number(await governor.state(p.id));
        const icon = stateNum === 7 ? "✅" : "❌";
        const [against, forV, abstain] = await governor.proposalVotes(p.id);
        console.log(
            `   ${icon} Proposta ${LABELS[i]} [${TOPIC_LABELS[p.topicId]}] (${p.amount} ETH): ` +
            `${STATES[stateNum]} | FOR=${ethers.formatEther(forV)} | AGAINST=${ethers.formatEther(against)}`
        );
    }

    // Bilanci Treasury e startup dopo le esecuzioni.
    const balAfter    = await treasury.getBalance();
    const startupBal  = await mockStartup.getBalance();
    const investedTot = await treasury.investedIn(addresses.mockStartup);
    const delta       = balBefore - balAfter;

    console.log("\n💰 Bilanci finali:");
    console.log(`   🏦 Treasury:             ${ethers.formatEther(balAfter)} ETH   (prima: ${ethers.formatEther(balBefore)} ETH)`);
    console.log(`   🏢 MockStartup:          ${ethers.formatEther(startupBal)} ETH`);
    console.log(`   📉 ETH usciti dal treasury: ${ethers.formatEther(delta)} ETH`);
    console.log(`   📒 investedIn (storico):   ${ethers.formatEther(investedTot)} ETH`);
    console.log(`   🔢 Proposte eseguite:       ${executedCount}/4`);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  ✅ Pipeline CompetenceDAO completata con successo!");
    console.log("  Steps eseguiti: deploy → join → delegate → upgrade →");
    console.log("                  deposit → propose → vote → execute");
    console.log("══════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
