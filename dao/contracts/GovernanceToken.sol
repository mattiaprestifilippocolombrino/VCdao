// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
GovernanceToken — Token ERC20 + Votes per la DAO con Voting Power multi-topic.

Architettura del Voting Power (VP):
  VP_totale(account, topic) = VP_stake(account) + VP_skill(account, topic)

  VP_stake: derivato dal balance ERC20 (token mintati al deposito ETH).
            Uguale per tutti i topic — tracciato da ERC20Votes.
  VP_skill: dipende dal topic della proposta — tracciato da checkpoint manuali
            Checkpoints.Trace208 (stessa struttura e stesso clock di ERC20Votes).

Modello gradi (13 valori):
  Student                     → score 0 per tutti i topic
  BachelorCS / MasterCS / PhDCS / ProfessorCS → topic CS (0)
  BachelorCE / MasterCE / PhDCE / ProfessorCE → topic CE (1)
  BachelorEE / MasterEE / PhDEE / ProfessorEE → topic EE (2)

Score base per livello: Bachelor=25, Master=50, PhD=75, Professor=100
Se topic del grado == topic proposta → score pieno
Se topic del grado != topic proposta → max(0, score - CROSS_TOPIC_PENALTY)
CROSS_TOPIC_PENALTY = 25 (hardcoded)

Esempio: ProfessorCS, topic CE → 100 - 25 = 75
         BachelorCS,  topic EE → max(0, 25 - 25) = 0
*/

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "./VPVerifier.sol";

contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes {
    using Checkpoints for Checkpoints.Trace208;

    // =========================================================================
    //  Costanti Topic
    // =========================================================================

    /// Topic IDs. Devono essere contigui e partire da 0.
    uint256 public constant TOPIC_CS  = 0;
    uint256 public constant TOPIC_CE  = 1;
    uint256 public constant TOPIC_EE  = 2;
    uint256 public constant NUM_TOPICS = 3;

    /// Penalità applicata (in punti score) quando la competenza non corrisponde al topic.
    uint256 public constant CROSS_TOPIC_PENALTY = 25;

    /// Numero di livelli per topic (Bachelor, Master, PhD, Professor).
    uint8 private constant LEVELS_PER_TOPIC = 4;

    // =========================================================================
    //  Costanti DAO
    // =========================================================================

    uint256 public constant MAX_DEPOSIT   = 100 ether;
    uint8   public constant MAX_DEGREE_LEVEL = 4;
    uint256 public constant BASIS_POINTS  = 10_000;

    bytes32 public constant UNIVERSAL_DOMAIN_SEPARATOR =
        keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version)"),
            keccak256(bytes("Universal VC Protocol")),
            keccak256(bytes("1"))
        ));

    // =========================================================================
    //  Enum gradi — Student + 4 livelli × 3 topic = 13 valori
    //  Mapping numerico: grade g (g > 0) → topic = (g-1)/4, level = (g-1)%4
    //  level 0→Bachelor(25), 1→Master(50), 2→PhD(75), 3→Professor(100)
    // =========================================================================
    enum CompetenceGrade {
        Student,     // 0
        BachelorCS,  // 1  (topic 0, level 0, score 25)
        MasterCS,    // 2  (topic 0, level 1, score 50)
        PhDCS,       // 3  (topic 0, level 2, score 75)
        ProfessorCS, // 4  (topic 0, level 3, score 100)
        BachelorCE,  // 5  (topic 1, level 0, score 25)
        MasterCE,    // 6  (topic 1, level 1, score 50)
        PhDCE,       // 7  (topic 1, level 2, score 75)
        ProfessorCE, // 8  (topic 1, level 3, score 100)
        BachelorEE,  // 9  (topic 2, level 0, score 25)
        MasterEE,    // 10 (topic 2, level 1, score 50)
        PhDEE,       // 11 (topic 2, level 2, score 75)
        ProfessorEE  // 12 (topic 2, level 3, score 100)
    }

    // =========================================================================
    //  Stato immutabile / configurabile
    // =========================================================================

    uint256 public immutable pesoCompetenze;
    uint256 public immutable pesoSoldi;
    address public immutable timelock;
    address public immutable deployer;
    address public treasury;
    address public trustedIssuer;

    // =========================================================================
    //  Stato per membro
    // =========================================================================

    mapping(address => uint256)          public ethDeposited;
    mapping(address => CompetenceGrade)  public memberGrade;
    mapping(address => bool)             public isMember;
    mapping(address => string)           public competenceProof;
    mapping(address => string)           public memberDID;
    mapping(bytes32 => address)          public didToAddress;

    // =========================================================================
    //  Checkpoint skill per topic
    //
    //  _skillVotesCheckpoints[account][topicId]:
    //      storico cumulativo VP-skill dell'utente per quel topic (in wei).
    //      Chiave: uint48 = numero di blocco (clock()). Valore: uint208 = VP wei.
    //
    //  _totalSkillSupplyCheckpoints[topicId]:
    //      somma cumulativa di tutti i VP-skill emessi per quel topic (in wei).
    //      Usata dal Governor per quorum/superQuorum topic-specifico.
    // =========================================================================

    mapping(address => mapping(uint256 => Checkpoints.Trace208)) private _skillVotesCheckpoints;
    mapping(uint256 => Checkpoints.Trace208) private _totalSkillSupplyCheckpoints;

    // =========================================================================
    //  Eventi
    // =========================================================================

    event MemberJoined(address indexed member, uint256 ethAmount, uint256 tokensReceived);
    event TokensMinted(address indexed member, uint256 ethAmount, uint256 tokensMinted);
    event CompetenceUpgraded(
        address indexed member,
        CompetenceGrade newGrade,
        uint256[3] skillVPPerTopic,
        string proof
    );
    event CompetenceUpgradedWithVP(
        address indexed member, CompetenceGrade newGrade, uint8 degreeLevel, string issuerDid
    );
    event DIDRegistered(address indexed member, string did);
    event TrustedIssuerSet(address indexed issuer);

    // =========================================================================
    //  Errori
    // =========================================================================

    error OnlyTimelock();
    error OnlyDeployer();
    error AlreadyMember();
    error NotMember();
    error ZeroDeposit();
    error ExceedsMaxDeposit();
    error CannotDowngrade();
    error ZeroAddress();
    error TreasuryNotSet();
    error TreasuryAlreadySet();
    error TreasuryTransferFailed();
    error InvalidWeights();
    error DepositTooSmall();
    error DIDAlreadyRegistered();
    error DIDAlreadyBound();
    error NoDIDRegistered();
    error DIDMismatch();
    error UntrustedIssuer();
    error InvalidDegreeLevel();
    error TrustedIssuerNotSet();
    error EmptyDID();
    error InvalidTopicId(uint256 topicId);

    // =========================================================================
    //  Modifier
    // =========================================================================

    modifier onlyTimelock() { if (msg.sender != timelock) revert OnlyTimelock(); _; }
    modifier onlyDeployer() { if (msg.sender != deployer) revert OnlyDeployer(); _; }

    // =========================================================================
    //  Costruttore
    // =========================================================================

    constructor(
        address _timelock,
        uint256 _pesoCompetenze,
        uint256 _pesoSoldi
    ) ERC20("CompetenceDAO Token", "COMP") ERC20Permit("CompetenceDAO Token") {
        if (_timelock == address(0)) revert ZeroAddress();
        if (_pesoCompetenze + _pesoSoldi != BASIS_POINTS) revert InvalidWeights();
        timelock       = _timelock;
        deployer       = msg.sender;
        pesoCompetenze = _pesoCompetenze;
        pesoSoldi      = _pesoSoldi;
    }

    // =========================================================================
    //  Setup
    // =========================================================================

    function setTreasury(address _treasury) external onlyDeployer {
        if (treasury != address(0)) revert TreasuryAlreadySet();
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    function setTrustedIssuer(address _issuer) external {
        if (_issuer == address(0)) revert ZeroAddress();
        if (trustedIssuer == address(0)) {
            if (msg.sender != deployer) revert OnlyDeployer();
        } else {
            if (msg.sender != timelock) revert OnlyTimelock();
        }
        trustedIssuer = _issuer;
        emit TrustedIssuerSet(_issuer);
    }

    // =========================================================================
    //  Membership e Stake (componente economica — ERC20)
    // =========================================================================

    function getScoreSoldiForDeposit(uint256 deposited) public pure returns (uint256) {
        if (deposited >= MAX_DEPOSIT) return 100;
        return (deposited * 100) / MAX_DEPOSIT;
    }

    function _calculateStakeTokens(uint256 depositAmt, uint256 oldDeposited)
        internal view returns (uint256)
    {
        uint256 oldScore = getScoreSoldiForDeposit(oldDeposited);
        uint256 newScore = getScoreSoldiForDeposit(oldDeposited + depositAmt);
        return ((newScore - oldScore) * pesoSoldi * 1e18) / BASIS_POINTS;
    }

    /// @notice Entra nella DAO depositando ETH. Minta token proporzionali allo stake.
    function joinDAO() external payable {
        if (treasury == address(0)) revert TreasuryNotSet();
        if (isMember[msg.sender])   revert AlreadyMember();
        if (msg.value == 0)         revert ZeroDeposit();
        if (msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        uint256 tokenAmount = _calculateStakeTokens(msg.value, 0);
        if (tokenAmount == 0) revert DepositTooSmall();

        isMember[msg.sender]     = true;
        memberGrade[msg.sender]  = CompetenceGrade.Student;
        ethDeposited[msg.sender] = msg.value;

        _mint(msg.sender, tokenAmount);
        (bool ok,) = treasury.call{value: msg.value}("");
        if (!ok) revert TreasuryTransferFailed();
        emit MemberJoined(msg.sender, msg.value, tokenAmount);
    }

    /// @notice Deposita ETH aggiuntivo per aumentare lo stake (solo membri esistenti).
    function mintTokens() external payable {
        if (!isMember[msg.sender]) revert NotMember();
        if (msg.value == 0)        revert ZeroDeposit();
        if (treasury == address(0)) revert TreasuryNotSet();
        if (ethDeposited[msg.sender] + msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        uint256 newTokens = _calculateStakeTokens(msg.value, ethDeposited[msg.sender]);
        if (newTokens == 0) revert DepositTooSmall();

        ethDeposited[msg.sender] += msg.value;
        _mint(msg.sender, newTokens);
        (bool ok,) = treasury.call{value: msg.value}("");
        if (!ok) revert TreasuryTransferFailed();
        emit TokensMinted(msg.sender, msg.value, newTokens);
    }

    // =========================================================================
    //  DID
    // =========================================================================

    function registerDID(string calldata _did) external {
        if (!isMember[msg.sender]) revert NotMember();
        if (bytes(_did).length == 0) revert EmptyDID();
        if (bytes(memberDID[msg.sender]).length > 0) revert DIDAlreadyRegistered();
        bytes32 h = keccak256(bytes(_did));
        if (didToAddress[h] != address(0)) revert DIDAlreadyBound();
        memberDID[msg.sender] = _did;
        didToAddress[h]       = msg.sender;
        emit DIDRegistered(msg.sender, _did);
    }

    // =========================================================================
    //  Upgrade Competenze
    // =========================================================================

    /// @notice Upgrade legacy senza VC — solo Timelock (test/governance diretta).
    function upgradeCompetence(
        address _member,
        CompetenceGrade _newGrade,
        string calldata _proof
    ) external onlyTimelock {
        if (!isMember[_member]) revert NotMember();
        _performUpgrade(_member, _newGrade, _proof);
    }

    /// @notice Upgrade Self-Sovereign: il membro presenta la propria VC firmata EIP-712.
    function upgradeCompetenceWithVP(
        VPVerifier.VerifiableCredential memory _vc,
        bytes memory _issuerSignature
    ) external {
        if (!isMember[msg.sender]) revert NotMember();
        if (trustedIssuer == address(0)) revert TrustedIssuerNotSet();
        if (bytes(memberDID[msg.sender]).length == 0) revert NoDIDRegistered();
        if (keccak256(bytes(_vc.credentialSubject.id)) != keccak256(bytes(memberDID[msg.sender])))
            revert DIDMismatch();

        address recovered = VPVerifier.recoverIssuer(_vc, _issuerSignature, UNIVERSAL_DOMAIN_SEPARATOR);
        if (recovered != trustedIssuer) revert UntrustedIssuer();

        CompetenceGrade newGrade = _gradeFromTitle(_vc.credentialSubject.degreeTitle);
        string memory proof = string(abi.encodePacked("VP-EIP712:", _vc.issuer.id));
        _performUpgrade(msg.sender, newGrade, proof);

        emit CompetenceUpgradedWithVP(msg.sender, newGrade, uint8(newGrade), _vc.issuer.id);
    }

    // =========================================================================
    //  Logica interna upgrade
    // =========================================================================

    /*
    _performUpgrade — Cuore dell'aggiornamento competenze.

    Invariante: il grado nuovo deve avere un base-score strettamente maggiore di quello
    corrente (es. Master > Bachelor). Mosse laterali (BachelorCS→BachelorCE) sono bloccate.

    Per ogni topic t ∈ {CS, CE, EE}:
      deltaVP(t) = (skillScoreForTopic(newGrade, t) − skillScoreForTopic(oldGrade, t))
                  × pesoCompetenze × 10^18 / BASIS_POINTS
    Il delta viene sommato al checkpoint corrente dell'utente e al checkpoint globale del topic.
    */
    function _performUpgrade(
        address _member,
        CompetenceGrade _newGrade,
        string memory _proof
    ) internal {
        uint256 newBase = _gradeBaseScore(_newGrade);
        uint256 oldBase = _gradeBaseScore(memberGrade[_member]);
        if (newBase <= oldBase) revert CannotDowngrade();

        uint48 blk = clock();
        uint256[3] memory addedVP;

        for (uint256 t = 0; t < NUM_TOPICS; t++) {
            uint256 oldScore = _skillScoreForTopic(memberGrade[_member], t);
            uint256 newScore = _skillScoreForTopic(_newGrade, t);

            // newScore >= oldScore è garantito da newBase > oldBase e dalla formula
            if (newScore <= oldScore) continue;

            uint256 deltaVP = ((newScore - oldScore) * pesoCompetenze * 1e18) / BASIS_POINTS;
            if (deltaVP == 0) continue;

            addedVP[t] = deltaVP;

            uint208 u = SafeCast.toUint208(deltaVP);

            // Checkpoint per-utente
            uint208 prevUser = _skillVotesCheckpoints[_member][t].latest();
            _skillVotesCheckpoints[_member][t].push(blk, prevUser + u);

            // Checkpoint supply globale
            uint208 prevTotal = _totalSkillSupplyCheckpoints[t].latest();
            _totalSkillSupplyCheckpoints[t].push(blk, prevTotal + u);
        }

        memberGrade[_member]    = _newGrade;
        competenceProof[_member] = _proof;
        emit CompetenceUpgraded(_member, _newGrade, addedVP, _proof);
    }

    // =========================================================================
    //  Funzioni pure di supporto per i gradi
    // =========================================================================

    /// @dev Per grade > 0: topic = (g-1)/4, level = (g-1)%4
    function _gradeBaseScore(CompetenceGrade grade) internal pure returns (uint256) {
        if (grade == CompetenceGrade.Student) return 0;
        uint8 level = (uint8(grade) - 1) % LEVELS_PER_TOPIC; // 0,1,2,3
        return uint256(level + 1) * 25; // 25,50,75,100
    }

    function _gradeTopic(CompetenceGrade grade) internal pure returns (uint256) {
        if (grade == CompetenceGrade.Student) return 0; // irrilevante (score=0)
        return uint256((uint8(grade) - 1) / LEVELS_PER_TOPIC); // 0=CS,1=CE,2=EE
    }

    /// @dev Score del grado per un determinato topic (con penalità cross-topic).
    function _skillScoreForTopic(CompetenceGrade grade, uint256 topicId)
        internal pure returns (uint256)
    {
        uint256 base = _gradeBaseScore(grade);
        if (base == 0) return 0;
        if (_gradeTopic(grade) == topicId) return base;
        return base > CROSS_TOPIC_PENALTY ? base - CROSS_TOPIC_PENALTY : 0;
    }

    /// @dev Parsing degreeTitle → CompetenceGrade. Supporta suffissi CS/CE/EE.
    function _gradeFromTitle(string memory title) internal pure returns (CompetenceGrade) {
        bytes32 h = keccak256(bytes(title));
        // CS
        if (h == keccak256(bytes("BachelorCS")))  return CompetenceGrade.BachelorCS;
        if (h == keccak256(bytes("MasterCS")))    return CompetenceGrade.MasterCS;
        if (h == keccak256(bytes("PhDCS")))       return CompetenceGrade.PhDCS;
        if (h == keccak256(bytes("ProfessorCS"))) return CompetenceGrade.ProfessorCS;
        // CE
        if (h == keccak256(bytes("BachelorCE")))  return CompetenceGrade.BachelorCE;
        if (h == keccak256(bytes("MasterCE")))    return CompetenceGrade.MasterCE;
        if (h == keccak256(bytes("PhDCE")))       return CompetenceGrade.PhDCE;
        if (h == keccak256(bytes("ProfessorCE"))) return CompetenceGrade.ProfessorCE;
        // EE
        if (h == keccak256(bytes("BachelorEE")))  return CompetenceGrade.BachelorEE;
        if (h == keccak256(bytes("MasterEE")))    return CompetenceGrade.MasterEE;
        if (h == keccak256(bytes("PhDEE")))       return CompetenceGrade.PhDEE;
        if (h == keccak256(bytes("ProfessorEE"))) return CompetenceGrade.ProfessorEE;
        revert InvalidDegreeLevel();
    }

    // =========================================================================
    //  Getter pubblici skill VP (con storico a blocchi)
    // =========================================================================

    /// @notice VP-skill corrente dell'utente per il topic dato.
    function getSkillVotes(address account, uint256 topicId) public view returns (uint256) {
        if (topicId >= NUM_TOPICS) revert InvalidTopicId(topicId);
        return _skillVotesCheckpoints[account][topicId].latest();
    }

    /// @notice VP-skill storico dell'utente per il topic dato al blocco `timepoint`.
    function getPastSkillVotes(address account, uint256 topicId, uint256 timepoint)
        public view returns (uint256)
    {
        if (topicId >= NUM_TOPICS) revert InvalidTopicId(topicId);
        uint48 cur = clock();
        if (timepoint >= cur) revert ERC5805FutureLookup(timepoint, cur);
        return _skillVotesCheckpoints[account][topicId].upperLookupRecent(
            SafeCast.toUint48(timepoint)
        );
    }

    /// @notice Supply totale di skill VP per il topic dato al blocco `timepoint`.
    function getPastTotalSkillSupply(uint256 topicId, uint256 timepoint)
        public view returns (uint256)
    {
        if (topicId >= NUM_TOPICS) revert InvalidTopicId(topicId);
        uint48 cur = clock();
        if (timepoint >= cur) revert ERC5805FutureLookup(timepoint, cur);
        return _totalSkillSupplyCheckpoints[topicId].upperLookupRecent(
            SafeCast.toUint48(timepoint)
        );
    }

    // =========================================================================
    //  Getter di scoring / diagnostica
    // =========================================================================

    function getMemberGrade(address _member) external view returns (CompetenceGrade) {
        return memberGrade[_member];
    }

    /// @notice VP totale corrente dell'utente per il topic dato.
    function getScoreTotale(address _member, uint256 topicId) public view returns (uint256) {
        return balanceOf(_member) + getSkillVotes(_member, topicId);
    }

    /// @notice Score stake corrente [0-100].
    function getScoreSoldi(address _member) public view returns (uint256) {
        return getScoreSoldiForDeposit(ethDeposited[_member]);
    }

    /// @notice Score skill per un topic, basato sul grado corrente.
    function getSkillScoreForTopic(address _member, uint256 topicId)
        public view returns (uint256)
    {
        return _skillScoreForTopic(memberGrade[_member], topicId);
    }

    // =========================================================================
    //  Override richiesti da ereditarietà multipla
    // =========================================================================

    function _update(address from, address to, uint256 amount)
        internal override(ERC20, ERC20Votes)
    {
        super._update(from, to, amount);
    }

    function nonces(address owner)
        public view virtual override(ERC20Permit, Nonces) returns (uint256)
    {
        return super.nonces(owner);
    }
}
