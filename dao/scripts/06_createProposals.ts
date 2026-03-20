/*
06_createProposals.ts — Crea 4 proposte di investimento in startup

Script che crea 4 proposte di governance per investire ETH dal Treasury della DAO in una startup.

Ogni proposta chiede di trasferire una quantità diversa di ETH.
Si hanno 4 PROPOSTE, con supply ≈ 3.507.000, quorum 20% ≈ 701.400, superquorum 70% ≈ 2.454.900.
  A — "Lab AI"          (10 ETH) → vincerà con SUPERQUORUM (>70% vota FOR → immediato)
  B — "Ricerca"         (3 ETH)  → vincerà con ~63% FOR a fine votazione
  C — "Espansione"      (8 ETH)  → quorum raggiunto, ma la maggioranza vota AGAINST
  D — "Fondo Minore"    (1 ETH)  → non raggiungerà il quorum (20%)

Per ogni proposta viene codificata la chiamata invest(startup, importo) come calldata 
e inviata al Governor con propose().
Il Governor riceve in input l'indirizzo del contratto da chiamare, il Treasury, come targets,
gli ETH da inviare con la chiamata, 0, perché invest() non è payable, come values,
la chiamata codificata (invest(startup, importo)) come calldatas e la descrizione della proposta.
Gli ID delle proposte vengono salvati in proposalState.json per gli script successivi.

ESECUZIONE: npx hardhat run scripts/06_createProposals.ts --network localhost
// ============================================================================
*/


import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
    console.log("══════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Creazione di 4 proposte");
    console.log("══════════════════════════════════════════════════\n");

    // Carica gli indirizzi dei contratti
    const addressesPath = path.join(__dirname, "..", "deployedAddresses.json");
    const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
    const treasury = await ethers.getContractAt("Treasury", addresses.treasury);
    const governor = await ethers.getContractAt("MyGovernor", addresses.governor);

    // Definizione delle 4 proposte di investimento
    const proposals = [
        { amount: "10", desc: "Proposta A: Investire 10 ETH in Laboratorio AI" },
        { amount: "3", desc: "Proposta B: Investire 3 ETH in Ricerca Congiunta" },
        { amount: "8", desc: "Proposta C: Investire 8 ETH in Espansione Campus" },
        { amount: "1", desc: "Proposta D: Investire 1 ETH in Fondo Sperimentale" },
    ];

    // Per ogni proposta:
    //   1. Codifica la chiamata invest(startup, importo) come calldata
    //   2. Invia la proposta al Governor con propose()
    //   3. Estrae il proposalId dall'evento ProposalCreated
    const proposalIds: string[] = [];
    for (const p of proposals) {
        // Codifica la chiamata: treasury.invest(mockStartup, importoInWei)
        const calldata = treasury.interface.encodeFunctionData("invest", [
            addresses.mockStartup, ethers.parseEther(p.amount),
        ]);

        // Crea la proposta nel Governor
        const tx = await governor.propose([addresses.treasury], [0n], [calldata], p.desc);
        const receipt = await tx.wait();

        // Estrai il proposalId dall'evento ProposalCreated nei log
        const id = receipt!.logs
            .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
            .find((pr: any) => pr?.name === "ProposalCreated")?.args?.proposalId;

        proposalIds.push(id.toString());
        console.log(`   📝 ${p.desc} (ID: ${id})`);
    }

    // Salva le proposte in un file JSON per gli script successivi (voto, queue, execute)
    const state = { proposals: proposals.map((p, i) => ({ ...p, id: proposalIds[i] })) };
    fs.writeFileSync(path.join(__dirname, "..", "proposalState.json"), JSON.stringify(state, null, 2));

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ 4 proposte create! Prossimo: 07_voteOnProposals.ts");
    console.log("══════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
