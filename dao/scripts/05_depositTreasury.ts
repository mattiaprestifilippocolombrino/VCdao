/*
05_depositTreasury.ts — Mint aggiuntivo di token (ETH → Treasury)
Script in cui i membri della DAOmintano nuovi token inviando ETH tramite mintTokens().
I token ricevuti tengono conto del grado di competenza attuale.
Gli ETH vengono automaticamente trasferiti al Treasury della DAO.
I baseTokens del membro vengono aggiornati per futuri calcoli di upgrade.

ESECUZIONE: npx hardhat run scripts/05_depositTreasury.ts --network localhost
// ============================================================================
*/

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
    const signers = await ethers.getSigners();

    console.log("══════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Mint aggiuntivo di token");
    console.log("══════════════════════════════════════════════════\n");

    // Carica gli indirizzi dei contratti salvati dallo script 01
    const addressesPath = path.join(__dirname, "..", "deployedAddresses.json");
    const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));

    // Riconnettiti ai contratti GovernanceToken e Treasury
    const token = await ethers.getContractAt("GovernanceToken", addresses.token);
    const treasury = await ethers.getContractAt("Treasury", addresses.treasury);

    // Lista dei membri che mintano token aggiuntivi.
    // I Professors hanno più ETH rimasti → depositano di più.
    // I token mintati vengono moltiplicati per il coefficiente di competenza
    // (dopo gli upgrade dello script 04).
    const mints = [
        { signer: signers[1], eth: "20", label: "Professor 2" },  // 80 + 20 = 100
        { signer: signers[2], eth: "10", label: "Professor 3" },  // 90 + 10 = 100
        { signer: signers[3], eth: "30", label: "Professor 4" },  // 70 + 30 = 100
        { signer: signers[4], eth: "30", label: "Professor 5" },  // 60 + 30 = 90
        { signer: signers[5], eth: "10", label: "PhD 1" },        // 30 + 10 = 40
        { signer: signers[6], eth: "8", label: "PhD 2" },         // 25 + 8 = 33
        { signer: signers[8], eth: "5", label: "Master 1" },      // 15 + 5 = 20
        { signer: signers[10], eth: "2", label: "Bachelor 1" },   // 8 + 2 = 10
    ];

    // Per ogni membro:
    //   1. Salva il saldo token prima del mint
    //   2. Chiama mintTokens() → invia ETH, riceve COMP moltiplicati
    //   3. Calcola la differenza per mostrare quanti token sono stati mintati
    for (const m of mints) {
        const balBefore = await token.balanceOf(m.signer.address);
        await token.connect(m.signer).mintTokens({ value: ethers.parseEther(m.eth) });
        const balAfter = await token.balanceOf(m.signer.address);
        const minted = ethers.formatUnits(balAfter - balBefore, 18);
        console.log(`   💰 ${m.label}: ${m.eth} ETH → +${minted} COMP`);
    }

    // Riepilogo: saldo Treasury e supply totale
    const balance = await treasury.getBalance();
    const supply = await token.totalSupply();
    console.log(`\n   🏦 Saldo Treasury: ${ethers.formatEther(balance)} ETH`);
    console.log(`   📊 Supply totale:  ${ethers.formatUnits(supply, 18)} COMP`);
    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ Mint completato! Prossimo: 06_createProposals.ts");
    console.log("══════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
