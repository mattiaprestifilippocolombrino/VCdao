PER TESI: se faccio override di _countVote() cambio come vengono conteggiati i voti, ma non il voting power in se, quindi quorum super quorum e il resto si basano ancora sul token
Se cambio _getVotes() cambio direttamente su cosa si basa il voting power del membro
Oltre a _getVotes(), introduci anche getPastTotalVotingPower(timepoint).
Fai override di quorum() e superQuorum() per usare quel totale VPC.
Ho un altro problema, tenendo le competenze in un mapping, vengono prese live e non snapshottate al blocco in cui viene fatta la proposta
Che in fondo puo non essere un male, perchè la competenza è data tramite VC e non è il caso del cretino che acquista token a raffica

Nuova idea: Ma se al posto  di fare così, io gestisco tutto il voting power all'interno del token. Al momento del mint, applico la formula della parte scoreSoldi, ossia scoreSoldi = min(ethDeposited / CAP, 1) × 100  ∈ [0, 100], e poi lo moltiplico per il pesoSoldi, e ottengo i token mintati. Quando eseguo l'upgrade di competenza, prendo lo scoreCompetenze ∈ {0, 25, 50, 75, 100} e lo moltiplico per pesoCompetenze, e lo aggiungo come token

Progetto Tesi 3: Rilascio di credenziali con Veramo e Verifica on-chain
Introduzione
Questo progetto interconnette i moduli utilizzati nei progetti precedenti. Il modulo Veramo si occupa del rilascio di VC da parte di un Issuer, in questo caso l’università, a una serie di Holder, membri dell’università. Le VC rappresentano in particolare il grado ottenuto dall’Holder certificato dall’università.
Livelli: Bachelor Degree, Master Degree, Phd, Professor.
Il modulo DAO contiene gli smart contract, che implementano la governance della DAO. In particolare, la DAO permette di effettuare un upgrade del potere di voto a un membro nel caso in cui presenta una VC, rilasciata da un issuer fidato, contenente un livello certificato. In base a tale livello, se la VC viene correttamente verificata, il voting power aumenta proporzionalmente.
La verifica viene fatta on-chain, mediante uno smart contract. Viene utilizzato EIP712 per la firma delle VC e per la loro verifica.
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

dao/contracts
Analizziamo ora gli smart contract che effettuano la verifica on-chain delle VC generate dal modulo Veramo e presentate dagli utenti per effettuare l’upgrade di potere di voto.

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

GovernanceToken.sol
function upgradeCompetenceWithVP()
Funzione di upgrade di competenza tramite VC.  Usa la libreria VPVerifier per verificare una VC firmata e applica l'upgrade se valida.
La funzione controlla se il membro è esistente e se è configurato l'issuer fidato.
Controlla se il DID del membro è coerente con il DID nel credentialSubject.
Calcola il typehash del dominio EIP-712.
Recupera l'address del firmatario usando le funzioni della libreria VPVerifier sulla firma EIP-712 contenuta nella VC.
Controlla se l'issuer recuperato è uguale al trustedIssuer. In caso positivo, mappa il titolo testuale nell'enum di grado.
Costruisce una stringa prova sintetica persistita on-chain. Esegue l'aggiornamento del grado del membro, tramite la funzione _performUpgrade.
 
function _performUpgrade()
Funzione di upgrade di competenza, che si occupa di effettuare nella DAO le modifiche, dopo che la VC è stata verificata. La funzione calcola il vecchio e il nuovo punteggio di competenza del membro. Calcola i token aggiuntivi da mintare in base ai token mintati in precedenza dal membro, moltiplicati per la differenza tra il nuovo e il vecchio punteggio di competenza.
Aggiorna il grado del membro e inserisce la proof di competenza on-chain.








