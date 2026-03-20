/*
03_delegateAll.ts — Auto-delega dei voti per tutti i 15 membri

In OpenZeppelin ERC20Votes, possedere token NON dà automaticamente
diritto di voto. Bisogna "delegare" i propri voti a qualcuno.

Se deleghi a TE STESSO, il tuo voting power è il tuo saldo token.
Se deleghi a UN ALTRO, lui vota con il peso dei tuoi token.
 Senza delega, getVotes() restituisce 0 anche se hai milioni di token.

COSA FA QUESTO SCRIPT:
Ogni membro delega i voti a sé stesso → attiva il proprio voting power.
Poi mina 1 blocco per consolidare i checkpoint on-chain.

ESECUZIONE: npx hardhat run scripts/03_delegateAll.ts --network localhost
*/

import { ethers } from "hardhat";
import { mine } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";

async function main() {
    // Ottieni tutti gli account Hardhat
    const signers = await ethers.getSigners();

    console.log("══════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Auto-delega di tutti i membri");
    console.log("══════════════════════════════════════════════════\n");

    // Carica gli indirizzi dei contratti
    const addressesPath = path.join(__dirname, "..", "deployedAddresses.json");
    const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
    const token = await ethers.getContractAt("GovernanceToken", addresses.token);

    // Etichette per i 15 membri (fondatore + 14 nuovi)
    const labels = [
        "Professor 1 (Fondatore)", "Professor 2", "Professor 3", "Professor 4", "Professor 5",
        "PhD 1", "PhD 2", "PhD 3", "Master 1", "Master 2",
        "Bachelor 1", "Bachelor 2", "Bachelor 3", "Student 1", "Student 2",
    ];

    // Per ogni membro che possiede token:
    //   - delegate(self) → attiva il voting power pari al saldo
    //   - Es: un membro con 10.000 COMP ora ha 10.000 voti
    for (let i = 0; i < 15; i++) {
        const bal = await token.balanceOf(signers[i].address);
        if (bal === 0n) continue; // Salta chi non ha token
        await token.connect(signers[i]).delegate(signers[i].address);
        console.log(`   ✅ ${labels[i]}: ${ethers.formatUnits(bal, 18)} voti`);
    }

    // Mina 1 blocco per consolidare i checkpoint dei voti.
    // ERC20Votes usa checkpoint per blocco: il voting power al blocco X
    // è usato per le votazioni di proposte create a quel blocco.
    await mine(1);

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ Tutti delegati! Prossimo: 04_upgradeCompetences.ts");
    console.log("══════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
