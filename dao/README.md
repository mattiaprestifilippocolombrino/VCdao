# CompetenceDAO (DAO Module)

Modulo on-chain del PoC di tesi: la DAO assegna peso di voto in base a stake economico e skill certificate da VC firmate off-chain e verificate on-chain.

## Obiettivo

- Membership aperta: chiunque entra con `joinDAO()` depositando ETH.
- Voting power composito: stake ERC20Votes + skill VP topic-specifico.
- Upgrade skill tramite governance legacy o VC EIP-712 verificata on-chain.

## Formula Voting Power

- `stakeScore = min(stakeDeposited / MAX_DEPOSIT, 1) * 100`
- `stakeVP = stakeScore * weightStake / 10_000`
- `skillVP(topic) = skillScore(topic) * weightSkill / 10_000`
- `totalVotingPower(topic) = stakeVP + skillVP(topic)`

Skill riconosciute:

- `machineLearning`
- `dataEngineering`
- `cyberSecurity`
- `cloudArchitecture`
- `distributedSystems`
- `blockchain`
- `softwareArchitecture`
- `startupFinance`

| ID | Topic | Significato |
|---:|---|---|
| 0 | AI & Data | Startup basate su AI, machine learning, analytics e infrastrutture dati |
| 1 | Cloud & Cybersecurity | Cloud infrastructure, cybersecurity, networking e sistemi distribuiti |
| 2 | FinTech & Blockchain | Pagamenti, infrastrutture finanziarie, blockchain e sistemi decentralizzati |
| 3 | Enterprise Software | SaaS B2B, piattaforme aziendali, ERP, CRM e software per processi enterprise |

Lo `SkillCalculator` somma la rilevanza delle skill uniche, aggiunge 10 punti
per la coppia complementare del topic e applica il cap a 100. Le coppie sono:

- AI & Data: `machineLearning` + `dataEngineering`
- Cloud & Cybersecurity: `cyberSecurity` + `cloudArchitecture`
- FinTech & Blockchain: `blockchain` + `startupFinance`
- Enterprise Software: `softwareArchitecture` + `cloudArchitecture`

| Skill | AI & Data | Cloud & Cybersecurity | FinTech & Blockchain | Enterprise Software |
|---|---:|---:|---:|---:|
| `machineLearning` | 35 | 5 | 5 | 15 |
| `dataEngineering` | 30 | 20 | 15 | 20 |
| `cyberSecurity` | 15 | 35 | 25 | 20 |
| `cloudArchitecture` | 15 | 30 | 20 | 30 |
| `distributedSystems` | 20 | 30 | 25 | 30 |
| `blockchain` | 5 | 15 | 35 | 15 |
| `softwareArchitecture` | 15 | 25 | 20 | 35 |
| `startupFinance` | 15 | 10 | 30 | 25 |

## Contratti Principali

- `contracts/GovernanceToken.sol`
- `contracts/MyGovernor.sol`
- `contracts/Treasury.sol`
- `contracts/VPVerifier.sol`

### GovernanceToken

- gestisce membership e stake
- minta la componente ERC20Votes del voting power da stake

### GovernanceSkill

- gestisce trusted issuer, DID registrati e skill dei membri
- registra un DID unico per membro (`registerDID`)
- applica upgrade legacy (`upgradeSkill`)
- applica upgrade VC-based (`upgradeSkillWithVC`)
- salva checkpoint VP skill topic-specifici

Le skill sono salvate in `memberSkillBitmap(address)`: un solo `uint256` per membro.
I bit 0–7 corrispondono, nell'ordine, alle otto skill elencate sopra; la mappatura
è definita in `SkillDefinitions` e le posizioni assegnate non vanno riordinate.
Il merge usa OR, valida ogni nome e scrive lo storage solo se aggiunge skill.
`hasSkill(address, bytes32)` controlla il singolo bit; `getMemberSkills(address)`
ricostruisce gli hash in ordine canonico, indipendente dall'ordine di acquisizione.

La DAO chiama `calculateAllVPFromBitmap(uint256)` sul calcolatore. L'adapter
`calculateAllVP(bytes32[])` resta disponibile per i chiamanti che usano hash.
Una VC già acquisita viene comunque verificata ed emette gli eventi di upgrade,
ma non ricalcola gli score né aggiorna i checkpoint. I nomi delle skill nelle VC
e la firma EIP-712 rimangono invariati.

Questa versione sostituisce i vecchi getter automatici `memberSkills(address,uint256)`
e `memberHasSkill(address,bytes32)` con `memberSkillBitmap` e `hasSkill`.
Il layout di storage e l'interfaccia del calcolatore cambiano: occorre un nuovo deploy
dei moduli; non è una migrazione in-place dello stato già distribuito.

Misura locale prima/dopo su `test/05_gasEstimation.test.ts`, con la stessa VC reale
(`cyberSecurity` + `cloudArchitecture`), Solidity 0.8.28 e optimizer a 200 runs:

| Operazione | Prima (gas) | Bitmap (gas) | Riduzione |
|---|---:|---:|---:|
| Primo upgrade VC | 546754 | 455549 | 16,7% |
| Upgrade amministrativo equivalente | 521616 | 430429 | 17,5% |
| Stessa VC ripetuta | 101049 | 61098 | 39,5% |

Il confronto VC/amministrativo ripristina lo stesso stato iniziale e usa le stesse
skill. La differenza comprende calldata, controlli ed eventi, oltre alla verifica
crittografica. I valori dipendono dal profilo e dai checkpoint già presenti.

### VPVerifier

Libreria che ricostruisce l'hash EIP-712 della VC minimale e recupera il firmatario.

Firma coperta dai claim semantici:

- `issuer.id`
- `issuanceDate`
- `credentialSubject.id`
- `credentialSubject.organization`
- `credentialSubject.unit`
- `credentialSubject.skills`

## Modello VC Atteso dalla DAO

Top-level obbligatori:

- `@context`
- `type`
- `issuer`
- `issuanceDate`
- `credentialSubject`
- `proof`

`credentialSubject`:

- `id` (DID holder)
- `organization` (universita', azienda, DAO o training provider)
- `unit` (facolta', dipartimento, team o sezione)
- `skills` (array di skill supportate)

Lo script DAO filtra gli issuer fidati e rifiuta skill non riconosciute.
Prima dell'upgrade VC, il membro registra il proprio DID una sola volta; il contratto confronta poi l'hash del DID registrato con `credentialSubject.id`.

## Pipeline Script DAO

1. `scripts/01_deploy.ts`
2. `scripts/02_joinMembers.ts`
3. `scripts/03_delegateAll.ts`
4. `scripts/04_upgradeCompetences.ts`
5. `scripts/05_depositTreasury.ts`
6. `scripts/06_createProposals.ts`
7. `scripts/07_voteOnProposals.ts`
8. `scripts/08_executeProposals.ts`

Lo script `04_upgradeCompetences.ts` legge le VC da:

- `shared-credentials/*.json`

Questi file sono prodotti dal modulo Veramo (`veramo/scripts/issue-for-dao.ts`).

## Run End-to-End (locale)

Terminale 1:

```bash
cd dao
npx hardhat node
```

Terminale 2:

```bash
# Deploy e setup DAO
cd dao
npx hardhat run scripts/01_deploy.ts --network localhost
npx hardhat run scripts/02_joinMembers.ts --network localhost
npx hardhat run scripts/03_delegateAll.ts --network localhost

# Emissione VC lato Veramo (cartella shared per DAO)
cd ../veramo
DAO_ISSUER_PRIVATE_KEY=<issuer_private_key> DAO_HARDHAT_MNEMONIC='<hardhat_mnemonic>' npm run issue-for-dao

# Upgrade skill con verifica VC on-chain
cd ../dao
npx hardhat run scripts/04_upgradeCompetences.ts --network localhost

# Resto della pipeline governance
npx hardhat run scripts/05_depositTreasury.ts --network localhost
npx hardhat run scripts/06_createProposals.ts --network localhost
npx hardhat run scripts/07_voteOnProposals.ts --network localhost
npx hardhat run scripts/08_executeProposals.ts --network localhost
```

## Test

```bash
cd dao
npx hardhat test
```

I test coprono:

- membership + mint + delega
- lifecycle governance completo
- upgrade legacy
- upgrade VC-based con firma valida/non valida
- DID mismatch e issuer non trusted
