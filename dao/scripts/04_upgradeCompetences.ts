/*
04_upgradeCompetences.ts — Upgrade skill con VC firmata EIP-712 (bitmap multi-topic)
ESECUZIONE: npx hardhat run scripts/04_upgradeCompetences.ts --network localhost

PREREQUISITI:
  - Eseguito 03_delegateAll.ts
  - Eseguito veramo/scripts/issue-for-dao.ts (VC generate in shared-credentials/)

FLUSSO:
  1. Legge le VC JSON generate e salvate dall'agent Veramo.
  2. Abbina credentialSubject.id al wallet Hardhat con lo stesso address.
  3. Registra il DID del membro se non è già stato registrato.
  4. Quel wallet chiama upgradeSkillWithVC() presentando la propria VC.
  5. Il contratto verifica msg.sender, DID registrato e firma EIP-712 dell'issuer,
     unisce le skill nella bitmap del membro e aggiorna i checkpoint VP per ogni
     topic via SkillCalculator.

SKILL RICONOSCIUTE (fonte di verità in GovernanceSkill):
  machineLearning | dataEngineering | cyberSecurity | cloudArchitecture
  distributedSystems | blockchain | softwareArchitecture | startupFinance

BOOST COMBINAZIONALI:
  machineLearning + dataEngineering            su AI & Data             → +10
  cyberSecurity + cloudArchitecture             su Cloud & Cybersecurity → +10
  blockchain + startupFinance                   su FinTech & Blockchain  → +10
  softwareArchitecture + cloudArchitecture      su Enterprise Software   → +10
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";
import { assertContractsDeployed, loadDeployedAddresses } from "./helpers";
import {
    EIP712_DOMAIN,
    RECOGNIZED_SKILLS,
    TOPIC_LABELS,
    VC_TYPES,
    addressFromEthrDid,
} from "../../veramo/types/credentials";

// Skill valide per validazione client-side
const ALLOWED_SKILLS = new Set<string>(RECOGNIZED_SKILLS);
const SKILL_NAMES_BY_ID = new Map<string, string>(
    RECOGNIZED_SKILLS.map((name) => [ethers.id(name), name])
);

function formatSkillIds(skillIds: readonly string[]): string {
    return skillIds.map((skillId) => SKILL_NAMES_BY_ID.get(skillId) ?? skillId).join(", ");
}

// Helper: legge e valida una VC JSON con skills[]
interface ParsedCredential {
    file: string;
    issuerDid: string;
    issuanceDate: string;
    credentialSubject: {
        id: string;
        organization: string;
        unit: string;
        skills: string[];
    };
    signature: string;
}

function parseCredential(c: any, file: string): ParsedCredential {
    if (!c.issuer?.id)                          throw new Error("VC manca issuer.id");
    if (!c.credentialSubject?.id)               throw new Error("VC manca credentialSubject.id");
    if (!c.credentialSubject?.organization)     throw new Error("VC manca credentialSubject.organization");
    if (!c.credentialSubject?.unit)             throw new Error("VC manca credentialSubject.unit");
    if (!Array.isArray(c.credentialSubject?.skills)) throw new Error("VC manca skills[] nel credentialSubject");
    if (!c.proof?.proofValue)                   throw new Error("VC manca proofValue");

    const skills: string[] = c.credentialSubject.skills;
    const unknown = skills.filter((s: string) => !ALLOWED_SKILLS.has(s));
    if (unknown.length > 0) {
        throw new Error(`Skill non riconosciute: ${unknown.join(", ")}`);
    }

    return {
        file,
        issuerDid:   c.issuer.id,
        issuanceDate: c.issuanceDate,
        credentialSubject: {
            id:           c.credentialSubject.id,
            organization: c.credentialSubject.organization,
            unit:         c.credentialSubject.unit,
            skills:       skills,
        },
        signature: c.proof.proofValue,
    };
}

function readCredential(filePath: string): ParsedCredential {
    const credential = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parseCredential(credential, path.basename(filePath));
}

function recoverCredentialIssuer(credential: ParsedCredential): string {
    // Ricostruiamo esattamente lo stesso typed-data firmato da Veramo e
    // verificato da GovernanceSkill. In questo modo una VC alterata viene
    // scartata prima di inviare una transazione destinata a fallire.
    return ethers.verifyTypedData(
        EIP712_DOMAIN,
        VC_TYPES,
        {
            issuer: { id: credential.issuerDid },
            issuanceDate: credential.issuanceDate,
            credentialSubject: credential.credentialSubject,
        },
        credential.signature,
    );
}

async function main() {
    const signers = await ethers.getSigners();

    console.log("══════════════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Upgrade skill bitmap via VC EIP-712");
    console.log("══════════════════════════════════════════════════════════\n");

    const addresses = loadDeployedAddresses();
    await assertContractsDeployed(addresses, ["skillModule"]);
    const skillModule = await ethers.getContractAt("GovernanceSkill", addresses.skillModule);
    const trustedIssuerAddresses = addresses.trustedIssuers;
    const trustedIssuerDids = new Set(
        trustedIssuerAddresses.map((issuer: string) => `did:ethr:${issuer}`.toLowerCase())
    );

    // Veramo esporta direttamente le VC firmate dall'issuer. Non serve una VP:
    // sarà il subject stesso, tramite il proprio signer, a presentare la VC on-chain.
    const credentialsPath = path.join(__dirname, "..", "..", "shared-credentials");
    if (!fs.existsSync(credentialsPath)) {
        throw new Error(`Cartella non trovata: ${credentialsPath}. Esegui prima issue-for-dao.ts in veramo/`);
    }

    const files = fs.readdirSync(credentialsPath).filter((f: string) => f.endsWith(".json")).sort();
    if (files.length === 0) throw new Error(`Nessuna VC trovata in ${credentialsPath}`);

    console.log("📝 Lettura e validazione VC Veramo...");
    const parsedCreds = files.map((f: string) => readCredential(path.join(credentialsPath, f)));

    // Una VC è utilizzabile solo se la firma appartiene al DID issuer dichiarato
    // e quell'issuer è configurato come trusted nel contratto.
    const trustedCreds = parsedCreds.filter((credential) => {
        try {
            const declaredIssuer = addressFromEthrDid(credential.issuerDid);
            const recoveredIssuer = recoverCredentialIssuer(credential);
            return recoveredIssuer === declaredIssuer
                && trustedIssuerDids.has(credential.issuerDid.toLowerCase());
        } catch {
            return false;
        }
    });
    if (trustedCreds.length === 0) {
        throw new Error(`Nessuna VC trovata con issuer fidato`);
    }
    console.log(`   Trovate ${trustedCreds.length} VC valide su ${parsedCreds.length} totali.\n`);

    // Ricaviamo l'address dal DID del credentialSubject e cerchiamo il signer
    // Hardhat corrispondente. Non usiamo l'ordine dei file: ogni VC viene così
    // presentata dal wallet identificato nella credenziale stessa.
    const toUpgrade = trustedCreds.map((cred) => {
        const holderAddress = addressFromEthrDid(cred.credentialSubject.id);
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

    console.log(`🔐 Registrazione DID e upgrade self-sovereign...`);

    for (const u of toUpgrade) {
        const currentDid = await skillModule.memberDID(u.signer.address);
        const holderDidHash = ethers.keccak256(ethers.toUtf8Bytes(u.holderDid));
        if (currentDid === ethers.ZeroHash) {
            await skillModule.connect(u.signer).registerDID(u.holderDid);
            console.log(`   🔑 Registrato DID per signer[${u.signerIdx}]: ${u.holderDid}`);
        } else if (currentDid !== holderDidHash) {
            console.log(`   ⚠️  DID già registrato diverso per signer[${u.signerIdx}]. Salto.`);
            continue;
        }

        // Il legame msg.sender ↔ DID ↔ credentialSubject viene chiuso qui:
        // - connect(u.signer) determina msg.sender;
        // - registerDID ha associato a quel sender u.holderDid;
        // - GovernanceSkill confronta l'hash del DID registrato con l'id nella VC.
        const tx = await skillModule.connect(u.signer).upgradeSkillWithVC(u.vcDataObj, u.signature);
        await tx.wait();

        const skills = await skillModule.getMemberSkills(u.signer.address);
        console.log(
            `   ✅ Signer[${u.signerIdx}] (${u.signer.address.slice(0, 8)}...) ` +
            `→ Skill: [${formatSkillIds(skills)}]`
        );
    }

    // Report VP post-upgrade per tutti i signer coinvolti
    console.log("\n📊 Stato VP post-upgrade per i membri:");
    for (const u of toUpgrade) {
        const m = u.signer;
        const skills = await skillModule.getMemberSkills(m.address);
        const topicVotes = await Promise.all(
            TOPIC_LABELS.map((_, topicId) => skillModule.getSkillVotes(m.address, topicId))
        );

        console.log(
            `   Signer[${String(u.signerIdx).padEnd(2)}] [${formatSkillIds(skills).padEnd(42)}] | ` +
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
