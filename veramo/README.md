# VC EIP-712 per CompetenceDAO

Questo modulo contiene un solo flusso: genera le VC EIP-712 consumate dalla DAO.
Le definizioni condivise sono in `types/credentials.ts`; lo script
`scripts/issue-for-dao.ts` produce le credenziali in due cartelle:

- `veramo/credentials` (copia locale)
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
- `organization` (universita', azienda, DAO o training provider)
- `unit` (facolta', dipartimento, team o sezione)
- `skills` (array di skill supportate dalla DAO)

Note:

- La firma EIP-712 copre i soli claim semantici richiesti dal PoC.
- Il contratto salva solo l'hash del DID holder e verifica che la VC firmata riporti lo stesso `credentialSubject.id`; non richiede un formato DID legato all'address Ethereum.
- Nel flusso DAO, il membro registra questo DID on-chain prima di presentare la VC.

## Script

- `issue-for-dao.ts`: genera e firma tutte le VC compatibili con
  `GovernanceSkill.sol` e `VPVerifier.sol`.

## Installazione

```bash
npm install
```

## Configurazione

Servono esclusivamente:

- `DAO_ISSUER_PRIVATE_KEY`
- `DAO_HARDHAT_MNEMONIC`

e il file `dao/deployedAddresses.json` già popolato dal deploy DAO.

## Esecuzione

```bash
npm run issue-for-dao
```

Lo script sostituisce i file JSON precedenti. Dopo una modifica a topic, skill o
schema EIP-712, le credenziali devono sempre essere rigenerate prima dei test DAO:

```bash
cd ../dao
npx hardhat test
```
