# Emissione e Verifica delle VC in Questo Progetto

Questo documento descrive in modo dettagliato come funziona, nel repository `VCdao`, il ciclo di vita delle Verifiable Credentials (VC):

1. Emissione off-chain con Veramo (`veramo/`)
2. Verifica off-chain con Veramo (VC e VP)
3. Integrazione on-chain nella DAO (`dao/`) con verifica EIP-712 in Solidity

L'obiettivo e mostrare esattamente cosa fa il codice attuale, distinguendo chiaramente tra:

- flusso didattico SSI in Veramo
- flusso operativo di upgrade competenze in DAO

## 1) Architettura logica del progetto

Attori principali:

- Issuer: Universita (`ACTORS.ISSUER`, alias `university-of-pisa`)
- Holder: profili VC del piano tesi (`HOLDERS`, 13 nel flusso DAO)
- Verifier: piattaforma (`ACTORS.VERIFIER`, alias `verifier-platform`)
- DAO on-chain: contratti Solidity che accettano VC firmate da un `trustedIssuer`

File chiave:

- `veramo/agent/setup.ts`: setup agente Veramo e plugin
- `veramo/types/credentials.ts`: modello dati e costanti VC
- `veramo/scripts/2-issue-credential.ts`: emissione VC Veramo
- `veramo/scripts/3-selective-disclosure.ts`: selective disclosure policy-driven
- `veramo/scripts/4-verify-credential.ts`: verifica diretta VC
- `veramo/scripts/5-full-flow.ts`: demo end-to-end Veramo
- `veramo/scripts/issue-for-dao.ts`: funzione condivisa di emissione VC (riusata da script 2)
- `dao/contracts/VPVerifier.sol`: hashing/verifica firma EIP-712 on-chain
- `dao/contracts/GovernanceToken.sol`: upgrade con `upgradeCompetenceWithVP`
- `dao/scripts/04_upgradeCompetences.ts`: pipeline governance che consuma VC shared

## 2) Prerequisiti tecnici (Veramo)

Nel setup Veramo (`veramo/agent/setup.ts`) vengono inizializzati:

- `KeyManager` + `kms-local`: gestione chiavi private cifrate
- `DIDManager` con `EthrDIDProvider` su rete `sepolia`
- `DIDResolverPlugin`: resolver `ethr` + `web`
- `CredentialPlugin([CredentialProviderEIP712])`: creazione/verifica VC e VP con proof EIP-712
- `SelectiveDisclosure`: utility SDR
- `DataStore` + `DataStoreORM`: persistenza locale su SQLite

Variabili obbligatorie:

- `INFURA_PROJECT_ID`: usato sia dal provider DID che dal resolver
- `KMS_SECRET_KEY`: 64 char hex per cifrare chiavi nel DB
- `DATABASE_FILE` opzionale (default `database.sqlite`)

## 3) Modello VC Unico (Veramo + DAO)

Il progetto usa un solo schema VC (`veramo/types/credentials.ts`) con claim in inglese:

- `credentialSubject.id`
- `credentialSubject.university`
- `credentialSubject.faculty`
- `credentialSubject.degreeTitle` (`BachelorDegree | MasterDegree | PhD | Professor`)
- `credentialSubject.grade`

Vincoli chiave:

- `Student` e escluso dalle VC (non e un titolo)
- top-level VC fisso: `@context`, `type`, `issuer`, `issuanceDate`, `credentialSubject`, `proof`
- firma EIP-712 sui soli campi semantici necessari

## 4) Emissione VC in Veramo (script 2)

Script: `veramo/scripts/2-issue-credential.ts`

Questo script usa la stessa logica di `issue-for-dao.ts` e:

1. legge configurazione DAO (`dao/deployedAddresses.json`)
2. firma le VC con `DAO_ISSUER_PRIVATE_KEY`
3. genera DID holder allineati ai signer Hardhat (`DAO_HARDHAT_MNEMONIC`)
4. salva le VC in:
- `veramo/credentials` (wallet locale SSI)
- `dao/scripts/shared-credentials` (input diretto per DAO)

Questa e la connessione end-to-end richiesta per il PoC tesi.

## 5) Verifica VC off-chain (script 4)

Script: `veramo/scripts/4-verify-credential.ts`

Verifica locale EIP-712 allineata al contratto:

1. carica ogni VC da `veramo/credentials`
2. ricostruisce payload tipizzato
3. recupera signer con `ethers.verifyTypedData`
4. confronta signer e DID issuer con `trustedIssuer`

## 6) Selective Disclosure didattica (script 3)

Script: `veramo/scripts/3-selective-disclosure.ts`

Approccio policy-driven (didattico):

1. il verifier richiede solo `degreeTitle`
2. verifica prima la firma VC
3. processa e mostra solo il claim richiesto

Nota:

- non usa ZK proofs
- e una selective disclosure applicativa/policy, utile come demo SSI semplice

## 7) Full Flow Veramo -> DAO (script 5)

Script: `veramo/scripts/5-full-flow.ts`

Pipeline unica:

1. setup DID (issuer/verifier/holder aliases)
2. issue VC con modello unico
3. export automatico verso cartella DAO shared
4. verifica firme + disclosure del solo `degreeTitle`

## 8) Integrazione on-chain DAO

Pipeline applicativa:

- `dao/scripts/04_upgradeCompetences.ts` legge `dao/scripts/shared-credentials`
- valida struttura strict della VC
- filtra VC firmate da `trustedIssuer`
- registra DID membro (`registerDID`) se assente
- propone batch `upgradeCompetenceWithVP(...)`
- vota, queue, execute

Controlli on-chain in `GovernanceToken.upgradeCompetenceWithVP`:

1. membro DAO valido
2. `trustedIssuer` configurato
3. DID registrato e coerente con `credentialSubject.id`
4. firma EIP-712 valida (`VPVerifier.recoverIssuer`)
5. mapping `degreeTitle -> CompetenceGrade`

## 9) Garanzie del PoC

- autenticita: solo issuer trusted puo firmare VC valide
- integrita: claim firmati non modificabili
- coerenza identitaria: DID VC allineato al DID registrato
- coerenza semantica: `degreeTitle` mappato a grado DAO

## 10) Limiti operativi

1. selective disclosure e policy-driven (non ZK)
2. il dominio EIP-712 deve restare coerente con `GovernanceToken`
3. ogni variazione di struct/typehash richiede riallineamento off-chain/on-chain

## 11) Comandi utili

Flusso Veramo a step:

```bash
cd veramo
npm run create-dids
npm run issue-credential
npm run selective-disclosure
npm run verify-credential
```

Flusso Veramo completo:

```bash
cd veramo
npm run full-flow
```

Flusso VC verso DAO:

```bash
cd veramo
npm run issue-credential
```

Poi, lato DAO (network locale Hardhat), eseguire lo script upgrade:

```bash
cd dao
npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
```

## 12) Formato VC richiesto dal professore (senza domain nella VC)

Obiettivo richiesto:

- VC riusabili da qualunque verifier/smart contract (nessun campo `domain` nel payload VC)
- niente nome persona e niente codice fiscale
- soggetto pseudo-anonimo tramite solo DID
- claim in inglese e minimali
- `degreeTitle` ammessi: `BachelorDegree`, `MasterDegree`, `PhD`, `Professor`
- `Student` escluso (non e un titolo)

Nota di compatibilita con questo progetto:

- il payload firmato EIP-712 copre solo i dati semantici:
- `issuer.id`, `issuanceDate`, `credentialSubject.id`, `university`, `faculty`, `degreeTitle`, `grade`
- nessun campo `eip712.*` nel JSON VC finale

Formato consigliato:

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "UniversityDegreeCredential"],
  "issuer": { "id": "did:ethr:0xISSUER_ADDRESS" },
  "issuanceDate": "2026-03-24T10:30:00Z",
  "credentialSubject": {
    "id": "did:ethr:0xHOLDER_ADDRESS",
    "university": "University of Pisa",
    "faculty": "Computer Science",
    "degreeTitle": "Professor",
    "grade": "N/A"
  },
  "proof": {
    "type": "EthereumEip712Signature2021",
    "created": "2026-03-24T10:30:00Z",
    "proofPurpose": "assertionMethod",
    "verificationMethod": "did:ethr:0xISSUER_ADDRESS#controller",
    "proofValue": "0x..."
  }
}
```

## 13) Piano test richiesto (gas/tempo vs numero attributi)

Per confrontare costo gas e tempi, prepara VC con 4 configurazioni:

1. 2 attributi: `id`, `degreeTitle`
2. 4 attributi: `id`, `university`, `faculty`, `degreeTitle`
3. 5 attributi (baseline attuale): `id`, `university`, `faculty`, `degreeTitle`, `grade`
4. 8/16 attributi: aggiungi metadata testuali opzionali per benchmark (senza rompere il parser strict, in una variante dedicata benchmark)

Per ogni configurazione:

- prova lunghezze variabili delle stringhe (corta/media/lunga)
- misura gas di verifica on-chain
- misura tempo medio off-chain per firma/verifica
- misura tempo totale pipeline (`issue-credential` -> `upgradeCompetenceWithVP`)
