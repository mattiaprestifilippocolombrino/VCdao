# Comandi Utili per il Progetto VC-DAO

Di seguito sono elencati i comandi principali per compilare, testare e generare i report sul gas per il tuo progetto di tesi. 
**Importante:** Tutti i comandi devono essere eseguiti all'interno della cartella `dao` (`cd /home/matti/solidity/VCdao/dao` su WSL).

## 1. Compilazione
Prima di eseguire test o script, assicurati che i contratti siano compilati e i tipi (TypeChain) siano aggiornati.
```bash
npx hardhat compile
```

## 2. Test Completi
Esegue l'intera suite di test del progetto (cartella `test/`) per verificare che tutta la logica (SSI, DAO, Governance) funzioni correttamente.
```bash
npx hardhat test
```

## 3. Stima e Report del Gas (Ideale per la Tesi)
Questi comandi eseguono specifici file di test che stampano in console tabelle precise con il costo in gas, convertendolo in ETH e USD (utilizzando le best practice e funzioni di libreria).

**Stima del Gas Dettagliata (Focus VP e approccio Self-Sovereign):**
```bash
npx hardhat test test/06_gasEstimation.test.ts
```

**Report del Gas Completo (Tutto l'ecosistema DAO e SSI):**
```bash
npx hardhat test test/07_fullGasReport.test.ts
```

## 4. Simulazione Completa (Esecuzione Script)
Se vuoi simulare l'intero ciclo di vita del progetto (dal deployment all'aggiornamento competenze), puoi eseguire gli script in sequenza:

```bash
# Se vuoi solo testare gli script sull'ambiente effimero di Hardhat:
npx hardhat run scripts/01_deploy.ts
# e così via per gli script successivi (02, 03, 04...)
```

*Se invece vuoi mantenere i dati persistenti tra uno script e l'altro durante i test manuali:*
1. Avvia un nodo locale in un terminale separato:
   ```bash
   npx hardhat node
   ```
2. In un altro terminale, esegui gli script specificando la rete locale:
   ```bash
   npx hardhat run scripts/01_deploy.ts --network localhost
   npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
   ```
