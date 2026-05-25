// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./ISkillCalculator.sol";
import "./SkillDefinitions.sol";

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

    /*
        Calcola gli score per tutti i topic in una sola chiamata esterna.
        GovernanceSkill la usa durante gli upgrade per evitare una chiamata esterna
        separata al calculator per ogni topic.
    */
    function calculateAllVP(bytes32[] calldata skills) external pure override returns (uint256[] memory scores) {
        scores = new uint256[](SkillDefinitions.TOPIC_COUNT);
        for (uint256 topicId = 0; topicId < SkillDefinitions.TOPIC_COUNT; topicId++) {
            scores[topicId] = _calculateVP(topicId, skills);
        }
    }

    function _calculateVP(uint256 topicId, bytes32[] calldata skills) private pure returns (uint256) {
        if (topicId >= SkillDefinitions.TOPIC_COUNT) return 0;

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

            if (skill == SkillDefinitions.SKILL_SMART_CONTRACTS && !hasSmartContracts) {
                hasSmartContracts = true;
                score += _scoreSmartContracts(topicId);
            } else if (skill == SkillDefinitions.SKILL_MACHINE_LEARNING && !hasMachineLearning) {
                hasMachineLearning = true;
                score += _scoreMachineLearning(topicId);
            } else if (skill == SkillDefinitions.SKILL_TOKENOMICS && !hasTokenomics) {
                hasTokenomics = true;
                score += _scoreTokenomics(topicId);
            } else if (skill == SkillDefinitions.SKILL_DIGITAL_HEALTH && !hasDigitalHealth) {
                hasDigitalHealth = true;
                score += _scoreDigitalHealth(topicId);
            } else if (skill == SkillDefinitions.SKILL_DATA_ANALYSIS && !hasDataAnalysis) {
                hasDataAnalysis = true;
                score += _scoreDataAnalysis(topicId);
            } else if (skill == SkillDefinitions.SKILL_BACKEND_JAVA && !hasBackendJava) {
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
        if (topicId == SkillDefinitions.TOPIC_WEB3) return 40;
        if (topicId == SkillDefinitions.TOPIC_AI) return 5;
        if (topicId == SkillDefinitions.TOPIC_HEALTH) return 0;
        return 10;
    }

    function _scoreMachineLearning(uint256 topicId) private pure returns (uint256) {
        if (topicId == SkillDefinitions.TOPIC_WEB3) return 10;
        if (topicId == SkillDefinitions.TOPIC_AI) return 40;
        if (topicId == SkillDefinitions.TOPIC_HEALTH) return 20;
        return 10;
    }

    function _scoreTokenomics(uint256 topicId) private pure returns (uint256) {
        if (topicId == SkillDefinitions.TOPIC_WEB3) return 35;
        if (topicId == SkillDefinitions.TOPIC_AI) return 5;
        if (topicId == SkillDefinitions.TOPIC_HEALTH) return 5;
        return 10;
    }

    function _scoreDigitalHealth(uint256 topicId) private pure returns (uint256) {
        if (topicId == SkillDefinitions.TOPIC_WEB3) return 0;
        if (topicId == SkillDefinitions.TOPIC_AI) return 10;
        if (topicId == SkillDefinitions.TOPIC_HEALTH) return 45;
        return 0;
    }

    function _scoreDataAnalysis(uint256 topicId) private pure returns (uint256) {
        if (topicId == SkillDefinitions.TOPIC_WEB3) return 10;
        if (topicId == SkillDefinitions.TOPIC_AI) return 30;
        if (topicId == SkillDefinitions.TOPIC_HEALTH) return 20;
        return 15;
    }

    function _scoreBackendJava(uint256 topicId) private pure returns (uint256) {
        if (topicId == SkillDefinitions.TOPIC_WEB3) return 5;
        if (topicId == SkillDefinitions.TOPIC_AI) return 10;
        if (topicId == SkillDefinitions.TOPIC_HEALTH) return 5;
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
        if (topicId == SkillDefinitions.TOPIC_WEB3 && hasSmartContracts && hasTokenomics) {
            return 20;
        }

        if (topicId == SkillDefinitions.TOPIC_AI && hasMachineLearning && hasDataAnalysis) {
            return 20;
        }

        if (topicId == SkillDefinitions.TOPIC_HEALTH && hasDigitalHealth && hasDataAnalysis) {
            return 20;
        }

        if (topicId == SkillDefinitions.TOPIC_ENTERPRISE && hasBackendJava && hasDataAnalysis) {
            return 15;
        }

        return 0;
    }
}
