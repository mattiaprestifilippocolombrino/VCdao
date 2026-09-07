import * as fs from "fs";
import * as path from "path";
import { ethers } from "hardhat";
import {
    CREDENTIAL_CONTEXT,
    CREDENTIAL_TYPE,
    DaoCompatibleVc,
    EIP712_DOMAIN,
    RECOGNIZED_SKILLS,
    VC_TYPES,
} from "../../../veramo/types/credentials";

export { EIP712_DOMAIN } from "../../../veramo/types/credentials";

export interface LoadedCredential {
    fileName: string;
    filePath: string;
    raw: DaoCompatibleVc;
    vcData: {
        issuer: { id: string };
        issuanceDate: string;
        credentialSubject: {
            id: string;
            organization: string;
            unit: string;
            skills: string[];
        };
    };
    signature: string;
    holderAddress: string;
    issuerAddress: string;
}

export const SHARED_CREDENTIALS_DIR = path.resolve(__dirname, "../../../shared-credentials");

function requireCondition(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(`VC condivisa non valida: ${message}`);
}

function addressFromDid(did: string, field: string): string {
    const didParts = did.split(":");
    const address = didParts[didParts.length - 1];
    requireCondition(address && ethers.isAddress(address), `${field} non contiene un address Ethereum: ${did}`);
    return ethers.getAddress(address);
}

function sameStringArray(actual: unknown, expected: readonly string[]): boolean {
    return Array.isArray(actual)
        && actual.length === expected.length
        && actual.every((value, index) => value === expected[index]);
}

export function loadSharedCredential(filePath: string): LoadedCredential {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as DaoCompatibleVc;
    const fileName = path.basename(filePath);

    requireCondition(sameStringArray(raw["@context"], CREDENTIAL_CONTEXT), `${fileName}: @context inatteso`);
    requireCondition(sameStringArray(raw.type, CREDENTIAL_TYPE), `${fileName}: type inatteso`);
    requireCondition(typeof raw.issuer?.id === "string", `${fileName}: issuer.id mancante`);
    requireCondition(typeof raw.issuanceDate === "string", `${fileName}: issuanceDate mancante`);
    requireCondition(typeof raw.credentialSubject?.id === "string", `${fileName}: credentialSubject.id mancante`);
    requireCondition(typeof raw.credentialSubject?.organization === "string", `${fileName}: organization mancante`);
    requireCondition(typeof raw.credentialSubject?.unit === "string", `${fileName}: unit mancante`);
    requireCondition(Array.isArray(raw.credentialSubject?.skills), `${fileName}: skills deve essere un array`);
    requireCondition(raw.credentialSubject.skills.length > 0, `${fileName}: skills vuoto`);

    const allowedSkills = new Set<string>(RECOGNIZED_SKILLS);
    requireCondition(
        raw.credentialSubject.skills.every((skill) => allowedSkills.has(skill)),
        `${fileName}: contiene skill non riconosciute`,
    );
    requireCondition(
        new Set(raw.credentialSubject.skills).size === raw.credentialSubject.skills.length,
        `${fileName}: contiene skill duplicate`,
    );

    requireCondition(raw.proof?.type === "EthereumEip712Signature2021", `${fileName}: proof.type inatteso`);
    requireCondition(raw.proof.created === raw.issuanceDate, `${fileName}: proof.created non coincide con issuanceDate`);
    requireCondition(raw.proof.proofPurpose === "assertionMethod", `${fileName}: proofPurpose inatteso`);
    requireCondition(
        raw.proof.verificationMethod === `${raw.issuer.id}#controller`,
        `${fileName}: verificationMethod incoerente con issuer.id`,
    );
    requireCondition(ethers.isHexString(raw.proof.proofValue, 65), `${fileName}: firma EIP-712 non valida`);

    const vcData = {
        issuer: raw.issuer,
        issuanceDate: raw.issuanceDate,
        credentialSubject: {
            id: raw.credentialSubject.id,
            organization: raw.credentialSubject.organization,
            unit: raw.credentialSubject.unit,
            skills: [...raw.credentialSubject.skills],
        },
    };
    const holderAddress = addressFromDid(raw.credentialSubject.id, "credentialSubject.id");
    const issuerAddress = addressFromDid(raw.issuer.id, "issuer.id");
    const recoveredIssuer = ethers.verifyTypedData(EIP712_DOMAIN, VC_TYPES, vcData, raw.proof.proofValue);
    requireCondition(
        recoveredIssuer === issuerAddress,
        `${fileName}: la firma non appartiene all'issuer dichiarato`,
    );

    return {
        fileName,
        filePath,
        raw,
        vcData,
        signature: raw.proof.proofValue,
        holderAddress,
        issuerAddress,
    };
}

export function loadSharedCredentials(): LoadedCredential[] {
    requireCondition(fs.existsSync(SHARED_CREDENTIALS_DIR), `cartella assente: ${SHARED_CREDENTIALS_DIR}`);
    const files = fs.readdirSync(SHARED_CREDENTIALS_DIR)
        .filter((fileName) => fileName.endsWith(".json"))
        .sort();
    requireCondition(files.length > 0, `nessun file JSON in ${SHARED_CREDENTIALS_DIR}`);
    return files.map((fileName) => loadSharedCredential(path.join(SHARED_CREDENTIALS_DIR, fileName)));
}

export function loadCredentialForAddress(address: string): LoadedCredential {
    const normalizedAddress = ethers.getAddress(address);
    const matches = loadSharedCredentials().filter((credential) => credential.holderAddress === normalizedAddress);
    requireCondition(matches.length === 1, `attesa una sola VC per ${normalizedAddress}, trovate ${matches.length}`);
    return matches[0];
}
