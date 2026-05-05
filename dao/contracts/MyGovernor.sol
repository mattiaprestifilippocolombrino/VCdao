// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
    Contratto che gestisce la governance della DAO, ovvero l'intero ciclo di vita
    delle proposte di investimento: propose → vote → queue → (delay) → execute
    Eredita 7 moduli OpenZeppelin che lavorano insieme:
    Governor (core): Fornisce la struttura di base per gestire le proposte
    GovernorSettings: Fornisce i parametri di voto: votingDelay, votingPeriod, threshold
    GovernorCountingSimple: Fornisce le funzioni di conteggio: For / Against / Abstain
    GovernorVotes: Collega il token ERC20Votes al Governor
    GovernorVotesQuorumFraction: Gestisce i parametri di quorum: Quorum in % della supply totale
    GovernorVotesSuperQuorumFraction: Gestisce i parametri di superquorum per l'approvazione rapida
    GovernorTimelockControl: Gestisce il timelock, che fornisce un delay di sicurezza prima dell'esecuzione. 
    Il flusso di esecuzione di una proposta è il seguente: 
    1. propose()   → crea la proposta, stato = Pending
    2. (voting delay passa) → stato = Active
    3. castVote()  → i membri votano For/Against/Abstain
    4. (voting period finisce) → stato = Succeeded o Defeated
       OPPURE: se superquorum raggiunto → Succeeded prima della scadenza!
    5. queue()     → mette la proposta nel Timelock (stato = Queued)
    6. (timelock delay passa)
    7. execute()   → il Timelock esegue l'operazione (stato = Executed)

    SEPARAZIONE DEL VOTING POWER:
    Il VP totale di ogni membro è composto da due componenti indipendenti:
      - Componente economica: derivata dal saldo ERC20 (token mintati al depositoETH).
        Tracciata da GovernorVotes tramite token.getPastVotes(account, timepoint).
      - Componente competenza: derivata dagli upgrade via Verifiable Credential.
        NON è rappresentata da token; è tracciata in checkpoint Checkpoints.Trace208
        separati dentro GovernanceToken (getPastSkillVotes / getPastTotalSkillSupply).

    Coerenza quorum/superQuorum:
    Entrambe le soglie sono calcolate sulla base votante totale:
      totalVotingPower(t) = token.getPastTotalSupply(t) + token.getPastTotalSkillSupply(t)
    In questo modo le percentuali di quorum e superquorum sono sempre riferite all'intera
    capacità votante della DAO, senza distorsioni tra le due componenti.
*/

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesSuperQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/governance/utils/IVotes.sol";
import "./GovernanceToken.sol";

contract MyGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorVotesSuperQuorumFraction,
    GovernorTimelockControl
{
    //  Stato e costruttore

    /// Riferimento tipizzato al token per accedere ai metodi custom di skill VP.
    GovernanceToken public immutable governanceToken;

    /*  Il costruttore riceve in input il Token ERC20Votes, il TimelockController, il numero di blocchi di attesa
    prima dell'inizio del voto, la durata della finestra di voto, la soglia minima di voti per poter 
    creare una proposta, il quorum in % della supply totale votabile al blocco di snapshot della proposta, 
    e il superquorum. I contratti ereditati vengono inizializzati con tali parametri.
*/
    /// @param token_                Token ERC20Votes (chi lo possiede può votare)
    /// @param timelock_             TimelockController (delay di sicurezza)
    /// @param votingDelay_          Blocchi/secondi di attesa prima dell'inizio del voto
    /// @param votingPeriod_         Durata della finestra di voto
    /// @param proposalThreshold_    Voti minimi per creare una proposta
    /// @param quorumNumerator_      Quorum in % (es. 4 = 4% della supply totale combinata)
    /// @param superQuorumNumerator_ Superquorum in % (es. 20 = 20%, deve essere ≥ quorum)
    constructor(
        IVotes token_,
        TimelockController timelock_,
        uint48 votingDelay_,
        uint32 votingPeriod_,
        uint256 proposalThreshold_,
        uint256 quorumNumerator_,
        uint256 superQuorumNumerator_
    )
        Governor("MyGovernor")
        GovernorSettings(votingDelay_, votingPeriod_, proposalThreshold_)
        GovernorVotes(token_)
        GovernorVotesQuorumFraction(quorumNumerator_)
        GovernorVotesSuperQuorumFraction(superQuorumNumerator_)
        GovernorTimelockControl(timelock_)
    {
        governanceToken = GovernanceToken(address(token_));
    }

    // =====================================================================
    //  Override del voting power: componente economica + componente skill
    //
    //  GovernorVotes._getVotes() legge solo token.getPastVotes(account, t),
    //  che restituisce la componente economica (ERC20 balance snapshot).
    //  L'override qui aggiunge la componente skill letta dai checkpoint
    //  manuali di GovernanceToken.getPastSkillVotes(account, t).
    //
    //  Questa è l'unica funzione che deve essere toccata per il conteggio
    //  voti: GovernorCountingSimple accumula direttamente il valore restituito
    //  qui, quindi non è necessario fare override di _countVote.
    // =====================================================================

    /*
    Restituisce il voting power totale dell'account al blocco `timepoint`.
    VP_totale = VP_economico (ERC20Votes snapshot) + VP_competenza (skill checkpoint).
    */
    function _getVotes(
        address account,
        uint256 timepoint,
        bytes memory params
    ) internal view override(Governor, GovernorVotes) returns (uint256) {
        // Componente economica: saldo ERC20 delegato al blocco timepoint.
        uint256 economicVotes = super._getVotes(account, timepoint, params);

        // Componente competenza: skill VP dal checkpoint manuale al blocco timepoint.
        uint256 skillVotes = governanceToken.getPastSkillVotes(account, timepoint);

        return economicVotes + skillVotes;
    }

    // =====================================================================
    //  Override del quorum: basato sulla supply totale combinata
    //
    //  GovernorVotesQuorumFraction.quorum() usa token.getPastTotalSupply(t),
    //  che include solo i token ERC20 (componente economica).
    //  L'override qui somma anche getPastTotalSkillSupply(t) per includere
    //  l'intera base votante nel calcolo della soglia minima.
    //
    //  La formula è la stessa di OZ: supply_totale × numeratore / denominatore.
    //  Il numeratore e il denominatore sono quelli di GovernorVotesQuorumFraction
    //  (storici, gestiti con i propri checkpoint interni di OZ).
    // =====================================================================

    /*
    Numero minimo di voti richiesti perché una proposta sia valida, calcolato al
    blocco di snapshot della proposta.
    Quorum = (totalEconomicSupply + totalSkillSupply) × quorumNumerator / quorumDenominator
    */
    function quorum(
        uint256 timepoint
    )
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        // Supply economica al timepoint (token ERC20 mintati dagli stake).
        uint256 economicSupply = governanceToken.getPastTotalSupply(timepoint);

        // Supply di competenza al timepoint (skill VP aggregato di tutti i membri).
        uint256 skillSupply = governanceToken.getPastTotalSkillSupply(timepoint);

        uint256 totalSupply = economicSupply + skillSupply;

        // Stessa formula di GovernorVotesQuorumFraction, applicata alla supply combinata.
        return Math.mulDiv(totalSupply, quorumNumerator(timepoint), quorumDenominator());
    }

    // =====================================================================
    //  Override del superQuorum: coerente con quorum()
    //
    //  GovernorVotesSuperQuorumFraction.superQuorum() usa anch'esso
    //  token.getPastTotalSupply(t). L'override qui applica la stessa
    //  logica del quorum() sopra, usando la supply totale combinata.
    //  In questo modo le due soglie (quorum e superquorum) sono sempre
    //  proporzionate allo stesso universo di voti potenziali.
    // =====================================================================

    /*
    Numero di voti "For" richiesti per far passare una proposta anticipatamente
    (prima della scadenza del votingPeriod).
    SuperQuorum = (totalEconomicSupply + totalSkillSupply) × superQuorumNumerator / quorumDenominator
    */
    function superQuorum(
        uint256 timepoint
    ) public view override returns (uint256) {
        uint256 economicSupply = governanceToken.getPastTotalSupply(timepoint);
        uint256 skillSupply = governanceToken.getPastTotalSkillSupply(timepoint);
        uint256 totalSupply = economicSupply + skillSupply;

        return Math.mulDiv(totalSupply, superQuorumNumerator(timepoint), quorumDenominator());
    }

    // Override richiesti da Solidity per risolvere conflitti di ereditarietà.

    // ----- Parametri di governance (GovernorSettings ↔ Governor) -----

    /// @notice Ritardo prima dell'inizio della votazione
    function votingDelay()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingDelay();
    }

    /// @notice Durata della finestra di voto
    function votingPeriod()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.votingPeriod();
    }

    /// @notice Soglia minima di voti per poter creare una proposta
    function proposalThreshold()
        public
        view
        override(Governor, GovernorSettings)
        returns (uint256)
    {
        return super.proposalThreshold();
    }

    // ----- Clock (GovernorVotes ↔ Governor) -----

    /// @notice Clock corrente (numero di blocco, coerente con ERC20Votes e i checkpoint skill)
    function clock()
        public
        view
        override(Governor, GovernorVotes)
        returns (uint48)
    {
        return super.clock();
    }

    /// @notice Modalità del clock (es. "mode=blocknumber&from=default")
    function CLOCK_MODE()
        public
        view
        override(Governor, GovernorVotes)
        returns (string memory)
    {
        return super.CLOCK_MODE();
    }

    // ----- Conteggio voti (GovernorCountingSimple ↔ GovernorSuperQuorum) -----

    /// @notice Restituisce i voti di una proposta: contrari, favorevoli, astenuti
    function proposalVotes(
        uint256 proposalId
    )
        public
        view
        override(GovernorCountingSimple, GovernorSuperQuorum)
        returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)
    {
        return super.proposalVotes(proposalId);
    }

    // ----- Stato della proposta (SuperQuorumFraction ↔ TimelockControl) -----

    /// @notice Stato corrente di una proposta
    /// @dev Unisce DUE logiche:
    ///      1. Superquorum: può far passare la proposta PRIMA della scadenza
    ///      2. Timelock: gestisce stati Queued → Executed / Canceled
    function state(
        uint256 proposalId
    )
        public
        view
        override(
            Governor,
            GovernorVotesSuperQuorumFraction,
            GovernorTimelockControl
        )
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    // ----- Timelock: coda, esecuzione, cancellazione -----

    /// @notice Indica se la proposta necessita di essere messa in coda (timelock)
    function proposalNeedsQueuing(
        uint256 proposalId
    ) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.proposalNeedsQueuing(proposalId);
    }

    /// @notice Mette in coda le operazioni della proposta nel TimelockController
    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return
            super._queueOperations(
                proposalId,
                targets,
                values,
                calldatas,
                descriptionHash
            );
    }

    /// @notice Esegue le operazioni della proposta tramite il TimelockController
    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(
            proposalId,
            targets,
            values,
            calldatas,
            descriptionHash
        );
    }

    /// @notice Cancella una proposta (e rimuove l'operazione dal timelock se in coda)
    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    /// @notice Indirizzo che esegue le azioni (il TimelockController)
    function _executor()
        internal
        view
        override(Governor, GovernorTimelockControl)
        returns (address)
    {
        return super._executor();
    }

    // ----- Aggiornamento quorum (QuorumFraction ↔ SuperQuorumFraction) -----

    /// @notice Aggiorna il numeratore del quorum
    /// @dev Assicura che il quorum resti sempre ≤ superquorum
    function _updateQuorumNumerator(
        uint256 newQuorumNumerator
    )
        internal
        override(GovernorVotesQuorumFraction, GovernorVotesSuperQuorumFraction)
    {
        super._updateQuorumNumerator(newQuorumNumerator);
    }
}
