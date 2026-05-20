// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
/*
Interfaccia usata per calcolare il voting power derivato da skill dei membri.
*/
interface ISkillCalculator {
    /// @notice Restituisce lo score (0-100) calcolato per un determinato topic, date le skill hashate dell'utente.
    function calculateVP(uint256 topicId, bytes32[] calldata skills) external view returns (uint256);

    /// @notice Controlla se un topicId è valido e supportato.
    function isValidTopic(uint256 topicId) external view returns (bool);

    /// @notice Restituisce i topic supportati dal calcolatore.
    function getSupportedTopics() external view returns (uint256[] memory);
}
