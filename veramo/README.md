# Agent SSI Veramo per CompetenceDAO

Questo modulo implementa l'intero flusso SSI usato dalla DAO tramite un agent
Veramo:

1. importa l'issuer e gli holder come DID `did:ethr` gestiti dal
   `DIDManager`;
2. custodisce le chiavi nel KMS locale Veramo, cifrate nel database SQLite;
3. emette le Verifiable Credential tramite `createVerifiableCredential`;
4. salva VC e Verifiable Presentation tramite il `DataStore` Veramo;
5. crea una VP firmata dal wallet holder tramite
   `createVerifiablePresentation`;
6. esporta VC e VP per lo script Hardhat di onboarding.

Il provider EIP-712 in `providers/DaoEip712CredentialProvider.ts` è un provider
Veramo specifico per CompetenceDAO. È necessario perché il provider EIP-712
generico usa uno schema dinamico, mentre `VPVerifier.sol` richiede il type-hash
stabile definito in `types/credentials.ts`.

## Coerenza tra DID e wallet Hardhat

Ogni DID è costruito nella forma:

`did:ethr:<address Ethereum checksum>`

Prima dell'emissione, lo script deriva i wallet dal mnemonic e confronta ogni
address con `eth_accounts` restituito dal nodo Hardhat. L'esecuzione viene
interrotta se un DID, una chiave Veramo e il relativo account Hardhat non
coincidono.

La VP è firmata dalla chiave dell'holder. Lo script
`dao/scripts/04_upgradeCompetences.ts` verifica questa firma, controlla che il
subject della VC coincida con l'holder della VP e usa lo stesso signer Hardhat
per `registerDID` e `upgradeSkillWithVC`.

## Configurazione

Copiare `.env.example` in `.env` e configurare:

- `DAO_ISSUER_PRIVATE_KEY`: chiave del trusted issuer della DAO;
- `DAO_HARDHAT_MNEMONIC`: mnemonic usato dal nodo Hardhat;
- `KMS_SECRET_KEY`: 32 byte esadecimali per cifrare il KMS locale;
- `DAO_HARDHAT_RPC_URL`: endpoint del nodo, normalmente
  `http://127.0.0.1:8545`.

## Esecuzione

Con il nodo Hardhat e la DAO già avviati:

```bash
cd veramo
npm install
npm run issue-for-dao
```

Output prodotti:

- `veramo/database.sqlite`: datastore Veramo di DID, chiavi cifrate, VC e VP;
- `veramo/credentials`: esportazione locale delle VC;
- `veramo/presentations`: esportazione locale delle VP;
- `shared-credentials`: VC usate dai test Solidity;
- `shared-presentations`: VP consumate dallo script Hardhat di onboarding.

Il database e gli output vengono rigenerati a ogni esecuzione, rendendo la demo
riproducibile. Non devono essere pubblicati perché contengono identità e chiavi
di sviluppo.
