// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
    Libreria leggera con le definizioni condivise di topic e skill supportati dalla DAO.
    Contiene solo costanti e funzioni pure: non occupa storage e le funzioni internal vengono inlinate.
*/
library SkillDefinitions {
    uint256 internal constant TOPIC_WEB3 = 0;
    uint256 internal constant TOPIC_AI = 1;
    uint256 internal constant TOPIC_HEALTH = 2;
    uint256 internal constant TOPIC_ENTERPRISE = 3;
    uint256 internal constant TOPIC_COUNT = 4;

    bytes32 internal constant SKILL_SMART_CONTRACTS = keccak256(bytes("smart-contracts"));
    bytes32 internal constant SKILL_MACHINE_LEARNING = keccak256(bytes("machine-learning"));
    bytes32 internal constant SKILL_TOKENOMICS = keccak256(bytes("tokenomics"));
    bytes32 internal constant SKILL_DIGITAL_HEALTH = keccak256(bytes("digital-health"));
    bytes32 internal constant SKILL_DATA_ANALYSIS = keccak256(bytes("data-analysis"));
    bytes32 internal constant SKILL_BACKEND_JAVA = keccak256(bytes("backend-java"));

    function skillId(string memory skill) internal pure returns (bytes32) {
        return keccak256(bytes(skill));
    }

    function isValidTopic(uint256 topicId) internal pure returns (bool) {
        return topicId < TOPIC_COUNT;
    }

    function isValidSkill(bytes32 candidateSkill) internal pure returns (bool) {
        return candidateSkill == SKILL_SMART_CONTRACTS
            || candidateSkill == SKILL_MACHINE_LEARNING
            || candidateSkill == SKILL_TOKENOMICS
            || candidateSkill == SKILL_DIGITAL_HEALTH
            || candidateSkill == SKILL_DATA_ANALYSIS
            || candidateSkill == SKILL_BACKEND_JAVA;
    }

    function supportedTopics() internal pure returns (uint256[] memory topics) {
        topics = new uint256[](TOPIC_COUNT);
        topics[0] = TOPIC_WEB3;
        topics[1] = TOPIC_AI;
        topics[2] = TOPIC_HEALTH;
        topics[3] = TOPIC_ENTERPRISE;
    }

    function supportedSkills() internal pure returns (bytes32[] memory skills) {
        skills = new bytes32[](6);
        skills[0] = SKILL_SMART_CONTRACTS;
        skills[1] = SKILL_MACHINE_LEARNING;
        skills[2] = SKILL_TOKENOMICS;
        skills[3] = SKILL_DIGITAL_HEALTH;
        skills[4] = SKILL_DATA_ANALYSIS;
        skills[5] = SKILL_BACKEND_JAVA;
    }
}
