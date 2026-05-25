// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "./VPVerifier.sol";
import "./ISkillCalculator.sol";
import "./IGovernanceToken.sol";
import "./SkillDefinitions.sol";

contract GovernanceSkill {
    using Checkpoints for Checkpoints.Trace208;

    uint256 public constant BASIS_POINTS = 10_000;      /// Denominatore basis points per effettuare i calcoli in %, che rappresenta il 100% = 10.000 bp.
    bytes32 public constant VC_PROOF_TYPEHASH = keccak256("VCProof(bytes32 credentialSubjectHash)");

    /// Domain separator EIP-712 universale, precalcolato a compile-time, identico al dominio usato off-chain da Veramo per firmare le VC.
    /// Essendo `constant`, il valore viene incorporato direttamente nel bytecode senza occupare storage e senza costi di SLOAD (risparmio ~600 gas)
    bytes32 public constant UNIVERSAL_DOMAIN_SEPARATOR =
        keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version)"),
                keccak256(bytes("Universal VC Protocol")),
                keccak256(bytes("1"))
            )
        );

    uint256 public weightSkill;     // Peso della componente skill nella formula del voting power, espresso in basis points.

    // Timelock e deployer non cambiano mai dopo il deploy.
    // Il deployer serve solo per il bootstrap iniziale; poi le modifiche passano dal Timelock.
    address public immutable timelock;      /// Indirizzo del TimelockController, cioè l'esecutore delle decisioni di governance.
    address public immutable deployer;      /// Indirizzo del deployer, cioè la il token, usato solo per il setup iniziale.

    IGovernanceToken public immutable governanceToken;

    
    mapping(address => bool) public trustedIssuers;  // Issuer attendibili dal contratto che firmano le Verifiable Credential contenenti le skill dei membri.
    uint256 public trustedIssuerCount;


    ISkillCalculator public skillCalculator;   // Contratto esterno che calcola lo score skill per topic. Implementa l'intefaccia ISkillCulculator.


    mapping(address => bytes32) public memberDID;    // Mappa che associa ogni membro all'hash del suo DID. Evita di salvare stringhe nello storage.
    mapping(bytes32 => address) public didToAddress;        // Mappa che associa ogni DID hash al suo indirizzo, per garantire l'unicita dei DID nella DAO.
    
    // Storage canonico delle skill di un membro. Le skill sono salvate come hash
    // per evitare stringhe nello storage e confrontarle in modo economico.
    mapping(address => bytes32[]) public memberSkills;
    mapping(address => mapping(bytes32 => bool)) public memberHasSkill;


    // Checkpoint skill per topic

    //  _skillVotesCheckpoints[account][topicId]
    // storico cumulativo del voting power derivato da skill dell'utente, per quel determinato topic.
    // Associa l'indirizzo di un membro, al mapping che va dal topicId al voting power relativo.
    mapping(address => mapping(uint256 => Checkpoints.Trace208)) private _skillVotesCheckpoints;

    //  _totalSkillSupplyCheckpoints[topicId]:
    //  Tiene traccia della somma cumulativa di tutti i VP-skill emessi per quel topic, per tutti gli utenti.
    // Associa il topicId al voting power da skill totale accumulato.
    mapping(uint256 => Checkpoints.Trace208) private _totalSkillSupplyCheckpoints;

    event SkillUpgradedWithVC(address indexed member, bytes32 indexed issuerDidHash);
    event SkillUpgraded(address indexed member, bytes32 indexed proofHash);
    event DIDRegistered(address indexed member, bytes32 indexed didHash);
    event TrustedIssuerAdded(address indexed issuer);
    event TrustedIssuerRemoved(address indexed issuer);
    event SkillCalculatorSet(address indexed calculator);
    event SkillWeightUpdated(uint256 weightSkill);
    event MemberSkillsMerged(address indexed member, uint256 addedSkills, uint256 totalSkills);

    error OnlyTimelock();
    error OnlyDeployer();
    error NotMember();
    error ZeroAddress();
    error DIDAlreadyRegistered();
    error DIDAlreadyBound();
    error NoDIDRegistered();
    error DIDMismatch();
    error UntrustedIssuer();
    error TrustedIssuerNotSet();
    error TrustedIssuerAlreadySet();
    error CannotRemoveLastTrustedIssuer();
    error EmptyDID();
    error InvalidTopicId(uint256 topicId);
    error CalculatorNotSet();
    error NotAContract();
    error InvalidCalculator();
    error InvalidWeights();
    error InvalidSkill(bytes32 skillId);
    error ERC5805FutureLookup(uint256 timepoint, uint48 clock);

    /// Decorator che obbliga la funzione interna ad essere eseguita solo dal TimeLockController.
    modifier onlyTimelock() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _;
    }

    /// Decorator che obbliga la funzione interna ad essere eseguita solo dal deployer.
    modifier onlyDeployer() {
        if (msg.sender != deployer) revert OnlyDeployer();
        _;
    }

    constructor(
        address _governanceToken,
        address _timelock,
        uint256 _weightSkill
    ) {
        if (_governanceToken == address(0)) revert ZeroAddress();
        if (_timelock == address(0)) revert ZeroAddress();
        if (_weightSkill > BASIS_POINTS) revert InvalidWeights();
        governanceToken = IGovernanceToken(_governanceToken);
        timelock = _timelock;
        deployer = msg.sender;
        weightSkill = _weightSkill;
    }

    /*
    Funzione che configura gli issuer fidati, che firmano le VC riconosciute dal contratto. 
       Il primo issuer può impostarlo solo il deployer. 
       Dopo la prima configurazione, solo la governance può cambiarlo o aggiungere altri issuer.
    */
    function setTrustedIssuer(address _issuer) external {
        if (_issuer == address(0)) revert ZeroAddress();
        if (trustedIssuers[_issuer]) revert TrustedIssuerAlreadySet();

        if (trustedIssuerCount == 0) {
            if (msg.sender != deployer) revert OnlyDeployer();
        } else {
            if (msg.sender != timelock) revert OnlyTimelock();
        }

        trustedIssuers[_issuer] = true;
        trustedIssuerCount++;
        emit TrustedIssuerAdded(_issuer);
    }

    // Rimuove un issuer dall'insieme fidato. Puo farlo solo la governance.
    function removeTrustedIssuer(address _issuer) external onlyTimelock {
        if (!trustedIssuers[_issuer]) revert UntrustedIssuer();
        if (trustedIssuerCount == 1) revert CannotRemoveLastTrustedIssuer();

        trustedIssuers[_issuer] = false;
        trustedIssuerCount--;

        emit TrustedIssuerRemoved(_issuer);
    }

    /*
        Imposta il calcolatore delle skill, che implementa l'interfaccia ISkillCalculator.
        La prima configurazione e' bootstrap del deployer; le successive passano dal Timelock.
    */
    function setSkillCalculator(address _calculator) external {
        if (_calculator == address(0)) revert ZeroAddress();
        if (_calculator.code.length == 0) revert NotAContract();

        if (address(skillCalculator) == address(0)) {
            if (msg.sender != deployer) revert OnlyDeployer();
        } else {
            if (msg.sender != timelock) revert OnlyTimelock();
        }

        ISkillCalculator candidate = ISkillCalculator(_calculator);
        bytes32[] memory emptySkills = new bytes32[](0);
        try candidate.calculateAllVP(emptySkills) returns (uint256[] memory scores) {
            if (scores.length != SkillDefinitions.TOPIC_COUNT) revert InvalidCalculator();
            for (uint256 topicId = 0; topicId < SkillDefinitions.TOPIC_COUNT; topicId++) {
                if (scores[topicId] > 100) revert InvalidCalculator();
            }
        } catch {
            revert InvalidCalculator();
        }

        skillCalculator = candidate;
        emit SkillCalculatorSet(_calculator);
    }

    function setSkillWeight(uint256 _weightSkill) external onlyTimelock {
        if (_weightSkill > BASIS_POINTS) revert InvalidWeights();
        weightSkill = _weightSkill;
        emit SkillWeightUpdated(_weightSkill);
    }

    // Espone lo stesso clock del GovernanceToken, così i checkpoint skill dichiarano esplicitamente la stessa base temporale dello stake.
    function clock() public view returns (uint48) {
        return governanceToken.clock();
    }

    // Espone la stessa modalità del clock del GovernanceToken, per compatibilità con lo standard ERC-5805.
    function CLOCK_MODE() public view returns (string memory) {
        return governanceToken.CLOCK_MODE();
    }

    function supportedTopics(uint256 topicId) public pure returns (bool) {
        return isValidTopic(topicId);
    }

    function supportedSkills(bytes32 skillId) public pure returns (bool) {
        return isValidSkill(skillId);
    }

    function getSupportedTopics() external pure returns (uint256[] memory topics) {
        return SkillDefinitions.supportedTopics();
    }

    function getSupportedSkills() external pure returns (bytes32[] memory skills) {
        return SkillDefinitions.supportedSkills();
    }

    // La validazione dei topic viene mantenuta nel modulo skill della DAO.
    function isValidTopic(uint256 topicId) public pure returns (bool) {
        return SkillDefinitions.isValidTopic(topicId);
    }

    function isValidSkill(bytes32 skillId) public pure returns (bool) {
        return SkillDefinitions.isValidSkill(skillId);
    }


    //  DID

     /*  Funzione per la registrazione del DID di un membro. Un membro puo registrare un solo DID
        e lo stesso DID non puo essere usato da due address.
        Verifica che il msg.sender sia un membro della DAO e che non abbia gia registrato un DID.
        Effettua l'hash del DID, controlla che non sia già stato registrato. 
        In tal caso, registra nei mapping le associazioni address -> DID hash e DID hash -> address.
    */
    function registerDID(string calldata _did) external {
        if (!governanceToken.isMember(msg.sender)) revert NotMember();
        if (bytes(_did).length == 0) revert EmptyDID();
        if (memberDID[msg.sender] != bytes32(0)) revert DIDAlreadyRegistered();
        bytes32 h = keccak256(bytes(_did));
        if (didToAddress[h] != address(0)) revert DIDAlreadyBound();
        memberDID[msg.sender] = h;
        didToAddress[h] = msg.sender;
        emit DIDRegistered(msg.sender, h);
    }


    //  Upgrade Skill


    // Getter comodo per leggere l'array di skill hashate del membro.
    function getMemberSkills(address member) public view returns (bytes32[] memory) {
        return memberSkills[member];
    }

    // Controlla se un membro possiede una skill.
    function hasSkill(address member, bytes32 skillId) public view returns (bool) {
        return memberHasSkill[member][skillId];
    }

    // Aggiunge skill gia' hashate, senza duplicati, e restituisce la lista aggiornata.
    function _mergeSkills(address member, bytes32[] memory skillIds) internal returns (bytes32[] memory) {
        bytes32[] storage skills = memberSkills[member];
        uint256 added;
        uint256 skillCount = skillIds.length;
        for (uint256 i = 0; i < skillCount; i++) {
            if (_addValidSkill(member, skills, skillIds[i])) {
                ++added;
            }
        }
        if (added > 0) emit MemberSkillsMerged(member, added, skills.length);
        return skills;
    }

    function _skillIds(string[] memory skillNames) private pure returns (bytes32[] memory skillIds) {
        uint256 skillCount = skillNames.length;
        skillIds = new bytes32[](skillCount);
        for (uint256 i = 0; i < skillCount; i++) {
            skillIds[i] = SkillDefinitions.skillId(skillNames[i]);
        }
    }

    function _addValidSkill(address member, bytes32[] storage skills, bytes32 skillId) private returns (bool) {
        if (!SkillDefinitions.isValidSkill(skillId)) revert InvalidSkill(skillId);
        if (memberHasSkill[member][skillId]) return false;

        memberHasSkill[member][skillId] = true;
        skills.push(skillId);
        return true;
    }

    /*
        Upgrade amministrativo via governance No VC, usato a fini di test.
        Il Timelock passa skill testuali approvate da una proposta.
    */
    function upgradeSkill(
        address _member,
        string[] calldata _skills,
        bytes32 _proofHash
    ) external onlyTimelock {
        if (!governanceToken.isMember(_member)) revert NotMember();
        if (address(skillCalculator) == address(0)) revert CalculatorNotSet();
        bytes32[] memory mergedSkills = _mergeSkills(_member, _skillIds(_skills));
        _performUpgrade(_member, mergedSkills, _proofHash);
    }

    /*
    Funzione che esegue l'upgrade del grado di competenza di un membro tramite VC. 
    Usa la libreria VPVerifier per verificare una VC firmata e applica l'upgrade se la VC è valida.
    La funzione controlla se il membro è esistente e se è configurato nella DAO l'issuer fidato.
    Controlla se il DID del membro è coerente con il DID nel credentialSubject.
    Il typehash del dominio EIP-712 è precalcolato come constant (0 gas di hashing).
    Recupera l'address del firmatario usando le funzioni della libreria VPVerifier sulla firma EIP-712 
    contenuta nella VC.
    Controlla se l'issuer recuperato è uguale al trustedIssuer. 
    In caso positivo, mappa il titolo testuale nell'enum di grado di competenza.
    Costruisce un hash della proof sintetica da esporre negli eventi. 
    Esegue l'aggiornamento del grado del membro, tramite la funzione _performUpgrade, senza passare dalla governance.
    */
    function upgradeSkillWithVC(
        VPVerifier.VerifiableCredential memory _vc,
        bytes memory _issuerSignature
    ) external {
        if (!governanceToken.isMember(msg.sender)) revert NotMember();
        if (trustedIssuerCount == 0) revert TrustedIssuerNotSet();
        if (address(skillCalculator) == address(0)) revert CalculatorNotSet();
        bytes32 didHash = memberDID[msg.sender];
        if (didHash == bytes32(0)) revert NoDIDRegistered();
        if (keccak256(bytes(_vc.credentialSubject.id)) != didHash) revert DIDMismatch();

        address recovered = VPVerifier.recoverIssuer(_vc, _issuerSignature, UNIVERSAL_DOMAIN_SEPARATOR);
        if (!trustedIssuers[recovered]) revert UntrustedIssuer();

        bytes32[] memory mergedSkills = _mergeSkills(msg.sender, _skillIds(_vc.credentialSubject.skills));
        
        bytes32 issuerDidHash = keccak256(bytes(_vc.issuer.id));
        bytes32 proofHash = _credentialSubjectProofHash(_vc.credentialSubject);
        _performUpgrade(msg.sender, mergedSkills, proofHash);

        emit SkillUpgradedWithVC(msg.sender, issuerDidHash);
    }

    /*
        Proof sintetica per gli eventi: lega l'upgrade al CredentialSubject certificato
        (holder DID, universita', faculty e hash ordinato delle skill) senza salvare stringhe on-chain.
        VPVerifier resta responsabile solo dell'hashing EIP-712 della VC; GovernanceSkill decide
        quale proof esporre nella logica DAO.
    */
    function _credentialSubjectProofHash(
        VPVerifier.CredentialSubject memory credentialSubject
    ) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VC_PROOF_TYPEHASH,
                VPVerifier.hashCredentialSubject(credentialSubject)
            )
        );
    }

    /*
    Funzione di upgrade di competenza, che si occupa di effettuare nella DAO le modifiche
    al voting power del membro dopo che la VC è stata verificata (oppure dopo che il Timelock ha autorizzato
    l'upgrade legacy).
    Per ogni topic t ∈:
        VPSkills(skills[], t) = skillsScoreForTopic(skills[], t) × weightSkill × 10^18 / BASIS_POINTS
    Per calcolare skillsScoreForTopic(skills[], t) si usa l'interfaccia ISkillCalculator.
    Viene preso il blocco attuale. Si prende la lista di topic. Per ogni topic, si chiama lo SkillCalculator per calcolare
    il voting power dell'utente per tale topic.
    Si chiama la funzione che aggiorna i checkpoint.
    */
    function _performUpgrade(
        address _member,
        bytes32[] memory _skills,
        bytes32 _proofHash
    ) internal {
        uint48 blk = clock();
        uint256[] memory scores = skillCalculator.calculateAllVP(_skills);
        if (scores.length != SkillDefinitions.TOPIC_COUNT) revert InvalidCalculator();

        for (uint256 topicId = 0; topicId < SkillDefinitions.TOPIC_COUNT; topicId++) {
            uint256 score = scores[topicId];
            if (score > 100) revert InvalidCalculator();
            uint256 newVP = (score * weightSkill * 1e18) / BASIS_POINTS;

            _writeSkillVotes(_member, topicId, newVP, blk);
        }

        emit SkillUpgraded(_member, _proofHash);
    }

    /*
        Scrive il nuovo valore assoluto di VP skill.
        Aggiorna anche la total supply del topic applicando solo la differenza
        tra vecchio e nuovo valore. Cosi' supporta sia aumenti sia eventuali
        diminuzioni future dovute a un nuovo SkillCalculator.
    */
   /*
    Funzione che aggiunge il voting power da skill aggiuntivo per un dato topic
    ai checkpoint del membro e alla supply totale del topic. Supporta anche downgrade se il voting power diminuisce.
    I checkpoint permettono al Governor di leggere il Voting power storico derivato da skill al blocco di snapshot
    della proposta, evitando che upgrade successivi modifichino votazioni già iniziate.
    La funzione crea un record sul checkpoint dell VP del membro per il topic. Salva il nuovo valore del VP nel membro.
    Poi crea il record per il checkpoint sulla totalSupply. Confronta il VP attuale del membro con quello dell'ultimo checkpoint.
    Se il VP è aumentato, aggiunge la differenza, mentre se è diminuito sottrae la differenza.
    */
    function _writeSkillVotes(
        address account,
        uint256 topicId,
        uint256 newVP,
        uint48 checkpointKey
    ) internal {
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

    // Validazione interna usata dai getter topic-aware.
    function _validateTopicId(uint256 topicId) internal pure {
        if (!SkillDefinitions.isValidTopic(topicId)) revert InvalidTopicId(topicId);
    }

    // =========================================================================
    //  Getter pubblici
    // =========================================================================

    // Restituisce il checkpint del VP skill corrente del membro su un topic.
    function getSkillVotes(address account, uint256 topicId) public view returns (uint256) {
        _validateTopicId(topicId);
        return _skillVotesCheckpoints[account][topicId].latest();
    }

    // Restituisce il VP skill storico del membro al Governor, al blocco di snapshot della proposta.
    function getPastSkillVotes(address account, uint256 topicId, uint256 timepoint) public view returns (uint256) {
        _validateTopicId(topicId);
        uint48 cur = clock();
        if (timepoint >= cur) revert ERC5805FutureLookup(timepoint, cur);
        return _skillVotesCheckpoints[account][topicId].upperLookupRecent(SafeCast.toUint48(timepoint));
    }

    // Restituisce il checkpoint della TotalSupply VP skill corrente di un topic.
    function getTotalSkillSupply(uint256 topicId) public view returns (uint256) {
        _validateTopicId(topicId);
        return _totalSkillSupplyCheckpoints[topicId].latest();
    }

    // Restituisce il checkpoint della TotalSupply VP skill corrente di un topic, ad un certo timepoint
    function getPastTotalSkillSupply(uint256 topicId, uint256 timepoint) public view returns (uint256) {
        _validateTopicId(topicId);
        uint48 cur = clock();
        if (timepoint >= cur) revert ERC5805FutureLookup(timepoint, cur);
        return _totalSkillSupplyCheckpoints[topicId].upperLookupRecent(SafeCast.toUint48(timepoint));
    }
}
