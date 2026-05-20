/*
04_upgradeCompetences.ts — Upgrade skill con VC firmata EIP-712 (skill array multi-topic)
ESECUZIONE: npx hardhat run scripts/04_upgradeCompetences.ts --network localhost

PREREQUISITI:
  - Eseguito 03_delegateAll.ts
  - Eseguito veramo/scripts/issue-for-dao.ts (VC generate in shared-credentials/)

FLUSSO:
  1. Legge le VC JSON generate da Veramo.
  2. Valida il formato (credentialSubject.skills deve essere un array).
  3. Registra i DID dei membri nel contratto GovernanceToken.
  4. Ogni membro chiama upgradeSkillWithVC() presentando la propria VC.
  5. Il contratto verifica la firma EIP-712 (ecrecover), unisce le skill all'array
     del membro e aggiorna i checkpoint VP per ogni topic via SkillCalculator.

SKILL RICONOSCIUTE (immutabili in SkillCalculator):
  smart-contracts | machine-learning | tokenomics
  digital-health | data-analysis | backend-java

BOOST COMBINAZIONALI:
  smart-contracts + tokenomics       su Web3       → +20
  machine-learning + data-analysis   su AI         → +20
  digital-health + data-analysis     su Health     → +20
  backend-java + data-analysis       su Enterprise → +15
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";

// Skill valide per validazione client-side
const ALLOWED_SKILLS = new Set([
    "smart-contracts",
    "machine-learning",
    "tokenomics",
    "digital-health",
    "data-analysis",
    "backend-java",
]);
const TOPIC_LABELS = ["Web3", "AI", "Health", "Enterprise"];

function addressFromDid(did: string): string {
    const tail = did.split(":").pop();
    if (!tail || !ethers.isAddress(tail)) {
        throw new Error(`DID holder non supportato dallo script locale: ${did}`);
    }
    return ethers.getAddress(tail);
}

// Helper: legge e valida una VC JSON con skills[]
function parseCredential(filePath: string) {
    const c = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!c.issuer?.id)                          throw new Error("VC manca issuer.id");
    if (!Array.isArray(c.credentialSubject?.skills)) throw new Error("VC manca skills[] nel credentialSubject");
    if (!c.proof?.proofValue)                   throw new Error("VC manca proofValue");

    const skills: string[] = c.credentialSubject.skills;
    const unknown = skills.filter((s: string) => !ALLOWED_SKILLS.has(s));
    if (unknown.length > 0) {
        throw new Error(`Skill non riconosciute: ${unknown.join(", ")}`);
    }

    return {
        file: path.basename(filePath),
        issuerDid:   c.issuer.id,
        issuanceDate: c.issuanceDate,
        credentialSubject: {
            id:         c.credentialSubject.id,
            university: c.credentialSubject.university,
            faculty:    c.credentialSubject.faculty,
            skills:     skills,
        },
        signature: c.proof.proofValue,
    };
}

async function main() {
    const signers = await ethers.getSigners();

    console.log("══════════════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Upgrade skill array via VC EIP-712");
    console.log("══════════════════════════════════════════════════════════\n");

    const addresses = JSON.parse(
        fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8")
    );
    const token = await ethers.getContractAt("GovernanceToken", addresses.token);
    const trustedIssuerAddresses = (addresses.trustedIssuers ?? [addresses.issuer]).map((issuer: string) =>
        ethers.getAddress(issuer)
    );
    const trustedIssuerDids = new Set(
        trustedIssuerAddresses.map((issuer: string) => `did:ethr:sepolia:${issuer}`.toLowerCase())
    );

    // Cartella delle VC generate da Veramo
    const credsPath = path.join(__dirname, "..", "..", "shared-credentials");
    if (!fs.existsSync(credsPath)) {
        throw new Error(`Cartella non trovata: ${credsPath}. Esegui prima issue-for-dao.ts in veramo/`);
    }

    const files = fs.readdirSync(credsPath).filter((f: string) => f.endsWith(".json")).sort();
    if (files.length === 0) throw new Error(`Nessuna VC trovata in ${credsPath}`);

    console.log("📝 Lettura e validazione VC...");
    const parsedCreds = files.map((f: string) => parseCredential(path.join(credsPath, f)));

    // Filtriamo solo quelle firmate da uno degli issuer fidati
    const trustedCreds = parsedCreds.filter(
        (c: any) => trustedIssuerDids.has(c.issuerDid.toLowerCase())
    );
    if (trustedCreds.length === 0) {
        throw new Error(`Nessuna VC trovata con issuer fidato`);
    }
    console.log(`   Trovate ${trustedCreds.length} VC valide su ${parsedCreds.length} totali.\n`);

    // Mappa ogni VC al signer che possiede davvero il DID.
    // Evitiamo di affidarci all'ordine dei file, che è comodo ma fragile.
    const toUpgrade = trustedCreds.map((cred: any) => {
        const holderAddress = addressFromDid(cred.credentialSubject.id);
        const signerIdx = signers.findIndex((s) => s.address === holderAddress);
        if (signerIdx === -1) {
            throw new Error(`Nessun signer Hardhat trovato per ${cred.credentialSubject.id}`);
        }

        return {
            signer: signers[signerIdx],
            signerIdx,
            holderDid: cred.credentialSubject.id,
            vcDataObj: {
                issuer: { id: cred.issuerDid },
                issuanceDate: cred.issuanceDate,
                credentialSubject: cred.credentialSubject,
            },
            signature: cred.signature,
        };
    });

    console.log(`🔐 Registrazione DID e Upgrade self-sovereign...`);

    for (const u of toUpgrade) {
        // Registra DID se non ancora fatto
        const currentDid = await token.memberDID(u.signer.address);
        if (currentDid === "") {
            await token.connect(u.signer).registerDID(u.holderDid);
            console.log(`   🔑 Registrato DID per signer[${u.signerIdx}]: ${u.holderDid}`);
        } else if (currentDid !== u.holderDid) {
            console.log(`   ⚠️  DID mismatch per signer[${u.signerIdx}]. Salto.`);
            continue;
        }

        // Upgrade skill via VC EIP-712
        const tx = await token.connect(u.signer).upgradeSkillWithVC(u.vcDataObj, u.signature);
        await tx.wait();

        const skills = await token.getMemberSkills(u.signer.address);
        console.log(
            `   ✅ Signer[${u.signerIdx}] (${u.signer.address.slice(0, 8)}...) ` +
            `→ Skill: [${skills.join(", ")}]`
        );
    }

    // Report VP post-upgrade per tutti i signer coinvolti
    console.log("\n📊 Stato VP post-upgrade per i membri:");
    for (let i = 0; i < Math.min(toUpgrade.length, signers.length); i++) {
        const m = signers[i];
        const skills = await token.getMemberSkills(m.address);
        const topicVotes = await Promise.all(
            TOPIC_LABELS.map((_, topicId) => token.getSkillVotes(m.address, topicId))
        );

        console.log(
            `   Signer[${String(i).padEnd(2)}] [${skills.join(",").padEnd(30)}] | ` +
            TOPIC_LABELS.map((label, topicId) =>
                `${label}: ${ethers.formatEther(topicVotes[topicId]).padEnd(8)} VP`
            ).join(" | ")
        );
    }

    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  ✅ Upgrade VC completati! Prossimo: 05_depositTreasury.ts");
    console.log("══════════════════════════════════════════════════════════");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
