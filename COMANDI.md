# Guida ai Comandi del Progetto VC-DAO

Questa guida riassume tutti i comandi necessari per configurare, eseguire e testare il progetto, inclusi i report sui costi del gas.

---

## 1. Configurazione Iniziale

Esegui l'installazione delle dipendenze in entrambe le cartelle principali.

### Modulo DAO (Smart Contracts)
```bash
cd dao
npm install
```

### Modulo Veramo (SSI / Verifiable Credentials)
```bash
cd veramo
npm install
```

---

## 2. Esecuzione del Progetto (Pipeline Completa)

Per simulare l'intero ciclo di vita della DAO (deploy, join, upgrade, votazioni, esecuzione), segui questi passaggi:

1. **Avvia il nodo locale Hardhat** (in un terminale separato):
   ```bash
   cd dao
   npx hardhat node
   ```

2. **Esegui la pipeline degli script** (in un altro terminale, dentro la cartella `dao`):
   ```bash
   # Compila i contratti
   npx hardhat compile

   # Esegui gli script in ordine
   npx hardhat run scripts/01_deploy.ts --network localhost
   npx hardhat run scripts/02_joinMembers.ts --network localhost
   npx hardhat run scripts/03_delegateAll.ts --network localhost
   npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
   npx hardhat run scripts/05_depositTreasury.ts --network localhost
   npx hardhat run scripts/06_createProposals.ts --network localhost
   npx hardhat run scripts/07_voteOnProposals.ts --network localhost
   npx hardhat run scripts/08_executeProposals.ts --network localhost
   ```

---

## 3. Comandi per i Costi del Gas

Il progetto include test specifici per misurare e analizzare i costi del gas.

### Report Gas Hardhat (Standard)
Mostra una tabella riassuntiva di tutte le funzioni chiamate durante i test.
```bash
cd dao
REPORT_GAS=true npx hardhat test
```

### Report Gas Dettagliato (per Tesi)
Questi test generano report formattati con conversioni in ETH e USD per diverse reti (Mainnet, Arbitrum, Optimism).

1. **Stima Gas Operazioni Singole**:
   ```bash
   npx hardhat test test/06_gasEstimation.test.ts
   ```

2. **Report Completo (DAO + SSI)**:
   Genera una tabella esaustiva con tutti i costi di deploy e interazione.
   ```bash
   npx hardhat test test/07_fullGasReport.test.ts
   ```

---

## 4. Modulo Veramo (Emissione Credenziali)

Per generare le Verifiable Credentials (VC) firmate che verranno usate dalla DAO:

```bash
cd veramo
# Emette le credenziali per i membri della DAO
npm run issue-for-dao
```

Altre utility disponibili in `veramo`:
- `npm run create-dids`: Crea i DID per i test.
- `npm run full-flow`: Esegue un flusso completo SSI off-chain.

---

## 5. Altri Comandi Utili

- **Pulizia Cache**: `npx hardhat clean`
- **Generazione Documentazione**: `npx hardhat dodoc` (se configurato)
- **Verifica Contratti**: `npx hardhat verify --network <network> <address>`
