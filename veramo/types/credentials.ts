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
  nominativo: string
  dataNascita: string
  codiceFiscale: string
  facolta: string
  voto: string
  level: CredentialLevel
}

// Creiamo 10 holder di prova, due per ogni livello di competenza
export const HOLDERS: HolderInfo[] = [
  { alias: 'student-luca-bianchi', nominativo: 'Luca Bianchi', dataNascita: '2001-05-12', codiceFiscale: 'BNCLCU01E12H501Y', facolta: 'Informatica', voto: 'N/A', level: CredentialLevel.SIMPLE_STUDENT },
  { alias: 'student-sara-verdi', nominativo: 'Sara Verdi', dataNascita: '2002-08-24', codiceFiscale: 'VRDSRA02M64F205Z', facolta: 'Informatica', voto: 'N/A', level: CredentialLevel.SIMPLE_STUDENT },
  { alias: 'bachelor-marco-rossi', nominativo: 'Marco Rossi', dataNascita: '1999-11-03', codiceFiscale: 'RSSMRC99S03F205K', facolta: 'Informatica', voto: '110/110', level: CredentialLevel.BACHELOR_DEGREE },
  { alias: 'bachelor-giulia-neri', nominativo: 'Giulia Neri', dataNascita: '2000-02-15', codiceFiscale: 'NRIGLI00B55H501X', facolta: 'Informatica', voto: '105/110', level: CredentialLevel.BACHELOR_DEGREE },
  { alias: 'master-alessandro-conti', nominativo: 'Alessandro Conti', dataNascita: '1996-07-22', codiceFiscale: 'CNTLND96L22F205J', facolta: 'Informatica', voto: '110L/110', level: CredentialLevel.MASTER_DEGREE },
  { alias: 'master-elena-martini', nominativo: 'Elena Martini', dataNascita: '1997-04-10', codiceFiscale: 'MRTLNE97D50H501W', facolta: 'Informatica', voto: '108/110', level: CredentialLevel.MASTER_DEGREE },
  { alias: 'phd-francesco-ricci', nominativo: 'Francesco Ricci', dataNascita: '1992-09-30', codiceFiscale: 'RCCFNC92P30F205Q', facolta: 'Informatica', voto: 'N/A', level: CredentialLevel.PHD },
  { alias: 'phd-chiara-colombo', nominativo: 'Chiara Colombo', dataNascita: '1993-12-05', codiceFiscale: 'CLMCHR93T45H501M', facolta: 'Informatica', voto: 'N/A', level: CredentialLevel.PHD },
  { alias: 'prof-giuseppe-ferrari', nominativo: 'Giuseppe Ferrari', dataNascita: '1975-03-18', codiceFiscale: 'FRRGPP75C18F205A', facolta: 'Informatica', voto: 'N/A', level: CredentialLevel.PROFESSOR },
  { alias: 'prof-maria-romano', nominativo: 'Maria Romano', dataNascita: '1980-01-29', codiceFiscale: 'RMNMRA80A69H501V', facolta: 'Informatica', voto: 'N/A', level: CredentialLevel.PROFESSOR },
]

// Identificativi per gli attori del sistema
export const ACTORS = {
  ISSUER: UNIVERSITY_INFO.alias,
  VERIFIER: 'verifier-platform', // La app/DAO che verifica la competenza
} as const

// Struttura dei dati certificati all'interno della Verifiable Credential
// I campi sono scritti in ordine rigorosamente ALFABETICO.
// Veramo ordina alfabeticamente le chiavi per l'hash EIP-712: dobbiamo far sì che Solidity faccia lo stesso.
export interface UniversityCredentialSubject {
  codiceFiscale: string         // Codice Fiscale
  dataNascita: string           // Data di nascita
  exp: number                   // Data di scadenza in timestamp
  facolta: string               // Facoltà
  id: string                    // DID dell'holder
  nbf: number                   // Data di validità in timestamp (Not-Before)
  nominativo: string            // Nome e Cognome
  titoloStudio: string          // Livello esteso (es. "Bachelor Degree") compatibile con string
  universita: string            // Nome dell'Università emittente
  voto: string                  // Voto di laurea o "N/A"
}

// Tipo e contesto W3C standard per la credenziale
export const CREDENTIAL_TYPE = ['VerifiableCredential', 'UniversityDegreeCredential'] as const
export const CREDENTIAL_CONTEXT = ['https://www.w3.org/2018/credentials/v1'] as const

// Constante che identifica il campo che il Verifier chiederà e che l'Holder rivelerà, tramite selective disclosure
export const DISCLOSED_FIELD = 'titoloStudio' as const

// Tutti i campi presenti nella VC, utili a mostrare la differenza tra campi visibili e nascosti nei log
export const ALL_CREDENTIAL_FIELDS = ['nominativo', 'titoloStudio', 'voto', 'universita'] as const

// Cartella dove salviamo temporaneamente le credenziali in JSON
export const CREDENTIALS_DIR = './credentials'

// Funzione che restituisce il percorso del file JSON della credenziale
export function getCredentialPath(holderAlias: string): string {
  return `${CREDENTIALS_DIR}/${holderAlias}.json`
}
