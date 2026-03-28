# Moduli e Concetti da Studiare per la Tesi

Per comprendere a fondo l'architettura del progetto e saperla difendere/esporre in sede di tesi, si consiglia di studiare i seguenti argomenti (moduli teorici) e la loro implementazione nel codice.

## 1. Identità Decentralizzata (DID) e Verifiable Credentials (W3C)
**Cosa studiare:**
- Cos'è un Decentralized Identifier (DID) e perché svincola l'identità dai provider centralizzati.
- Il modello dati W3C delle Verifiable Credentials. Cos'è il `credentialSubject`, l'`issuer`, la `proof`.
- Il ciclo di trust: Issuer (chi emette), Holder (chi possiede/condivide), Verifier (chi verifica).
**Dove è implementato nel progetto:**
- `veramo/scripts/1-create-dids.ts` e le configurazioni in `veramo/agent/setup.ts`.
- La struttura dei JSON generati in `veramo/credentials/`.

## 2. Standard EIP-712 (Typed Structured Data Hashing and Signing)
**Cosa studiare:**
- Come EIP-712 previene attacchi di replay (grazie al `domainSeparator` che include `chainId` e `verifyingContract`).
- Come EIP-712 organizza i dati in strutture leggibili dagli utenti nei wallet (Metamask), anziché stringhe incomprensibili.
- Il processo matematico: `hashStruct` e `signTypedData`.
**Dove è implementato nel progetto:**
- **Off-chain (Firma):** `veramo/scripts/issue-for-dao.ts` (l'issuer usa `signTypedData` passando i tipi definiti in `types/credentials.ts`).
- **On-chain (Verifica):** Il contratto `dao/contracts/VPVerifier.sol` implementa gli hash EIP-712 e usa `ECDSA.recover` per estrarre il firmatario.

## 3. Architettura DAO e Governance (OpenZeppelin)
**Cosa studiare:**
- Il ciclo di vita di una proposta di governance: `Pending -> Active -> Succeeded -> Queued -> Executed`.
- Concetti di `Quorum` (partecipazione minima) e `Superquorum` (per approvazione istantanea senza attendere la fine del periodo di voto).
- Il ruolo del `TimelockController` (motivi di sicurezza, delay per dare tempo agli utenti di reagire).
- Differenza tra un normale token ERC20 e un ERC20Votes (che tiene traccia del potere di voto nel tempo usando gli snapshot).
**Dove è implementato nel progetto:**
- `dao/contracts/MyGovernor.sol` (Tutta la logica di voto estesa da OpenZeppelin).
- `dao/contracts/GovernanceToken.sol` (Override ERC20Votes per deleghe e snapshot).

## 4. Integrazione On-Chain delle VC (Innovazione Architetturale)
**Cosa studiare:**
- Come legare un indirizzo Ethereum a un DID. La necessità del *Binding* 1:1 per evitare che una credenziale universitaria venga usata da un altro wallet.
- Il processo di estrazione crittografica: come il verifying contract passa dall'hash EIP-712 e la firma in bytes per ottenere l'address dell'Issuer (Università), e come lo confronta con il `trustedIssuer`.
- La "traduzione" semantica: convertire la prova testuale (es. `MasterDegree`) in un peso numerico (es. x3).
**Dove è implementato nel progetto:**
- Il mapping `memberDID` e la funzione di registrazione `registerDID` in `GovernanceToken.sol`.
- La complessa funzione `upgradeCompetenceWithVP()` in `GovernanceToken.sol` che unisce la `VPVerifier.sol` con lo state della tokenomics.

---
**Tip per la Tesi:** Assicurati di evidenziare come questo progetto sposti la computazione pesante e l'emissione *off-chain* (risparmiando gas costosi) pur garantendo la totale crittografia e sicurezza *on-chain* (la validazione della delega di authority).
