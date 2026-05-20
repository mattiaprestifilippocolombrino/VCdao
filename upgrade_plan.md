# Piano di Refactoring Architetturale: Gestione Dinamica delle Skill e Calcolo Esterno del VP

Il nuovo design ha l'obiettivo di supportare array di skill immutabili, punteggi specifici per topic, bonus combinazionali (boost) ed esecuzione esterna per il calcolo del Voting Power (VP). Soprattutto, il calcolo del VP avverrà **in fase di upgrade**, memorizzando i risultati nei checkpoint nativi di OpenZeppelin, così da annullare il gas extra durante le votazioni.

Ecco il piano aggiornato per mantenere l'architettura magistrale, aderente alle best practice DAO e con il massimo risparmio di gas.

---

## 1. Il Contratto Esterno: `SkillCalculator.sol`
Tutta la logica di calcolo del VP, che ora deve mappare skill immutabili per ogni topic e applicare boost combinazionali, viene estratta in un modulo esterno, aggiornabile solo sostituendone l'address nel `GovernanceToken`.

### Caratteristiche:
1. **Interfaccia `ISkillCalculator`**:
   ```solidity
   interface ISkillCalculator {
       function calculateVP(uint256 topic, bytes32[] calldata skills) external view returns (uint256);
   }
   ```
2. **Immutabilità e Risparmio Gas (No SLOAD)**:
   Siccome i valori delle skill e i topic sono immutabili per definizione, la best practice assoluta per il gas è **non usare lo storage state (`mapping`)**. Invece, i valori saranno *hardcoded* come costanti o mappati all'interno di funzioni `pure` tramite `if/else` o `switch` (in assembly) o costrutti simili che lavorano solo in memoria.
   - Le skill supportate sono note e realistiche: `smart-contracts`, `machine-learning`, `tokenomics`, `digital-health`, `data-analysis`, `backend-java`. Nel contratto sono esposte come costanti leggibili usando `keccak256(bytes("nome-skill"))`, evitando costanti esadecimali opache.
3. **Logica di Punteggio e Boost**:
   - La funzione `calculateVP` riceverà in input l'array di skill dell'account e il topic.
   - Ciclerà sulle skill applicando il punteggio specifico per il topic passato.
   - **Boost Combinazionali**: Durante o dopo il ciclo, una logica controllerà se sono presenti particolari set coerenti con il topic, ad esempio `smart-contracts + tokenomics` su Web3 oppure `machine-learning + data-analysis` su AI. In caso positivo, aggiungerà il bonus.

---

## 2. `GovernanceToken.sol` (Core)
Questo contratto deve fungere da hub, mantenendo lo storage, aggiornandosi tramite il calcolatore e salvando la cronologia usando il meccanismo di Checkpoints.

### Modifiche da effettuare:
1. **Rimozione Hardcode**:
   - Rimuovere `CompetenceGrade` e gli identificatori statici dei topic all'interno del token.
   - I topic validi non saranno più un contatore statico fisso. La validazione dei topic (`_validateTopicId`) può essere delegata al calcolatore.
2. **Nuove Strutture Dati**:
   - `mapping(address => bytes32[]) public memberSkills;` per tenere traccia delle skill approvate e in possesso del membro (sotto forma di array di hash per non sprecare gas).
   - `ISkillCalculator public skillCalculator;` modificabile solo via `onlyTimelock`.
3. **Il Modulo `_performUpgrade` (Cruciale per il Gas)**:
   - Quando si valida una VC in `upgradeSkillWithVC`, l'array di nuove skill estratto viene unito (senza duplicati) a `memberSkills`.
   - Viene chiamato `skillCalculator.calculateVP(topic, updatedSkills)` per tutti i topic registrati (o per un topic specifico passato assieme alla proposta/upgrade).
   - Il risultato restituisce il **nuovo Score Totale** dell'utente. Il `GovernanceToken` calcola la differenza (`Delta VP = nuovoVP - vecchioVP`) e aggiunge il delta nei checkpoint `_skillVotesCheckpoints[account][topicId]` e `_totalSkillSupplyCheckpoints[topicId]`.
   - **Vantaggio**: Al momento di votare con `MyGovernor`, non ci sarà NESSUNA chiamata al contratto esterno. Si leggerà il checkpoint in 1 singola operazione (SSTORE -> SLOAD), garantendo il costo computazionale più basso possibile per i votanti.

---

## 3. `VPVerifier.sol` (La Libreria)
La Verifiable Credential dovrà supportare array, poichè le skill sono passate tramite EIP-712.

### Modifiche da effettuare:
1. **Aggiornamento TypeHash `CredentialSubject`**:
   - `bytes32 internal constant CREDENTIAL_SUBJECT_TYPEHASH = keccak256("CredentialSubject(string id,string[] skills)");`
   - La struct diventerà:
     ```solidity
     struct CredentialSubject {
         string id;
         string[] skills; 
     }
     ```
2. **Aggiornamento Algoritmo di Hashing**:
   - Per hashare un array dinamico in EIP-712 occorre un ciclo.
   - Si creerà una funzione interna `hashSkills(string[] memory skills)` che farà `abi.encodePacked` del keccak256 di ciascuna stringa e poi ritornerà l'hash globale dell'array come impone lo standard.

---

## 4. Modulo Veramo (Off-chain)
Allineamento del backend di issuing.

### Modifiche da effettuare:
1. **Dati della VC**: Il `credentialSubject` emesso off-chain conterrà skill realistiche, ad esempio `skills: ["smart-contracts", "tokenomics"]`.
2. **Tipi EIP-712**:
   - `CredentialSubject` nei `types` avrà: `{ name: 'skills', type: 'string[]' }`.

---

## 5. `MyGovernor.sol`
Essendo che il calcolo dinamico viene assorbito interamente da `_performUpgrade` in `GovernanceToken.sol`, `MyGovernor` rimarrà estremamente leggero.

### Modifiche da effettuare:
1. Non sono necessarie logiche complesse aggiuntive per la gestione del Voting Power. L'override di `_getVotes` e `quorum` (usando `getPastSkillVotes`) continuerà a funzionare magistralmente poichè andrà a pescare i dati storicizzati del VP elaborati e depositati durante l'ultimo upgrade del membro.
2. Controllo coerenza del Topic tramite interfaccia per lanciare la proposta.

## Riassunto dei benefici di questo piano:
- **Zero SLOAD nel calcolatore**: Utilizzo di logica `pure` con hashing precalcolato per gli identificatori delle skill.
- **Gas ottimizzato per il voto (O(1))**: L'interfaccia viene chiamata **solo** al momento dell'upgrade per ricalcolare i delta (quando un utente presenta una nuova credenziale), tenendo i check di voto super economici ed evitando calcoli di loop e boost durante l'invio del voto.
- **Struttura Modulare**: Tutto ciò che riguarda i punteggi (mapping, boost, pesi specifici) è relegato al modulo `SkillCalculator.sol`. Il `GovernanceToken` si limita ad amministrare l'assegnazione e l'uso storico dei fondi.
- **Evoluzione senza attrito**: Se in futuro la governance decidesse di cambiare le regole o le skill riconosciute (ad esempio aggiungendone una nuova), basterebbe un upgrade del `SkillCalculator.sol` via Timelock senza toccare minimamente né il token né il governor.
