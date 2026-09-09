// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./ISkillCalculator.sol";

contract MockFlatSkillCalculator is ISkillCalculator {
    uint256 private constant TOPIC_COUNT = 4;
    uint256 private constant SCORE = 100;

    function calculateAllVP(bytes32[] calldata) external pure override returns (uint256[] memory scores) {
        return _scores();
    }

    function calculateAllVPFromBitmap(uint256) external pure override returns (uint256[] memory scores) {
        return _scores();
    }

    function _scores() private pure returns (uint256[] memory scores) {
        scores = new uint256[](TOPIC_COUNT);
        for (uint256 i = 0; i < TOPIC_COUNT; i++) {
            scores[i] = SCORE;
        }
    }
}
