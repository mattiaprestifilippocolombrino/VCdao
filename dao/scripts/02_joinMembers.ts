/*
02_joinMembers.ts — 14 nuovi membri entrano nella DAO via joinDAO()
ESECUZIONE: npx hardhat run scripts/02_joinMembers.ts --network localhost

PREREQUISITI: 01_deploy.ts già eseguito (deployedAddresses.json presente).

Ogni membro chiama joinDAO() inviando ETH al GovernanceToken.
La funzione applica la formula VP stake:
  tokens = effectiveDiff × 100 × weightStake × 10^18 / (MAX_DEPOSIT × BASIS_POINTS)
dove effectiveDiff è la differenza di deposito effettivo capped a 100 ETH.

Gli ETH vengono inoltrati automaticamente al Treasury.
Le skill arriveranno dopo tramite VC: qui si gestisce solo lo stake.
La delega (eseguita nel prossimo script) è necessaria per attivare il VP.

DISTRIBUZIONE DIDATTICA (le label anticipano le VC dello script 04):
  signers[1]  → 80 ETH  (Web3 lead)
  signers[2]  → 90 ETH  (Protocol analyst)
  signers[3]  → 70 ETH  (AI product lead)
  signers[4]  → 60 ETH  (Health tech lead)
  signers[5]  → 30 ETH  (Enterprise architect)
  signers[6]  → 25 ETH  (Machine learning engineer)
  signers[7]  → 20 ETH  (Health analyst)
  signers[8]  → 15 ETH  (Data analyst)
  signers[9]  → 10 ETH  (Backend engineer)
  signers[10] →  8 ETH  (Tokenomics analyst)
  signers[11] →  5 ETH  (Smart contract auditor)
  signers[12] →  6 ETH  (Junior data analyst)
  signers[13] →  2 ETH  (Observer)
  signers[14] →  1 ETH  (Observer)
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";

async function main() {
    const signers = await ethers.getSigners();

    console.log("══════════════════════════════════════════════════════════");
    console.log("  CompetenceDAO — 14 nuovi membri entrano nella DAO");
    console.log("══════════════════════════════════════════════════════════\n");

    // Carica gli indirizzi salvati dallo script 01_deploy.ts.
    // Questo evita di dover rideploy i contratti a ogni script.
    const addresses = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8")
    );

    // Riconnessione al GovernanceToken già deployato tramite il suo ABI e indirizzo.
    const token = await ethers.getContractAt("GovernanceToken", addresses.token);

    // Definizione dei 14 nuovi membri.
    // signers[0] è il fondatore (già entrato nel deploy), si parte da signers[1].
    // L'etichetta (label) indica le skill che arriveranno nel passo 04.
    // Il deposito in ETH determina il VP stake di ogni membro.
    const members = [
        { signer: signers[1],  eth: "80", label: "Web3 lead (futuro)"              },
        { signer: signers[2],  eth: "90", label: "Protocol analyst (futuro)"       },
        { signer: signers[3],  eth: "70", label: "AI product lead (futuro)"        },
        { signer: signers[4],  eth: "60", label: "Health tech lead (futuro)"       },
        { signer: signers[5],  eth: "30", label: "Enterprise architect (futuro)"   },
        { signer: signers[6],  eth: "25", label: "Machine learning engineer"       },
        { signer: signers[7],  eth: "20", label: "Health analyst (futuro)"         },
        { signer: signers[8],  eth: "15", label: "Data analyst (futuro)"           },
        { signer: signers[9],  eth: "10", label: "Backend engineer (futuro)"       },
        { signer: signers[10], eth: "8",  label: "Tokenomics analyst (futuro)"     },
        { signer: signers[11], eth: "5",  label: "Smart contract auditor (futuro)" },
        { signer: signers[12], eth: "6",  label: "Junior data analyst (futuro)"    },
        { signer: signers[13], eth: "2",  label: "Observer"                        },
        { signer: signers[14], eth: "1",  label: "Observer"                        },
    ];

    console.log("📥 Ingresso membri nella DAO:");
    console.log(`   ${"Indirizzo".padEnd(44)} ${"ETH dep.".padStart(10)}  ${"COMP mint.".padStart(14)}  Label`);
    console.log(`   ${"─".repeat(44)} ${"─".repeat(10)}  ${"─".repeat(14)}  ${"─".repeat(20)}`);

    let totalMinted = 0n;

    for (const m of members) {
        // joinDAO() verifica che il membro non esista, invia gli ETH al Treasury,
        // minta i token COMP e applica l'auto-delega per attivare il VP.
        await token.connect(m.signer).joinDAO({ value: ethers.parseEther(m.eth) });

        // Legge il balance COMP dell'account appena entrato.
        const bal = await token.balanceOf(m.signer.address);
        totalMinted += bal;

        console.log(
            `   ${m.signer.address}  ${m.eth.padStart(10)} ETH  ${ethers.formatEther(bal).padStart(14)} COMP  ${m.label}`
        );
    }

    // Riepilogo complessivo dopo tutti i join.
    const totalSupply  = await token.totalSupply();
    const treasuryContract = await ethers.getContractAt("Treasury", addresses.treasury);
    const treasuryBal = await treasuryContract.getBalance();

    console.log("\n📊 Riepilogo post-join:");
    console.log(`   Supply totale:       ${ethers.formatEther(totalSupply)} COMP`);
    console.log(`   Treasury balance:    ${ethers.formatEther(
        treasuryBal
    )} ETH`);

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  ✅ 14 membri aggiunti! Prossimo: 03_delegateAll.ts");
    console.log("══════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
