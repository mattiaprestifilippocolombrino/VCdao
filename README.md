Progetto competenceDAO – Mattia Prestifilippo
Modulo DAO
Questo progetto implementa una DAO in cui il potere di voto non è determinato solo dalla quantità di ETH versati da un utente, ma è influenzato anche dal grado di competenza del membro. Il voting power di ogni utente è rappresentato da un token di governance ERC20. I membri con grado di competenza più elevato ricevono un numero maggiore di token, amplificando il loro potere di voto.
Questo vuole essere solo un primo esempio per vedere il funzionamento delle DAO e per dare il potere di voto in base alle competenze.
Link github: https://github.com/mattiaprestifilippocolombrino/competenceBasedDao

Scelte di governance
Chiunque può unirsi alla DAO chiamando joinDAO(), inviando ETH e ricevendo in cambio token. Quando l’utente entra nella DAO, parte dal livello di competenza base.
Il potere di voto di un membro della DAO dipende dalla quantità di ETH depositati nella DAO e dal livello di competenza del membro.
Se in futuro un membro fornisce una Verifiable Credential che prova il suo livello di competenza, la DAO verifica on-chain se la VC è valida ed è firmata da un Issuer fidato dalla DAO. Se la verifica passa, il membro ottiene maggiore potere di voto. 
Se il membro deposita in futuro altri ETH, la quantità dei propri token aumenta.
Sia nel caso di mint per unione alla DAO, che in caso di mint successivo, i soldi depositati vengono inviati dallo smart contract del token direttamente a quello del treasury della DAO.
In un’idea iniziale sia il join che il mint dei token dopo il join dovevano essere approvati dalla DAO, ma per rendere più semplice agli utenti l’accesso e soprattutto invogliarli ad investire nella DAO, si è scelto di lasciare libero il join e il mint di token, senza passare da una proposal. 
Si ricorda che è impossibile acquistare potere di voto durante una proposal, poiché anche se i token vengono mintati, la proposal tiene conto della totalSupply di token del blocco in cui parte il votingPeriod.
Le proposte vengono utilizzate per decidere collettivamente come investire i soldi depositati nella treasury. Solo il TimeLockController è autorizzato ad eseguire le azioni approvate relative alle proposal, e a investire i soldi del treasury.
Il ciclo di vita di una proposta, in caso di successo, è: propose → (votingDelay) → vote → (votingPeriod) → queue → (timelockDelay) → execute.


Formula per calcolare il voting power di un membro
Il numero totale dei token rappresenta il potere di voto del membro. Viene calcolato usando la seguente formula:
ScoreTotale =  pesoSoldi × scoreSoldi + pesoCompetenze × scoreCompetenze
dove:
scoreCompetenze ∈ {0, 25, 50, 75, 100}, a secondo del grado accademico del membro verificato da una VC presentata alla DAO.
scoreSoldi = min(ethDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100]
pesoCompetenze + pesoSoldi = 10.000 bp (configurabili al deploy del Token)
Si nota che ScoreTotale = parteCompetenze + parteSoldi. 
La parteSoldi della formula viene calcolata al momento del minting di token via deposito di ETH(joinDAO / mintTokens) sottoforma di token, usando la prima parte della formula.
La parteCompetenze viene calcolata al momento dell'upgrade competenze via VC, ottenendo token secondo la seconda parte della formula. 
Gradi di competenza: In questa implementazione si considera una DAO universitaria. I gradi sono Simple Student con coefficiente 0, Bachelor Degree con coefficiente 25, Master Degree con coefficiente 50, PhD con coefficiente 75, Professor con coefficiente 100. Ogni membro inizia dal grado base Simple Student. Il grado di competenza di un membro può essere migliorato fornendo alla DAO una Verifiable Credential contenente il proprio grado di competenza, firmata da un Trusted Issuer. 

Quorum e Superquorum: In questa implementazione la DAO utilizza un quorum del 20%, per cui per essere valida una proposta devono votare almeno il 20% della totalSupply, e un superquorum del 70%, per cui la proposta viene approvata immediatamente se viene raggiunto il 70%, senza attendere la fine del voting period.
Il progetto utilizza Solidity, HardHat, Typescript e le API offerte dalla libreria OpenZeppelin.

Smart Contract
 

GovernanceToken.sol
Smart Contract che implementa il token ERC20 usato per votare nella DAO.
Chiunque può unirsi alla DAO chiamando joinDAO() e inviando ETH.
Per aumentare il proprio potere di voto, un membro puo effettuare un UPGRADE DI COMPETENZA presentando una Verifiable Credential. Se la verifica va a buon fine, viene usato il metodo upgradeCompetence() per aumentare il grado di competenza del membro. I membri possono acquistare token aggiuntivi chiamando mintTokens().
Dettagli implementativi
Il token eredita ERC20 per le funzionalità base del token (transfer, balanceOf, ecc.), e ERC20Votes per la gestione del potere di voto nella DAO, con checkpoint basati sul blocco di inizio votazione e delega del potere di voto.

I gradi di competenza sono rappresentati da una Enum chiamata CompetenceGrade, in cui il grado di partenza è Student con 0 con score 0, BachelorDegree con 1 con score 25, MasterDegree con 2 con score 50, PhD con 3 con score 75 e Professor con 4 con score 100.

Costanti: Vengono usate come costanti il deposito massimo per membro (100 ETH), il massimo livello enum supportato (4), il denominatore basis points (10 000) che rappresenta il 100% per effettuare i calcoli in %, e il Domain separator EIP-712 universale, usato nella verifica VC.
Il Domain separator EIP-712 universale viene usato come costante poiché precalcolato a compile-time, in modo che il valore viene incorporato direttamente nel bytecode senza occupare storage e senza costi di SLOAD.
 

Variabili di stato: Come variabili di stato vengono usati l’indirizzo del TimelockController, usato per eseguire gli upgrade di competenza autorizzati dalla governance; l’indirizzo del Treasury, usato per inviare gli ETH ricevuti dai joinDAO() e dai mintTokens(); l’indirizzo del deployer, usato per chiamare setTreasury() al deploy della DAOM l’indirizzo del Trusted Issuer, usato per verificare se una VC è firmata da un issuer fidato dalla DAO; Si ha il peso della componente accademica nella formula VPC, in percentuale bp; il peso della componente economica nella formula VPC, in percentuale bp.

Mapping: Viene usata una mappa competenceScore che associa ad ogni grado di competenza il relativo score, usato per calcolare il potere di voto del membro.; Una mappa ethDeposited che tiene traccia di quanti ETH ha depositato ogni membro (in wei); Una mappa memberGrade che associa ad ogni membro il suo grado di competenza; Una mappa isMember che tiene traccia degli indirizzi membri della DAO; una mappa competenceProof che tiene  traccia per ogni membro della proof dell'upgrade piu recente; Una mappa memberDID che associa ogni membro al suo DID; Una mappa didToAddress che associa ogni DID al suo indirizzo, per garantire l'unicita dei DID nella DAO.

Decorator: Vengono usati due decorator. Un decorator onlyTimelock che obbliga la funzione interna ad essere eseguita solo dal TimeLockController, e un decorator onlyDeployer() che obbliga la funzione interna ad essere eseguita solo dal deployer.

Il costruttore dello smart contract prende come input l'indirizzo del TimelockController della DAO, il peso delle competenze e il peso dei soldi. Inizializza il token, l'indirizzo del timelock e del deployer, imposta i pesiCompetenza e pesoSoldi e imposta la tabella dei coefficienti di competenza.
 

La funzione setTreasury() è una funzione di setup one shot che imposta l'indirizzo del Treasury. Prende in input l'indirizzo del treasury e può essere chiamata una sola volta, solo dal deployer. È necessaria perché il Treasury viene deployato dopo il GovernanceToken.
 

La funzione setTrustedIssuer() è una funzione che configura l'issuer fidato, ossia colui firma le VC, fidato dalla DAO. Il deployer può impostarlo solo al primo setup. Dopo la prima configurazione, solo la governance (timelock) può cambiarlo.
 

La funzione _calculateMintedTokensForSoldi() è una funzione di utility che calcola i token da mintare per la componente economica della formula VPC.
Formula applicata: pesoSoldi × ΔscoreSoldi, dove scoreSoldi = min(ethDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100].
La funzione prende il vecchio e il nuovo score, effettua la differenza, e moltiplica per il pesoSoldi, calcolando i token da mintare. Il risultato è in wei (× 10^18).
Es: pesoSoldi=5000 bp, oldDeposited=5, amount = 3, newDeposited=8 → oldScore=50, newScore=80 → ΔscoreSoldi=30 → (30 × 5000 × 10^18) / 10000 = + 15 × 10^18 token
 

La funzione getScoreSoldiForDeposit() dato in input il valore del deposito di ETH, calcola scoreSoldi = min(deposited / MAX_DEPOSIT, 1) × 100.
 


La funzione joinDAO() è una funzione usata dagli utenti per entrare nella DAO, chiamabile da chiunque, senza passare da una proposal. Può essere chiamata solo dagli utenti che non sono ancora membri della DAO. Controlla che il treasury abbia un indirizzo assegnato, che il deposito sia superiore a 0 e inferiore al deposito massimo consentito. Calcola il numero di token da ricevere in base al deposito effettuato via formula VPC. In particolare la parte pesoSoldi × scoreSoldi.  Imposta il nuovo membro come attivo, con grado minimo Student e viene registrato il deposito effettuato. I token vengono mintati e inviati al membro. La funzione trasferisce gli ETH ricevuti direttamente al treasury.
 
La funzione mintTokens() è una funzione minta i token successivamente all'ingresso nella DAO, inviando ETH. La funzione controlla che il membro sia effettivamente un membro della DAO, che il treasury abbia un indirizzo assegnato e che il deposito inviato sia superiore a 0. Controlla che gli ETH depositati dal membro sommati a quelli che sta per depositare non superino MAX_DEPOSIT. Calcola il numero di token da ricevere in base al deposito effettuato via formula VPC. In particolare la parte pesoSoldi × scoreSoldi. Si tiene conto degli ETH già depositati per il calcolo dello score. Viene aggiornato il conto degli ETH depositati dall'utente. Vengono mintati i token. Gli ETH vengono trasferiti direttamente al Treasury.
 
 

La funzione registerDID registra il DID di un membro. Un membro puo registrare un solo DID e lo stesso DID non puo essere usato da due address. Verifica che il msg.sender sia un membro della DAO e che non abbia gia registrato un DID. Effettua l'hash del DID, controlla che non sia già stato registrato.  In tal caso, registra nei mapping le associazioni address -> DID e DID -> address.
 

La funzione upgradeCompetenceWithVP() esegue l'upgrade di competenza di un membro tramite VC. Usa la libreria VPVerifier.sol per verificare una VC firmata e applica l'upgrade se la VC è valida. La funzione controlla se il membro è esistente e se è configurato nella DAO l'issuer fidato. Controlla se il DID del membro è coerente con il DID nel credentialSubject. Il typehash del dominio EIP-712 è precalcolato come constant (0 gas di hashing). Recupera l'address del firmatario usando le funzioni della libreria VPVerifier sulla firma EIP-712 contenuta nella VC. Controlla se l'issuer recuperato è uguale al trustedIssuer.  In caso positivo, mappa il titolo testuale nell'enum di grado di competenza. Costruisce una stringa proof sintetica persistita on-chain. Esegue l'aggiornamento del grado del membro, tramite la funzione _performUpgrade, senza passare dalla governance.
 
 
   
La funzione _performUpgrade() si occupa di effettuare nella DAO le modifiche, dopo che la VC è stata verificata. La funzione calcola il vecchio e il nuovo punteggio di competenza del membro. Calcola i token aggiuntivi da mintare in base alla formula di VP, in particolare alla parte: pesoCompetenze × ΔscoreCompetenze.
Si ha ΔscoreCompetenze = newScore - oldScore  ∈ {25, 50, 75, 100}.
 
Viene quindi effettuata la differenza tra il vecchio score e il nuovo, e viene moltiplicata per il pesoCompetenze e divisa per 10000, mintando i token aggiuntivi al membro.
Aggiorna il grado del membro e inserisce la proof di competenza on-chain.
Es: Upgrade Student→PhD (Δ=75), pesoCompetenze=5000 bp → (75 × 5000 × 10^18) / 10000 = 37.5 × 10^18 token

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
       oppure: se superquorum raggiunto → Succeeded prima della scadenza!
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

Flusso:
1. I membri depositano mintando token o inviando ETH direttamente.
2. Un membro propone un investimento tramite il Governor.
3. La comunità vota.
4. Se approvata, la proposta viene messa in coda nel Timelock.
5. Dopo il delay, il Timelock esegue Treasury.invest(), inviando gli ETH alla startup.

Come variabili di stato abbiamo l’address del TimelockController, che l'unico che può ordinare investimenti; Un mapping che mantiene lo storico di tutti gli investimenti effettuati, con chiave l'indirizzo startup e valore gli ETH investiti su di essa.

Abbiamo un decorator usato per indicare che solo il Timelock può chiamare la funzione decorata. Il costruttore dello smart contract inizializza il Treasury prendendo in input e impostando l'indirizzo del TimelockController.
Si ha una funzione deposit() che permette a chiunque di depositare ETH nel Treasury. Questa viene chiamata dal GovernanceToken per depositare i soldi ricevuti per il mint dei token.
 
La funzione principale del Treasury è invest(), chiamabile solo dal TimeLock, che permette alla DAO di investire ETH in una startup. Prende in input l'indirizzo della startup destinataria e l'importo in wei da investire. Viene chiamata dal Timelock dopo che una proposta di investimento è stata approvata e il delay è trascorso. Incrementa l'importo investito nella startup e trasferisce ETH alla startup.
 
Si ha anche una funzione getBalance() che restituisce il saldo attuale del Treasury.

StartupRegistry.sol
Contratto che mantiene un registro on-chain di startup/progetti verso cui la DAO può investire. Invece di proporre investimenti verso indirizzi "random", la DAO può
verificare che la startup sia registrata dai membri e attiva. 
Solo la governance (TimelockController) può registrare o disattivare startup.

MockStartup.sol
Contratto che simula una startup che riceve investimenti dalla DAO. Serve a verificare nei test il corretto funzionamento della logica di investimento, e  che i fondi siano arrivati.
La funzione receive() permette al contratto di ricevere ETH e registra l'investimento.
La funzione getBalance() restituisce il saldo ETH attuale del contratto.


Verifica on-chain
La DAO permette di effettuare un upgrade del potere di voto a un membro nel caso in cui presenta una VC, rilasciata da un issuer fidato, contenente un livello certificato. In base a tale livello, se la VC viene correttamente verificata, il voting power aumenta proporzionalmente. La verifica viene fatta on-chain, mediante uno smart contract. Viene utilizzato EIP712 per la firma delle VC e per la loro verifica.

VPVerifier.sol
Libreria Solidity utile a verificare on-chain una VC firmata off-chain con EIP-712.
Prende i dati della credenziale, ricostruisce esattamente lo stesso hash digest che era stato firmato off-chain, e poi usa la firma contenuta nella VC per recuperare la chiave pubblica di chi lo ha firmato.
Il contratto chiamante confronta poi questo address con il trusted issuer. Se coincidono, la VC è valida.

Costanti TypeHash
La libreria utilizza delle costanti per costruire il typeHash, ovvero l'hash della struttura dei campi che compongono la VC. I nomi e l'ordine dei campi devono essere identici a quelli usati off-chain durante l'emissione della VC. La libreria hasha la struttura del 
credentialSubject, con al suo interno i campi id, university, faculty, degreeTitle, grade. 
 
Ricostruisce poi il typeHash della struct principale VerifiableCredential, contenente issuer, issuanceDate e credentialSubject in modo annidato, come richiede EIP-712.

 

Struct che modellano i dati della VC
La liberia crea poi delle struct utili per contenere i dati della VC. Crea una struct contenente l’identita dell'issuer (DID).
Crea poi una struct contenente i dati informativi relativi all'holder, ovvero il CredentialSubject (i campi sono gli stessi già descritti).
Crea infine una struct contenente tutti i dati della VC informativi, da certificare. Comprende come campi le due struct precedenti, e la data di emissione. 
 
Funzioni di hashing
La prima funzione si occupa di effettuare l’Hash EIP-712 della struct Issuer, hashando il typeHash e l'id dell'issuer.
 
La seconda funzione si occupa di effettuare l’Hash EIP-712 della struct CredentialSubject, hashando il typeHash e tutti i valori assunti dai campi informativi dell’holder.
 
La terza funzione si occupa di effettuare l’Hash EIP-712 della credenziale completa. Per campi struct annidati usa i rispettivi hash (`hashIssuer`, `hashCredentialSubject`), chiamando le due funzioni precedenti sui dati completi.
 

Recover Signer
La funzione di Recover Signer ricrea il digest EIP-712 usando le funzioni precedentemente implementate. Viene ricreato il digest EIP-712 concatenando il prefisso standard `0x1901`, il domainSeparator e il digest. Il digest finale deve combaciare bit-a-bit con quello usato dal firmatario off-chain. A partire dal digest e dalla firma, viene recuperato l'address relativo alla chiave pubblica che ha prodotto la firma. Il chiamante confronta poi questo address con il trusted issuer. Se coincidono, la VC è valida.
 


Generazione e firma di Verifiable Credential con Veramo
Il modulo Veramo si occupa del rilascio di VC da parte di un Issuer, in questo caso l’università, a una serie di Holder, membri dell’università. Le VC rappresentano in particolare il grado ottenuto dall’Holder certificato dall’università.
Livelli: Bachelor Degree, Master Degree, Phd, Professor.

Dilemma: Effettuare la verifica on-chain, spendendo gas, e rischiando di mostrare i dati dell’utente on-chain se non viene utilizzata la selective disclousure, ma avendo la sicurezza intrinseca della blockchain, o effettuare la verifica off-chain, dovendosi fidare del verifier, che potrebbe alterare le VC, le firme e l’integrità in generale.
I dettagli interni dei moduli che implementano la governance della DAO e gli script di Veramo sono spiegati in maggior dettaglio nelle documentazioni dei progetti precedenti. Andiamo ora a studiare i nuovi moduli che permettono l’interconnessione tra rilascio delle VC con Veramo e verifica delle VC con smart contract basati su EIP712.

Esempio VC
 
Mostriamo una VC firmata in cui l’issuer University of Pisa, identificato dal DID specificato certifica che l’holder, identificato dal DID specificato, ha un master degree in Computer Science con voto 110/110”.
@context: Indica che la VC segue lo standard ufficiale W3C. Deve essere interpetata secondo tali regole.
Type: Indica il tipo di credenziale, in questo caso è sia una VC standard che una VC di tipo UniversityDegreeCredential.
Issuer: Specifica i dati dell’issuer che rilascia e firma la credenziale, in questo caso il suo DID, che è collegato a una chiave pubblica.
issuanceDate: Data di emissione della VC.
credentialSubject: Parte della VC che contiene i dati dell’holder. Viene specificato il DID dell’holder, l’università, la facoltà, il titolo ottenuto e il voto se presente.
proof: Contiene i dati della firma crittografica che rende la VC verificabile. Descriviamo i campi contenuti al suo interno:
type: Indica il tipo di firma crittografica utilizzata. Serve al verificatore per capire quale algoritmo usare per verificarla. In questo caso la firma è basata su EIP-712.
created: Indica quando è stata creata la firma.
proofPurpose: Specifica perché la firma è stata fatta. assertionMethod significa che l’issuer sta dichiarando che questi dati sono veri.
verificationMethod: Indica quale chiave pubblica usare per verificare la firma. In questo caso si indica un DID collegato ad una chiave pubblica.
proofValue: Contiene la firma digitale vera e propria.

veramo/types/credential.ts
Modulo che contiene la definizione del modello delle VC e le costanti utilizzate per la loro creazione. Definisce il modello dei dati del Credential Subject, dei dati dell’issuer e dell’intera VC, come specificato sopra. Include costanti e tipi usati per la creazione della VC. Indica quali campi utilizzare per effettuare la firma EIP712. Indica su quali campi effettuare la Selective Disclousure.

veramo/issue-for-dao.ts
Script che emette Verifiable Credential firmate EIP-712 secondo lo schema visto precedentemente. In questo caso l’issuer è un’Università e gli holder sono i membri dell’università che hanno un determinato grado.
Il flusso di esecuzione è il seguente. 
Lo script carica da un file .env di ambiente la private key dell'issuer che firmera tutte le VC, e controlla che la private key sia una hex string lunga esattamente 32 byte.
Carica dal file di env una sequenza Mnemonic usata per rigenerare i wallet degli holder in modo deterministico.
Legge il file deployedAddresses.json contenente gli indirizzi deployati dei contratti DAO, in cui sono presenti gli indirizzi del token, del timelock, del governor, del registry e dell'issuer. Dal JSON estrae l'indirizzo dell’issuer fidato della DAO.
A partire dalla private key ottenuta dall’env otteniamo il wallet (address+public+private key) dell’issuer. Confrontiamo che l’indirizzo dell’issuer fidato della DAO corrisponde con l’indirizzo del wallet, poiché la chiave usata per firmare la CV deve coincidere.
Costruiamo il percorso della cartella locale e della cartella condivisa con la DAO dove salvare le VC, e le inizializza in stato pulito, ovvero elimando eventuali JSON di VC già presenti.
Lo script crea poi il dominio EIP-712, che serve a contestualizzare la firma typed data.
In questo caso abbiamo scelto un dominio universale, cioè non legato a una chain o a uno specifico smart contract, in modo che la firma può essere verificata ovunque.
Lo script passa poi nella fase vera e propria di emissione delle credenziali.
Lo script itera per tutti gli holder definiti nel file di configurazione. In base alla stringa mnemonic viene generata una master key e da questa vengono derivati i wallet degli holder, in modo deterministico. Poi converte l'address dell’holder ottenuto in DID.
Viene generato il timestamp di emissione a precisione secondi.
Viene poi costruito il payload contenente i dati informativi della VC, che devono essere firmati dall’issuer. Sono inclusi il DID dell'issuer, il timestamp di emissione, il DID del holder, il nome dell’universita emittente, la facolta, il titolo di studio e l’eventuale voto.

La VC viene poi firmata con la chiave privata dell’issuer, utilizzando EIP-712.
Viene costruito il JSON VC finale, contenente anche i dati da non firmare e la proof. Il JSON viene salvato sia in una directory locale che in una directory condivisa con la DAO.

 
Funzionamento firma:  IssuerWallet è il wallet in cui è contenuta la chiave privata dell’issuer. Con signTypedData() non viene firmata una semplice stringa libera, ma dei dati strutturati secondo lo standard EIP-712.
Il parametro domain serve a definire il contesto della firma. Il parametro VC_TYPES descrive la forma esatta dei dati da firmare. Dice quali campi da firmare esistono, in che ordine stanno e di che tipo sono. Il parametro vcForSigning, contiene i valori concreti della credenziale, che sono indicati come da firmare. 
La funzione costruisce internamente un hash digest, hashando i campi id, university, faculty, degreeTitle e grade, ovvero i campi del credentialSubject. Poi vengono hashati issuer, issuanceDate e credentialSubject. Poi gli hash ottenuti vengono combinati ed hashati insieme.
Poi viene hashato il dominio e la struttura dei tipi da firmare. Poi questi hash vengono combinati e hashati in un unico digest.
Questo hash digest viene poi firmato dal wallet dell’issuer, con la sua chiave privata, usando EIP-712.
Il risultato finale, ovvero la firma digitale vera e propria, viene salvato in proofValue, in formato esadecimale.
Se qualcuno modifica anche solo un campo della credenziale, per esempio il voto o il titolo, la firma non risulterà più valida.

****************************************************************************
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


