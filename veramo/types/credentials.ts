/**
 * Single source of truth per il modello VC usato da tutto il progetto:
 * - modulo Veramo (issue/verify/disclosure demo)
 * - modulo DAO (upgradeCompetenceWithVP on-chain)
 */


//Definisce i valori ammessi per il titolo. I valori sono: BachelorDegree, MasterDegree, PhD, Professor
export type DegreeTitle = "BachelorDegree" | "MasterDegree" | "PhD" | "Professor"
//Elenco dei valori ammessi per il titolo, contenuti in un array-
export const DEGREE_TITLES: DegreeTitle[] = [
  "BachelorDegree",
  "MasterDegree",
  "PhD",
  "Professor",
]
//Ogni elemento di DEGREE_TITLES ha correlata una stringa estesa leggibile da un essere umano
export const CREDENTIAL_LABELS: Record<DegreeTitle, string> = {
  BachelorDegree: "Bachelor Degree",
  MasterDegree: "Master Degree",
  PhD: "PhD",
  Professor: "Professor",
}

//Informazioni sull'università emittente. COntiene nome esteso, nome corto e paese.
export const UNIVERSITY_INFO = {
  name: "University of Pisa",
  alias: "university-of-pisa",
  country: "IT",
} as const

/* 
Definisce i dati di ogni persona che possiede una VC.
Ogni holder ha un nome alias interno, un nome leggibile, un indice del signer/account, un titolo, una facoltà e un voto
*/
export interface HolderPlan {
  alias: string
  displayName: string
  signerIndex: number
  degreeTitle: DegreeTitle
  faculty: string
  grade: string
}

// Creiamo un set di costanti che implementano un array di HolderPlan, come pianificato in DAO/scripts/04_upgradeCompetences.ts.
export const HOLDERS: HolderPlan[] = [
  { alias: "professor-1", displayName: "Professor 1", signerIndex: 0, degreeTitle: "Professor", faculty: "Computer Science", grade: "N/A" },
  { alias: "professor-2", displayName: "Professor 2", signerIndex: 1, degreeTitle: "Professor", faculty: "Computer Science", grade: "N/A" },
  { alias: "professor-3", displayName: "Professor 3", signerIndex: 2, degreeTitle: "Professor", faculty: "Computer Science", grade: "N/A" },
  { alias: "professor-4", displayName: "Professor 4", signerIndex: 3, degreeTitle: "Professor", faculty: "Computer Science", grade: "N/A" },
  { alias: "professor-5", displayName: "Professor 5", signerIndex: 4, degreeTitle: "Professor", faculty: "Computer Science", grade: "N/A" },
  { alias: "phd-1", displayName: "PhD 1", signerIndex: 5, degreeTitle: "PhD", faculty: "Computer Science", grade: "N/A" },
  { alias: "phd-2", displayName: "PhD 2", signerIndex: 6, degreeTitle: "PhD", faculty: "Computer Science", grade: "N/A" },
  { alias: "phd-3", displayName: "PhD 3", signerIndex: 7, degreeTitle: "PhD", faculty: "Computer Science", grade: "N/A" },
  { alias: "master-1", displayName: "Master 1", signerIndex: 8, degreeTitle: "MasterDegree", faculty: "Computer Science", grade: "110/110" },
  { alias: "master-2", displayName: "Master 2", signerIndex: 9, degreeTitle: "MasterDegree", faculty: "Computer Science", grade: "108/110" },
  { alias: "bachelor-1", displayName: "Bachelor 1", signerIndex: 10, degreeTitle: "BachelorDegree", faculty: "Computer Science", grade: "105/110" },
  { alias: "bachelor-2", displayName: "Bachelor 2", signerIndex: 11, degreeTitle: "BachelorDegree", faculty: "Computer Science", grade: "104/110" },
  { alias: "bachelor-3", displayName: "Bachelor 3", signerIndex: 12, degreeTitle: "BachelorDegree", faculty: "Computer Science", grade: "103/110" },
]

//Definisce gli attori del sistema: emittente e verificatore. Serve solo a centralizzare questi nomi.
export const ACTORS = {
  ISSUER: UNIVERSITY_INFO.alias,
  VERIFIER: "verifier-platform",
} as const

//Costante che definisce il contesto e il tipo della VC, come definito nello standard W3C
export const CREDENTIAL_CONTEXT = ["https://www.w3.org/2018/credentials/v1"] as const
export const CREDENTIAL_TYPE = ["VerifiableCredential", "UniversityDegreeCredential"] as const

/*Definizione della struttura della VC, come definito nello standard W3C.
Questo blocco definisce la struttura EIP-712 dei dati da firmare.
Dice quali campi vengono firmati, che tipo di dati contengono, e in che ordine vengono firmati.
In questo caso vengono firmati i seguenti campi: id, university, faculty, degreeTitle e grade.
Poi all'esterno del credentialSubject vengono firmati: issuer, issuanceDate e credentialSubject.
La verifica on chain usa la stessa struttura per ricreare l'hash e confrontarlo con quello memorizzato nel contratto.
*/
export const VC_TYPES: Record<string, Array<{ name: string; type: string }>> = {
  Issuer: [{ name: "id", type: "string" }],
  CredentialSubject: [
    { name: "id", type: "string" },
    { name: "university", type: "string" },
    { name: "faculty", type: "string" },
    { name: "degreeTitle", type: "string" },
    { name: "grade", type: "string" },
  ],
  VerifiableCredential: [
    { name: "issuer", type: "Issuer" },
    { name: "issuanceDate", type: "string" },
    { name: "credentialSubject", type: "CredentialSubject" },
  ],
}

//Interfaccia che definisce la struttura dei dati del credential subject. Cuore informativo della VC.
export interface CredentialSubject {
  id: string
  university: string
  faculty: string
  degreeTitle: DegreeTitle
  grade: string
}

/*
Questa interfaccia definisce com’è fatta la VC completa che il progetto accetta. Deve avere
@context, type, issuer, issuanceDate, credentialSubject, proof.
In più impone che la proof sia coerente con una firma EthereumEip712Signature2021.
*/
export interface DaoCompatibleVc {
  "@context": readonly ["https://www.w3.org/2018/credentials/v1"]
  type: readonly ["VerifiableCredential", "UniversityDegreeCredential"]
  issuer: { id: string }
  issuanceDate: string
  credentialSubject: CredentialSubject
  proof: {
    type: "EthereumEip712Signature2021"
    created: string
    proofPurpose: "assertionMethod"
    verificationMethod: string
    proofValue: string
  }
}

//Campo che viene mostrato quando si fa la disclosure
export const DISCLOSED_FIELD = "degreeTitle" as const
//Tutti i campi informativi della VC
export const ALL_CREDENTIAL_FIELDS = ["degreeTitle", "university", "faculty", "grade"] as const

//Directory dove vengono salvate le VC
export const CREDENTIALS_DIR = "./credentials"
//Directory dove vengono salvate le VC condivise con la DAO
export const DAO_SHARED_CREDENTIALS_DIR = "dao/scripts/shared-credentials"

//Funzione che restituisce il percorso del file JSON della VC dato l'alias dell'holder
export function getCredentialPath(holderAlias: string, baseDir: string = CREDENTIALS_DIR): string {
  return `${baseDir}/${holderAlias}.json`
}

//Funzione che converte un indirizzo Ethereum in un DID
export function toDid(address: string): string {
  return `did:ethr:sepolia:0x${address.slice(2)}`
}

export function toIsoSecondPrecision(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z")
}
