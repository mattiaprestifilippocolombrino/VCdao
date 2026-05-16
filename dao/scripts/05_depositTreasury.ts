/*
05_depositTreasury.ts — Simulazione depositi e finanziamenti nel Treasury
ESECUZIONE: npx hardhat run scripts/05_depositTreasury.ts --network localhost

SCOPO:
  Inoltrare fondi aggiuntivi nel Treasury, simulando grant esterni, entrate
  dalla DAO o donazioni. Non tutti gli ETH nel Treasury provengono dal joinDAO.
  La funzione deposit() del Treasury permette a chiunque di inviare ETH.
  
  Qui depositiamo 20 ETH da un account esterno, assicurandoci che il Treasury
  abbia fondi sufficienti per finanziare le proposte dello script 06.
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";

async function main() {
    const signers = await ethers.getSigners();
    // Usiamo l'ultimo account disponibile (19) come "Sponsor esterno"
    const sponsor = signers[19]; 

    console.log("══════════════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Deposito aggiuntivo nel Treasury");
    console.log("══════════════════════════════════════════════════════════\n");

    const addresses = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8")
    );
    const treasury = await ethers.getContractAt("Treasury", addresses.treasury);

    const balBefore = await treasury.getBalance();
    console.log(`🏦 Treasury Balance Iniziale:  ${ethers.formatEther(balBefore)} ETH`);

    // Deposito di 20 ETH
    const depositAmount = ethers.parseEther("20");
    console.log(`📥 Sponsor (${sponsor.address.slice(0,8)}...) invia 20 ETH via deposit()...`);
    
    const tx = await treasury.connect(sponsor).deposit({ value: depositAmount });
    await tx.wait();

    const balAfter = await treasury.getBalance();
    console.log(`🏦 Treasury Balance Finale:    ${ethers.formatEther(balAfter)} ETH`);
    
    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  ✅ Deposito completato! Prossimo: 06_createProposals.ts");
    console.log("══════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
