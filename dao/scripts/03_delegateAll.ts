/*
03_delegateAll.ts — Auto-delega del voting power per tutti i membri
ESECUZIONE: npx hardhat run scripts/03_delegateAll.ts --network localhost

PREREQUISITI: 02_joinMembers.ts già eseguito.

PERCHÉ È NECESSARIA LA DELEGA:
  In OpenZeppelin ERC20Votes, possedere i token non significa automaticamente
  avere voting power. Il VP viene attivato solo quando si "delega":
    - A sé stessi (self-delegation): il membro vota con i propri token.
    - A un altro indirizzo: si delega il proprio VP a un rappresentante.

  In linea con le best practices, la delega manuale e successiva all'ingresso
  nella DAO obbliga gli utenti a compiere un'azione cosciente per attivare
  il proprio peso votante. Questo script esegue la delega per tutti gli holder.

  La delega è necessaria affinché getPastVotes() restituisca valori corretti
  al blocco di snapshot delle proposte.
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";

async function main() {
    const signers = await ethers.getSigners();

    console.log("══════════════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Verifica e delega voting power");
    console.log("══════════════════════════════════════════════════════════\n");

    // Carica gli indirizzi dal deploy precedente.
    const addresses = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8")
    );
    const token = await ethers.getContractAt("GovernanceToken", addresses.token);

    // Verifica e delega per i primi 15 signers (0..14): il fondatore + i 14 membri.
    console.log("🗳️  Stato delega per ogni membro:");
    console.log(`   ${"Signer".padEnd(5)}  ${"Indirizzo".padEnd(44)}  ${"Balance COMP".padStart(14)}  ${"Votes (VP)".padStart(14)}  Stato`);
    console.log(`   ${"─".repeat(5)}  ${"─".repeat(44)}  ${"─".repeat(14)}  ${"─".repeat(14)}  ${"─".repeat(12)}`);

    let delegated = 0;
    let alreadyOk = 0;

    for (let i = 0; i < 15; i++) {
        const member  = signers[i];
        // balanceOf: token posseduti in assoluto (stake)
        const balance = await token.balanceOf(member.address);
        // getVotes:  VP attivo corrente (> 0 solo se delegato)
        const votes   = await token.getVotes(member.address);

        let stato = "—";

        // Se ha token ma nessun VP attivo, delega a sé stesso.
        if (balance > 0n && votes === 0n) {
            await token.connect(member).delegate(member.address);
            const votesAfter = await token.getVotes(member.address);
            stato = `✅ delegato (${ethers.formatEther(votesAfter)} VP)`;
            delegated++;
        } else if (balance > 0n) {
            // VP già attivo (delega già effettuata)
            stato = `✔  già attivo`;
            alreadyOk++;
        } else {
            // Signer non membro (nessun deposito)
            stato = `⚠️  non membro`;
        }

        console.log(
            `   ${String(i).padEnd(5)}  ${member.address}  ` +
            `${ethers.formatEther(balance).padStart(14)}  ` +
            `${ethers.formatEther(votes).padStart(14)}  ${stato}`
        );
    }

    // Riepilogo
    console.log(`\n   Nuove deleghe eseguite:      ${delegated}`);
    console.log(`   Deleghe già attive:           ${alreadyOk}`);
    console.log(`   Supply totale token:          ${ethers.formatEther(await token.totalSupply())} COMP`);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  ✅ Delega completata! Prossimo: 04_upgradeCompetences.ts");
    console.log("══════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
