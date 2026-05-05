/**
 * Single source of truth per il modello VC usato da tutto il progetto:
 * - modulo Veramo (issue/verify/disclosure)
 * - modulo DAO (upgradeCompetenceWithVP on-chain)
 *
 * I degreeTitle ora includono il suffisso topic: CS / CE / EE.
 * Esempio: "ProfessorCS", "PhDCE", "MasterEE".
 */

// Topic IDs — devono corrispondere alle costanti del contratto GovernanceToken.
export const TOPIC_CS = 0;
export const TOPIC_CE = 1;
export const TOPIC_EE = 2;
export const NUM_TOPICS = 3;

export type TopicSuffix = "CS" | "CE" | "EE";
export type DegreeLevel = "Bachelor" | "Master" | "PhD" | "Professor";
export type DegreeTitle =
  | "BachelorCS" | "MasterCS" | "PhDCS" | "ProfessorCS"
  | "BachelorCE" | "MasterCE" | "PhDCE" | "ProfessorCE"
  | "BachelorEE" | "MasterEE" | "PhDEE" | "ProfessorEE";

export const DEGREE_TITLES: DegreeTitle[] = [
  "BachelorCS", "MasterCS", "PhDCS", "ProfessorCS",
  "BachelorCE", "MasterCE", "PhDCE", "ProfessorCE",
  "BachelorEE", "MasterEE", "PhDEE", "ProfessorEE",
];

// Topic di appartenenza di ogni degreeTitle.
export const DEGREE_TITLE_TOPIC: Record<DegreeTitle, number> = {
  BachelorCS: TOPIC_CS, MasterCS: TOPIC_CS, PhDCS: TOPIC_CS, ProfessorCS: TOPIC_CS,
  BachelorCE: TOPIC_CE, MasterCE: TOPIC_CE, PhDCE: TOPIC_CE, ProfessorCE: TOPIC_CE,
  BachelorEE: TOPIC_EE, MasterEE: TOPIC_EE, PhDEE: TOPIC_EE, ProfessorEE: TOPIC_EE,
};

// Label human-readable per i gradi.
export const CREDENTIAL_LABELS: Record<DegreeTitle, string> = {
  BachelorCS: "Bachelor (CS)", MasterCS: "Master (CS)", PhDCS: "PhD (CS)", ProfessorCS: "Professor (CS)",
  BachelorCE: "Bachelor (CE)", MasterCE: "Master (CE)", PhDCE: "PhD (CE)", ProfessorCE: "Professor (CE)",
  BachelorEE: "Bachelor (EE)", MasterEE: "Master (EE)", PhDEE: "PhD (EE)", ProfessorEE: "Professor (EE)",
};

// Informazioni sull'università emittente.
export const UNIVERSITY_INFO = {
  name: "University of Pisa",
  alias: "university-of-pisa",
  country: "IT",
} as const;

export interface HolderPlan {
  alias: string;
  displayName: string;
  signerIndex: number;
  degreeTitle: DegreeTitle;
  faculty: string;
  grade: string;
}

/*
 * Distribuzione dei 13 holder (signers 0–12) con gradi e topic misti.
 * Questo array guida sia l'emissione delle VC (veramo) sia l'upgrade (04_upgradeCompetences.ts).
 *
 * Distribuzione:
 *   signers 0–2  → ProfessorCS (topic CS, score 100/75/75)
 *   signer  3    → ProfessorCE (topic CE, score 100/75/75)
 *   signer  4    → ProfessorEE (topic EE, score 100/75/75)
 *   signers 5–6  → PhDCS  (topic CS, score 75/50/50)
 *   signer  7    → PhDCE  (topic CE, score 75/50/50)
 *   signers 8–9  → MasterCS (topic CS, score 50/25/25)
 *   signers 10   → MasterCE (topic CE, score 50/25/25)
 *   signers 11–12→ BachelorCS (topic CS, score 25/0/0)
 */
export const HOLDERS: HolderPlan[] = [
  { alias: "professor-cs-1", displayName: "Professor CS 1", signerIndex: 0,  degreeTitle: "ProfessorCS", faculty: "Computer Science",        grade: "N/A" },
  { alias: "professor-cs-2", displayName: "Professor CS 2", signerIndex: 1,  degreeTitle: "ProfessorCS", faculty: "Computer Science",        grade: "N/A" },
  { alias: "professor-cs-3", displayName: "Professor CS 3", signerIndex: 2,  degreeTitle: "ProfessorCS", faculty: "Computer Science",        grade: "N/A" },
  { alias: "professor-ce-1", displayName: "Professor CE 1", signerIndex: 3,  degreeTitle: "ProfessorCE", faculty: "Computer Engineering",    grade: "N/A" },
  { alias: "professor-ee-1", displayName: "Professor EE 1", signerIndex: 4,  degreeTitle: "ProfessorEE", faculty: "Electronic Engineering",  grade: "N/A" },
  { alias: "phd-cs-1",       displayName: "PhD CS 1",       signerIndex: 5,  degreeTitle: "PhDCS",       faculty: "Computer Science",        grade: "N/A" },
  { alias: "phd-cs-2",       displayName: "PhD CS 2",       signerIndex: 6,  degreeTitle: "PhDCS",       faculty: "Computer Science",        grade: "N/A" },
  { alias: "phd-ce-1",       displayName: "PhD CE 1",       signerIndex: 7,  degreeTitle: "PhDCE",       faculty: "Computer Engineering",    grade: "N/A" },
  { alias: "master-cs-1",    displayName: "Master CS 1",    signerIndex: 8,  degreeTitle: "MasterCS",    faculty: "Computer Science",        grade: "110/110" },
  { alias: "master-cs-2",    displayName: "Master CS 2",    signerIndex: 9,  degreeTitle: "MasterCS",    faculty: "Computer Science",        grade: "108/110" },
  { alias: "master-ce-1",    displayName: "Master CE 1",    signerIndex: 10, degreeTitle: "MasterCE",    faculty: "Computer Engineering",    grade: "105/110" },
  { alias: "bachelor-cs-1",  displayName: "Bachelor CS 1",  signerIndex: 11, degreeTitle: "BachelorCS",  faculty: "Computer Science",        grade: "104/110" },
  { alias: "bachelor-cs-2",  displayName: "Bachelor CS 2",  signerIndex: 12, degreeTitle: "BachelorCS",  faculty: "Computer Science",        grade: "103/110" },
];

export const ACTORS = {
  ISSUER: UNIVERSITY_INFO.alias,
  VERIFIER: "verifier-platform",
} as const;

export const CREDENTIAL_CONTEXT = ["https://www.w3.org/2018/credentials/v1"] as const;
export const CREDENTIAL_TYPE     = ["VerifiableCredential", "UniversityDegreeCredential"] as const;

// Struttura EIP-712 per la firma della VC (invariata rispetto alla versione precedente).
export const VC_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Issuer: [{ name: "id", type: "string" }],
  CredentialSubject: [
    { name: "id",          type: "string" },
    { name: "university",  type: "string" },
    { name: "faculty",     type: "string" },
    { name: "degreeTitle", type: "string" },
    { name: "grade",       type: "string" },
  ],
  VerifiableCredential: [
    { name: "issuer",             type: "Issuer" },
    { name: "issuanceDate",       type: "string" },
    { name: "credentialSubject",  type: "CredentialSubject" },
  ],
};

export interface CredentialSubject {
  id: string;
  university: string;
  faculty: string;
  degreeTitle: DegreeTitle;
  grade: string;
}

export interface DaoCompatibleVc {
  "@context": readonly ["https://www.w3.org/2018/credentials/v1"];
  type: readonly ["VerifiableCredential", "UniversityDegreeCredential"];
  issuer: { id: string };
  issuanceDate: string;
  credentialSubject: CredentialSubject;
  proof: {
    type: "EthereumEip712Signature2021";
    created: string;
    proofPurpose: "assertionMethod";
    verificationMethod: string;
    proofValue: string;
  };
}

export const DISCLOSED_FIELD       = "degreeTitle" as const;
export const ALL_CREDENTIAL_FIELDS = ["degreeTitle", "university", "faculty", "grade"] as const;
export const CREDENTIALS_DIR           = "./credentials";
export const DAO_SHARED_CREDENTIALS_DIR = "shared-credentials";

export function getCredentialPath(holderAlias: string, baseDir: string = CREDENTIALS_DIR): string {
  return `${baseDir}/${holderAlias}.json`;
}

export function toDid(address: string): string {
  return `did:ethr:sepolia:0x${address.slice(2)}`;
}

export function toIsoSecondPrecision(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}
