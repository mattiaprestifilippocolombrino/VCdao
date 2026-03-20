/**
File che centralizza le costanti usate in tutto il progetto.
Definisce i ruoli (Issuer, Verifier, Holder) e quali campi della
Verifiable Credential verranno condivisi tramite Selective Disclosure.
*/

// Livelli di competenza accademica. Questo è l'UNICO dato che riveleremo alla DAO (Selective Disclosure).
export enum CredentialLevel {
  SIMPLE_STUDENT = 'SimpleStudent',
  BACHELOR_DEGREE = 'BachelorDegree',
  MASTER_DEGREE = 'MasterDegree',
  PHD = 'PhD',
  PROFESSOR = 'Professor',
}

// Nomi leggibili per i livelli di competenza utili per i log
export const CREDENTIAL_LABELS: Record<CredentialLevel, string> = {
  [CredentialLevel.SIMPLE_STUDENT]: 'Studente Semplice',
  [CredentialLevel.BACHELOR_DEGREE]: 'Laurea Triennale',
  [CredentialLevel.MASTER_DEGREE]: 'Laurea Magistrale',
  [CredentialLevel.PHD]: 'Dottorato di Ricerca (PhD)',
  [CredentialLevel.PROFESSOR]: 'Professore Universitario',
}

// L'Università fungerà da "Issuer" (chi emette la credenziale)
export const UNIVERSITY_INFO = {
  name: 'University of Computer Science',
  alias: 'university-of-cs',
  country: 'IT',
} as const

// Struttura di un Holder (lo studente/docente che riceve la credenziale)
export interface HolderInfo {
  alias: string
  name: string
  level: CredentialLevel
}

// Creiamo 10 holder di prova, due per ogni livello di competenza
export const HOLDERS: HolderInfo[] = [
  { alias: 'student-luca-bianchi', name: 'Luca Bianchi', level: CredentialLevel.SIMPLE_STUDENT },
  { alias: 'student-sara-verdi', name: 'Sara Verdi', level: CredentialLevel.SIMPLE_STUDENT },
  { alias: 'bachelor-marco-rossi', name: 'Marco Rossi', level: CredentialLevel.BACHELOR_DEGREE },
  { alias: 'bachelor-giulia-neri', name: 'Giulia Neri', level: CredentialLevel.BACHELOR_DEGREE },
  { alias: 'master-alessandro-conti', name: 'Alessandro Conti', level: CredentialLevel.MASTER_DEGREE },
  { alias: 'master-elena-martini', name: 'Elena Martini', level: CredentialLevel.MASTER_DEGREE },
  { alias: 'phd-francesco-ricci', name: 'Francesco Ricci', level: CredentialLevel.PHD },
  { alias: 'phd-chiara-colombo', name: 'Chiara Colombo', level: CredentialLevel.PHD },
  { alias: 'prof-giuseppe-ferrari', name: 'Giuseppe Ferrari', level: CredentialLevel.PROFESSOR },
  { alias: 'prof-maria-romano', name: 'Maria Romano', level: CredentialLevel.PROFESSOR },
]

// Identificativi per gli attori del sistema
export const ACTORS = {
  ISSUER: UNIVERSITY_INFO.alias,
  VERIFIER: 'verifier-platform', // La app/DAO che verifica la competenza
} as const

// Struttura dei dati certificati all'interno della Verifiable Credential
export interface UniversityCredentialSubject {
  id: string                    // DID dell'holder
  name: string                  // Nome (rimarrà privato)
  degreeLevel: CredentialLevel  // Livello di competenza (verrà rivelato)
  degreeName: string            // Nome del corso (rimarrà privato)
  university: string            // Università (rimarrà privata)
}

// Tipo e contesto W3C standard per la credenziale
export const CREDENTIAL_TYPE = ['VerifiableCredential', 'UniversityDegreeCredential'] as const
export const CREDENTIAL_CONTEXT = ['https://www.w3.org/2018/credentials/v1'] as const

// Constante che identifica il campo che il Verifier chiederà e che l'Holder rivelerà, tramite selective disclosure
export const DISCLOSED_FIELD = 'degreeLevel' as const

// Tutti i campi presenti nella VC, utili a mostrare la differenza tra campi visibili e nascosti nei log
export const ALL_CREDENTIAL_FIELDS = ['name', 'degreeLevel', 'degreeName', 'university'] as const

// Cartella dove salviamo temporaneamente le credenziali in JSON
export const CREDENTIALS_DIR = './credentials'

// Funzione che restituisce il percorso del file JSON della credenziale
export function getCredentialPath(holderAlias: string): string {
  return `${CREDENTIALS_DIR}/${holderAlias}.json`
}
