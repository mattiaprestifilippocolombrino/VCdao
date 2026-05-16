/*
04_upgradeCompetences.ts — Upgrade skill con VC firmata EIP-712 (multi-topic)
ESECUZIONE: npx hardhat run scripts/04_upgradeCompetences.ts --network localhost

PREREQUISITI:
  - Eseguito 03_delegateAll.ts
  - Eseguito veramo/scripts/issue-for-dao.ts (VC generate in shared-credentials/)

FLUSSO:
  1. Legge le VC JSON generate da Veramo.
  2. Valida il formato e si assicura che l'issuer sia quello fidato.
  3. Registra i DID dei membri nel contratto GovernanceToken.
  4. Ogni membro chiama upgradeSkillWithVC() presentando la propria VC.
  5. Il contratto verifica la firma EIP-712 (ecrecover) e aggiorna il grado,
     fornendo VP nel topic specificato dal degreeTitle.

GRADI E TOPIC (degreeTitle):
  - BachelorCS, MasterCS, PhDCS, ProfessorCS
  - BachelorCE, MasterCE, PhDCE, ProfessorCE
  - BachelorEE, MasterEE, PhDEE, ProfessorEE
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";

// Enum per leggibilità
const GRADE_NAMES: Record<number, string> = {
    0:  "Student",
    1:  "BachelorCS", 2: "MasterCS",  3: "PhDCS",  4: "ProfessorCS",
    5:  "BachelorCE", 6: "MasterCE",  7: "PhDCE",  8: "ProfessorCE",
    9:  "BachelorEE", 10: "MasterEE", 11: "PhDEE", 12: "ProfessorEE",
};

const ALLOWED_DEGREE_TITLES = new Set([
    "BachelorCS", "MasterCS", "PhDCS", "ProfessorCS",
    "BachelorCE", "MasterCE", "PhDCE", "ProfessorCE",
    "BachelorEE", "MasterEE", "PhDEE", "ProfessorEE",
]);

// Helper per parsare la VC in modo sicuro
function parseCredential(filePath: string) {
    const c = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!c.issuer || !c.issuer.id) throw new Error("VC manca issuer.id");
    if (!c.credentialSubject || !c.credentialSubject.degreeTitle) throw new Error("VC manca degreeTitle");
    if (!c.proof || !c.proof.proofValue) throw new Error("VC manca proofValue");

    const degreeTitle = c.credentialSubject.degreeTitle;
    if (!ALLOWED_DEGREE_TITLES.has(degreeTitle)) {
        throw new Error(`degreeTitle non supportato: ${degreeTitle}`);
    }

    return {
        file: path.basename(filePath),
        issuerDid: c.issuer.id,
        issuanceDate: c.issuanceDate,
        credentialSubject: c.credentialSubject,
        signature: c.proof.proofValue
    };
}

async function main() {
    const signers = await ethers.getSigners();

    console.log("══════════════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Upgrade skill multi-topic via VC EIP-712");
    console.log("══════════════════════════════════════════════════════════\n");

    const addresses = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8")
    );
    const token = await ethers.getContractAt("GovernanceToken", addresses.token);
    const trustedIssuerDid = "did:ethr:sepolia:" + addresses.issuer;

    // Cartella delle VC generate da Veramo
    const credsPath = path.join(__dirname, "..", "..", "shared-credentials");
    if (!fs.existsSync(credsPath)) {
        throw new Error(`Cartella non trovata: ${credsPath}. Esegui prima issue-for-dao.ts in veramo/`);
    }

    const files = fs.readdirSync(credsPath).filter(f => f.endsWith(".json")).sort();
    if (files.length === 0) throw new Error(`Nessuna VC trovata in ${credsPath}`);

    console.log("📝 Lettura e validazione VC...");
    const parsedCreds = files.map(f => parseCredential(path.join(credsPath, f)));
    
    // Filtriamo solo quelle firmate dall'issuer fidato
    const trustedCreds = parsedCreds.filter(c => c.issuerDid.toLowerCase() === trustedIssuerDid.toLowerCase());
    
    if (trustedCreds.length === 0) {
        throw new Error(`Nessuna VC trovata con issuer ${trustedIssuerDid}`);
    }
    console.log(`   Trovate ${trustedCreds.length} VC valide su ${parsedCreds.length} totali.\n`);

    // Mappatura target dei ruoli ai signer index.
    // Dobbiamo assegnare le VC lette ai membri corretti.
    const upgradeSlots: Record<string, number[]> = {
        ProfessorCS: [1, 2, 0], // I primi 3 saranno Professor CS (signer 1, 2 e il deployer 0)
        ProfessorCE: [3],
        ProfessorEE: [4],
        PhDCS:       [5, 6],
        PhDCE:       [7],
        MasterCS:    [8, 9],
        MasterCE:    [10],
        BachelorCS:  [11, 12],
    };

    const usedFiles = new Set<string>();
    const toUpgrade = [];

    // Assegnazione logica delle VC ai signer
    for (const [grade, slots] of Object.entries(upgradeSlots)) {
        const available = trustedCreds.filter(c => c.credentialSubject.degreeTitle === grade && !usedFiles.has(c.file));
        const count = Math.min(available.length, slots.length);
        
        for (let i = 0; i < count; i++) {
            const cred = available[i];
            usedFiles.add(cred.file);
            const signer = signers[slots[i]];
            const holderDid = cred.credentialSubject.id;

            const vcDataObj = {
                issuer: { id: cred.issuerDid },
                issuanceDate: cred.issuanceDate,
                credentialSubject: cred.credentialSubject,
            };

            toUpgrade.push({ signer, slot: slots[i], grade, holderDid, vcDataObj, signature: cred.signature });
        }
    }

    console.log(`🔐 Registrazione DID e Upgrade self-sovereign...`);
    
    for (const u of toUpgrade) {
        const currentDid = await token.memberDID(u.signer.address);
        if (currentDid === "") {
            await token.connect(u.signer).registerDID(u.holderDid);
            console.log(`   🔑 Registrato DID per signer[${u.slot}]: ${u.holderDid}`);
        } else if (currentDid !== u.holderDid) {
            console.log(`   ⚠️  DID mismatch per signer[${u.slot}]. Atteso: ${u.holderDid}, Attuale: ${currentDid}`);
            continue;
        }

        // Effettua l'upgrade
        const tx = await token.connect(u.signer).upgradeSkillWithVC(u.vcDataObj, u.signature);
        await tx.wait();
        
        const gradeNum = Number(await token.getMemberGrade(u.signer.address));
        console.log(`   ✅ Signer[${u.slot}] (${u.signer.address.slice(0, 8)}...) → ${GRADE_NAMES[gradeNum]}`);
    }

    console.log("\n📊 Stato VP post-upgrade per i membri:");
    for (let i = 0; i < 13; i++) {
        const member = signers[i];
        const gradeNum = Number(await token.getMemberGrade(member.address));
        const skillVPCS = await token.getSkillVotes(member.address, 0);
        const skillVPCE = await token.getSkillVotes(member.address, 1);
        const skillVPEE = await token.getSkillVotes(member.address, 2);

        console.log(
            `   Signer[${String(i).padEnd(2)}] ${GRADE_NAMES[gradeNum].padEnd(12)} | ` +
            `CS: ${ethers.formatEther(skillVPCS)} VP | ` +
            `CE: ${ethers.formatEther(skillVPCE)} VP | ` +
            `EE: ${ethers.formatEther(skillVPEE)} VP`
        );
    }

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  ✅ Upgrade VC completati! Prossimo: 05_depositTreasury.ts");
    console.log("══════════════════════════════════════════════════════════");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
