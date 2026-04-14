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
*/

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesSuperQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";

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
    // =====================================================================
    //  Voting Power Composto — stato e costruttore
    // =====================================================================

    /// Denominatore basis points (100% = 10.000 bp).
    uint256 public constant BASIS_POINTS = 10_000;

    /// Riferimento tipizzato al token per leggere i dati di scoring.
    GovernanceToken public immutable governanceToken;

    /// Peso della componente accademica nella formula VPC (in basis points).
    uint256 public immutable pesoCompetenze;

    /// Peso della componente economica nella formula VPC (in basis points).
    uint256 public immutable pesoSoldi;

    error InvalidWeights();

    /// @param token_                Token ERC20Votes (chi lo possiede può votare)
    /// @param timelock_             TimelockController (delay di sicurezza)
    /// @param votingDelay_          Blocchi/secondi di attesa prima dell'inizio del voto
    /// @param votingPeriod_         Durata della finestra di voto
    /// @param proposalThreshold_    Voti minimi per creare una proposta
    /// @param quorumNumerator_      Quorum in % (es. 4 = 4% della supply)
    /// @param superQuorumNumerator_ Superquorum in % (es. 20 = 20%, deve essere ≥ quorum)
    /// @param pesoCompetenze_       Peso accademico in bp (es. 5000 = 50%)
    /// @param pesoSoldi_            Peso economico in bp (es. 5000 = 50%)
    constructor(
        IVotes token_,
        TimelockController timelock_,
        uint48 votingDelay_,
        uint32 votingPeriod_,
        uint256 proposalThreshold_,
        uint256 quorumNumerator_,
        uint256 superQuorumNumerator_,
        uint256 pesoCompetenze_,
        uint256 pesoSoldi_
    )
        Governor("MyGovernor")
        GovernorSettings(votingDelay_, votingPeriod_, proposalThreshold_)
        GovernorVotes(token_)
        GovernorVotesQuorumFraction(quorumNumerator_)
        GovernorVotesSuperQuorumFraction(superQuorumNumerator_)
        GovernorTimelockControl(timelock_)
    {
        if (pesoCompetenze_ + pesoSoldi_ != BASIS_POINTS)
            revert InvalidWeights();
        governanceToken = GovernanceToken(address(token_));
        pesoCompetenze = pesoCompetenze_;
        pesoSoldi = pesoSoldi_;
    }

    // Override richiesti da Solidity per risolvere conflitti di ereditarietà.abi
    // Il contratto esegue l'override delle funzioni votingDelay, votingPeriod, proposalThreshold, quorum, clock,
    // e _execute.

    // ----- Parametri di governance (GovernorSettings ↔ Governor) -----

    /// @notice Ritardo prima dell'inizio della votazione
    /// @dev Override necessario: sia Governor che GovernorSettings definiscono questa funzione
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

    // ----- Quorum (GovernorVotesQuorumFraction ↔ Governor) -----

    /// @notice Numero minimo di voti richiesti perché la proposta sia valida
    /// @dev Il quorum è calcolato come percentuale della supply totale votabile
    ///      al blocco di snapshot della proposta
    function quorum(
        uint256 timepoint
    )
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(timepoint);
    }

    // ----- Clock (GovernorVotes ↔ Governor) -----

    /// @notice Clock corrente (blocco o timestamp, dipende dal token)
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
    /// @dev Serve sia a GovernorCountingSimple (conteggio) sia a GovernorSuperQuorum
    ///      (verifica se il superquorum è stato raggiunto)
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

    // =====================================================================
    //  Voting Power Composto (VPC) — Override _countVote
    // =====================================================================

    /*
    Funzione in override che calcola il VotingPower effettivo del membro al momento del voto,
    applicando la formula: ScoreTotale = pesoCompetenze × scoreCompetenze + pesoSoldi × scoreSoldi
    dove:
        scoreCompetenze ∈ {0, 25, 50, 75, 100}, in base alla competenza estratta dalla VC
        scoreSoldi      = min(ethDeposited / CAP, 1) × 100  ∈ [0, 100]
        pesoCompetenze + pesoSoldi = 10.000
    */
    function _countVote(
        uint256 proposalId,
        address account,
        uint8 support,
        uint256 totalWeight, // SALDO TOKEN SNAPSHOTTATO, DELEGATO IN PASSATO
        bytes memory params
    ) internal override(Governor, GovernorCountingSimple) returns (uint256) {
        uint256 scoreTotale = _computeVotingScore(account, totalWeight);
        return
            super._countVote(
                proposalId,
                account,
                support,
                scoreTotale * 1e18,
                params
            );
    }

    /*
    Funzione Helper che applica la formula VPC calcando scoreSoldi dal saldo token snapshottato `totalWeight`.
    */
    function _computeVotingScore(
        address account,
        uint256 snapshottedTokens
    ) internal view returns (uint256) {
        uint256 scoreC = governanceToken.getScoreCompetenze(account); // [0, 100]
        uint256 TOKEN_CAP = 100 * 10 ** 18;
        uint256 scoreS;
        if (snapshottedTokens >= TOKEN_CAP) {
            scoreS = 100;
        } else {
            scoreS = (snapshottedTokens * 100) / TOKEN_CAP; // [0, 100]
        }

        return (pesoCompetenze * scoreC + pesoSoldi * scoreS) / BASIS_POINTS;
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
    /// @dev Ritorna true perché usiamo GovernorTimelockControl
    function proposalNeedsQueuing(
        uint256 proposalId
    ) public view override(Governor, GovernorTimelockControl) returns (bool) {
        return super.proposalNeedsQueuing(proposalId);
    }

    /// @notice Mette in coda le operazioni della proposta nel TimelockController
    /// @dev Viene chiamata internamente da queue()
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
    /// @dev Viene chiamata internamente da execute()
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
    /// @dev Le azioni NON vengono eseguite dal Governor ma dal Timelock
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
