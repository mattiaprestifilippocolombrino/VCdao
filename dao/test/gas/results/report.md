# Misurazioni gas - V3 Topic-Based DAO

## Experimental setup

Le misurazioni sono eseguite su Hardhat Network leggendo `gasUsed` dalle receipt delle transazioni. Per rendere i costi economici riproducibili nella tesi, la conversione usa valori fissi:

- gas price: 1.03244 Gwei;
- ETH price: $2638.48;
- membri: 10;
- stake per membro: 5 ETH;
- pesi: 50% stake / 50% skill;
- proposta: 10 ETH, topic FINTECH_BLOCKCHAIN (WEB3).

## Flow principale

| phase | calls | minGas | avgGas | maxGas | totalGas | totalUsd |
| --- | --- | --- | --- | --- | --- | --- |
| Join DAO | 10 | 146771 | 149922 | 178286 | 1499225 | $4.08 |
| Delegate | 10 | 95611 | 95621 | 95623 | 956218 | $2.60 |
| Register DID | 10 | 74617 | 74636 | 74713 | 746362 | $2.03 |
| Upgrade skill with VC | 10 | 397144 | 403652 | 455549 | 4036520 | $11.00 |
| Propose with topic | 1 | 96590 | 96590 | 96590 | 96590 | $0.2631 |
| Cast vote | 10 | 112157 | 115603 | 129301 | 1156034 | $3.15 |
| Queue | 1 | 174653 | 174653 | 174653 | 174653 | $0.4758 |
| Execute | 1 | 217515 | 217515 | 217515 | 217515 | $0.5925 |

## Costi aggregati

| metric | gas | usd | note |
| --- | --- | --- | --- |
| 10 Member Activation Cost | 7238325 | $19.72 | joinDAO + delegate + registerDID + upgradeSkillWithVC |
| Governance Cycle Cost | 1644792 | $4.48 | proposeWithTopic + 10 castVote + queue + execute |
| Total Gas | 8883117 | $24.20 | activation + governance cycle |
| Per-Member Activation Estimate | 723832 | $1.97 | activation / 10 members |
| Per-Member Cycle Share Estimate | 164479 | $0.4481 | governance cycle / 10 members |
| Per-Member Total Estimate | 888311 | $2.42 | total gas / 10 members |

## Scalabilita' upgradeSkillWithVC

| skillCount | skills | upgradeGas | costUsd |
| --- | --- | --- | --- |
| 1 | cyberSecurity | 451593 | $1.23 |
| 2 | cyberSecurity + cloudArchitecture | 455249 | $1.24 |
| 4 | blockchain + cloudArchitecture + cyberSecurity + distributedSystems | 462709 | $1.26 |
| 6 | blockchain + cloudArchitecture + cyberSecurity + distributedSystems + machineLearning + dataEngineering | 469457 | $1.28 |
| 8 | machineLearning + dataEngineering + cyberSecurity + cloudArchitecture + distributedSystems + blockchain + softwareArchitecture + startupFinance | 477599 | $1.30 |

## Interpretazione sintetica

Il costo di attivazione include le operazioni necessarie affinche' un membro entri nella DAO, attivi il voto ERC20Votes, registri il DID e ottenga il voting power da competenze tramite VC. Il costo del ciclo di governance misura invece la vita di una proposta topic-based: creazione con `topicId`, voto dei 10 membri, queue nel Timelock ed execute.

Il micro-benchmark di scalabilita' isola `upgradeSkillWithVC` al variare del numero di skill nella credential. L'aumento e' contenuto perche' i checkpoint vengono mantenuti per i 4 topic, mentre il costo marginale deriva soprattutto dal parsing/hashing delle skill presenti nella VC.

## File prodotti

- `gas-flow.csv`
- `gas-flow-summary.csv`
- `gas-aggregates.csv`
- `gas-scalability.csv`
- `gas-grafici.html`
