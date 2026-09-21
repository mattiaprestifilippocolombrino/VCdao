# Agent SSI Veramo per CompetenceDAO

Questo modulo implementa l'intero flusso SSI usato dalla DAO tramite un agent
Veramo:

1. importa nel `DIDManager` l'issuer che firma le credenziali;
2. custodisce le chiavi nel KMS locale Veramo, cifrate nel database SQLite;
3. deriva i DID `did:ethr` pubblici degli holder dagli account Hardhat, senza
   importare le loro chiavi private nel KMS;
4. emette le Verifiable Credential tramite `createVerifiableCredential`;
5. verifica e salva le VC tramite il `DataStore` Veramo;
6. esporta le VC per lo script Hardhat di onboarding.

Il flusso non usa Verifiable Presentation. L'holder dimostra il controllo del
proprio DID inviando direttamente la transazione Ethereum che presenta la VC.

Il provider EIP-712 in `providers/DaoEip712CredentialProvider.ts` è un provider
Veramo specifico per CompetenceDAO. È necessario perché il provider EIP-712
generico usa uno schema dinamico, mentre `VPVerifier.sol` richiede il type-hash
stabile definito in `types/credentials.ts`.

## Coerenza tra DID e wallet Hardhat

Ogni DID è costruito nella forma:

`did:ethr:<address Ethereum checksum>`

Prima dell'emissione, lo script deriva i wallet dal mnemonic e confronta ogni
address con `eth_accounts` restituito dal nodo Hardhat. L'esecuzione viene
interrotta se un DID subject e il relativo account Hardhat non coincidono. La
chiave dell'issuer resta invece nel KMS Veramo ed è controllata dal provider
prima di firmare ogni VC.

Lo script `dao/scripts/04_upgradeCompetences.ts` ricava l'address dal
`credentialSubject.id`, seleziona il signer Hardhat corrispondente e usa quel
wallet sia per `registerDID` sia per `upgradeSkillWithVC`. Il contratto controlla
quindi che `msg.sender` sia un membro, che il suo DID registrato coincida con il
subject della VC e che la VC sia firmata da un issuer fidato.

## Configurazione

Copiare `.env.example` in `.env` e configurare:

- `DAO_ISSUER_PRIVATE_KEY`: chiave del trusted issuer della DAO;
- `DAO_HARDHAT_MNEMONIC`: mnemonic usato dal nodo Hardhat;
- `KMS_SECRET_KEY`: 32 byte esadecimali per cifrare il KMS locale;
- `DAO_HARDHAT_RPC_URL`: endpoint del nodo, normalmente
  `http://127.0.0.1:8545`.

## Esecuzione

Richiede Node.js 20.17 o successivo. Le dipendenze sono bloccate dal
`package-lock.json`; per un'installazione riproducibile usare `npm ci`.

Con il nodo Hardhat e la DAO già avviati:

```bash
cd veramo
npm ci
npm run issue-for-dao
```

Output prodotti:

- `veramo/database.sqlite`: datastore Veramo di DID, chiavi cifrate e VC;
- `veramo/credentials`: esportazione locale delle VC;
- `shared-credentials`: VC usate dagli script e dai test Solidity.

Le API per le Verifiable Presentation richieste dall'interfaccia del provider
Veramo sono disabilitate esplicitamente e restituiscono un errore se invocate.

Il database SQLite usa le migrazioni ufficiali di `@veramo/data-store`; la
chiave privata dell'issuer è cifrata dal KMS locale tramite `SecretBox`.

Il database e gli output vengono rigenerati a ogni esecuzione, rendendo la demo
riproducibile. Non devono essere pubblicati perché contengono identità e chiavi
di sviluppo.
