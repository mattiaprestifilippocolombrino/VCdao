# Misurazioni sperimentali voting power

## Experimental setup

Le misurazioni usano dataset sintetici piccoli e controllati, composti da 10 membri. Per isolare l'effetto della formula, a parita' di utenti, stake e skill vengono modificati solo:

- topic della proposta;
- `weightStake`;
- `weightSkill`.

I valori sono letti dai contratti Hardhat deployati nel test. Il voting power e' espresso in token `COMP`, dopo normalizzazione da wei.

## Esperimento 1 - Token-only vs modelli ibridi

Topic: AI & Data.

| user | stake | skills | skillScoreAI | tokenOnlyVP | stake75Skill25VP | hybridVP | stake25Skill75VP | skillOnlyVP | diff |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| U1 | 100 | blockchain | 5 | 100 | 76.25 | 52.50 | 28.75 | 5 | -47.50 |
| U2 | 20 | machineLearning + dataEngineering | 75 | 20 | 33.75 | 47.50 | 61.25 | 75 | 27.50 |
| U3 | 20 | blockchain + startupFinance | 20 | 20 | 20 | 20 | 20 | 20 | 0 |
| U4 | 40 | softwareArchitecture + cloudArchitecture | 30 | 40 | 37.50 | 35 | 32.50 | 30 | -5 |
| U5 | 30 | cyberSecurity + cloudArchitecture | 30 | 30 | 30 | 30 | 30 | 30 | 0 |
| U6 | 15 | machineLearning | 35 | 15 | 20 | 25 | 30 | 35 | 10 |
| U7 | 15 | dataEngineering | 30 | 15 | 18.75 | 22.50 | 26.25 | 30 | 7.50 |
| U8 | 10 | startupFinance | 15 | 10 | 11.25 | 12.50 | 13.75 | 15 | 2.50 |
| U9 | 10 | distributedSystems | 20 | 10 | 12.50 | 15 | 17.50 | 20 | 5 |
| U10 | 5 | nessuna | 0 | 5 | 3.75 | 2.50 | 1.25 | 0 | -2.50 |

Interpretazione: nel modello token-only il VP coincide con la sola componente economica. Le configurazioni 75/25, 50/50 e 25/75 mostrano una transizione progressiva verso la componente skill. La configurazione 0/100 rappresenta un limite sperimentale only-competences: il deposito resta obbligatorio e tracciato, ma non genera token stake.

## Esperimento 2 - Whale vs expert minority

Topic: AI & Data.

| user | stake | skills | skillScoreAI | tokenOnlyVP | stake75Skill25VP | hybridVP | stake25Skill75VP | skillOnlyVP | shareTokenOnly | share75_25 | shareHybrid | share25_75 | shareSkillOnly |
| --- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |--- |
| Whale | 60 | blockchain | 5 | 60 | 46.25 | 32.50 | 18.75 | 5 | 59.41 | 34.71 | 19.64 | 9.48 | 2.17 |
| Expert A | 10 | machineLearning + dataEngineering | 75 | 10 | 26.25 | 42.50 | 58.75 | 75 | 9.90 | 19.70 | 25.68 | 29.71 | 32.61 |
| Expert B | 10 | machineLearning | 35 | 10 | 16.25 | 22.50 | 28.75 | 35 | 9.90 | 12.20 | 13.60 | 14.54 | 15.22 |
| Expert C | 5 | dataEngineering + distributedSystems | 50 | 5 | 16.25 | 27.50 | 38.75 | 50 | 4.95 | 12.20 | 16.62 | 19.60 | 21.74 |
| Other 1 | 5 | softwareArchitecture | 15 | 5 | 7.50 | 10 | 12.50 | 15 | 4.95 | 5.63 | 6.04 | 6.32 | 6.52 |
| Other 2 | 4 | cloudArchitecture | 15 | 4 | 6.75 | 9.50 | 12.25 | 15 | 3.96 | 5.07 | 5.74 | 6.19 | 6.52 |
| Other 3 | 3 | startupFinance | 15 | 3 | 6 | 9 | 12 | 15 | 2.97 | 4.50 | 5.44 | 6.07 | 6.52 |
| Other 4 | 2 | cyberSecurity | 15 | 2 | 5.25 | 8.50 | 11.75 | 15 | 1.98 | 3.94 | 5.14 | 5.94 | 6.52 |
| Other 5 | 1 | nessuna | 0 | 1 | 0.75 | 0.50 | 0.25 | 0 | 0.99 | 0.56 | 0.30 | 0.13 | 0 |
| Other 6 | 1 | blockchain | 5 | 1 | 2 | 3 | 4 | 5 | 0.99 | 1.50 | 1.81 | 2.02 | 2.17 |

Nel modello token-only il whale controlla il 59.41% del voting power. Con pesi 50/50 la sua quota scende al 19.64%. La quota aggregata dei tre esperti passa dal 24.75% al 55.90%. Il caso 0/100 mostra il limite massimo dell'effetto competenze, ma va letto come scenario di confronto e non come configurazione principale.

## Esperimento 3 - Topic sensitivity

Profili sintetici con stesso stake e combinazioni di skill rappresentative dei quattro topic. Cambia solo il topic della proposta.

| user | stake | skills | aiDataVP | cloudCyberVP | fintechBlockchainVP | enterpriseSoftwareVP |
| --- |--- |--- |--- |--- |--- |--- |
| AI/Data expert | 40 | machineLearning + dataEngineering | 57.50 | 32.50 | 30 | 37.50 |
| Cloud/Security expert | 40 | cyberSecurity + cloudArchitecture | 35 | 57.50 | 42.50 | 45 |
| FinTech/Web3 expert | 40 | blockchain + startupFinance | 30 | 32.50 | 57.50 | 40 |
| Enterprise architect | 40 | softwareArchitecture + cloudArchitecture | 35 | 47.50 | 40 | 57.50 |
| Cross-domain engineer | 40 | distributedSystems + cloudArchitecture | 37.50 | 50 | 42.50 | 50 |
| No certified skill | 40 | nessuna | 20 | 20 | 20 | 20 |

Il contributo economico del membro rimane invariato per tutti i topic, mentre la componente skill varia in funzione della pertinenza delle competenze rispetto al topic della proposta. Il profilo senza skill certificate funge da controllo: il suo VP resta identico su tutti i topic.

## Sensitivity analysis

Scenario whale/expert su AI & Data. La tabella mostra la quota del whale e la quota aggregata dei tre esperti al variare dei pesi.

| weightStake | weightSkill | whaleShare | expertShare |
| --- |--- |--- |--- |
| 100% | 0% | 59.41 | 24.75 |
| 75% | 25% | 34.71 | 44.10 |
| 50% | 50% | 19.64 | 55.90 |
| 25% | 75% | 9.48 | 63.85 |
| 0% | 100% | 2.17 | 69.57 |

## File prodotti

- `experiment-1-token-only-vs-hybrid.csv`
- `experiment-2-whale-vs-experts.csv`
- `experiment-3-topic-sensitivity.csv`
- `sensitivity-analysis.csv`
- `grafici.html`
