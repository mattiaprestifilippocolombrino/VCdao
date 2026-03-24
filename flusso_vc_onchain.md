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

- Issuer: Universita (`ACTORS.ISSUER`, alias `university-of-cs`)
- Holder: 10 utenti di test (`HOLDERS`)
- Verifier: piattaforma (`ACTORS.VERIFIER`, alias `verifier-platform`)
- DAO on-chain: contratti Solidity che accettano VC firmate da un `trustedIssuer`

File chiave:

- `veramo/agent/setup.ts`: setup agente Veramo e plugin
- `veramo/types/credentials.ts`: modello dati e costanti VC
- `veramo/scripts/2-issue-credential.ts`: emissione VC Veramo
- `veramo/scripts/3-selective-disclosure.ts`: VP + verifica + policy SDR
- `veramo/scripts/4-verify-credential.ts`: verifica diretta VC
- `veramo/scripts/5-full-flow.ts`: demo end-to-end Veramo
- `veramo/scripts/issue-for-dao.ts`: emissione VC con dominio EIP-712 compatibile DAO
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

## 3) Modello della Verifiable Credential

La struttura certificata sta in `UniversityCredentialSubject` (`veramo/types/credentials.ts`):

- `codiceFiscale`
- `dataNascita`
- `exp` (timestamp scadenza)
- `facolta`
- `id` (DID holder)
- `nbf` (not before)
- `nominativo`
- `titoloStudio` (claim usato per il peso voto)
- `universita`
- `voto`

Dettaglio importante:

- i campi sono mantenuti in ordine alfabetico
- il progetto dipende da coerenza forte tra struttura off-chain e on-chain per EIP-712

Tipi W3C usati in emissione:

- `type`: `["VerifiableCredential", "UniversityDegreeCredential"]`
- `@context`: `["https://www.w3.org/2018/credentials/v1"]`
- `proofFormat`: `EthereumEip712Signature2021`

## 4) Emissione VC off-chain (Veramo script 2)

Script: `veramo/scripts/2-issue-credential.ts`

Flusso esatto:

1. Recupera DID issuer da alias `ACTORS.ISSUER`
2. Crea cartella wallet locale `./credentials` se assente
3. Per ogni holder:
4. Recupera DID holder dal DB DID
5. Costruisce `credentialSubject` con:
6. `nbf = now - 3600`
7. `exp = now + 5 anni`
8. Crea VC con `agent.createVerifiableCredential(...)` e proof EIP-712
9. Salva JSON su disco: `credentials/<holder-alias>.json`
10. Salva la stessa VC nel DataStore Veramo (`dataStoreSaveVerifiableCredential`)

Output pratico:

- 10 VC emesse, una per holder
- ogni VC contiene dati e firma dell'issuer (`proof.proofValue`)

## 5) Verifica VC off-chain (Veramo script 4)

Script: `veramo/scripts/4-verify-credential.ts`

Flusso:

1. Carica ogni file VC da `./credentials`
2. Esegue `agent.verifyCredential({ credential: vc })`
3. Veramo risolve il DID issuer con resolver `ethr`
4. Recupera materiale pubblico necessario alla verifica
5. Ricostruisce dati tipizzati EIP-712
6. Verifica integrita e origine della firma
7. Produce esito `verified` true/false con eventuale errore

Questa verifica controlla la VC singolarmente, senza VP.

## 6) Verifica tramite VP e policy SDR (Veramo script 3)

Script: `veramo/scripts/3-selective-disclosure.ts`

Questo script implementa il flusso "request + presentation + verify":

1. Verifier costruisce una SDR locale (`buildSdr`) che richiede solo `titoloStudio`
2. Definisce issuer trusted nella claim policy (`issuers: [{ did: trustedIssuerDid, ... }]`)
3. Genera `challenge` random e `domain` (`dao-voting-demo.local`)
4. Per ogni holder:
5. Carica VC locale
6. Verifica subito la VC (`verifyCredential`)
7. Controlla che wallet soddisfi i claim essenziali SDR (`getVerifiableCredentialsForSdr`)
8. Holder crea VP firmata EIP-712 (`createVerifiablePresentation`) con `challenge` e `domain`
9. Verifier verifica VP (`verifyPresentation`) con stessi `challenge/domain`
10. Decodifica la VC embedded in VP (in questo stack puo arrivare serializzata come stringa JSON)
11. Verifica anche la VC embedded (`verifyCredential`) come best practice
12. Valida formalmente VP contro SDR (`validatePresentationAgainstSdr`)
13. Estrae e usa solo `DISCLOSED_FIELD` (`titoloStudio`)

Nota di progetto molto importante:

- in questo flusso la selective disclosure e applicativa/policy-driven
- non viene usata una prova ZK che redige crittograficamente il payload originale
- il verifier, nel codice demo, si disciplina a processare solo il claim richiesto

## 7) Flusso completo Veramo (script 5)

Script: `veramo/scripts/5-full-flow.ts`

Esegue all-in-one:

1. Creazione/reuse DID per issuer, holders, verifier
2. Emissione 10 VC EIP-712
3. Creazione VP per ogni holder
4. Verifica VP
5. Verifica VC embedded nella VP
6. Estrazione claim `titoloStudio`
7. Riepilogo finale successi/fallimenti

Differenza rispetto a script 3:

- qui non usa il blocco SDR completo
- mantiene pipeline snella focalizzata su VC+VP EIP-712

## 8) Pipeline VC per la DAO (off-chain strict)

Script: `veramo/scripts/issue-for-dao.ts`

Scopo:

- produrre VC con struttura EIP-712 perfettamente allineata ai typehash Solidity (`VPVerifier.sol`)
- salvare credenziali in `dao/scripts/shared-credentials`

Dettagli critici:

- dominio EIP-712:
- `name: "CompetenceDAO Token"`
- `version: "1"`
- `chainId: 31337`
- `verifyingContract: tokenAddress`
- tipi firmati:
- `CredentialSubject`
- `VerifiableCredential(issuerDid, issuerAddress, subject, issuanceDate, expirationDate)`
- firma generata con `issuerWallet.signTypedData(domain, VC_TYPES, vcForSigning)`
- la firma e salvata in `proof.proofValue`

Questa emissione e separata dagli script Veramo didattici, proprio per garantire compatibilita deterministica con verifica on-chain.

## 9) Verifica on-chain nella DAO

Pipeline applicativa:

- `dao/scripts/04_upgradeCompetences.ts` legge le VC shared
- valida struttura minima dei campi
- filtra VC firmate dall'issuer trusted
- registra DID dei membri (`registerDID`) se assente
- costruisce call batch `upgradeCompetenceWithVP(...)`
- crea proposta governance, vota, queue, execute

Controlli nel contratto `GovernanceToken.upgradeCompetenceWithVP`:

1. `_member` deve essere membro DAO
2. `trustedIssuer` deve essere impostato
3. DID membro registrato (binding obbligatorio)
4. DID della VC (`_vc.subject.id`) deve combaciare col DID registrato
5. validita temporale VC: `nbf <= block.timestamp < exp` (via `VPVerifier.isTemporallyValid`)
6. recovery firma EIP-712 con `VPVerifier.recoverIssuer`
7. signer recuperato deve essere `trustedIssuer`
8. anche `_vc.issuerAddress` deve essere `trustedIssuer`
9. mapping semantico `titoloStudio -> CompetenceGrade`
10. upgrade tokens con `_performUpgrade`

La libreria `VPVerifier.sol`:

- definisce typehash costanti per `CredentialSubject` e `VerifiableCredential`
- calcola struct hash annidati
- costruisce digest EIP-712 (`\x19\x01 || domainSeparator || structHash`)
- recupera signer con `ECDSA.recover`

## 10) Garanzie offerte dal sistema

Quando i controlli passano, la DAO ottiene:

- autenticita: la VC e firmata dall'issuer trusted
- integrita: dati non alterati dopo la firma
- validita temporale: VC non scaduta e non prematura
- coerenza identitaria: DID VC allineato al DID registrato dal membro
- coerenza semantica: `titoloStudio` riconosciuto e mappato a grado valido

## 11) Limiti e attenzione operativa

1. I flussi Veramo didattici e DAO strict non sono identici: hanno obiettivi diversi.
2. La selective disclosure nel modulo Veramo e principalmente di policy applicativa.
3. La verifica on-chain richiede allineamento perfetto di dominio EIP-712 e typehash.
4. Se cambia anche solo l'ordine/campo nelle struct, la verifica firma on-chain fallisce.
5. Gli script dipendono dallo stato locale (DB DID, file VC, deployed addresses).

## 12) Comandi utili

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
npm run issue-for-dao
```

Poi, lato DAO (network locale Hardhat), eseguire lo script upgrade:

```bash
cd dao
npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
```

## 13) Formato VC richiesto dal professore (senza domain nella VC)

Obiettivo richiesto:

- VC riusabili da qualunque verifier/smart contract (nessun campo `domain` nel payload VC)
- niente nome persona e niente codice fiscale
- soggetto pseudo-anonimo tramite solo DID
- attributi principali: `skills`, `certificate_title`, `issuing_institution`, `level` (opzionale)
- `level?: "course" | "master" | "bachelor degree" | "master degree" | "phd"`

Nota di compatibilita con questo progetto:

- per compatibilita semantica con `GovernanceToken`, manteniamo anche `titoloStudio` (mapping on-chain dei gradi)
- `titoloStudio` puo essere valorizzato in coerenza con `level` (es. `level="bachelor degree"` -> `titoloStudio="BachelorDegree"`)
- manteniamo `nbf`/`exp` per i controlli di validita temporale gia presenti nel contratto

Formato consigliato:

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "AcademicSkillsCredential"],
  "issuer": { "id": "did:ethr:0xISSUER_ADDRESS" },
  "issuanceDate": "2026-03-24T10:30:00.000Z",
  "expirationDate": "2031-03-24T10:30:00.000Z",
  "credentialSubject": {
    "id": "did:ethr:0xHOLDER_ADDRESS",
    "skills": ["solidity", "smart-contract-security", "dao-governance", "typescript"],
    "certificate_title": "Bachelor Degree in Computer Science",
    "level": "bachelor degree",
    "titoloStudio": "BachelorDegree",
    "issuing_institution": "University of Pisa",
    "nbf": 1774348200,
    "exp": 1932114600
  },
  "proof": {
    "type": "EthereumEip712Signature2021",
    "created": "2026-03-24T10:30:00.000Z",
    "proofPurpose": "assertionMethod",
    "verificationMethod": "did:ethr:0xISSUER_ADDRESS#controller",
    "proofValue": "0x..."
  }
}
```

## 14) Piano test richiesto (gas/tempo vs numero attributi)

Per confrontare costo gas e tempi, prepara VC con 4 configurazioni:

1. 2 attributi: `id`, `skills`
2. 4 attributi: `id`, `skills`, `certificate_title`, `issuing_institution`
3. 8 attributi: aggiungi `level`, `titoloStudio`, `nbf`, `exp`
4. 16 attributi: aggiungi 8 campi extra testuali (es. `skill_1...skill_8` o metadata custom)

Per ogni configurazione:

- prova lunghezze variabili delle stringhe (corta/media/lunga)
- misura gas di verifica on-chain
- misura tempo medio off-chain per firma/verifica
- misura tempo totale pipeline (`issue-for-dao` -> `upgradeCompetenceWithVP`)
