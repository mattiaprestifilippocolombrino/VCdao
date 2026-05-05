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
    // I Professors depositano quantitativi arbitrari di ETH per aumentare il loro stake VP.
    // I token mintati (COMP) rappresentano ora SOLO la componente economica (stake).
    // La componente legata alle skill (competenze) viene tracciata separatamente via Checkpoint manuali
    // (aggiornati dallo script 04) e NON influisce sul numero di token mintati.
    const mints = [
        { signer: signers[0], eth: "50", label: "Professor CS 1" }, 
        { signer: signers[1], eth: "40", label: "Professor CS 2" }, 
        { signer: signers[2], eth: "45", label: "Professor CS 3" }, 
        { signer: signers[3], eth: "35", label: "Professor CE 1" }, 
        { signer: signers[4], eth: "30", label: "Professor EE 1" }, 
        { signer: signers[5], eth: "10", label: "PhD CS 1" },       
        { signer: signers[6], eth: "8",  label: "PhD CS 2" },       
        { signer: signers[8], eth: "5",  label: "Master CS 1" },    
        { signer: signers[10], eth: "2", label: "Master CE 1" },    
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
