# 🚀 Flusso di Esecuzione Completo (SSI + DAO)

Questo documento elenca la sequenza esatta e aggiornata dei comandi da eseguire nei terminali WSL per avviare l'intero progetto, dall'emissione delle Verifiable Credentials (VC) off-chain fino all'upgrade delle competenze on-chain nella DAO, sfruttando le **Best Practices W3C (Dati Semantici Reali)**.

---

## FASE 1: Il Backend Universitario (Veramo Issuer)
In questa fase simuliamo il server dell'Università che crea le identità (DID) degli studenti e rilascia le VC in formato EIP-712. I certificati conterranno veri titoli di studio testuali (es. "BachelorDegree"), voti (es. "110/110") e dati anagrafici.

1. Apri un **[Terminale 1]** (WSL).
2. Spostati nella cartella del modulo Issuer:
   ```bash
   cd ~/solidity/VCdao/veramo
   ```
3. Genera i DID per l'Università e i 10 studenti sulla rete Sepolia (da fare solo una volta se il database è vuoto):
   ```bash
   npm run create-dids
   ```
4. Emetti le 10 Verifiable Credentials crittografate:
   ```bash
   npm run issue-credential
   ```
   > **Nota:** Questo script stamperà a schermo la creazione di 10 certificati W3C con dati semantici (es. "VC emessa per Marco Rossi (Laurea Triennale)"). Se apri la cartella `/veramo/credentials/`, vedrai i JSON con i 10 campi rigorosamente in ordine alfabetico e la firma EIP-712.

---

## FASE 2: La Blockchain Locale (Hardhat Node)
Prepariamoci a simulare la rete Ethereum localmente per deployare la nostra DAO.

1. Apri un **[Terminale 2]** (WSL).
2. Spostati nella cartella del modulo DAO:
   ```bash
   cd ~/solidity/VCdao/dao
   ```
3. Avvia il nodo locale Ethereum:
   ```bash
   npx hardhat node
   ```
   > **Attenzione:** Lascia questo terminale aperto in background. Rappresenta la blockchain dove gireranno i nostri Smart Contract.

---

## FASE 3: L'Esecuzione della DAO (Deploy e Verifica)
La DAO opererà limitandosi a "leggere" i JSON che gli studenti teoricamente presenterebbero sulla dApp Web3.

1. Apri un **[Terminale 3]** (WSL) mantenendo aperte le finestre precedenti.
2. Spostati nella cartella del modulo DAO:
   ```bash
   cd ~/solidity/VCdao/dao
   ```
3. Compila gli Smart Contract per allinearli alle ultime modifiche al Traduttore Semantico W3C:
   ```bash
   npx hardhat compile
   ```
4. Esegui il ciclo di vita della DAO rigorosamente in quest'ordine:

   - **A. Deploy dei Contratti:**
     ```bash
     npx hardhat run scripts/01_deploy.ts --network localhost
     ```
     *(Il deployer scansionerà un JSON Veramo per estrarre il DID dell'Università e impostarlo come "Trusted Issuer" nello Smart Contract).*

   - **B. Ingresso Base dei Membri:**
     ```bash
     npx hardhat run scripts/02_joinMembers.ts --network localhost
     ```
     *(I wallet depositano fondi ed entrano nella DAO. Tutti partono dal grado base: "Student").*

   - **C. Attivazione Potere di Voto:**
     ```bash
     npx hardhat run scripts/03_delegateAll.ts --network localhost
     ```
     *(Ogni membro attiva il token di governance delegando il potere di voto a se stesso).*

   - **D. L'Upgrade On-Chain (Il Core della Tesi):**
     ```bash
     npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
     ```
     *(Lo script scansiona la cartella `/veramo/credentials`. Esegue le transazioni in cui la DAO legge i 10 campi anagrafici testuali, verifica la firma EIP-712 e converte le stringhe come "Professor" nei rispettivi moltiplicatori di voto)*.

   - **E. Simulazione della Governance:**
     ```bash
     npx hardhat run scripts/05_runProposals.ts --network localhost
     ```
     *(Viene simulata una votazione per dimostrare che, avendo tutti depositato 5 ETH, i Professori hanno ora un peso di voto x5, i PhD x4, confermando l'avvenuto upgrade).*

---

## FASE 4 (Opzionale): Test Automatizzati
Per eseguire l'intera suite di Test Unitari che verifica matematicamente ogni singolo edge-case sulle firme EIP-712 fallate, i DID sbagliati e le traduzioni semantiche:
```bash
cd ~/solidity/VCdao/dao
npx hardhat test
```
