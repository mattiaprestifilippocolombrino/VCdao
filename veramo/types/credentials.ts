/**
 * Single source of truth per il modello VC usato da tutto il progetto:
 * - Veramo emette credenziali EIP-712 con `skills: string[]`
 * - GovernanceToken verifica la VC e salva solo hash di skill
 * - SkillCalculator assegna punteggi e boost per topic
 */

export const TOPIC_WEB3 = 0;
export const TOPIC_AI = 1;
export const TOPIC_HEALTH = 2;
export const TOPIC_ENTERPRISE = 3;
export const NUM_TOPICS = 4;

export const TOPIC_LABELS: Record<number, string> = {
  [TOPIC_WEB3]: "Web3 Infrastructure",
  [TOPIC_AI]: "AI Products",
  [TOPIC_HEALTH]: "Digital Health",
  [TOPIC_ENTERPRISE]: "Enterprise Software",
};

export type SkillName =
  | "smart-contracts"
  | "machine-learning"
  | "tokenomics"
  | "digital-health"
  | "data-analysis"
  | "backend-java";

export const RECOGNIZED_SKILLS: SkillName[] = [
  "smart-contracts",
  "machine-learning",
  "tokenomics",
  "digital-health",
  "data-analysis",
  "backend-java",
];

export const SKILL_LABELS: Record<SkillName, string> = {
  "smart-contracts": "Smart contracts",
  "machine-learning": "Machine learning",
  tokenomics: "Tokenomics",
  "digital-health": "Digital health",
  "data-analysis": "Data analysis",
  "backend-java": "Backend Java",
};

export const UNIVERSITY_INFO = {
  name: "University of Pisa",
  alias: "university-of-pisa",
  country: "IT",
} as const;

export interface HolderPlan {
  alias: string;
  displayName: string;
  signerIndex: number;
  faculty: string;
  skills: SkillName[];
}

/*
 * Distribuzione didattica dei 13 holder usati dagli script locali.
 * Ogni holder riceve una VC con skill realistiche, non un grado accademico.
 */
export const HOLDERS: HolderPlan[] = [
  {
    alias: "web3-lead-1",
    displayName: "Web3 Lead 1",
    signerIndex: 0,
    faculty: "Blockchain Engineering",
    skills: ["smart-contracts", "tokenomics"],
  },
  {
    alias: "web3-lead-2",
    displayName: "Web3 Lead 2",
    signerIndex: 1,
    faculty: "Blockchain Engineering",
    skills: ["smart-contracts", "tokenomics", "data-analysis"],
  },
  {
    alias: "protocol-analyst",
    displayName: "Protocol Analyst",
    signerIndex: 2,
    faculty: "Digital Economy",
    skills: ["tokenomics", "smart-contracts"],
  },
  {
    alias: "ai-product-lead",
    displayName: "AI Product Lead",
    signerIndex: 3,
    faculty: "Artificial Intelligence",
    skills: ["machine-learning", "data-analysis"],
  },
  {
    alias: "health-tech-lead",
    displayName: "Health Tech Lead",
    signerIndex: 4,
    faculty: "Digital Health",
    skills: ["digital-health", "data-analysis"],
  },
  {
    alias: "enterprise-architect",
    displayName: "Enterprise Architect",
    signerIndex: 5,
    faculty: "Software Engineering",
    skills: ["backend-java", "data-analysis"],
  },
  {
    alias: "ml-engineer",
    displayName: "Machine Learning Engineer",
    signerIndex: 6,
    faculty: "Artificial Intelligence",
    skills: ["machine-learning"],
  },
  {
    alias: "health-analyst",
    displayName: "Health Analyst",
    signerIndex: 7,
    faculty: "Digital Health",
    skills: ["digital-health"],
  },
  {
    alias: "data-analyst",
    displayName: "Data Analyst",
    signerIndex: 8,
    faculty: "Data Science",
    skills: ["data-analysis"],
  },
  {
    alias: "backend-engineer",
    displayName: "Backend Engineer",
    signerIndex: 9,
    faculty: "Software Engineering",
    skills: ["backend-java"],
  },
  {
    alias: "tokenomics-analyst",
    displayName: "Tokenomics Analyst",
    signerIndex: 10,
    faculty: "Digital Economy",
    skills: ["tokenomics"],
  },
  {
    alias: "smart-contract-auditor",
    displayName: "Smart Contract Auditor",
    signerIndex: 11,
    faculty: "Cybersecurity",
    skills: ["smart-contracts"],
  },
  {
    alias: "junior-data-analyst",
    displayName: "Junior Data Analyst",
    signerIndex: 12,
    faculty: "Data Science",
    skills: ["data-analysis"],
  },
];

export const ACTORS = {
  ISSUER: UNIVERSITY_INFO.alias,
  VERIFIER: "verifier-platform",
} as const;

export const CREDENTIAL_CONTEXT = ["https://www.w3.org/2018/credentials/v1"] as const;
export const CREDENTIAL_TYPE = ["VerifiableCredential", "SkillCredential"] as const;

export const VC_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Issuer: [{ name: "id", type: "string" }],
  CredentialSubject: [
    { name: "id", type: "string" },
    { name: "university", type: "string" },
    { name: "faculty", type: "string" },
    { name: "skills", type: "string[]" },
  ],
  VerifiableCredential: [
    { name: "issuer", type: "Issuer" },
    { name: "issuanceDate", type: "string" },
    { name: "credentialSubject", type: "CredentialSubject" },
  ],
};

export interface CredentialSubject {
  id: string;
  university: string;
  faculty: string;
  skills: SkillName[];
}

export interface DaoCompatibleVc {
  "@context": readonly ["https://www.w3.org/2018/credentials/v1"];
  type: readonly ["VerifiableCredential", "SkillCredential"];
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

export const DISCLOSED_FIELD = "skills" as const;
export const ALL_CREDENTIAL_FIELDS = ["skills", "university", "faculty"] as const;
export const CREDENTIALS_DIR = "./credentials";
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
