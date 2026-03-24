# Comandi per testare il progetto (WSL)

## 0) Prerequisiti

```bash
# dalla root del repo
cd /home/matti/solidity/VCdao

# install dipendenze
cd dao && npm install
cd ../veramo && npm install
```

## 1) Test modulo DAO (smart contract + governance)

```bash
cd /home/matti/solidity/VCdao/dao

# compile + test
npx hardhat compile
npx hardhat test

# typecheck script TS
npx tsc --noEmit
```

## 2) Esecuzione pipeline completa DAO (01 -> 08)

### Terminale A
```bash
cd /home/matti/solidity/VCdao/dao
npx hardhat node
```

### Terminale B
```bash
cd /home/matti/solidity/VCdao/dao
DAO_TRUSTED_ISSUER=<address_issuer> npx hardhat run scripts/01_deploy.ts --network localhost
cd ../veramo
DAO_ISSUER_PRIVATE_KEY=<pk_issuer> DAO_HARDHAT_MNEMONIC="<mnemonic_hardhat>" npm run issue-for-dao
cd ../dao
npx hardhat run scripts/02_joinMembers.ts --network localhost
npx hardhat run scripts/03_delegateAll.ts --network localhost
npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
npx hardhat run scripts/05_depositTreasury.ts --network localhost
npx hardhat run scripts/06_createProposals.ts --network localhost
npx hardhat run scripts/07_voteOnProposals.ts --network localhost
npx hardhat run scripts/08_executeProposals.ts --network localhost
```

## 3) Test modulo Veramo (SSI / VC)

```bash
cd /home/matti/solidity/VCdao/veramo

# typecheck
npx tsc --noEmit

# flow completo SSI
npm run full-flow
```

## 4) Esecuzione step-by-step Veramo

```bash
cd /home/matti/solidity/VCdao/veramo
npm run create-dids
npm run issue-credential
npm run selective-disclosure
npm run verify-credential
```

## 5) Smoke test completo (ordine consigliato)

```bash
# 1. genera VC compatibili per DAO (dopo il deploy, usando token address deployato)
cd /home/matti/solidity/VCdao/veramo
DAO_ISSUER_PRIVATE_KEY=<pk_issuer> DAO_HARDHAT_MNEMONIC="<mnemonic_hardhat>" npm run issue-for-dao

# 2. testa e poi esegui DAO
cd /home/matti/solidity/VCdao/dao
npx hardhat test
# poi pipeline 01->08 con hardhat node attivo
```

## 6) Reset rapido ambiente locale

```bash
# ferma eventuale hardhat node con Ctrl+C

# (opzionale) pulizia cache/typechain nel modulo dao
cd /home/matti/solidity/VCdao/dao
npx hardhat clean
npx hardhat compile
```
