# Modello di Governance Ibrido: Il Voting Power Composto (VPC)

*Bozza / Appunti per il capitolo della tesi relativo al calcolo del potere di voto nella DAO.*

---

## 1. Introduzione al Problema

Nelle DAO (Decentralized Autonomous Organizations) tradizionali di matrice DeFi, la governance è solitamente **plutocratica**: il potere di voto è strettamente proporzionale al capitale investito ($1 \text{ Token} = 1 \text{ Voto}$). Questo modello, sebbene eccellente per allineare gli incentivi economici (Skin in the Game), esclude completamente il concetto di **merito** o **competenza tecnica**, permettendo ad attori con ingenti capitali (balene) di prendere decisioni anche in assenza di un background adeguato sulle tematiche del protocollo.

Per risolvere questo limite strutturale, in questa tesi viene descritto, implementato e analizzato un modello di **Voting Power Composto (VPC)** ibrido. Il modello sfrutta le Verifiable Credentials (VC) in ecosistema SSI (Self-Sovereign Identity) per determinare on-chain il grado accademico dell'utente. Il potere di voto finale diventa un bilanciamento matematico tra il capitale di rischio allocato e il livello di competenza verificato.

---

## 2. Definizione del Modello Matematico

Il potere di voto per l'utente $i$, denotato come $VP_i$, è calcolato attraverso la seguente equazione:

$$ VP_i = B_i \times [ (1 - k) + k \times S_i ] $$

Dove:
*   $\mathbf{B_i}$ **(Base Tokens):** Rappresenta il puro contributo economico dell'utente $i$. Corrisponde ai token ottenuti tramite deposito di ETH nello Smart Contract ($\text{ETH} \times 1000$).
*   $\mathbf{S_i}$ **(Competence Score):** È il coefficiente di merito estratto e certificato tramite Verifiable Credential. Assume valori numerici incrementali discreti (es. $Student = 1$, $Bachelor = 2$, $Master = 3$, $PhD = 4$, $Professor = 5$).
*   $\mathbf{k}$ **(Competence Weight):** È il parametro di sistema configurato al deploy del contratto ($0 \le k \le 1$). Determina l'incidenza del peso accademico rispetto a quello puramente economico.

### 2.1 Riformulazione Analitica (Consigliata per la dissertazione)

Al fine di esplicitare il meccanismo di incentivo per la stesura accademica, l'equazione può essere algebricamente espansa e riorganizzata come segue:

$$ VP_i = B_i - kB_i + k B_i S_i $$
$$ VP_i = B_i + k B_i (S_i - 1) $$

In questa forma, il Voting Power è espresso come la somma di due componenti isolate:
1.  **Componente di Base Economica ($\mathbf{B_i}$):** Il potere di voto intrinseco dato dal capitale.
2.  **Bonus di Merito [$\mathbf{k \cdot B_i \cdot (S_i - 1)}$]:** I voti addizionali generati dalla leva della competenza sull'investimento base, mitigati dal fattore $k$.

---

## 3. Proprietà Fondamentali del Modello (Core Properties)

L'equazione proposta soddisfa tre proprietà assiomatiche, critiche per la sicurezza e la fairness della DAO:

### A. Invarianza della Baseline (Fair Entry)
Si osserva dalla formula algebrica che qualora un membro sia al livello minimo di affiliazione ($Student$, $S_i = 1$), il termine moltiplicativo $(S_i - 1)$ si annulla. 
Ne consegue che, per i nuovi membri non specializzati, $VP_i = B_i$ indipendentemente dal valore di controllo $k$. Questa proprietà matematica garantisce che nessun nuovo entrante venga mai penalizzato dai parametri di rete, assicurando un ingresso equo ($1 \text{ ETH} \equiv 1000 \text{ Voti}$ per i novizi) a prescindere dal livello di meritocrazia impostato dalla community fondativa.

### B. "Skin in the Game" Assicurativo (Resistenza ai Sybil Attack)
Poiché la competenza agisce come moltiplicatore della base economica ($B_i$), se un membro è provvisto della massima certificazione accademica ($S_i = 5$) ma non investe capitale nella rete DAO ($B_i = 0$), il suo Bonus di Metito è matematicamente azzerato ($VP_i = 0$). 
Questa proprietà colma le vulnerabilità tipiche dei modelli "Proof of Personhood", rendendo economicamente inefficaci attacchi Sybil o la mera emissione indiscriminata di VC. Per esercitare il proprio peso intellettuale, l'esperto deve necessariamente allineare i propri incentivi finanziari a quelli dell'organizzazione, caricandosi di un rischio d'impresa (Skin in the Game).

### C. Interpolazione Lineare degli Estremi
Il parametro $k$ permette alla DAO, con una singola formula, di simulare vari regimi di governance:
*   $\mathbf{k = 0}$ **(Plutocrazia):** Elimina il Bonus di merito. Il protocollo collassa su un modello puramente capital-based come Uniswap o MakerDAO.
*   $\mathbf{k = 1}$ **(Meritocrazia Pura):** $VP_i = B_i \times S_i$. Il grado accademico applica una leva massima.
*   $\mathbf{k = 0.5}$ **(Hybrid Blend 50/50):** Un professore riceve un Bonus parziale, raggiungendo un equilibrio in cui gli investitori puri e gli accademici contribuiscono in modo bilanciato al Quorum.

---

## 4. Architettura ed Esecuzione in Solidity

Dal punto di vista dell'Ingegneria del Software on-chain, il modello VPC è stato integrato in un contratto derivato da `ERC20Votes` (Standard OpenZeppelin per la Governance).

*   **Fixed-Point Math (Basis Points):** Poiché la Ethereum Virtual Machine (EVM) non supporta numeri in virgola mobile (floating-point), il parametro $k$ è stato mappato nel range $[0, 10.000]$ *Basis Points (bp)*. 
*   **Immutabilità del Quorum:** La logica del VPC è stata interamente racchiusa nel saldo token dell'utente, aggiornando le logiche interne di *minting* e delle chiamate dell'evento *upgradeCompetence*. In questo modo il ciclo vitale della governance on-chain (Proposal, Snapshot, Voting, Timelock) tramite i contratti `Governor` ignora agnosticamente come i voti siano stati calcolati, mantenendosi in stretta aderenza ai massimi standard di sicurezza del settore ERC-20.
*   **Decentralizzazione Fissa:** La costante di governance `competenceWeight` ($k$) è dichiarata come tipo attributo `immutable` per Smart Contract design. Settata alla genesi del blocco di deploy, l'organizzazione rinuncia crittograficamente per sempre al potere di modificarla senza un fork drastico della DAO, cementando un clima di massima predicibilità trustless.

---

## 5. Limitazioni e Sviluppi Futuri (Section per Conclusioni Tesi)

Nonostante l'efficienza riscontrata dal VPC, possono sorgere nuovi stimoli per iterazioni future della tesi:
1.  **Metriche di Decadimento Temporale (ve-Competence):** Ispirato alle logiche The Curve (veCRV), la validità delle VC potrebbe prevedere una scadenza integrata, costringendo i professori a rinnovare la certificazione o a vedere il proprio *Bonus di Merito* decadere temporalmente verso la baseline $B_i$.
2.  **Scoring Asintotico Universale:** Avere i punteggi $S_i$ lineari (1-5) non modella accuratamente la curva reale della rarità dei gradi accademici. Implementare una successione asintotica, e.g. Fibonacci $(1, 2, 3, 5, 8)$ o puramente esponenziale $(1, 2, 4, 8, 16)$, scalerebbe economicamente il "privilegio cognitivo" delle elite tecniche nella rete.
