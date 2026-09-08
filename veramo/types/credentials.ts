/**
 * Single source of truth per il modello VC usato da tutto il progetto:
 * - Veramo emette credenziali EIP-712 con `skills: string[]`
 * - GovernanceSkill verifica la VC e salva le skill in una bitmap
 * - SkillCalculator assegna punteggi e boost per topic
 */

export const TOPIC_AI_DATA = 0;
export const TOPIC_CLOUD_CYBERSECURITY = 1;
export const TOPIC_FINTECH_BLOCKCHAIN = 2;
export const TOPIC_ENTERPRISE_SOFTWARE = 3;
export const NUM_TOPICS = 4;

export const TOPIC_LABELS = [
  "AI & Data",
  "Cloud & Cybersecurity",
  "FinTech & Blockchain",
  "Enterprise Software",
] as const;

export const RECOGNIZED_SKILLS = [
  "machineLearning",
  "dataEngineering",
  "cyberSecurity",
  "cloudArchitecture",
  "distributedSystems",
  "blockchain",
  "softwareArchitecture",
  "startupFinance",
] as const;

export type SkillName = typeof RECOGNIZED_SKILLS[number];

export const DEFAULT_ORGANIZATION = {
  name: "University of Pisa",
} as const;

export interface HolderPlan {
  alias: string;
  displayName: string;
  signerIndex: number;
  unit: string;
  skills: SkillName[];
}

/*
 * Distribuzione didattica dei 13 holder usati dagli script locali.
 * Ogni holder riceve una VC con skill realistiche, non un grado accademico.
 */
export const HOLDERS: HolderPlan[] = [
  {
    alias: "ai-data-lead",
    displayName: "AI & Data Lead",
    signerIndex: 0,
    unit: "Artificial Intelligence",
    skills: ["machineLearning", "dataEngineering"],
  },
  {
    alias: "cloud-security-lead",
    displayName: "Cloud Security Lead",
    signerIndex: 1,
    unit: "Cybersecurity",
    skills: ["cyberSecurity", "cloudArchitecture"],
  },
  {
    alias: "fintech-lead",
    displayName: "FinTech Lead",
    signerIndex: 2,
    unit: "Digital Economy",
    skills: ["blockchain", "startupFinance"],
  },
  {
    alias: "enterprise-architect",
    displayName: "Enterprise Architect",
    signerIndex: 3,
    unit: "Software Engineering",
    skills: ["softwareArchitecture", "cloudArchitecture"],
  },
  {
    alias: "cybersecurity-engineer",
    displayName: "Cybersecurity Engineer",
    signerIndex: 4,
    unit: "Cybersecurity",
    skills: ["cyberSecurity", "distributedSystems"],
  },
  {
    alias: "cloud-platform-architect",
    displayName: "Cloud Platform Architect",
    signerIndex: 5,
    unit: "Software Engineering",
    skills: ["cloudArchitecture", "distributedSystems"],
  },
  {
    alias: "ml-engineer",
    displayName: "Machine Learning Engineer",
    signerIndex: 6,
    unit: "Artificial Intelligence",
    skills: ["machineLearning"],
  },
  {
    alias: "blockchain-engineer",
    displayName: "Blockchain Engineer",
    signerIndex: 7,
    unit: "Blockchain Engineering",
    skills: ["blockchain"],
  },
  {
    alias: "data-engineer",
    displayName: "Data Engineer",
    signerIndex: 8,
    unit: "Data Science",
    skills: ["dataEngineering"],
  },
  {
    alias: "software-architect",
    displayName: "Software Architect",
    signerIndex: 9,
    unit: "Software Engineering",
    skills: ["softwareArchitecture"],
  },
  {
    alias: "startup-finance-analyst",
    displayName: "Startup Finance Analyst",
    signerIndex: 10,
    unit: "Digital Economy",
    skills: ["startupFinance"],
  },
  {
    alias: "security-architect",
    displayName: "Security Architect",
    signerIndex: 11,
    unit: "Cybersecurity",
    skills: ["cyberSecurity", "cloudArchitecture"],
  },
  {
    alias: "distributed-systems-engineer",
    displayName: "Distributed Systems Engineer",
    signerIndex: 12,
    unit: "Data Science",
    skills: ["distributedSystems"],
  },
];

export const CREDENTIAL_CONTEXT = ["https://www.w3.org/2018/credentials/v1"] as const;
export const CREDENTIAL_TYPE = ["VerifiableCredential", "SkillCredential"] as const;

// Deve coincidere con VPVerifier.UNIVERSAL_DOMAIN_SEPARATOR.
export const EIP712_DOMAIN = {
  name: "Universal VC Protocol",
  version: "1",
} as const;

export const VC_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Issuer: [{ name: "id", type: "string" }],
  CredentialSubject: [
    { name: "id", type: "string" },
    { name: "organization", type: "string" },
    { name: "unit", type: "string" },
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
  organization: string;
  unit: string;
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

export const CREDENTIALS_DIR = "./credentials";
export const DAO_SHARED_CREDENTIALS_DIR = "shared-credentials";

export function toDid(address: string): string {
  return `did:ethr:sepolia:0x${address.slice(2)}`;
}
