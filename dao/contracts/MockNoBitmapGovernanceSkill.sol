// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "./IGovernanceToken.sol";
import "./ISkillCalculator.sol";
import "./VPVerifier.sol";

contract MockNoBitmapGovernanceSkill {
    using Checkpoints for Checkpoints.Trace208;

    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant TOPIC_COUNT = 4;
    bytes32 public constant VC_PROOF_TYPEHASH = keccak256("VCProof(bytes32 credentialSubjectHash)");

    IGovernanceToken public immutable governanceToken;
    ISkillCalculator public immutable skillCalculator;
    uint256 public immutable weightSkill;
    address public immutable deployer;

    mapping(address => bool) public trustedIssuers;
    uint256 public trustedIssuerCount;
    mapping(address => bytes32) public memberDID;
    mapping(bytes32 => address) public didToAddress;
    mapping(address => bytes32[]) public memberSkills;
    mapping(address => mapping(bytes32 => bool)) public memberHasSkill;
    mapping(address => mapping(uint256 => Checkpoints.Trace208)) private _skillVotesCheckpoints;
    mapping(uint256 => Checkpoints.Trace208) private _totalSkillSupplyCheckpoints;

    event SkillUpgradedWithVC(address indexed member, bytes32 indexed issuerDidHash);
    event SkillUpgraded(address indexed member, bytes32 indexed proofHash);
    event TrustedIssuerAdded(address indexed issuer);
    event MemberSkillsMerged(address indexed member, uint256 addedSkills, uint256 totalSkills);
    event DIDRegistered(address indexed member, bytes32 indexed didHash);

    error NotMember();
    error ZeroAddress();
    error DIDMismatch();
    error DIDAlreadyRegistered();
    error DIDAlreadyBound();
    error NoDIDRegistered();
    error EmptyDID();
    error UntrustedIssuer();
    error TrustedIssuerNotSet();
    error TrustedIssuerAlreadySet();
    error InvalidCalculator();
    error InvalidTopicId(uint256 topicId);
    error ERC5805FutureLookup(uint256 timepoint, uint48 clock);

    constructor(address _governanceToken, uint256 _weightSkill, address _skillCalculator) {
        if (_governanceToken == address(0) || _skillCalculator == address(0)) revert ZeroAddress();
        governanceToken = IGovernanceToken(_governanceToken);
        skillCalculator = ISkillCalculator(_skillCalculator);
        weightSkill = _weightSkill;
        deployer = msg.sender;
    }

    function setTrustedIssuer(address issuer) external {
        if (msg.sender != deployer) revert UntrustedIssuer();
        if (issuer == address(0)) revert ZeroAddress();
        if (trustedIssuers[issuer]) revert TrustedIssuerAlreadySet();
        trustedIssuers[issuer] = true;
        ++trustedIssuerCount;
        emit TrustedIssuerAdded(issuer);
    }

    function clock() public view returns (uint48) {
        return governanceToken.clock();
    }

    function registerDID(string calldata did) external {
        if (!governanceToken.isMember(msg.sender)) revert NotMember();
        if (bytes(did).length == 0) revert EmptyDID();
        if (memberDID[msg.sender] != bytes32(0)) revert DIDAlreadyRegistered();

        bytes32 didHash = keccak256(bytes(did));
        if (didToAddress[didHash] != address(0)) revert DIDAlreadyBound();
        memberDID[msg.sender] = didHash;
        didToAddress[didHash] = msg.sender;
        emit DIDRegistered(msg.sender, didHash);
    }

    function getMemberSkills(address member) external view returns (bytes32[] memory) {
        return memberSkills[member];
    }

    function hasSkill(address member, bytes32 skillId) external view returns (bool) {
        return memberHasSkill[member][skillId];
    }

    function upgradeSkillWithVC(
        VPVerifier.VerifiableCredential memory vc,
        bytes memory issuerSignature
    ) external {
        if (!governanceToken.isMember(msg.sender)) revert NotMember();
        if (trustedIssuerCount == 0) revert TrustedIssuerNotSet();
        bytes32 didHash = memberDID[msg.sender];
        if (didHash == bytes32(0)) revert NoDIDRegistered();
        if (keccak256(bytes(vc.credentialSubject.id)) != didHash) revert DIDMismatch();

        address recovered = VPVerifier.recoverIssuer(vc, issuerSignature);
        if (!trustedIssuers[recovered]) revert UntrustedIssuer();

        bytes32[] memory mergedSkills = _mergeSkills(msg.sender, vc.credentialSubject.skills);
        bytes32 issuerDidHash = keccak256(bytes(vc.issuer.id));
        bytes32 proofHash = _credentialSubjectProofHash(vc.credentialSubject);
        _performUpgrade(msg.sender, mergedSkills);

        emit SkillUpgraded(msg.sender, proofHash);
        emit SkillUpgradedWithVC(msg.sender, issuerDidHash);
    }

    function _mergeSkills(address member, string[] memory skillNames) private returns (bytes32[] memory) {
        bytes32[] storage skills = memberSkills[member];
        uint256 added;
        for (uint256 i = 0; i < skillNames.length; i++) {
            bytes32 skillId = keccak256(bytes(skillNames[i]));
            if (memberHasSkill[member][skillId]) continue;
            memberHasSkill[member][skillId] = true;
            skills.push(skillId);
            ++added;
        }
        if (added > 0) emit MemberSkillsMerged(member, added, skills.length);
        return skills;
    }

    function _performUpgrade(address member, bytes32[] memory skills) private {
        uint48 blk = clock();
        uint256[] memory scores = skillCalculator.calculateAllVP(skills);
        if (scores.length != TOPIC_COUNT) revert InvalidCalculator();

        for (uint256 topicId = 0; topicId < TOPIC_COUNT; topicId++) {
            if (scores[topicId] > 100) revert InvalidCalculator();
            uint256 newVP = (scores[topicId] * weightSkill * 1e18) / BASIS_POINTS;
            _writeSkillVotes(member, topicId, newVP, blk);
        }
    }

    function _writeSkillVotes(address account, uint256 topicId, uint256 newVP, uint48 checkpointKey) private {
        Checkpoints.Trace208 storage userTrace = _skillVotesCheckpoints[account][topicId];
        uint208 oldVotes = userTrace.latest();
        uint208 newVotes = SafeCast.toUint208(newVP);
        if (newVotes == oldVotes) return;

        Checkpoints.Trace208 storage totalTrace = _totalSkillSupplyCheckpoints[topicId];
        uint208 oldTotal = totalTrace.latest();
        userTrace.push(checkpointKey, newVotes);
        if (newVotes > oldVotes) {
            totalTrace.push(checkpointKey, oldTotal + (newVotes - oldVotes));
        } else {
            totalTrace.push(checkpointKey, oldTotal - (oldVotes - newVotes));
        }
    }

    function getSkillVotes(address account, uint256 topicId) external view returns (uint256) {
        _validateTopicId(topicId);
        return _skillVotesCheckpoints[account][topicId].latest();
    }

    function getPastSkillVotes(address account, uint256 topicId, uint256 timepoint) external view returns (uint256) {
        _validateTopicId(topicId);
        uint48 cur = clock();
        if (timepoint >= cur) revert ERC5805FutureLookup(timepoint, cur);
        return _skillVotesCheckpoints[account][topicId].upperLookupRecent(SafeCast.toUint48(timepoint));
    }

    function getTotalSkillSupply(uint256 topicId) external view returns (uint256) {
        _validateTopicId(topicId);
        return _totalSkillSupplyCheckpoints[topicId].latest();
    }

    function _validateTopicId(uint256 topicId) private pure {
        if (topicId >= TOPIC_COUNT) revert InvalidTopicId(topicId);
    }

    function _credentialSubjectProofHash(
        VPVerifier.CredentialSubject memory credentialSubject
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(VC_PROOF_TYPEHASH, VPVerifier.hashCredentialSubject(credentialSubject)));
    }
}
