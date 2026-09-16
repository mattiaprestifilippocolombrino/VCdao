# Comandi DAO

Tutti i comandi vanno eseguiti dalla cartella `dao`.

```bash
cd /home/matti/solidity/VCdao/dao
```

## Setup

Installa le dipendenze:

```bash
npm install
```

Compila i contratti:

```bash
npx hardhat compile
```

## Test

Test principali configurati in `package.json`:

```bash
npm test
```

Equivalente esplicito:

```bash
npx hardhat test test/01_tokenVotes.test.ts test/03_governor.test.ts test/04_treasury.test.ts test/05_competenceUpgrade.test.ts
```

Tutti i test, inclusi benchmark gas e misurazioni:

```bash
npm run test:all
```

Benchmark gas:

```bash
npm run test:gas
```

Equivalente esplicito:

```bash
npx hardhat test test/gas/gasMisuration.ts
```

Misurazioni voting power per la tesi:

```bash
npx hardhat test test/misurazioni/voting-power.measurement.ts
```

## Script sequenziali

Avvia un nodo locale Hardhat in un terminale dedicato:

```bash
npx hardhat node
```

In un secondo terminale, esegui il deploy. `DAO_TRUSTED_ISSUER` deve essere l'address dell'issuer che firma le VC in `shared-credentials`.

```bash
DAO_TRUSTED_ISSUER=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC npx hardhat run scripts/01_deploy.ts --network localhost
```

Esegui poi gli step successivi nello stesso ordine:

```bash
npx hardhat run scripts/02_joinMembers.ts --network localhost
npx hardhat run scripts/03_delegateAll.ts --network localhost
npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
npx hardhat run scripts/05_depositTreasury.ts --network localhost
npx hardhat run scripts/06_createProposals.ts --network localhost
npx hardhat run scripts/07_voteOnProposals.ts --network localhost
npx hardhat run scripts/08_executeProposals.ts --network localhost
```

## Ignition

Deploy con Hardhat Ignition su rete locale. Prima avvia `npx hardhat node`.

```bash
npx hardhat ignition deploy ignition/InvestmentDAO.ts --network localhost --parameters ignition/parameters.json
```

Esempio di `ignition/parameters.json`:

```json
{
  "InvestmentDAOModule": {
    "trustedIssuer": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
  }
}
```

Deploy Ignition su rete effimera Hardhat:

```bash
npx hardhat ignition deploy ignition/InvestmentDAO.ts --parameters ignition/parameters.json
```

## Pulizia opzionale

Cancella cache e artifact di compilazione:

```bash
npx hardhat clean
```
