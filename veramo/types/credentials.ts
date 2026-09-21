// Modello condiviso tra Veramo, script Hardhat e contratti Solidity.
import { ethers } from "ethers";

/**
 * Single source of truth per il modello VC usato da tutto il progetto:
 * - Veramo emette credenziali EIP-712 con `skills: string[]`
 * - GovernanceSkill verifica la VC e salva le skill in una bitmap
 * - SkillCalculator assegna punteggi e boost per topic
 */

// Gli ID devono coincidere con quelli usati da Governor e SkillCalculator.
export const TOPIC_AI_DATA = 0;
export const TOPIC_CLOUD_CYBERSECURITY = 1;
export const TOPIC_FINTECH_BLOCKCHAIN = 2;
export const TOPIC_ENTERPRISE_SOFTWARE = 3;
export const NUM_TOPICS = 4;

/** Etichette leggibili associate agli ID numerici usati nei contratti. */
export const TOPIC_LABELS = [
  "AI & Data",
  "Cloud & Cybersecurity",
  "FinTech & Blockchain",
  "Enterprise Software",
] as const;

/** Elenco chiuso delle skill che GovernanceSkill sa convertire in bitmap. */
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

/** Ente che emette le credenziali nell'ambiente dimostrativo. */
export const DEFAULT_ORGANIZATION = {
  name: "University of Pisa",
} as const;

export interface HolderPlan {
  /** Nome breve usato per generare il file JSON. */
  alias: string;
  /** Nome descrittivo mostrato nei log e nella documentazione. */
  displayName: string;
  /** Posizione dell'account nell'elenco restituito dal nodo Hardhat. */
  signerIndex: number;
  /** Dipartimento o area organizzativa certificata. */
  unit: string;
  /** Competenze certificate dall'issuer. */
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

// Metadati e typed-data firmati in ogni VC esportata.
export const CREDENTIAL_CONTEXT = ["https://www.w3.org/2018/credentials/v1"] as const;
export const CREDENTIAL_TYPE = ["VerifiableCredential", "SkillCredential"] as const;

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
  /** DID did:ethr del membro destinatario della credenziale. */
  id: string;
  /** Organizzazione che certifica le competenze. */
  organization: string;
  /** Dipartimento o area professionale del membro. */
  unit: string;
  /** Elenco di skill ammesse dal progetto. */
  skills: SkillName[];
}

/** Forma completa della VC JSON compatibile con Veramo e Solidity. */
export interface DaoCompatibleVc {
  /** Vocabolario W3C con cui interpretare i campi standard. */
  "@context": readonly ["https://www.w3.org/2018/credentials/v1"];
  /** Tipo generale W3C e tipo specifico CompetenceDAO. */
  type: readonly ["VerifiableCredential", "SkillCredential"];
  /** DID dell'ente certificatore. */
  issuer: { id: string };
  /** Data inclusa nel payload firmato. */
  issuanceDate: string;
  /** Membro e competenze certificate. */
  credentialSubject: CredentialSubject;
  /** Informazioni necessarie a comprendere e verificare la firma. */
  proof: {
    /** Suite di firma selezionata dal provider custom Veramo. */
    type: "EthereumEip712Signature2021";
    /** Data di creazione della firma. */
    created: string;
    /** L'issuer usa la chiave per affermare il contenuto della VC. */
    proofPurpose: "assertionMethod";
    /** ID della chiave controller gestita da Veramo. */
    verificationMethod: string;
    /** Firma EIP-712 in formato esadecimale. */
    proofValue: string;
    /** Descrizione del typed-data; utile per ispezione e interoperabilità. */
    eip712?: {
      domain: typeof EIP712_DOMAIN;
      types: typeof VC_TYPES;
      /** Nome della struttura radice firmata. */
      primaryType: "VerifiableCredential";
    };
  };
}

// Percorsi di output usati dallo script di emissione.
export const CREDENTIALS_DIR = "./credentials";
export const DAO_SHARED_CREDENTIALS_DIR = "shared-credentials";

/** Costruisce il DID canonico del progetto a partire da un address Ethereum. */
export function toDid(address: string): string {
  return `did:ethr:${ethers.getAddress(address)}`;
}

/**
 * Estrae e normalizza l'address da un DID supportato.
 * Qualsiasi metodo DID o formato diverso viene rifiutato esplicitamente.
 */
export function addressFromEthrDid(did: string): string {
  // Il progetto accetta solo DID did:ethr semplici, senza rete o parametri extra.
  const match = /^did:ethr:(0x[0-9a-fA-F]{40})$/.exec(did);
  if (!match) throw new Error(`DID did:ethr non supportato: ${did}`);
  return ethers.getAddress(match[1]);
}
