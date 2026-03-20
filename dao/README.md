Progetto 1: EduInvestment DAO – Mattia Prestifilippo
Questo progetto implementa una DAO in cui il potere di voto non è determinato solo dalla quantità di ETH versati da un utente, ma è influenzato dal grado di competenza del membro. I membri con grado di competenza più elevato ricevono un coefficiente che va a moltiplicare i propri token, amplificando il loro potere di voto.
Questo vuole essere solo un primo esempio per vedere il funzionamento delle DAO e per dare il potere di voto in base alle competenze.
Link github: https://github.com/mattiaprestifilippocolombrino/competenceBasedDao

Decisioni principali
Chiunque può entrare nella DAO inviando ETH e ricevendo token. In una prima idea per partecipare alla DAO doveva essere effettuata una proposta ed approvata dai membri della DAO, ma per rendere il processo aperto a più utenti ho scelto che in questa versione chiunque possa unirsi alla DAO e mintare token.
I token vengono forniti all’utente basandosi sugli ETH investiti moltiplicati per un coefficiente dato dal grado accademico dell’utente. Quando l’utente entra nella DAO, parte dal livello base. Se in futuro, fornisce una prova della sua competenza, questa viene sottomessa come proposal alla DAO. Se la proposta passa, i suoi token attuali vengono moltiplicati allo score delle sue competenze ed acquisisce maggior potere di voto. Quando deposita soldi e minta nuovi token, ne riceve in base ai soldi versati e al grado di competenza che ha.
Sia nel caso di mint per unione alla DAO, che in caso di mint successivo, i soldi depositati vengono inviati dallo smart contract del token direttamente a quello del treasury della DAO.
Anche il mint dei token dopo il join inizialmente doveva essere approvato dalla DAO, ma per il momento per rendere più semplice agli utenti e soprattutto invogliarli ad investire nella DAO, ho lasciato libero il mint dei token, senza passare da una proposal. Si ricorda che è impossibile acquistare potere di voto durante una proposal, poiché anche se i token vengono mintati, la proposal tiene conto della totalSupply di token del blocco in cui parte il votingPeriod.
Le proposte vengono utilizzate per decidere collettivamente come investire i soldi depositati nella treasury. Solo il TimeLockController è autorizzato ad eseguire le azioni approvate relative alle proposal, e a investire i soldi del treasury.
Il ciclo di vita di una proposta, in caso di successo, è: propose → (votingDelay) → vote → (votingPeriod) → queue → (timelockDelay) → execute.

Formula dei Token
TokenBase = #ETHVersati x 1000 token
TokenTotali = TokenBase × CoefficienteCompetenza

Gradi di competenza: In questo primo esempio, si considera per semplicità una DAO universitaria. I gradi sono Simple Student con coefficiente 1, Bachelor Degree con coefficiente 2, Master Degree con coefficiente 3, PhD con coefficiente 4, Bachelor Degree con coefficiente 5. 
Nelle versioni successive i gradi di competenza saranno implementati in base a competenze reale fornite da VC.
La DAO utilizza un quorum del 20%, per cui per essere valida una proposta devono votare almeno il 20% della totalSupply, e un superquorum del 70%, per cui la proposta se viene raggiunto il 70% viene approvata immediatamente, senza attendere la fine del voting period.
Il progetto utilizza Solidity, HardHat, Typescript e le API offerte dalla libreria OpenZeppelin.

Smart Contract
 

GovernanceToken.sol
Smart Contract che implementa il token usato per votare nella DAO. Chiunque può unirsi alla DAO chiamando joinDAO() e inviando ETH, e ricevendo token in proporzione. 
Per aumentare il proprio peso di voto, un membro può richiedere un UPGRADE DI COMPETENZA tramite proposta di governance. I membri votano e, se approvata, il Timelock della DAO chiama upgradeCompetence().
I membri possono acquistare token aggiuntivi chiamando mintTokens().
Dettagli implementativi
Il token eredita ERC20 per le funzionalità base del token (transfer, balanceOf, ecc.), e ERC20Votes per la gestione del potere di voto nella DAO, con checkpoint basati sul blocco di inizio votazione e delega del potere di voto.

I gradi di competenza sono rappresentati da una Enum chiamata CompetenceGrade, in cui il grado di partenza è Student con 1, BachelorDegree con 2, MasterDegree con 3, PhD con 4 e Professor con 5.

Vengono usate come costanti il tasso di conversione (1 ETH = 1.000 token) e il deposito massimo per membro (100 ETH).
Come variabili di stato vengono usati l’indirizzo del TimelockController, usato per eseguire gli upgrade di competenza autorizzati dalla governance; l’indirizzo del Treasury, usato per inviare gli ETH ricevuti dai joinDAO() e dai mintTokens(); l’indirizzo del deployer, usato per chiamare setTreasury() al deploy della DAO.
Viene usata una mappa competenceScore che associa ad ogni grado di competenza il relativo coefficiente; Una mappa baseTokens che associa ad ogni membro il numero di token ricevuti prima dell'upgrade di competenza; Una mappa memberGrade che associa ad ogni membro il suo grado di competenza; Una mappa isMember che associa ad ogni membro il flag isMember.

Vengono usati due decorator. Un decorator onlyTimelock che obbliga la funzione interna ad essere eseguita solo dal TimeLockController, e un decorator onlyDeployer() che obbliga la funzione interna ad essere eseguita solo dal deployer.

Il costruttore dello smart contract prende come input l'indirizzo del TimelockController della DAO, inizializza il token, l'indirizzo del timelock e del deployer e imposta la tabella dei coefficienti di competenza.

La funzione setTreasury() è uan funzione di setup one shot che imposta l'indirizzo del Treasury. Prende in input l'indirizzo del treasury e può essere chiamata una sola volta, solo dal deployer. È necessaria perché il Treasury viene deployato dopo il GovernanceToken.

La funzione joinDAO() è una funzione usata dagli utenti per entrare nella DAO, chiamabile da chiunque, senza passare da una proposal. Può essere chiamata solo dagli utenti che non sono ancora membri della DAO. Controlla che il treasury abbia un indirizzo assegnato, che il deposito sia superiore a 0 e inferiore al deposito massimo consentito. Calcola il numero di token da ricevere in base al deposito effettuato. Imposta il membro come attivo, come grado base Student e imposta il deposito effettuato. Minta i token e li invia al membro. Trasferisce gli ETH ricevuti direttamente al treasury.

La funzione mintTokens() è una funzione che minta i token successivamente all'ingresso nella DAO, inviando ETH. I token tengono conto del grado di competenza dell'utente. La funzione controlla che il membro sia effettivamente un membro della DAO, che il treasury abbia un indirizzo assegnato e che il deposito inviato sia superiore a 0.
La formula per calcolare i token mintati è: tokenMintati = ETH × 1.000 × coefficienteCompetenza. I baseTokens vengono aggiornati per i futuri calcoli di upgrade. Gli ETH vengono trasferiti direttamente al Treasury.

La funzione upgradeCompetence() è una funzione che promuove un membro a un grado superiore in base alle competenze dimostrate e dalla proof portata. Essendo una funzione di governance della DAO, può essere chiamata solo dal Timelock dopo approvazione della governance. Viene controllato che l'utente sia un membro della DAO, e che il grado sia superiore a quello corrente. Viene calcolato il numero di token aggiuntivi da mintare moltiplicando i baseTokens per la differenza tra il nuovo e il vecchio coefficiente di competenza. I token aggiuntivi vengono mintati e inviati al membro. Il grado di competenza del membro e la proof vengono aggiornati.

Override: Viene richiesto da Solidity di effettuare l'override della funzione _update e nonces per risolvere conflitti di ereditarietà tra ERC20, ERC20Votes e ERC20Permit.


MyGovernor.sol
Contratto che gestisce la governance della DAO, ovvero l'intero ciclo di vita delle proposte di investimento: propose → vote → queue → (delay) → execute.
Eredita 7 moduli OpenZeppelin che lavorano insieme:
-Governor (core): Fornisce la struttura di base per gestire le proposte
-GovernorSettings: Fornisce i parametri di voto: votingDelay, votingPeriod, threshold
-GovernorCountingSimple: Fornisce le funzioni di conteggio: For / Against / Abstain
-GovernorVotes: Collega il token ERC20Votes al Governor
-GovernorVotesQuorumFraction: Gestisce i parametri di quorum: Quorum in % della supply totale
-GovernorVotesSuperQuorumFraction: Gestisce i parametri di superquorum per l'approvazione rapida
-GovernorTimelockControl: Gestisce il timelock, che fornisce un delay di sicurezza prima dell'esecuzione. 
Il flusso di esecuzione di una proposta è il seguente: 
    1. propose()   → crea la proposta, stato = Pending
    2. (voting delay passa) → stato = Active
    3. castVote()  → i membri votano For/Against/Abstain
    4. (voting period finisce) → stato = Succeeded o Defeated
       OPPURE: se superquorum raggiunto → Succeeded prima della scadenza!
    5. queue()     → mette la proposta nel Timelock (stato = Queued)
    6. (timelock delay passa)
    7. execute()   → il Timelock esegue l'operazione (stato = Executed)

Il costruttore riceve in input il Token ERC20Votes, il TimelockController, il numero di blocchi di attesa prima dell'inizio del voto, la durata della finestra di voto, la soglia minima di voti per poter creare una proposta, il quorum in % della supply totale votabile al blocco di snapshot della proposta, e il superquorum. I contratti ereditati vengono inizializzati con tali parametri.

Si ha un quorum del 20% e un superquorum del 70%. Il Timelock gestisce la messa in coda delle operazioni approvate e la loro esecuzione.
Il contratto esegue l'override richiesto da Solidity per le funzioni di votingDelay, votingPeriod, proposalThreshold, quorum, clock, e _execute.


Treasury.sol
Contratto che conserva i fondi della DAO e permette di investirli in startup solo se l'operazione è stata approvata dalla governance e passa attraverso il TimelockController.
Il Treasury non è controllabile dal deployer né da nessun altro account.
L’unico indirizzo che può chiamare la funzione invest() è il TimelockController.
Questo garantisce che nessun singolo individuo possa spostare i fondi
senza il consenso della DAO.

FLUSSO:
1. I membri depositano mintando token o inviando ETH direttamente.
2. Un membro propone un investimento tramite il Governor.
3. La comunità vota.
4. Se approvata, la proposta viene messa in coda nel Timelock.
5. Dopo il delay, il Timelock esegue Treasury.invest(), inviando gli ETH alla startup.

Come variabili di stato abbiamo l’address del TimelockController, che  l'unico che può ordinare investimenti; Un mapping che mantiene lo storico di tutti gli investimenti effettuati, con chiave l'indirizzo startup e valore gli ETH investiti su di essa.

Abbiamo un decorator usato per indicare che solo il Timelock può chiamare la funzione decorata. Il costruttore dello smart contract inizializza il Treasury prendendo in input e impostando l'indirizzo del TimelockController.
Si ha una funzione deposit() che permette a chiunque di depositare ETH nel Treasury. Questa viene chiamata dal GovernanceToken per depositare i soldi ricevuti per il mint dei token.

La funzione principale del Treasury è invest(), chiamabile solo dal TimeLock, che permette alla DAO di investire ETH in una startup. Prende in input l'indirizzo della startup destinataria e l'importo in wei da investire. Viene chiamata dal Timelock dopo che una proposta di investimento è stata approvata e il delay è trascorso. Incrementa l'importo investito nella startup e trasferisce ETH alla startup.

Si ha anche una funzione getBalance() che restituisce il saldo attuale del Treasury.

StartupRegistry.sol
Contratto che mantiene un registro on-chain di startup/progetti verso cui la DAO può investire. Invece di proporre investimenti verso indirizzi "random", la DAO può
verificare che la startup sia registrata dai membri e attiva. 
TODO: In questo momento solo il deployer del contratto può aggiungere startup al registro. Il contratto deve essere aggiornato in modo che solo la DAO può aggiungere startup, quindi solo il TimeLockController.

MockStartup.sol
Contratto che simula una startup che riceve investimenti dalla DAO. Serve a verificare nei test il corretto funzionamento della logica di investimento, e  che i fondi siano arrivati.
La funzione receive() permette al contratto di ricevere ETH e registra l'investimento.
La funzione getBalance() restituisce il saldo ETH attuale del contratto.


Pipeline degli Script
Gli 8 script nella cartella scripts/ formano una pipeline sequenziale che dimostra l'intero ciclo di vita della DAO, partendo dal deploy iniziale, il join di tutti i membri, l’auto delegazione del potere di voto, l’upgrade di competenze di alcuni membri, il deposito nella Treasury con relativo mint di token, la creazione di proposal da parte dei membri, il processo di voto, e dopo il delay l’esecuzione delle azioni votate dalle proposal.
Comandi da usare
npx hardhat compile
npx hardhat node
Su un altro terminale:
npx hardhat run scripts/01_deploy.ts --network localhost
npx hardhat run scripts/02_joinMembers.ts --network localhost
npx hardhat run scripts/03_delegateAll.ts --network localhost
npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
npx hardhat run scripts/05_depositTreasury.ts --network localhost
npx hardhat run scripts/06_createProposals.ts --network localhost
npx hardhat run scripts/07_voteOnProposals.ts --network localhost
npx hardhat run scripts/08_executeProposals.ts --network localhost


01_deploy.ts
Script di deploy di tutti i contratti della DAO. 
Il primo contratto deployato è il TimelockController, che ritarda ed esegue le proposte approvate. I parametri passati sono il tempo di delay di 1 ora, la lista vuota degli indirizzi con ruolo proposer, executors, e admin, impostata inizialmente all’indirizzo del deployer e poi revocata.
La funzione ethers.getContractFactory("TimelockController") richiede la factory, la componente che permette di creare istanze del contratto.
La funzione Timelock.deploy(args) crea l'istanza del contratto a partire dalla factory, chiamando il costruttore con i parametri specificati ed eseguendo il deploy.
La funzione timelock.waitForDeployment() attende che la transazione venga minata e che il contratto venga realmente creato sulla blockchain.
Per il deploy dei contratti successivi queste funzioni sono usate in modo analogo.

Il GovernanceToken viene deployato ricevendo in input l'indirizzo del Timelock, utilizzato dal token per fare gli upgrade.

Il contratto MyGovernor viene deployato impostando i parametri di governance principali. La DAO aspetta 1 blocco prima di votare, poi 50 blocchi per votare.
Serve lo 0% dei token ad un utente per proporre (da aggiornare), poi serve il 20% della supply per il quorum, poi serve il 70% della supply per l'approvazione immediata tramite superquorum.
TODO: Quorum, SuperQuorum e delay iniziale vanno bene, devo aggiornare rendendo verosimile delay di voto e proposal treshoold.

Il Treasury della DAO viene deployato ricevendo come parametro l'indirizzo del Timelock, in quanto solo il Timelock può chiamare invest().
Viene effettuato il collegamento tra Token e Treasury, in modo che il token sappia dove inviare gli ETH mintati dagli utenti che entrano nella DAO. setTreasury() può essere chiamata una sola volta dal deployer.
Il deployer entra nella DAO e chiama joinDAO() con 100 ETH, ricevendo 100k token. Poi delega i voti a sé stesso per attivare il voting power.
Vengono deployati i contratti StartupRegistry e MockStartup.

Vengono configurati i ruoli del Timelock. Solo il Governor può mettere in coda le proposte nel TimeLock (chiunque può sottometterle al Governor). Chiunque (address(0)) può eseguire le proposte in coda dopo il delay. Il Governor può cancellare le proposte in coda. Infine revochiamo l'admin al deployer, in modo che la DAO sia completamente decentralizzata.

Tutti gli indirizzi dei contratti vengono salvati poi in un file JSON, in modo che gli script successivi possano riconnettersi ai contratti deployati.


02_joinMembers.ts 
Vengono creati 14 membri. Ogni utente chiama joinDAO() inviando ETH al contratto GovernanceToken e ricevendo token in proporzione.
Dopo il mint ogni membro parte come Student (coefficiente 1). Gli ETH vengono trasferiti automaticamente nel Treasury.
Il fondatore (signers[0]) è già entrato nel deploy con 100 ETH. Qui entrano i restanti 14 membri (signers[1..14]). Per ogni membro si stampa i token ottenuti, e infine la total supply.
 

03_delegateAll.ts
Contratto che Auto-delega i token per dare potere di voti a tutti i 15 membri.
Mina 1 blocco per avanzare il tempo on-chain e consolidare i checkpoint.

04_upgradeCompetences.ts 
Script che esegue l'upgrade delle competenze dei membri tramite governance.
Crea una proposta di governance che contiene 13 upgrade di competenza
in un'unica operazione batch.  Gli utenti che hanno eseguito l'upgrade ricevono i token aggiuntivi che gli spettano.
Viene creata la proposta di upgrade, specificando per ogni membro indirizzo, grado e prova di competenza. Si avanza di votingDelay + 1 blocchi per arrivare alla fase di voto.
Viene sottoposta a voto e approvata. Vengono avanzati i blocchi fino alla fine del periodo di voto. Viene inclusa nella coda del Timelock, viene avanzato il tempo fino alla fine del periodo di attesa e poi viene eseguita. Viene infine stampata la total supply, il quorum e il superquorum aggiornati.

05_depositTreasury.ts 
Script in cui i membri della DAO mintano nuovi token inviando ETH tramite mintTokens(). I token ricevuti tengono conto del grado di competenza attuale.
Gli ETH vengono automaticamente trasferiti al Treasury della DAO.

06_createProposals.ts 
Script che crea 4 proposte di governance per investire ETH dal Treasury della DAO in una startup.
Si hanno 4 PROPOSTE, con supply (3.507.000), quorum 20% (701.400), e superquorum 70% (2.454.900). Le proposte sono le seguenti:
-A: "Lab AI", investimento di 10 ETH, vincerà con SUPERQUORUM (>70% vota FOR).
-B: "Ricerca", investimento di 3 ETH, vincerà con 63% FOR a fine votazione.
-C: "Espansione", investimento di 8 ETH, raggiungerà il quorum, ma la maggioranza vota AGAINST.
-D: "Fondo Minore", investimento di 1 ETH, non raggiungerà il quorum.
Per ogni proposta viene codificata la chiamata invest(startup, importo) come calldata 
e inviata al Governor con propose().
Il Governor riceve in input l'indirizzo del contratto da chiamare, il Treasury, come targets, gli ETH da inviare con la chiamata, 0, perché invest() non è payable, come values, la chiamata codificata (invest(startup, importo)) come calldatas e la descrizione della proposta. Gli ID delle proposte vengono salvati in proposalState.json per gli script successivi.

07_voteOnProposals.ts
Script che avanza il votingDelay (1 blocco) per entrare nella fase di voto, i membri votano sulle 4 proposte create nello script precedente, avanza il votingPeriod (50 blocchi) per chiudere le votazioni e mette in coda le proposte vincenti nel Timelock.
I valori di voto assegnati sono 0 ad AGAINST, 1 a FOR. Si vota chiamando la funzione castVote().
Proposta A: Prof1 (750k) + Prof2 (600k) + Prof3 (675k) + Prof4 (525k) = 2.550.000 FOR (72.7%). Supera il 70%, quindi raggiunge subito il superquorum.
Proposta B: Prof1 (750k) + PhD1 (160k) votano FOR (910.000), Prof5 (450k) + PhD3 (80k) votano AGAINST (530.000). Si ha 63% FOR, raggiungendo il quorum raggiunto. Viene quindi approvata a fine periodo.
Proposta C: Prof5 (450k) + PhD1 (160k) + PhD2 (132k) votano FOR (742.000), Prof1 (750k) + Prof2 (600k) votano AGAINST (1.350.000). Si ha 35% FOR, quindi viene bocciata.
Proposta D: Bachelor2 (10k) + Bachelor3 (12k) + Student1 (2k) + Student2 (1k) votano FOR, si hanno 25.000 FOR. E’ molto sotto il 20%, quindi viene bocciata.
Lo script avanza per i blocchi previsti dal voting period. Le proposte approvate vengono inserite usando la funzione queue() nel TimeLock, con il delay configurato (1 ora).

 08_executeProposals.ts 
Script usato per l’esecuzione delle proposte approvate. Lo script avanza il tempo di 1 ora per far passare il delay del Timelock. Trascorso il delay, chiunque può chiamare execute() per eseguire la proposta. Viene ricostruito il calldata (deve essere identico a quello della proposta) e inviato al Timelock. Viene chiamato execute(). L'execute() chiama la funzione della proposta, treasury.invest(startup, importo) che trasferisce ETH alla startup.