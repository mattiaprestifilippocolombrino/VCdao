/*
04_upgradeCompetences.ts — Upgrade di competenza via governance (batch)
Script che esegue l'upgrade delle competenze dei membri tramite governance.
Crea UNA proposta di governance che contiene 13 upgrade di competenza
in un'unica operazione batch. I 2 Student restano al grado base.
Gli utenti che hanno eseguito l'upgrade ricevono i token aggiuntivi.
Viene creata la proposta di upgrade, specificando per ogni membro indirizzo, grado e prova di competenza.
Si avanza di votingDelay + 1 blocchi per arrivare alla fase di voto.
Viene sottoposta a voto e approvata. Vengono avanzati i blocchi fino alla fine del periodo di voto.
Viene inclusa nella coda del Timelock, viene avanzato il tempo fino alla fine del periodo di attesa e poi viene eseguita.
Viene stampata la total supply, il quorum e il superquorum aggiornati.
PROCESSO DI GOVERNANCE:
1. Creazione proposta batch (13 chiamate in una proposta)
2. Voto: Fondatore + Prof 2 votano FOR → superquorum raggiunto
3. Queue nel Timelock (1 ora di delay)
4. Esecuzione: tutti i 13 upgrade vengono applicati

RISULTATO DOPO L'UPGRADE:
- 5 Professors: base × 5   (Es: 100.000 × 5 = 500.000 COMP)
- 3 PhDs:       base × 4   (Es: 30.000 × 4 = 120.000 COMP)
- 2 Masters:    base × 3   (Es: 15.000 × 3 = 45.000 COMP)
- 3 Bachelors:  base × 2   (Es: 8.000 × 2 = 16.000 COMP)
- 2 Students:   nessun upgrade (restano base × 1)

ESECUZIONE: npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
*/


import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";

// Mappa numerica → nome del grado
const GRADE_NAMES: Record<number, string> = {
    0: "Student", 1: "Bachelor", 2: "Master", 3: "PhD", 4: "Professor",
};

async function main() {
    const signers = await ethers.getSigners();

    console.log("══════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Upgrade competenze (batch)");
    console.log("══════════════════════════════════════════════════\n");

    // Carica gli indirizzi dei contratti
    const addressesPath = path.join(__dirname, "..", "deployedAddresses.json");
    const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
    const token = await ethers.getContractAt("GovernanceToken", addresses.token);
    const governor = await ethers.getContractAt("MyGovernor", addresses.governor);

    // Parametri di governance (devono corrispondere al Governor deployato)
    const VOTING_DELAY = 1;        // 1 blocco prima dell'inizio delle votazioni
    const VOTING_PERIOD = 50;      // 50 blocchi per votare
    const TIMELOCK_DELAY = 3600;   // 1 ora di attesa nel Timelock

    // Lista degli upgrade da applicare
    // Ogni voce specifica: chi, a che grado, e la prova di competenza.
    // I 2 Student (signers[13] e signers[14]) NON vengono inclusi.
    const upgrades = [
        { signer: signers[0], grade: 4, proof: "Professore Ordinario di AI, Politecnico di Milano" },
        { signer: signers[1], grade: 4, proof: "Professore Associato di Blockchain, UniMi" },
        { signer: signers[2], grade: 4, proof: "Professore Ordinario di Economia, Bocconi" },
        { signer: signers[3], grade: 4, proof: "Professore Associato di Ingegneria, PoliTo" },
        { signer: signers[4], grade: 4, proof: "Professore Ordinario di Matematica, SNS Pisa" },
        { signer: signers[5], grade: 3, proof: "PhD in Computer Science, ETH Zürich, 2023" },
        { signer: signers[6], grade: 3, proof: "PhD in Economics, LSE, 2024" },
        { signer: signers[7], grade: 3, proof: "PhD in Engineering, TU München, 2022" },
        { signer: signers[8], grade: 2, proof: "Laurea Magistrale in Data Science, PoliMi, 2024" },
        { signer: signers[9], grade: 2, proof: "Laurea Magistrale in Finance, Bocconi, 2023" },
        { signer: signers[10], grade: 1, proof: "Laurea Triennale in Informatica, UniMi, 2024" },
        { signer: signers[11], grade: 1, proof: "Laurea Triennale in Economia, UniPd, 2023" },
        { signer: signers[12], grade: 1, proof: "Laurea Triennale in Ingegneria, UniRm, 2024" },
    ];

    // Costruzione della proposta batch
    // Una proposta batch contiene più chiamate in un'unica proposta.
    // Per ogni upgrade, costruiamo: target (token address), value (0 ETH), calldata (upgradeCompetence)
    const tokenAddr = addresses.token;
    const targets: string[] = [];       // Indirizzi dei contratti da chiamare
    const values: bigint[] = [];        // ETH da inviare (0 per upgrade)
    const calldatas: string[] = [];     // Dati codificati delle chiamate

    for (const u of upgrades) {
        targets.push(tokenAddr);
        values.push(0n);
        // Codifica la chiamata: upgradeCompetence(address, grade, proof)
        calldatas.push(
            token.interface.encodeFunctionData("upgradeCompetence", [
                u.signer.address, u.grade, u.proof,
            ])
        );
    }

    const description = "Batch upgrade: 5 Professors, 3 PhDs, 2 Masters, 3 Bachelors";

    // Creazione della proposta 
    // Il Governor registra la proposta. Emette l'evento ProposalCreated con l'ID.
    console.log("📝 Creazione proposta batch (13 upgrade)...");
    const tx = await governor.propose(targets, values, calldatas, description);
    const receipt = await tx.wait();

    // Estraiamo il proposalId dall'evento ProposalCreated nei log della transazione
    const proposalId = receipt!.logs
        .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
        .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;

    // Votazione
    // Avanziamo di votingDelay + 1 blocchi per arrivare alla fase di voto
    await mine(VOTING_DELAY + 1);

    // Fondatore (500.000 voti dopo l'upgrade atteso) + Prof 2 (400.000) votano FOR  
    // → 180.000 / 522.000 = 34.5% della supply attuale → sotto il superquorum (70%), ma supera il quorum (20%)
    await governor.connect(signers[0]).castVote(proposalId, 1); // 1 = FOR
    await governor.connect(signers[1]).castVote(proposalId, 1);

    // Controlla se il superquorum ha approvato immediatamente la proposta
    // Stato 4 = Succeeded (approvata senza aspettare la fine del voting period)
    const state = Number(await governor.state(proposalId));
    if (state !== 4) {
        console.log("   ⏳ Superquorum non raggiunto, attendo fine voting period...");
        await mine(VOTING_PERIOD + 1);
    }
    console.log("   ✅ Proposta approvata!");

    // ── 3. Queue nel Timelock ──
    // La proposta approvata viene messa in coda nel Timelock.
    // Deve attendere TIMELOCK_DELAY (1 ora) prima dell'esecuzione.
    const descHash = ethers.id(description);  // keccak256 della descrizione
    await governor.queue(targets, values, calldatas, descHash);
    console.log("   🔒 Proposta in coda nel Timelock");

    // ── 4. Esecuzione ──
    // Avanziamo il tempo di 1 ora, poi eseguiamo la proposta.
    // Il Timelock chiama upgradeCompetence() 13 volte in un'unica transazione.
    await time.increase(TIMELOCK_DELAY + 1);
    await governor.execute(targets, values, calldatas, descHash);
    console.log("   🚀 Upgrade eseguiti!\n");

    // ── Riepilogo: token e gradi dopo l'upgrade ──
    console.log("📊 Token dopo gli upgrade:");
    const labels = [
        "Professor 1", "Professor 2", "Professor 3", "Professor 4", "Professor 5",
        "PhD 1", "PhD 2", "PhD 3", "Master 1", "Master 2",
        "Bachelor 1", "Bachelor 2", "Bachelor 3", "Student 1", "Student 2",
    ];
    for (let i = 0; i < 15; i++) {
        const bal = await token.balanceOf(signers[i].address);
        const grade = Number(await token.getMemberGrade(signers[i].address));
        console.log(`   ${labels[i]}: ${ethers.formatUnits(bal, 18)} COMP (${GRADE_NAMES[grade]})`);
    }

    // Statistiche finali: supply totale e soglie di quorum
    const supply = await token.totalSupply();
    console.log(`\n   📊 Supply totale: ${ethers.formatUnits(supply, 18)} COMP`);
    console.log(`   📊 Quorum (20%): ${ethers.formatUnits(supply * 20n / 100n, 18)} COMP`);
    console.log(`   📊 Superquorum (70%): ${ethers.formatUnits(supply * 70n / 100n, 18)} COMP`);

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ Upgrade completati! Prossimo: 05_depositTreasury.ts");
    console.log("══════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
