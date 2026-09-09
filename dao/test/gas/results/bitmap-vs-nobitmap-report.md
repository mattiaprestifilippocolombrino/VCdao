# Bitmap vs no-bitmap - scalabilita gas

## Setup sperimentale

Le misure isolano `upgradeSkillWithVC` dopo il bootstrap non misurato del membro: `joinDAO`, `delegate`, `registerDID`. I contratti mock mantengono verifica EIP-712, DID e checkpoint per 4 topic; varia solo la rappresentazione delle skill:

- bitmap: un `uint256` per membro;
- no-bitmap: `bytes32[]` piu' mapping anti-duplicato;
- calculator: score costante pari a 100 per ogni topic, per non misurare la matrice di scoring.

Conversione economica: 1.03244 Gwei, ETH $2638.48.

## Scalabilita per numero di skill

| skills | bitmapGas | bitmapEth | bitmapUsd | noBitmapGas | noBitmapEth | noBitmapUsd | deltaGas | deltaPct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 450724 | 0.00046534548656 | $1.23 | 494712 | 0.00051076045728 | $1.35 | 43988 | 9.76% |
| 2 | 454045 | 0.0004687742198 | $1.24 | 541756 | 0.00055933056464 | $1.48 | 87711 | 19.32% |
| 4 | 460712 | 0.00047565749728 | $1.26 | 635858 | 0.00065648523352 | $1.73 | 175146 | 38.02% |
| 8 | 474131 | 0.00048951180964 | $1.29 | 824100 | 0.000850833804 | $2.24 | 349969 | 73.81% |
| 16 | 504291 | 0.00052065020004 | $1.37 | 1200621 | 0.00123956914524 | $3.27 | 696330 | 138.08% |
| 32 | 566907 | 0.00058529746308 | $1.54 | 1953789 | 0.00201716991516 | $5.32 | 1386882 | 244.64% |
| 64 | 692323 | 0.00071478195812 | $1.89 | 3460439 | 0.00357269564116 | $9.43 | 2768116 | 399.83% |

## Scalabilita per numero di utenti

Ogni riga misura il costo cumulativo di N chiamate indipendenti a `upgradeSkillWithVC`, una per utente, con 8 skill per VC. Il bootstrap del membro (`joinDAO`, `delegate`, `registerDID`) non e' incluso nel totale: serve solo a rendere valida la chiamata misurata.

Le colonne `PerUser` non sono una nuova transazione: sono il totale diviso per N. Servono a verificare se il costo medio per membro resta stabile quando cresce la popolazione.

| users | bitmapTotalGas | bitmapTotalEth | bitmapTotalUsd | noBitmapTotalGas | noBitmapTotalEth | noBitmapTotalUsd | bitmapPerUserGas | bitmapPerUserEth | bitmapPerUserUsd | noBitmapPerUserGas | noBitmapPerUserEth | noBitmapPerUserUsd | deltaPerUserGas | deltaPerUserPct |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 474131 | 0.00048951180964 | $1.29 | 824100 | 0.000850833804 | $2.24 | 474131 | 0.00048951180964 | $1.29 | 824100 | 0.000850833804 | $2.24 | 349969 | 73.81% |
| 2 | 890598 | 0.00091948899912 | $2.43 | 1590536 | 0.00164213298784 | $4.33 | 445299 | 0.00045974449956 | $1.21 | 795268 | 0.00082106649392 | $2.17 | 349969 | 78.59% |
| 4 | 1723520 | 0.0017794309888 | $4.69 | 3123396 | 0.00322471896624 | $8.51 | 430880 | 0.0004448577472 | $1.17 | 780849 | 0.00080617974156 | $2.13 | 349969 | 81.22% |
| 8 | 3389364 | 0.00349931496816 | $9.23 | 6189116 | 0.00638989092304 | $16.86 | 423670 | 0.0004374138548 | $1.15 | 773639 | 0.00079873584916 | $2.11 | 349969 | 82.60% |
| 16 | 6721028 | 0.00693905814832 | $18.31 | 12320592 | 0.01272027200448 | $33.56 | 420064 | 0.00043369087616 | $1.14 | 770037 | 0.00079501700028 | $2.10 | 349973 | 83.31% |
| 32 | 13384500 | 0.01381869318 | $36.46 | 24583556 | 0.02538104655664 | $66.97 | 418265 | 0.0004318335166 | $1.14 | 768236 | 0.00079315757584 | $2.09 | 349971 | 83.67% |
| 64 | 26711288 | 0.02757780218272 | $72.76 | 49109304 | 0.05070240982176 | $133.78 | 417363 | 0.00043090225572 | $1.14 | 767332 | 0.00079222425008 | $2.09 | 349969 | 83.85% |

## Lettura sintetica

La bitmap mantiene una crescita molto piu' contenuta al crescere del numero di skill perche' comprime la membership delle competenze in un solo `uint256`. Il modello no-bitmap paga storage separato per ogni nuova skill e il delta cresce con la cardinalita' della VC.

La misura utenti e' quasi lineare sul totale perche' ogni utente esegue una transazione distinta. Il valore per utente mostra il costo operativo atteso di un singolo nuovo membro con 8 skill, mentre il totale mostra il costo cumulativo per popolare una DAO con N membri gia' certificati.
