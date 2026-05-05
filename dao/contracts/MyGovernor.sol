// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
MyGovernor — Contratto di governance multi-topic per CompetenceDAO.

Flusso propose → vote → queue → execute invariato.
Novità rispetto alla versione base:
  - Ogni proposta è associata a un topicId (0=CS, 1=CE, 2=EE).
  - Il voting power di ogni membro per quella proposta è:
      VP = stakeVP (ERC20Votes snapshot) + skillVP(account, topicId, snapshot)
  - Quorum e SuperQuorum usano la supply totale del topic specifico.

API pubblica nuova:
  proposeWithTopic(targets, values, calldatas, description, topicId)
    → crea una proposta e ne memorizza il topic.

Voter: usa castVoteWithReasonAndParams(proposalId, support, "", abi.encode(topicId))
oppure semplicemente castVote() — in entrambi i casi il topicId viene iniettato
automaticamente da _castVote() a partire da proposalTopic[proposalId].
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
    // =========================================================================
    //  Stato
    // =========================================================================

    /// Riferimento tipizzato al token per accedere ai metodi skill custom.
    GovernanceToken public immutable governanceToken;

    /// Associa ogni proposalId al suo topicId (0=CS, 1=CE, 2=EE).
    mapping(uint256 => uint256) public proposalTopic;

    // =========================================================================
    //  Errori
    // =========================================================================

    error InvalidTopicId(uint256 topicId);

    // =========================================================================
    //  Costruttore
    // =========================================================================

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

    // =========================================================================
    //  Creazione proposte con topic
    // =========================================================================

    /*
    Crea una proposta associandola a un topicId.
    Deve essere usata al posto di propose() per le proposte topic-aware.

    @param topicId  0 = Computer Science, 1 = Computer Engineering, 2 = Electronic Engineering
    */
    function proposeWithTopic(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description,
        uint256 topicId
    ) external returns (uint256 proposalId) {
        if (topicId >= governanceToken.NUM_TOPICS()) revert InvalidTopicId(topicId);
        proposalId = propose(targets, values, calldatas, description);
        proposalTopic[proposalId] = topicId;
    }

    // =========================================================================
    //  Override _castVote — inietta automaticamente il topicId nei params
    //
    //  Questo garantisce che il topicId usato in _getVotes sia sempre quello
    //  associato alla proposta, indipendentemente da ciò che il voter passa.
    // =========================================================================

    function _castVote(
        uint256 proposalId,
        address account,
        uint8 support,
        string memory reason,
        bytes memory /* params */
    ) internal override returns (uint256) {
        // Inietta il topicId corretto dalla storage, ignorando i params del chiamante.
        bytes memory topicParams = abi.encode(proposalTopic[proposalId]);
        return super._castVote(proposalId, account, support, reason, topicParams);
    }

    // =========================================================================
    //  Override _getVotes — somma stake VP + skill VP per il topic della proposta
    // =========================================================================

    /*
    VP_totale(account, timepoint, topic) =
        token.getPastVotes(account, timepoint)           [stake, ERC20Votes]
      + governanceToken.getPastSkillVotes(account, topic, timepoint)  [skill, custom]
    */
    function _getVotes(
        address account,
        uint256 timepoint,
        bytes memory params
    ) internal view override(Governor, GovernorVotes) returns (uint256) {
        uint256 topicId = abi.decode(params, (uint256));

        uint256 stakeVotes = super._getVotes(account, timepoint, params);
        uint256 skillVotes = governanceToken.getPastSkillVotes(account, topicId, timepoint);

        return stakeVotes + skillVotes;
    }

    // =========================================================================
    //  Quorum e SuperQuorum topic-specifici
    //
    //  Problema: quorum(timepoint) non riceve il proposalId, quindi non conosce
    //  il topic. Soluzione: override di _quorumReached e _superQuorumReached
    //  (che hanno accesso al proposalId) con il calcolo topic-aware.
    //  quorum(timepoint) rimane per compatibilità interfaccia/display,
    //  usando la supply stake come base conservativa.
    // =========================================================================

    /// @dev Supply totale VP per il topic: stake + skill del topic.
    function _totalVotingPowerForTopic(uint256 topicId, uint256 timepoint)
        internal view returns (uint256)
    {
        uint256 stakeSupply = governanceToken.getPastTotalSupply(timepoint);
        uint256 skillSupply = governanceToken.getPastTotalSkillSupply(topicId, timepoint);
        return stakeSupply + skillSupply;
    }

    /// @dev Quorum assoluto per il topic al timepoint.
    function _quorumForTopic(uint256 topicId, uint256 timepoint) internal view returns (uint256) {
        return Math.mulDiv(
            _totalVotingPowerForTopic(topicId, timepoint),
            quorumNumerator(timepoint),
            quorumDenominator()
        );
    }

    /// @dev SuperQuorum assoluto per il topic al timepoint.
    function _superQuorumForTopic(uint256 topicId, uint256 timepoint) internal view returns (uint256) {
        return Math.mulDiv(
            _totalVotingPowerForTopic(topicId, timepoint),
            superQuorumNumerator(timepoint),
            quorumDenominator()
        );
    }

    /*
    Override _quorumReached: usa il quorum del topic specifico della proposta.
    Sostituisce GovernorCountingSimple._quorumReached che chiamerebbe quorum(timepoint).
    */
    function _quorumReached(uint256 proposalId)
        internal view override(Governor, GovernorCountingSimple) returns (bool)
    {
        uint256 snapshot = proposalSnapshot(proposalId);
        uint256 topicId  = proposalTopic[proposalId];
        uint256 q = _quorumForTopic(topicId, snapshot);

        (, uint256 forVotes, uint256 abstainVotes) = proposalVotes(proposalId);
        return q <= forVotes + abstainVotes;
    }

    /*
    Override _superQuorumReached: usa il superquorum del topic specifico.
    Sostituisce GovernorSuperQuorum._superQuorumReached che chiamerebbe superQuorum(timepoint).
    */
    function _superQuorumReached(uint256 proposalId)
        internal view override returns (bool)
    {
        uint256 snapshot = proposalSnapshot(proposalId);
        uint256 topicId  = proposalTopic[proposalId];
        uint256 sq = _superQuorumForTopic(topicId, snapshot);

        (, uint256 forVotes,) = proposalVotes(proposalId);
        return sq <= forVotes;
    }

    /*
    quorum(timepoint) — compatibilità interfaccia IGovernor.
    Ritorna il quorum sulla sola supply stake (conservativo, per display esterno).
    L'enforcement reale avviene in _quorumReached.
    */
    function quorum(uint256 timepoint)
        public view override(Governor, GovernorVotesQuorumFraction) returns (uint256)
    {
        return Math.mulDiv(
            governanceToken.getPastTotalSupply(timepoint),
            quorumNumerator(timepoint),
            quorumDenominator()
        );
    }

    /*
    superQuorum(timepoint) — compatibilità display.
    Come quorum(), usa solo la supply stake.
    */
    function superQuorum(uint256 timepoint)
        public view override returns (uint256)
    {
        return Math.mulDiv(
            governanceToken.getPastTotalSupply(timepoint),
            superQuorumNumerator(timepoint),
            quorumDenominator()
        );
    }

    // =========================================================================
    //  Override boilerplate richiesti da Solidity (conflitti ereditarietà)
    // =========================================================================

    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function clock() public view override(Governor, GovernorVotes) returns (uint48) {
        return super.clock();
    }

    function CLOCK_MODE() public view override(Governor, GovernorVotes) returns (string memory) {
        return super.CLOCK_MODE();
    }

    function proposalVotes(uint256 proposalId)
        public view override(GovernorCountingSimple, GovernorSuperQuorum)
        returns (uint256 againstVotes, uint256 forVotes, uint256 abstainVotes)
    {
        return super.proposalVotes(proposalId);
    }

    function state(uint256 proposalId)
        public view
        override(Governor, GovernorVotesSuperQuorumFraction, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public view override(Governor, GovernorTimelockControl) returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }

    function _updateQuorumNumerator(uint256 newQuorumNumerator)
        internal override(GovernorVotesQuorumFraction, GovernorVotesSuperQuorumFraction)
    {
        super._updateQuorumNumerator(newQuorumNumerator);
    }
}
