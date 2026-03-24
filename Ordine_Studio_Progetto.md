# Ordine consigliato dei file da studiare

## A) Visione generale (prima lettura)

1. `/home/matti/solidity/VCdao/Flusso_Esecuzione.md`
2. `/home/matti/solidity/VCdao/dao/README.md`
3. `/home/matti/solidity/VCdao/veramo/README.md`

## B) Core DAO (capire logica on-chain)

1. `/home/matti/solidity/VCdao/dao/contracts/GovernanceToken.sol`
2. `/home/matti/solidity/VCdao/dao/contracts/VPVerifier.sol`
3. `/home/matti/solidity/VCdao/dao/contracts/MyGovernor.sol`
4. `/home/matti/solidity/VCdao/dao/contracts/Treasury.sol`
5. `/home/matti/solidity/VCdao/dao/contracts/StartupRegistry.sol`
6. `/home/matti/solidity/VCdao/dao/contracts/MockStartup.sol`

## C) Script DAO (capire il ciclo di vita completo)

1. `/home/matti/solidity/VCdao/dao/scripts/01_deploy.ts`
2. `/home/matti/solidity/VCdao/dao/scripts/02_joinMembers.ts`
3. `/home/matti/solidity/VCdao/dao/scripts/03_delegateAll.ts`
4. `/home/matti/solidity/VCdao/dao/scripts/04_upgradeCompetences.ts`
5. `/home/matti/solidity/VCdao/dao/scripts/05_depositTreasury.ts`
6. `/home/matti/solidity/VCdao/dao/scripts/06_createProposals.ts`
7. `/home/matti/solidity/VCdao/dao/scripts/07_voteOnProposals.ts`
8. `/home/matti/solidity/VCdao/dao/scripts/08_executeProposals.ts`

## D) Test DAO (validazione comportamento)

1. `/home/matti/solidity/VCdao/dao/test/01_tokenVotes.test.ts`
2. `/home/matti/solidity/VCdao/dao/test/02_governorLifecycle.test.ts`
3. `/home/matti/solidity/VCdao/dao/test/03_treasuryInvestmentFlow.test.ts`
4. `/home/matti/solidity/VCdao/dao/test/04_superquorum.test.ts`
5. `/home/matti/solidity/VCdao/dao/test/05_competenceUpgrade.test.ts`

## E) Core SSI/VC Veramo

1. `/home/matti/solidity/VCdao/veramo/agent/setup.ts`
2. `/home/matti/solidity/VCdao/veramo/types/credentials.ts`
3. `/home/matti/solidity/VCdao/veramo/scripts/1-create-dids.ts`
4. `/home/matti/solidity/VCdao/veramo/scripts/2-issue-credential.ts`
5. `/home/matti/solidity/VCdao/veramo/scripts/3-selective-disclosure.ts`
6. `/home/matti/solidity/VCdao/veramo/scripts/4-verify-credential.ts`
7. `/home/matti/solidity/VCdao/veramo/scripts/5-full-flow.ts`
8. `/home/matti/solidity/VCdao/veramo/scripts/issue-for-dao.ts`

## F) File di stato utili in run locale

1. `/home/matti/solidity/VCdao/dao/deployedAddresses.json`
2. `/home/matti/solidity/VCdao/dao/proposalState.json`
3. `/home/matti/solidity/VCdao/veramo/credentials/*.json`

