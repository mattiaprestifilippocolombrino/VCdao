// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
Smart Contract che implementa il token ERC20 usato per votare nella DAO.
Chiunque può unirsi alla DAO chiamando joinDAO() e inviando ETH.
Per aumentare il proprio potere di voto, un membro può effettuare un UPGRADE DI COMPETENZA
presentando una Verifiable Credential (SSI).

Formula per calcolare il voting power di un membro nella nuova versione multi-topic:
    VP_totale(account, topic) = VP_stake(account) + VP_skill(account, topic)

dove:
    VP_stake = componente economica, uguale per tutti i topic, derivata dai token ERC20Votes
            mintati quando il membro deposita ETH con joinDAO() o increaseStake().
    VP_skill = componente competenze, diversa per ogni topic della proposta, 
    calcolata al momento dell'upgrade competenze via VC e salvata in checkpoint.

La componente economica riprende la formula:
   scoreStake = min(stakeDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100]
   VP_stake = weightStake × scoreStake

La componente competenze riprende la logica degli score accademici:
   scoreCompetenze ∈ {0, 25, 50, 75, 100} a secondo del grado accademico presente nella VC e dal topic della votazione
   Student=0, Bachelor=25, Master=50, PhD=75, Professor=100
   VP_skill = weightSkill × scoreSkill

Novità rispetto alla versione precedente:
Il grado accademico ora contiene anche il topic: CS, CE o EE.
Se il topic del grado coincide con il topic della proposta, lo score è pieno.
Se il topic è diverso, si applica CROSS_TOPIC_PENALTY = 25.

Esempi:
   ProfessorCS su proposta CS → scoreCompetenze = 100
   ProfessorCS su proposta CE → scoreCompetenze = 75
   BachelorCS  su proposta EE → scoreCompetenze = 0

I pesi weightSkill e weightStake sono configurabili al deploy del Token e la loro somma deve essere 
uguale a 10.000 basis points, cioè il 100%.
*/

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "./VPVerifier.sol";

/*
Il token eredita ERC20 per le funzionalità base del token (transfer, balanceOf, ecc.),
 e ERC20Votes per la gestione del potere di voto nella DAO, con checkpoint basati sul
blocco di inizio votazione e delega del potere di voto.

La parte competenze non viene mintata come balance ERC20, ma ogni utente ha un checkpoint che salva
il VP skill per ogni diverso topic di voto. 
*/

contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes {
    using Checkpoints for Checkpoints.Trace208;

    // =========================================================================
    //  Costanti Topic
    // =========================================================================

    /// Identificativi dei topic gestiti dalla DAO.
    /// Devono essere contigui e partire da 0 perché vengono usati come indici
    /// nei mapping dei checkpoint skill e negli array restituiti dagli eventi.
    uint256 public constant TOPIC_CS = 0;
    uint256 public constant TOPIC_CE = 1;
    uint256 public constant TOPIC_EE = 2;
    uint256 public constant NUM_TOPICS = 3;

    /// Penalità che viene applicata (in punti score) quando la competenza non corrisponde al topic.
    uint256 public constant CROSS_TOPIC_PENALTY = 25;

    /// Numero di livelli utili per il calcolo del VP derivato da skill (Bachelor, Master, PhD, Professor).
    uint8 private constant LEVELS_PER_TOPIC = 4;

    // =========================================================================
    //  Costanti DAO
    // =========================================================================

    //Deposito massimo per membro: 100 ETH
    uint256 public constant MAX_DEPOSIT = 100 ether;

    /// Massimo livello accademico supportato: 4 = Professor.
    uint8 public constant MAX_DEGREE_LEVEL = 4;

    /// Denominatore basis points per effettuare i calcoli in %, che rappresenta il 100% = 10.000 bp.
    uint256 public constant BASIS_POINTS = 10_000;

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

    //  Enumerazione che rappresenta i gradi di competenza.
    //  Ogni grado, tranne Student, è specializzato per topic:
    //      CS = Computer Science, CE = Computer Engineering, EE = Electronic Engineering.
    //  Mapping numerico: grade g (g > 0) -> topic = (g-1)/4, level = (g-1)%4
    //  level 0 -> Bachelor(25), 1 -> Master(50), 2 -> PhD(75), 3 -> Professor(100)

    enum CompetenceGrade {
        Student, // 0
        BachelorCS, // 1  (topic 0, level 0, score 25)
        MasterCS, // 2  (topic 0, level 1, score 50)
        PhDCS, // 3  (topic 0, level 2, score 75)
        ProfessorCS, // 4  (topic 0, level 3, score 100)
        BachelorCE, // 5  (topic 1, level 0, score 25)
        MasterCE, // 6  (topic 1, level 1, score 50)
        PhDCE, // 7  (topic 1, level 2, score 75)
        ProfessorCE, // 8  (topic 1, level 3, score 100)
        BachelorEE, // 9  (topic 2, level 0, score 25)
        MasterEE, // 10 (topic 2, level 1, score 50)
        PhDEE, // 11 (topic 2, level 2, score 75)
        ProfessorEE // 12 (topic 2, level 3, score 100)
    }

    //  Stato immutabile / configurabile

    /// Peso della componente skill nella formula del voting power, espresso in basis points.
    uint256 public immutable weightSkill;

    /// Peso della componente stake nella formula del voting power, espresso in basis points.
    uint256 public immutable weightStake;

    /// Indirizzo del TimelockController, cioè l'esecutore delle decisioni di governance.
    address public immutable timelock;

    /// Indirizzo del deployer, cioè la il token, usato solo per il setup iniziale.
    address public immutable deployer;

    /// Indirizzo del Treasury a cui vengono inoltrati gli ETH depositati dai membri.
    address public treasury;

    /// Issuer attendibile dal contratto che firma le Verifiable Credential con i gradi di competenza dei membri.
    address public trustedIssuer;

    //  Stato per membro

    /// Mapping che tiene traccia di quanti ETH ha depositato ogni membro.
    mapping(address => uint256) public stakeDeposited;

    /// Mappa che associa ad ogni membro il suo grado di competenza.
    mapping(address => CompetenceGrade) public memberGrade;

    /// Mappa che tiene traccia degli indirizzi membri della DAO.
    mapping(address => bool) public isMember;

    /// Mappa che tiene traccia per ogni utente della proof dell'upgrade piu recente.
    mapping(address => string) public skillProof;

    /// Mappa che associa ogni membro al suo DID. Viene usato per verificare coerenza identitaria durante upgrade via VC.
    mapping(address => string) public memberDID;

    /// Mappa che associa ogni DID al suo indirizzo, per garantire l'unicita dei DID nella DAO.
    mapping(bytes32 => address) public didToAddress;

    /*
    Rispetto alla vecchia versione non serve più inizializzare un mapping competenceScore:
    lo score del grado viene ricavato dalla posizione dell'enum tramite _gradeBaseScore()
    e poi adattato al topic tramite _skillScoreForTopic().
    */

    // Checkpoint skill per topic

    //  _skillVotesCheckpoints[account][topicId]
    // storico cumulativo del voting power derivato da skill dell'utente, per quel determinato topic.
    // Associa l'indirizzo di un membro, al mapping che va dal topicId al voting power relativo.
    mapping(address => mapping(uint256 => Checkpoints.Trace208))
        private _skillVotesCheckpoints;

    //  _totalSkillSupplyCheckpoints[topicId]:
    //  Tiene traccia della somma cumulativa di tutti i VP-skill emessi per quel topic, per tutti gli utenti.
    // Associa il topicId al voting power da skill totale accumulato.
    mapping(uint256 => Checkpoints.Trace208)
        private _totalSkillSupplyCheckpoints;

    //  Eventi

    /// Emesso quando un nuovo address entra nella DAO depositando ETH.
    event MemberJoined(
        address indexed member,
        uint256 stakeAmount,
        uint256 stakeTokensMinted
    );

    /// Emesso quando un membro già registrato aumenta il proprio stake economico.
    event StakeIncreased(
        address indexed member,
        uint256 stakeAmount,
        uint256 stakeTokensMinted
    );

    /// Emesso a ogni upgrade di competenza.
    /// skillVPPerTopic contiene il VP skill aggiunto per CS, CE ed EE.
    event SkillUpgraded(
        address indexed member,
        CompetenceGrade newGrade,
        uint256[3] skillVPPerTopic,
        string proof
    );

    /// Emesso quando l'upgrade è stato ottenuto verificando una VC EIP-712.
    event SkillUpgradedWithVC(
        address indexed member,
        CompetenceGrade newGrade,
        uint8 degreeLevel,
        string issuerDid
    );

    /// Emesso quando un membro registra il proprio DID.
    event DIDRegistered(address indexed member, string did);

    /// Emesso quando viene configurato o aggiornato il trusted issuer.
    event TrustedIssuerSet(address indexed issuer);

    // =========================================================================
    //  Errori
    // =========================================================================

    error OnlyTimelock(); // Chiamante diverso dal TimelockController.
    error OnlyDeployer(); // Chiamante diverso dal deployer nel setup iniziale.
    error AlreadyMember(); // L'address è già membro della DAO.
    error NotMember(); // L'address non è ancora membro della DAO.
    error ZeroDeposit(); // Deposito ETH nullo.
    error ExceedsMaxDeposit(); // Deposito cumulativo oltre MAX_DEPOSIT.
    error CannotDowngrade(); // Upgrade nullo, downgrade o cambio laterale non consentito.
    error ZeroAddress(); // Address zero non valido.
    error TreasuryNotSet(); // Treasury non configurato.
    error TreasuryAlreadySet(); // Treasury già configurato nel bootstrap.
    error TreasuryTransferFailed(); // Inoltro ETH al Treasury fallito.
    error InvalidWeights(); // weightSkill + weightStake diverso da BASIS_POINTS.
    error DepositTooSmall(); // Deposito troppo piccolo: produrrebbe 0 token.
    error DIDAlreadyRegistered(); // Il membro ha già registrato un DID.
    error DIDAlreadyBound(); // Il DID è già associato a un altro address.
    error NoDIDRegistered(); // Il membro non ha ancora registrato un DID.
    error DIDMismatch(); // DID della VC diverso dal DID registrato dal membro.
    error UntrustedIssuer(); // VC firmata da un issuer non autorizzato.
    error InvalidDegreeLevel(); // Titolo della VC non mappabile in un grado supportato.
    error TrustedIssuerNotSet(); // Trusted issuer non ancora configurato.
    error EmptyDID(); // DID vuoto.
    error InvalidTopicId(uint256 topicId); // Topic fuori dal range [0, NUM_TOPICS).
    error InvalidGrade(); // Enum grade fuori dal range supportato.

    //  Modifier

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

    //  Costruttore

    /*
    Costruttore che prende come input l'indirizzo del TimelockController della DAO,
    il peso delle competenze e il peso dello stake economico.
    Inizializza il token, l'indirizzo del timelock e del deployer, imposta weightSkill
    e weightStake e verifica che la somma dei pesi sia 10.000 basis points.
    */
    constructor(
        address _timelock,
        uint256 _weightSkill,
        uint256 _weightStake
    ) ERC20("CompetenceDAO Token", "COMP") ERC20Permit("CompetenceDAO Token") {
        if (_timelock == address(0)) revert ZeroAddress();
        if (_weightSkill + _weightStake != BASIS_POINTS)
            revert InvalidWeights();
        timelock = _timelock;
        deployer = msg.sender;
        weightSkill = _weightSkill;
        weightStake = _weightStake;
    }

    // =========================================================================
    //  Setup
    // =========================================================================

    /*  Funzione di setup one shot che Imposta l'indirizzo del Treasury. 
        Prende in input l'indirizzo del treasury e può essere chiamata una sola volta, solo dal deployer.
        È necessaria perché il Treasury viene deployato dopo il GovernanceToken.
    */
    function setTreasury(address _treasury) external onlyDeployer {
        if (treasury != address(0)) revert TreasuryAlreadySet();
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    /* Funzione che configura l'issuer fidato, che firma le VC riconosciute dal contratto. 
       Il deployer può impostarlo solo al primo setup. 
       Dopo la prima configurazione, solo la governance (timelock) può cambiarlo.
    */
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

    //  Funzioni di Stake
    // =========================================================================

    //Funzione di utility che calcola scoreStake = min(deposited / MAX_DEPOSIT, 1) × 100 ∈ [0, 100]
    function getStakeScoreForDeposit(
        uint256 deposited
    ) public pure returns (uint256) {
        if (deposited >= MAX_DEPOSIT) return 100;
        return (deposited * 100) / MAX_DEPOSIT;
    }

    /*
    Funzione che calcola i token da mintare per la componente stake della formula VPC.
    Si calcola weightStake × ΔscoreStake (solo l'incremento dello score)
    dove scoreStake = min(stakeDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100].
    Prende il vecchio score, il nuovo score, effettua la differenza e moltiplica
    per weightStake, calcolando i token da mintare. Il risultato è in wei (× 10^18).

    Es: weightStake=5000 bp, previousDeposit=5 ETH, depositAmount=3 ETH:
        oldScore=5, newScore=8, ΔscoreStake=3
        token = (3 × 5000 × 10^18) / 10000 = 1.5 × 10^18 token
    */
    function _calculateStakeTokens(
        uint256 depositAmount,
        uint256 previousDeposit
    ) internal view returns (uint256) {
        uint256 oldScore = getStakeScoreForDeposit(previousDeposit);
        uint256 newScore = getStakeScoreForDeposit(
            previousDeposit + depositAmount
        );
        uint256 scoreDiff = newScore - oldScore; // ΔscoreSoldi ∈ [0, 100]
        return (scoreDiff * weightStake * 1e18) / BASIS_POINTS;
    }

    /* Funzione usata dagli utenti per entrare nella DAO, chiamabile da chiunque, senza passare da una proposal.
       Può essere chiamata solo dagli utenti che non sono ancora membri della DAO. Controlla che il treasury abbia
       un indirizzo assegnato, che il deposito effettuato sia superiore a 0 e inferiore al deposito massimo consentito.
       Calcola il numero di token da ricevere in base al deposito effettuato via formula VPC. weightStake × scoreStake, usando le funzioni di utility precedenti.
       Imposta il nuovo membro come attivo, con grado minimo Student e viene registrato il deposito effettuato.
       I token vengono mintati e inviati al membro. La funzione trasferisce gli ETH ricevuti direttamente al treasury.
    */
    function joinDAO() external payable {
        if (treasury == address(0)) revert TreasuryNotSet();
        if (isMember[msg.sender]) revert AlreadyMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        uint256 tokenAmount = _calculateStakeTokens(msg.value, 0);
        if (tokenAmount == 0) revert DepositTooSmall();

        isMember[msg.sender] = true;
        memberGrade[msg.sender] = CompetenceGrade.Student;
        stakeDeposited[msg.sender] = msg.value;

        _mint(msg.sender, tokenAmount);
        (bool ok, ) = treasury.call{value: msg.value}("");
        if (!ok) revert TreasuryTransferFailed();
        emit MemberJoined(msg.sender, msg.value, tokenAmount);
    }

    /* Funzione che minta i token successivamente all'ingresso del membro nella DAO, depositando ETH.
       La funzione controlla che il membro sia effettivamente un membro della DAO, che il treasury abbia un indirizzo assegnato
       e che il deposito inviato sia superiore a 0.
       Controlla che gli ETH depositati dal membro sommati a quelli che sta per depositare non superino MAX_DEPOSIT.
       Calcola il numero di token da ricevere in base al deposito effettuato via formula VPC, usando le funzioni di utility precedenti.
       Calcola i nuovi token in base solo all'incremento dello score stake e tiene conto degli ETH già depositati.
       Viene aggiornato il conto degli ETH depositati dall'utente. Vengono mintati i token.
       Gli ETH vengono trasferiti direttamente al Treasury.
    */
    function increaseStake() external payable {
        if (!isMember[msg.sender]) revert NotMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (treasury == address(0)) revert TreasuryNotSet();
        if (stakeDeposited[msg.sender] + msg.value > MAX_DEPOSIT)
            revert ExceedsMaxDeposit();

        uint256 newTokens = _calculateStakeTokens(
            msg.value,
            stakeDeposited[msg.sender]
        );
        if (newTokens == 0) revert DepositTooSmall();

        stakeDeposited[msg.sender] += msg.value;
        _mint(msg.sender, newTokens);
        (bool ok, ) = treasury.call{value: msg.value}("");
        if (!ok) revert TreasuryTransferFailed();
        emit StakeIncreased(msg.sender, msg.value, newTokens);
    }

    // =========================================================================
    //  DID
    // =========================================================================

    /*  Funzione per la registrazione del DID di un membro. Un membro puo registrare un solo DID
        e lo stesso DID non puo essere usato da due address.
        Verifica che il msg.sender sia un membro della DAO e che non abbia gia registrato un DID.
        Effettua l'hash del DID, controlla che non sia già stato registrato. 
        In tal caso, registra nei mapping le associazioni address -> DID e DID -> address.
    */
    function registerDID(string calldata _did) external {
        if (!isMember[msg.sender]) revert NotMember();
        if (bytes(_did).length == 0) revert EmptyDID();
        if (bytes(memberDID[msg.sender]).length > 0)
            revert DIDAlreadyRegistered();
        bytes32 h = keccak256(bytes(_did));
        if (didToAddress[h] != address(0)) revert DIDAlreadyBound();
        memberDID[msg.sender] = _did;
        didToAddress[h] = msg.sender;
        emit DIDRegistered(msg.sender, _did);
    }

    // Funzioni di Upgrade Skill

    /* Funzione legacy, usata per i test, in cui un membro esegue l'upgrade di competenza senza verifica VC, passando un grado di competenza
        e una proof testuale. Solo il timelock puo chiamare questa funzione.
    */
    function upgradeSkill(
        address _member,
        CompetenceGrade _newGrade,
        string calldata _proof
    ) external onlyTimelock {
        if (!isMember[_member]) revert NotMember();
        _performUpgrade(_member, _newGrade, _proof);
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
    Costruisce una stringa proof sintetica persistita on-chain. 
    Esegue l'aggiornamento del grado del membro, tramite la funzione _performUpgrade, senza passare dalla governance.
    */

    function upgradeSkillWithVC(
        VPVerifier.VerifiableCredential memory _vc,
        bytes memory _issuerSignature
    ) external {
        if (!isMember[msg.sender]) revert NotMember();
        if (trustedIssuer == address(0)) revert TrustedIssuerNotSet();
        if (bytes(memberDID[msg.sender]).length == 0) revert NoDIDRegistered();
        if (
            keccak256(bytes(_vc.credentialSubject.id)) !=
            keccak256(bytes(memberDID[msg.sender]))
        ) revert DIDMismatch();

        address recovered = VPVerifier.recoverIssuer(
            _vc,
            _issuerSignature,
            UNIVERSAL_DOMAIN_SEPARATOR
        );
        if (recovered != trustedIssuer) revert UntrustedIssuer();

        CompetenceGrade newGrade = _gradeFromTitle(
            _vc.credentialSubject.degreeTitle
        );
        string memory proof = string(
            abi.encodePacked("VP-EIP712:", _vc.issuer.id)
        );
        _performUpgrade(msg.sender, newGrade, proof);

        emit SkillUpgradedWithVC(
            msg.sender,
            newGrade,
            uint8(newGrade),
            _vc.issuer.id
        );
    }

    //  Funzioni di utility per upgrade competenze

    /*
    Funzione che aggiunge il voting power da skill aggiuntivo per un dato topic
    ai checkpoint del membro e alla supply totale del topic.
    I checkpoint permettono al Governor di leggere il Voting power storico derivato da skill al blocco di snapshot
    della proposta, evitando che upgrade successivi modifichino votazioni già iniziate.
    La funzione casta il delta passato. Poi crea un record sui checkpoint del membro e del topic, 
    settandoli al timepoint passato come paramentro, e all'ultimo valore del checkpoint sommato al delta da aggiungere.
    Entrambi i record vengono concatenati via push ai due checkpoint.
    */
    function _addSkillVotes(
        address account,
        uint256 topicId,
        uint256 deltaVP,
        uint48 checkpointKey
    ) internal {
        uint208 delta = SafeCast.toUint208(deltaVP);

        Checkpoints.Trace208 storage userTrace = _skillVotesCheckpoints[
            account
        ][topicId];
        userTrace.push(checkpointKey, userTrace.latest() + delta);

        Checkpoints.Trace208 storage totalTrace = _totalSkillSupplyCheckpoints[
            topicId
        ];
        totalTrace.push(checkpointKey, totalTrace.latest() + delta);
    }

    /// Controlla che il topic richiesto esista.
    function _validateTopicId(uint256 topicId) internal pure {
        if (topicId >= NUM_TOPICS) revert InvalidTopicId(topicId);
    }

    // =========================================================================
    //  Funzioni pure di supporto per i gradi
    // =========================================================================

    /*
    Restituisce lo score base del grado, indipendente dal topic.
    Student vale 0; Bachelor, Master, PhD e Professor valgono rispettivamente
    25, 50, 75 e 100.
    */
    function _gradeBaseScore(
        CompetenceGrade grade
    ) internal pure returns (uint256) {
        if (uint8(grade) > uint8(CompetenceGrade.ProfessorEE))
            revert InvalidGrade();
        if (grade == CompetenceGrade.Student) return 0;
        uint8 level = (uint8(grade) - 1) % LEVELS_PER_TOPIC; // 0,1,2,3
        return uint256(level + 1) * 25; // 25,50,75,100
    }

    /*
    Ricava il topic nativo del grado.
    Per esempio BachelorCS, MasterCS, PhDCS e ProfessorCS ritornano TOPIC_CS.
    Student non ha un topic reale, ma ritorna 0 perché il suo score è sempre 0.
    */
    function _gradeTopic(
        CompetenceGrade grade
    ) internal pure returns (uint256) {
        if (uint8(grade) > uint8(CompetenceGrade.ProfessorEE))
            revert InvalidGrade();
        if (grade == CompetenceGrade.Student) return 0; // irrilevante (score=0)
        return uint256((uint8(grade) - 1) / LEVELS_PER_TOPIC); // 0=CS,1=CE,2=EE
    }

    /*
    Funzione che calcola lo score skill di un grado di competenza passato in input rispetto a un topic specifico.
    Se il topic della proposta coincide con quello del grado, usa lo score pieno.
    Se invece il topic è diverso, applica CROSS_TOPIC_PENALTY.
    */
    function _skillScoreForTopic(
        CompetenceGrade grade,
        uint256 topicId
    ) internal pure returns (uint256) {
        uint256 base = _gradeBaseScore(grade);
        if (base == 0) return 0;
        if (_gradeTopic(grade) == topicId) return base;
        return base > CROSS_TOPIC_PENALTY ? base - CROSS_TOPIC_PENALTY : 0;
    }

    /*
    Parser semantico che ritorna l'enum del grado di competenza a partire dalla
    stringa del titolo di studio contenuta nella VC.
    Nella vecchia versione erano supportati BachelorDegree, MasterDegree, PhD, Professor.
    Nella nuova versione i titoli devono includere anche il topic:
        BachelorCS, MasterCE, PhDEE, ProfessorEE, ecc.
    Usa hash per confronto stringhe gas-efficient.
    */
    function _gradeFromTitle(
        string memory title
    ) internal pure returns (CompetenceGrade) {
        bytes32 h = keccak256(bytes(title));
        // CS
        if (h == keccak256(bytes("BachelorCS")))
            return CompetenceGrade.BachelorCS;
        if (h == keccak256(bytes("MasterCS"))) return CompetenceGrade.MasterCS;
        if (h == keccak256(bytes("PhDCS"))) return CompetenceGrade.PhDCS;
        if (h == keccak256(bytes("ProfessorCS")))
            return CompetenceGrade.ProfessorCS;
        // CE
        if (h == keccak256(bytes("BachelorCE")))
            return CompetenceGrade.BachelorCE;
        if (h == keccak256(bytes("MasterCE"))) return CompetenceGrade.MasterCE;
        if (h == keccak256(bytes("PhDCE"))) return CompetenceGrade.PhDCE;
        if (h == keccak256(bytes("ProfessorCE")))
            return CompetenceGrade.ProfessorCE;
        // EE
        if (h == keccak256(bytes("BachelorEE")))
            return CompetenceGrade.BachelorEE;
        if (h == keccak256(bytes("MasterEE"))) return CompetenceGrade.MasterEE;
        if (h == keccak256(bytes("PhDEE"))) return CompetenceGrade.PhDEE;
        if (h == keccak256(bytes("ProfessorEE")))
            return CompetenceGrade.ProfessorEE;
        revert InvalidDegreeLevel();
    }

    /*
    Funzione di upgrade di competenza, che si occupa di effettuare nella DAO le modifiche
    dopo che la VC è stata verificata (oppure dopo che il Timelock ha autorizzato
    l'upgrade legacy).

    La funzione calcola il vecchio e il nuovo punteggio base di competenza del membro.
    Il nuovo grado deve avere uno score base strettamente maggiore del precedente:
    downgrade, upgrade nullo e mosse laterali come BachelorCS -> BachelorCE sono bloccate.

    La componente skill viene aggiunta ai checkpoint skill per ciascun topic.
    Per ogni topic t ∈ {CS, CE, EE}:
        deltaVP(t) =
            (skillScoreForTopic(newGrade, t) - skillScoreForTopic(oldGrade, t))
            × weightSkill × 10^18 / BASIS_POINTS
    Il delta viene sommato al checkpoint corrente dell'utente e al checkpoint globale
    del topic, così il Governor può leggere VP e supply storici al blocco di snapshot.
    Aggiorna il grado del membro e inserisce la proof di competenza on-chain.

    */

    function _performUpgrade(
        address _member,
        CompetenceGrade _newGrade,
        string memory _proof
    ) internal {
        CompetenceGrade oldGrade = memberGrade[_member];
        uint256 newBase = _gradeBaseScore(_newGrade);
        uint256 oldBase = _gradeBaseScore(oldGrade);
        if (newBase <= oldBase) revert CannotDowngrade();

        uint48 blk = clock();
        uint256[3] memory addedVP;

        for (uint256 t = 0; t < NUM_TOPICS; t++) {
            uint256 oldScore = _skillScoreForTopic(oldGrade, t);
            uint256 newScore = _skillScoreForTopic(_newGrade, t);

            // newScore >= oldScore è garantito da newBase > oldBase e dalla formula
            if (newScore <= oldScore) continue;
            uint256 scoreDiff = newScore - oldScore; // ΔscoreSoldi ∈ [0, 100]
            uint256 deltaVP = (scoreDiff * weightSkill * 1e18) / BASIS_POINTS;
            if (deltaVP == 0) continue;
            addedVP[t] = deltaVP;
            _addSkillVotes(_member, t, deltaVP, blk);
        }

        memberGrade[_member] = _newGrade;
        skillProof[_member] = _proof;
        emit SkillUpgraded(_member, _newGrade, addedVP, _proof);
    }

    //  Getter pubblici checkpoint skill voting power

    /// Restituisce il VP skill corrente dell'utente per il topic dato.
    function getSkillVotes(
        address account,
        uint256 topicId
    ) public view returns (uint256) {
        _validateTopicId(topicId);
        return _skillVotesCheckpoints[account][topicId].latest();
    }

    /*
    Restituisce il VP skill storico dell'utente al blocco indicato.
    È la funzione usata dal Governor durante il voto, perché ogni proposta deve usare
    il potere di voto cristallizzato allo snapshot e non quello corrente.
    */
    function getPastSkillVotes(
        address account,
        uint256 topicId,
        uint256 timepoint
    ) public view returns (uint256) {
        _validateTopicId(topicId);
        uint48 cur = clock();
        if (timepoint >= cur) revert ERC5805FutureLookup(timepoint, cur);
        return
            _skillVotesCheckpoints[account][topicId].upperLookupRecent(
                SafeCast.toUint48(timepoint)
            );
    }

    /// Restituisce la supply totale corrente di VP skill per il topic dato.
    function getTotalSkillSupply(
        uint256 topicId
    ) public view returns (uint256) {
        _validateTopicId(topicId);
        return _totalSkillSupplyCheckpoints[topicId].latest();
    }

    /*
    Restituisce la supply totale storica di VP skill per un topic.
    Serve al Governor per calcolare quorum e superquorum topic-specifici al blocco
    di snapshot della proposta.
    */
    function getPastTotalSkillSupply(
        uint256 topicId,
        uint256 timepoint
    ) public view returns (uint256) {
        _validateTopicId(topicId);
        uint48 cur = clock();
        if (timepoint >= cur) revert ERC5805FutureLookup(timepoint, cur);
        return
            _totalSkillSupplyCheckpoints[topicId].upperLookupRecent(
                SafeCast.toUint48(timepoint)
            );
    }

    //  Getter di scoring / diagnostica

    /// Getter semplice del grado corrente del membro.
    function getMemberGrade(
        address _member
    ) external view returns (CompetenceGrade) {
        return memberGrade[_member];
    }

    /*
    Calcola il voting power totale corrente del membro per un topic.
        VP_totale = balanceOf(membro) + getSkillVotes(membro, topicId)
    */
    function getVotingPowerForTopic(
        address _member,
        uint256 topicId
    ) public view returns (uint256) {
        return balanceOf(_member) + getSkillVotes(_member, topicId);
    }

    /// Restituisce lo score stake corrente del membro nel range [0, 100].
    function getStakeScore(address _member) public view returns (uint256) {
        return getStakeScoreForDeposit(stakeDeposited[_member]);
    }

    /// Restituisce lo score skill del membro per un topic, basato sul grado corrente.
    function getSkillScoreForTopic(
        address _member,
        uint256 topicId
    ) public view returns (uint256) {
        return _skillScoreForTopic(memberGrade[_member], topicId);
    }

    // =========================================================================
    //  Override richiesti da ereditarietà multipla
    //
    //  ERC20Votes ed ERC20Permit ereditano funzioni comuni da OpenZeppelin.
    //  Solidity richiede questi override espliciti per risolvere i conflitti
    //  e mantenere corretta la logica dei checkpoint di voto.
    // =========================================================================

    function _update(
        address from,
        address to,
        uint256 amount
    ) internal override(ERC20, ERC20Votes) {
        super._update(from, to, amount);
    }

    function nonces(
        address owner
    ) public view virtual override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
