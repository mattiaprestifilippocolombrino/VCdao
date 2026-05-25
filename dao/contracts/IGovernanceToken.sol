// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/interfaces/IERC5805.sol";

interface IGovernanceToken is IERC5805 {
    /// @dev Denominatore condiviso per validare che i pesi stake + skill facciano 100%.
    function BASIS_POINTS() external view returns (uint256);

    /// @dev Necessaria al modulo skill per consentire DID e upgrade solo ai membri.
    function isMember(address member) external view returns (bool);

    /// @dev Hook minimo di governance per aggiornare il peso della componente stake.
    function setWeights(uint256 _weightSkill, uint256 _weightStake) external;

    /// @dev Flusso utente minimo per entrare nella DAO e aumentare lo stake.
    function joinDAO() external payable;
    function increaseStake() external payable;
    function getStakeScore(address _member) external view returns (uint256);
}
