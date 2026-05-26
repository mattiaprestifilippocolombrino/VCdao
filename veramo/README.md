# Veramo Module — VC PoC for DAO

Questo modulo emette VC con un **modello unico** condiviso con il modulo DAO.
Le VC vengono generate in Veramo e salvate in due cartelle:

- `veramo/credentials` (wallet locale SSI)
- `shared-credentials` (input diretto per la governance DAO)

## Modello VC (unico)

Top-level:

- `@context`
- `type`
- `issuer`
- `issuanceDate`
- `credentialSubject`
- `proof`

`credentialSubject`:

- `id`
- `university`
- `faculty`
- `skills` (array di skill supportate dalla DAO)

Note:

- La firma EIP-712 copre i soli claim semantici richiesti dal PoC.
- Il contratto salva solo l'hash del DID holder e verifica che la VC firmata riporti lo stesso `credentialSubject.id`; non richiede un formato DID legato all'address Ethereum.
- Nel flusso DAO, il membro registra questo DID on-chain prima di presentare la VC.

## Script

- `1-create-dids.ts`: crea DID per issuer/verifier e alias holder (didattica SSI).
- `2-issue-credential.ts`: script principale consigliato per emettere VC PoC.
- `issue-for-dao.ts`: stessa logica di emissione, usata anche da altri script.
- `3-selective-disclosure.ts`: disclosure policy-driven del solo array `skills`.
- `4-verify-credential.ts`: verifica locale EIP-712 delle VC emesse.
- `5-full-flow.ts`: esecuzione end-to-end (setup DID + issue + verify + disclosure).

## Installazione

```bash
npm install
```

## Configurazione

Oltre alle variabili Veramo (`INFURA_PROJECT_ID`, `KMS_SECRET_KEY`), per il flusso DAO servono:

- `DAO_ISSUER_PRIVATE_KEY`
- `DAO_HARDHAT_MNEMONIC`

e il file `dao/deployedAddresses.json` già popolato dal deploy DAO.

## Esecuzione consigliata (PoC tesi)

```bash
# 1) DID setup didattico
npm run create-dids

# 2) Emissione VC unificata Veramo -> DAO
npm run issue-credential

# 3) Verifica crittografica locale EIP-712
npm run verify-credential

# 4) Disclosure del solo array skills (policy-driven)
npm run selective-disclosure
```

Oppure full flow:

```bash
npm run full-flow
```
