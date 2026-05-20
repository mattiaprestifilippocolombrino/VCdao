// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./ISkillCalculator.sol";

/*
    Contratto che implementa l'interfaccia ISkillCalculator
    Calcola il Voting Power derivato dalle skill dei membri della DAO.

    Topic:
    0 = Web3 Infrastructure
    1 = AI Products
    2 = Digital Health
    3 = Enterprise Software

    Skill riconosciute:
    - smart-contracts
    - machine-learning
    - tokenomics
    - digital-health
    - data-analysis
    - backend-java
*/
contract SkillCalculator is ISkillCalculator {
    uint256 public constant TOPIC_WEB3 = 0;
    uint256 public constant TOPIC_AI = 1;
    uint256 public constant TOPIC_HEALTH = 2;
    uint256 public constant TOPIC_ENTERPRISE = 3;

    bytes32 public constant SKILL_SMART_CONTRACTS = keccak256(bytes("smart-contracts"));
    bytes32 public constant SKILL_MACHINE_LEARNING = keccak256(bytes("machine-learning"));
    bytes32 public constant SKILL_TOKENOMICS = keccak256(bytes("tokenomics"));
    bytes32 public constant SKILL_DIGITAL_HEALTH = keccak256(bytes("digital-health"));
    bytes32 public constant SKILL_DATA_ANALYSIS = keccak256(bytes("data-analysis"));
    bytes32 public constant SKILL_BACKEND_JAVA = keccak256(bytes("backend-java"));

    /*
    Funzione che restituisce i topic supportati.
    */
    function getSupportedTopics() external pure override returns (uint256[] memory topics) {
        topics = new uint256[](4);
        topics[0] = TOPIC_WEB3;
        topics[1] = TOPIC_AI;
        topics[2] = TOPIC_HEALTH;
        topics[3] = TOPIC_ENTERPRISE;
    }

    //Funzione che dice se un topicId è valido
    function isValidTopic(uint256 topicId) external pure override returns (bool) {
        return topicId <= TOPIC_ENTERPRISE;
    }

    //Funzione che calcola il voting power skill di un membro rispetto a un topic. Prende in input un array di hash di skill.
    function calculateVP(uint256 topicId, bytes32[] calldata skills) external pure override returns (uint256) {
        if (topicId > TOPIC_ENTERPRISE) return 0;

        uint256 score;

        //Variabili usate per tenere conto se l'utente ha una skill, utile per assegnare score e valutare combinazioni di skill.
        bool hasSmartContracts;
        bool hasMachineLearning;
        bool hasTokenomics;
        bool hasDigitalHealth;
        bool hasDataAnalysis;
        bool hasBackendJava;

        // Per ogni skill dell'utente, se ha una determinata skill, setta a true il relativo bool e chiama la funzione
        // che ne calcola lo score.
        for (uint256 i = 0; i < skills.length; i++) {
            bytes32 skill = skills[i];

            if (skill == SKILL_SMART_CONTRACTS && !hasSmartContracts) {
                hasSmartContracts = true;
                score += _scoreSmartContracts(topicId);
            } else if (skill == SKILL_MACHINE_LEARNING && !hasMachineLearning) {
                hasMachineLearning = true;
                score += _scoreMachineLearning(topicId);
            } else if (skill == SKILL_TOKENOMICS && !hasTokenomics) {
                hasTokenomics = true;
                score += _scoreTokenomics(topicId);
            } else if (skill == SKILL_DIGITAL_HEALTH && !hasDigitalHealth) {
                hasDigitalHealth = true;
                score += _scoreDigitalHealth(topicId);
            } else if (skill == SKILL_DATA_ANALYSIS && !hasDataAnalysis) {
                hasDataAnalysis = true;
                score += _scoreDataAnalysis(topicId);
            } else if (skill == SKILL_BACKEND_JAVA && !hasBackendJava) {
                hasBackendJava = true;
                score += _scoreBackendJava(topicId);
            }
        }

        // Calcola il boost nel caso abbia una certa combinazione di skill.
        score += _boost(
            topicId,
            hasSmartContracts,
            hasMachineLearning,
            hasTokenomics,
            hasDigitalHealth,
            hasDataAnalysis,
            hasBackendJava
        );

        if (score > 100) return 100;    //Se supera lo score max, ritorna lo score max.
        return score;
    }


// Funzioni che ritornano lo score relativo ad una skill, in base al topic.
    function _scoreSmartContracts(uint256 topicId) private pure returns (uint256) {
        if (topicId == TOPIC_WEB3) return 40;
        if (topicId == TOPIC_AI) return 5;
        if (topicId == TOPIC_HEALTH) return 0;
        return 10;
    }

    function _scoreMachineLearning(uint256 topicId) private pure returns (uint256) {
        if (topicId == TOPIC_WEB3) return 10;
        if (topicId == TOPIC_AI) return 40;
        if (topicId == TOPIC_HEALTH) return 20;
        return 10;
    }

    function _scoreTokenomics(uint256 topicId) private pure returns (uint256) {
        if (topicId == TOPIC_WEB3) return 35;
        if (topicId == TOPIC_AI) return 5;
        if (topicId == TOPIC_HEALTH) return 5;
        return 10;
    }

    function _scoreDigitalHealth(uint256 topicId) private pure returns (uint256) {
        if (topicId == TOPIC_WEB3) return 0;
        if (topicId == TOPIC_AI) return 10;
        if (topicId == TOPIC_HEALTH) return 45;
        return 0;
    }

    function _scoreDataAnalysis(uint256 topicId) private pure returns (uint256) {
        if (topicId == TOPIC_WEB3) return 10;
        if (topicId == TOPIC_AI) return 30;
        if (topicId == TOPIC_HEALTH) return 20;
        return 15;
    }

    function _scoreBackendJava(uint256 topicId) private pure returns (uint256) {
        if (topicId == TOPIC_WEB3) return 5;
        if (topicId == TOPIC_AI) return 10;
        if (topicId == TOPIC_HEALTH) return 5;
        return 40;
    }


//Funzione che ritorna il boost, in base al topic e se l'utente ha una combinazione di skill
    function _boost(
        uint256 topicId,
        bool hasSmartContracts,
        bool hasMachineLearning,
        bool hasTokenomics,
        bool hasDigitalHealth,
        bool hasDataAnalysis,
        bool hasBackendJava
    ) private pure returns (uint256) {
        if (topicId == TOPIC_WEB3 && hasSmartContracts && hasTokenomics) {
            return 20;
        }

        if (topicId == TOPIC_AI && hasMachineLearning && hasDataAnalysis) {
            return 20;
        }

        if (topicId == TOPIC_HEALTH && hasDigitalHealth && hasDataAnalysis) {
            return 20;
        }

        if (topicId == TOPIC_ENTERPRISE && hasBackendJava && hasDataAnalysis) {
            return 15;
        }

        return 0;
    }
}
