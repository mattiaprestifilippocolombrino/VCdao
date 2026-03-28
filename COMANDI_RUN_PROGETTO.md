# Comandi per Eseguire il Progetto (VC DAO)

Questo documento contiene i comandi esatti da lanciare nel terminale per eseguire l'intero flusso del progetto.

## Prerequisiti
Assicurati di aver installato le dipendenze in entrambe le cartelle:
```bash
cd dao && npm install
cd ../veramo && npm install
```

---

## Flusso di Esecuzione Completo (Terminale Multiplo)

### 1. Avviare il Nodo Locale (Terminale 1)
Apri un terminale, posizionati nella cartella `dao` e avvia la blockchain locale di Hardhat:
```bash
cd dao
npx hardhat node
```
*(Lascia questo terminale aperto e in esecuzione)*

### 2. Deploy ed Inizializzazione (Terminale 2)
Apri un secondo terminale. Per gli script di deploy della DAO, usa l'Address definito nel file di ambiente (`dao/.env`). Questo file è stato già generato per te.

```bash
cd dao
npm install dotenv
npx hardhat run scripts/01_deploy.ts --network localhost
npx hardhat run scripts/02_joinMembers.ts --network localhost
npx hardhat run scripts/03_delegateAll.ts --network localhost
```

### 3. Generazione e Firma delle VC tramite Veramo (Terminale 2)
Ora spostati nella cartella `veramo`. Qui l'Issuer firmerà le credenziali. I parametri di Hardhat sono già stati configurati automaticamente in `veramo/.env`.

```bash
cd ../veramo
npm run issue-for-dao
```
*(Questo script creerà le VC nella cartella `dao/scripts/shared-credentials` per farle leggere alla DAO nel passaggio successivo)*

### 4. Upgrade Competenze e Ciclo di Governance (Terminale 2)
Torna nella cartella `dao` ed esegui il resto degli script.
Lo script `04` leggerà le credenziali appena generate, invierà le transazioni on-chain e il contratto verificherà crittograficamente (EIP-712) la firma dell'Issuer. I successivi simulano la vita della DAO (deposito, votazioni, esecuzioni).

```bash
cd ../dao
npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
npx hardhat run scripts/05_depositTreasury.ts --network localhost
npx hardhat run scripts/06_createProposals.ts --network localhost
npx hardhat run scripts/07_voteOnProposals.ts --network localhost
npx hardhat run scripts/08_executeProposals.ts --network localhost
```

---

## Altri Comandi Utili

### Lanciare i Test della DAO
Per verificare che tutti gli smart contract funzionino correttamente (compresa la validazione delle VC on-chain):
```bash
cd dao
npx hardhat test
```

### Flusso SSI Autonomo (Veramo Esteso)
Se vuoi testare solo la parte SSI (Generazione DID, Selective Disclosure, Verifica Off-chain) senza interagire con la blockchain locale della DAO:
```bash
cd veramo
npm run full-flow
```
