# Ordine di Studio del Progetto (CompetenceDAO)

Per poter padroneggiare interamente sia la componente decentralizzata (DAO) sia la componente di identità (SSI/Veramo) e discutere con successo il progetto alla tesi, ti consiglio di studiare i file **esattamente in questo ordine**.

## A) Visione Generale (Documentazione)
Prima di leggere il codice, capisci cosa stai per leggere.
1. `Flusso_Esecuzione.md` (Spiega a grandi linee come DAO e Veramo comunicano).
2. `COMANDI_RUN_PROGETTO.md` (Utile per avere in mente il risultato pratico che otterrai e come lanciare i nodi).
3. `MODULI_STUDIO_TESI.md` (Sintetizza i 4 pilastri teorici che devi conoscere).

## B) La Dapp Decentralizzata (Smart Contracts - Cartella `dao/contracts/`)
I file Solidity costituiscono le "regole immutabili" della tua applicazione.
1. **`Treasury.sol`**: File semplicissimo. Capisci come i fondi vengono custoditi e come la funzione `invest` blocchi chiunque tranne il `Timelock`.
2. **`VPVerifier.sol`**: File chiave matematico. Qui vedi come hai replicato in Solidity le struct W3C (Issuer, CredentialSubject) e come la libreria decifra le firme (EIP-712).
3. **`GovernanceToken.sol`**: Il cuore pulsante. Estende ERC20Votes (che permette di delegare voti), aggiunge il concetto di `joinDAO`, e soprattutto ospita la funzione monumentale `upgradeCompetenceWithVP()`, che unisce la tokenomics alla `VPVerifier.sol`.
4. **`MyGovernor.sol`**: Il modulo di voto Openzeppelin. Non serve studiarlo a memoria, basta capire come hai configurato (i parametri nel `constructor`: threshold, delay, period, superquorum).

## C) Il Backend delle Identità (Veramo SSI - Cartella `veramo/`)
La magia dell'emissione "gasless" off-chain avviene qui.
1. **`types/credentials.ts` e `agent/setup.ts`**: Tipi, costanti e configurazione del database per le chiavi private. 
2. **`scripts/1-create-dids.ts`**: Capisci come si registrano su Veramo gli Holder.
3. **`scripts/issue-for-dao.ts` (Core)**: Questo script va studiato riga per riga. Capisci il passaggio da dati utente a firma Typescript `signTypedData()`, per arrivare alla costruzione della W3C Verifiable Credential in formato JSON puro.
4. **`scripts/5-full-flow.ts`**: Leggilo per avere una panoramica di come i controlli della VC potrebbero essere fatti off-chain.

## D) Gli Script Operativi (Ciclo di Vita - Cartella `dao/scripts/`)
Leggere questi file equivale a veder girare il progetto al rallentatore passo passo, e sono pieni di commenti didattici.
1. **`01_deploy.ts`**: Inizializzazione del DAO, setup ruoli Timelock, salvataggio addresses.
2. **`02_joinMembers.ts` e `03_delegateAll.ts`**: Distribuzione tokens e attivazione voting power (importante per l'Openzeppelin ERC20Votes).
3. **`04_upgradeCompetences.ts`**: Script più ostico. Mostra come leggere i File JSON dal disco rigido, controllarli e inviarli alla blockchain come calldata.
4. Dal **`05_depositTreasury.ts`** allo **`08_executeProposals.ts`**: Il normale ciclo di vita della tesoreria e del superquorum. Basta scorrerli per capire come una proposta diventi codice eseguibile.
