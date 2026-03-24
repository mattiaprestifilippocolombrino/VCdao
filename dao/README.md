# CompetenceDAO (DAO Module)

Modulo on-chain del PoC di tesi: la DAO assegna peso di voto in base al grado di competenza certificato da VC firmate off-chain e verificate on-chain.

## Obiettivo

- Membership aperta: chiunque entra con `joinDAO()` depositando ETH.
- Voting power basata su token ERC20Votes.
- Upgrade competenza governato dalla DAO, con verifica EIP-712 della VC su smart contract.

## Formula Token

- `baseTokens = ETH * 1000`
- `totalTokens = baseTokens * competenceScore`

Gradi (`GovernanceToken.CompetenceGrade`):

1. `Student` (default, coefficiente 1)
2. `BachelorDegree` (2)
3. `MasterDegree` (3)
4. `PhD` (4)
5. `Professor` (5)

## Contratti Principali

- `contracts/GovernanceToken.sol`
- `contracts/MyGovernor.sol`
- `contracts/Treasury.sol`
- `contracts/VPVerifier.sol`

### GovernanceToken

- gestisce membership e mint
- registra DID con binding 1:1 (`registerDID`)
- applica upgrade legacy (`upgradeCompetence`)
- applica upgrade VC-based (`upgradeCompetenceWithVP`)

### VPVerifier

Libreria che ricostruisce l'hash EIP-712 della VC minimale e recupera il firmatario.

Firma coperta dai claim semantici:

- `issuer.id`
- `issuanceDate`
- `credentialSubject.id`
- `credentialSubject.university`
- `credentialSubject.faculty`
- `credentialSubject.degreeTitle`
- `credentialSubject.grade`

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
- `university`
- `faculty`
- `degreeTitle` (`BachelorDegree | MasterDegree | PhD | Professor`)
- `grade`

Non sono ammessi campi extra nella VC consumata dallo script DAO.

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

- `dao/scripts/shared-credentials/*.json`

Questi file sono prodotti dal modulo Veramo (`veramo/scripts/2-issue-credential.ts`).

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
DAO_ISSUER_PRIVATE_KEY=<issuer_private_key> DAO_HARDHAT_MNEMONIC='<hardhat_mnemonic>' npm run issue-credential

# Upgrade competenze con verifica VC on-chain
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
