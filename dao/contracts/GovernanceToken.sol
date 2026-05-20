// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "./VPVerifier.sol";
import "./ISkillCalculator.sol";


/*
Smart Contract che implementa il token ERC20 usato per votare nella DAO, salva le skill certificate da VC dei membri,
e storicizza il voting power derivato da skill, per ogni topic di voto, usando Checkpoints.
Chiunque può unirsi alla DAO chiamando joinDAO() e inviando ETH.
Per aumentare il proprio potere di voto, un membro può effettuare un UPGRADE DI COMPETENZA
presentando una Verifiable Credential che certifica le skills di un utente.
Ogni votazione ha un topic, e per ogni topic le skill valgono in modo diverso.

Formula per calcolare il voting power di un membro:
    VP_totale(account, topic) = VP_stake(account) + VP_skill(account, topic)

dove:
    VP_stake = componente economica, uguale per tutti i topic, derivata dai token ERC20Votes
            mintati quando il membro deposita ETH con joinDAO() o increaseStake().
    VP_skill = componente competenze, diversa per ogni topic della proposta, 
    calcolata al momento dell'upgrade competenze via VC e salvata in checkpoint.

La componente economica riprende la formula:
   scoreStake = min(stakeDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100]
   VP_stake = weightStake × scoreStake

La componente skill usa la formula: 
VP_skill(account, topic) = weightSkill × scoreSkills
Lo score delle skills di un utente viene calcolato in un contratto esterno, che implementa l'interfaccia ISkillCalculator.
Una DAO può sovrascrivere e calcolare in modo diverso il voting power derivato da skill.

I pesi weightSkill e weightStake sono configurabili al deploy del Token e la loro somma deve essere 
uguale a 10.000 basis points, cioè il 100%. Possono essere cambiati via proposal.
*/


/*
Il token eredita ERC20 per le funzionalità base del token (transfer, balanceOf, ecc.),
 e ERC20Votes per la gestione del potere di voto nella DAO, con checkpoint basati sul
blocco di inizio votazione e delega del potere di voto.

La parte competenze non viene mintata come balance ERC20, ma ogni utente ha un checkpoint che salva
il VP skill per ogni diverso topic di voto. 
*/


contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes {
    using Checkpoints for Checkpoints.Trace208;

  
    //  Costanti DAO
    
    uint256 public constant MAX_DEPOSIT = 100 ether;    //Deposito massimo per membro: 100 ETH
    uint256 public constant BASIS_POINTS = 10_000;      /// Denominatore basis points per effettuare i calcoli in %, che rappresenta il 100% = 10.000 bp.

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



    //  Stato configurabile

    uint256 public weightSkill;     // Peso della componente skill nella formula del voting power, espresso in basis points.
    uint256 public weightStake;     // Peso della componente stake nella formula del voting power, espresso in basis points.

    // Timelock e deployer non cambiano mai dopo il deploy.
    // Il deployer serve solo per il bootstrap iniziale; poi le modifiche passano dal Timelock.
    address public immutable timelock;      /// Indirizzo del TimelockController, cioè l'esecutore delle decisioni di governance.
    address public immutable deployer;      /// Indirizzo del deployer, cioè la il token, usato solo per il setup iniziale.

    address public treasury;       // Indirizzo del Treasury a cui vengono inoltrati gli ETH depositati dai membri.

    
    mapping(address => bool) public trustedIssuers;  // Issuer attendibili dal contratto che firmano le Verifiable Credential contenenti le skill dei membri.
    uint256 public trustedIssuerCount;


    ISkillCalculator public skillCalculator;   // Contratto esterno che calcola lo score skill per topic. Implementa l'intefaccia ISkillCulculator.


    //  Stato per membro

    mapping(address => uint256) public stakeDeposited;  // Mapping che tiene traccia di quanti ETH ha depositato ogni membro.
    mapping(address => bool) public isMember;       // Mappa che tiene traccia degli indirizzi membri della DAO.
    mapping(address => string) public memberDID;    // Mappa che associa ogni membro al suo DID. Viene usato per verificare coerenza identitaria durante upgrade via VC.
    mapping(bytes32 => address) public didToAddress;        // Mappa che associa ogni DID al suo indirizzo, per garantire l'unicita dei DID nella DAO.
    
    mapping(address => bytes32[]) public memberSkills;  // Mappa che associa ad ogni membro le sue skills, sottoforma di hash. L'uso di hash evita stringhe nello storage e rende il confronto piu' economico.


    // Checkpoint skill per topic

    //  _skillVotesCheckpoints[account][topicId]
    // storico cumulativo del voting power derivato da skill dell'utente, per quel determinato topic.
    // Associa l'indirizzo di un membro, al mapping che va dal topicId al voting power relativo.
    mapping(address => mapping(uint256 => Checkpoints.Trace208)) private _skillVotesCheckpoints;

    //  _totalSkillSupplyCheckpoints[topicId]:
    //  Tiene traccia della somma cumulativa di tutti i VP-skill emessi per quel topic, per tutti gli utenti.
    // Associa il topicId al voting power da skill totale accumulato.
    mapping(uint256 => Checkpoints.Trace208) private _totalSkillSupplyCheckpoints;


    //  Eventi

    event MemberJoined(address indexed member, uint256 stakeAmount, uint256 stakeTokensMinted);
    event StakeIncreased(address indexed member, uint256 stakeAmount, uint256 stakeTokensMinted);
    event SkillUpgradedWithVC(address indexed member, string issuerDid);
    event SkillUpgraded(address indexed member, string proof);
    event DIDRegistered(address indexed member, string did);
    event TrustedIssuerAdded(address indexed issuer);
    event TrustedIssuerRemoved(address indexed issuer);
    event SkillCalculatorSet(address indexed calculator);
    event WeightsUpdated(uint256 weightSkill, uint256 weightStake);
    event MemberSkillsMerged(address indexed member, uint256 addedSkills, uint256 totalSkills);


    //  Errori

    error OnlyTimelock();
    error OnlyDeployer();
    error AlreadyMember();
    error NotMember();
    error ZeroDeposit();
    error ExceedsMaxDeposit();
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
    error TrustedIssuerNotSet();
    error TrustedIssuerAlreadySet();
    error CannotRemoveLastTrustedIssuer();
    error EmptyDID();
    error InvalidTopicId(uint256 topicId);
    error CalculatorNotSet();
    error NotAContract();
    error InvalidCalculator();

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
        if (_weightSkill + _weightStake != BASIS_POINTS) revert InvalidWeights();

        // Pesi e timelock sono configurati al deploy. I pesi potranno poi cambiare solo via governance.
        timelock = _timelock;
        deployer = msg.sender;
        weightSkill = _weightSkill;
        weightStake = _weightStake;
    }


    //  Setup & Settings

    /*  Funzione di setup one shot che Imposta l'indirizzo del Treasury. 
        Prende in input l'indirizzo del treasury e può essere chiamata una sola volta, solo dal deployer.
        È necessaria perché il Treasury viene deployato dopo il GovernanceToken.
    */
    function setTreasury(address _treasury) external onlyDeployer {
        if (treasury != address(0)) revert TreasuryAlreadySet();
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
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
        Imposta il calcolatore delle skill, che implementa l'intefaccia ISkillCalculator.
        Controlla che l'indirizzo sia un contratto e che esponga almeno un set coerente di topic.
    */
    function setSkillCalculator(address _calculator) external {
        if (_calculator == address(0)) revert ZeroAddress();
        if (address(skillCalculator) == address(0)) {
            if (msg.sender != deployer) revert OnlyDeployer();
        } else {
            if (msg.sender != timelock) revert OnlyTimelock();
        }

        if (_calculator.code.length == 0) revert NotAContract();
        ISkillCalculator candidate = ISkillCalculator(_calculator);
        uint256[] memory topics = candidate.getSupportedTopics();
        if (topics.length == 0) revert InvalidCalculator();
        for (uint256 i = 0; i < topics.length; i++) {
            if (!candidate.isValidTopic(topics[i])) revert InvalidCalculator();
        }
        skillCalculator = candidate;
        emit SkillCalculatorSet(_calculator);
    }

    // Aggiornamento dei pesi skill e stake, via governance.
    // La somma deve restare 100%, espressa in basis points.
    function setWeights(uint256 _weightSkill, uint256 _weightStake) external onlyTimelock {
        if (_weightSkill + _weightStake != BASIS_POINTS) revert InvalidWeights();
        weightSkill = _weightSkill;
        weightStake = _weightStake;
        emit WeightsUpdated(_weightSkill, _weightStake);
    }

    // La validazione dei topic e' delegata al calcolatore corrente.
    function isValidTopic(uint256 topicId) public view returns (bool) {
        if (address(skillCalculator) == address(0)) return false;
        return skillCalculator.isValidTopic(topicId);
    }


    /*  Formula calcolo voting power stake:
        scoreStake = min(stakeDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100]
        VP_stake = weightStake × scoreStake
    */

    //Funzione che calcola scoreStake = min(deposited / MAX_DEPOSIT, 1) × 100 ∈ [0, 100]
    function getStakeScoreForDeposit(uint256 deposited) public pure returns (uint256) {
        if (deposited >= MAX_DEPOSIT) return 100;
        return (deposited * 100) / MAX_DEPOSIT;
    }
    

    /*
    Funzione che calcola scoreStake = min(deposited / MAX_DEPOSIT, 1) × 100 ∈ [0, 100]
    Funzione che calcola i token da mintare per la componente stake della formula VPC.
    Si calcola weightStake × ΔscoreStake (solo l'incremento dello score)
    dove scoreStake = min(stakeDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100].
    Prende il vecchio score, il nuovo score, effettua la differenza e moltiplica
    per weightStake, calcolando i token da mintare. Il risultato è in wei (× 10^18).

    Es: weightStake=5000 bp, previousDeposit=5 ETH, depositAmount=3 ETH:
        oldScore=5, newScore=8, ΔscoreStake=3
        token = (3 × 5000 × 10^18) / 10000 = 1.5 × 10^18 token
    */
    function _calculateStakeTokens(uint256 depositAmount, uint256 previousDeposit) internal view returns (uint256) {
        uint256 oldEffective = previousDeposit > MAX_DEPOSIT ? MAX_DEPOSIT : previousDeposit;
        uint256 newTotal = previousDeposit + depositAmount;
        uint256 newEffective = newTotal > MAX_DEPOSIT ? MAX_DEPOSIT : newTotal;

        uint256 effectiveDiff = newEffective - oldEffective;

        // Calcolo ottimizzato per non perdere i decimali di precisione.
        // Equivale alla logica originale (scoreDiff * weightStake * 1e18) / BASIS_POINTS
        return (effectiveDiff * 100 * weightStake * 1e18) / (MAX_DEPOSIT * BASIS_POINTS);
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
        if (stakeDeposited[msg.sender] + msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        uint256 newTokens = _calculateStakeTokens(msg.value, stakeDeposited[msg.sender]);
        if (newTokens == 0) revert DepositTooSmall();

        stakeDeposited[msg.sender] += msg.value;
        _mint(msg.sender, newTokens);
        (bool ok, ) = treasury.call{value: msg.value}("");
        if (!ok) revert TreasuryTransferFailed();
        emit StakeIncreased(msg.sender, msg.value, newTokens);
    }



    //  DID

     /*  Funzione per la registrazione del DID di un membro. Un membro puo registrare un solo DID
        e lo stesso DID non puo essere usato da due address.
        Verifica che il msg.sender sia un membro della DAO e che non abbia gia registrato un DID.
        Effettua l'hash del DID, controlla che non sia già stato registrato. 
        In tal caso, registra nei mapping le associazioni address -> DID e DID -> address.
    */
    function registerDID(string calldata _did) external {
        if (!isMember[msg.sender]) revert NotMember();
        if (bytes(_did).length == 0) revert EmptyDID();
        if (bytes(memberDID[msg.sender]).length > 0) revert DIDAlreadyRegistered();
        bytes32 h = keccak256(bytes(_did));
        if (didToAddress[h] != address(0)) revert DIDAlreadyBound();
        memberDID[msg.sender] = _did;
        didToAddress[h] = msg.sender;
        emit DIDRegistered(msg.sender, _did);
    }


    //  Upgrade Skill


    // Getter comodo per leggere l'array di skill hashate del membro.
    function getMemberSkills(address member) public view returns (bytes32[] memory) {
        return memberSkills[member];
    }

    // Funzione che converte una skill testuale nella sua rappresentazione hash compatta bytes32.
    function _skillId(string memory skill) internal pure returns (bytes32) {
        return keccak256(bytes(skill));
    }

    // Converte l'array skills[] della VC in bytes32[] hash da salvare nello storage.
    function _hashSkills(string[] memory skills) internal pure returns (bytes32[] memory hashes) {
        hashes = new bytes32[](skills.length);
        for (uint256 i = 0; i < skills.length; ++i) {
            hashes[i] = _skillId(skills[i]);
        }
    }

    /*
        Unisce nuove skill a quelle gia' possedute dal membro.
        Le skill sono immutabili: non vengono modificate o rimosse, solo aggiunte
        se non esistono gia'. Questo evita duplicati e mantiene leggibile il VP.
    */
    function _mergeSkills(address member, bytes32[] memory newSkills) internal returns (bytes32[] memory) {
        bytes32[] storage existing = memberSkills[member];
        uint256 added;
        for (uint256 i = 0; i < newSkills.length; i++) {
            bytes32 newSkill = newSkills[i];
            if (newSkill == bytes32(0)) continue;

            bool found = false;
            for (uint256 j = 0; j < existing.length; j++) {
                if (existing[j] == newSkill) {
                    found = true;
                    break;
                }
            }
            if (!found) {
                existing.push(newSkill);
                ++added;
            }
        }
        if (added > 0) emit MemberSkillsMerged(member, added, existing.length);
        return existing;
    }

    /*
        Upgrade amministrativo via governance No VC, usato a fini di test. Il Timelock passa skill gia' hashate e approvate da una proposta.
    */
    function upgradeSkill(
        address _member,
        bytes32[] calldata _skills,
        string calldata _proof
    ) external onlyTimelock {
        if (!isMember[_member]) revert NotMember();
        if (address(skillCalculator) == address(0)) revert CalculatorNotSet();
        bytes32[] memory mergedSkills = _mergeSkills(_member, _skills);
        _performUpgrade(_member, mergedSkills, _proof);
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
        if (trustedIssuerCount == 0) revert TrustedIssuerNotSet();
        if (address(skillCalculator) == address(0)) revert CalculatorNotSet();
        if (bytes(memberDID[msg.sender]).length == 0) revert NoDIDRegistered();
        if (keccak256(bytes(_vc.credentialSubject.id)) != keccak256(bytes(memberDID[msg.sender]))) revert DIDMismatch();

        address recovered = VPVerifier.recoverIssuer(_vc, _issuerSignature, UNIVERSAL_DOMAIN_SEPARATOR);
        if (!trustedIssuers[recovered]) revert UntrustedIssuer();

        bytes32[] memory newSkillHashes = _hashSkills(_vc.credentialSubject.skills);
        bytes32[] memory mergedSkills = _mergeSkills(msg.sender, newSkillHashes);
        
        _performUpgrade(msg.sender, mergedSkills, string(abi.encodePacked("VP-EIP712:", _vc.issuer.id)));

        emit SkillUpgradedWithVC(msg.sender, _vc.issuer.id);
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
        string memory _proof
    ) internal {
        uint48 blk = clock();
        
        uint256[] memory topics = skillCalculator.getSupportedTopics();
        
        for (uint256 i = 0; i < topics.length; i++) {
            uint256 t = topics[i];
            
            uint256 score = skillCalculator.calculateVP(t, _skills);
            uint256 newVP = (score * weightSkill * 1e18) / BASIS_POINTS;

            _writeSkillVotes(_member, t, newVP, blk);
        }

        emit SkillUpgraded(_member, _proof);
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
    function _validateTopicId(uint256 topicId) internal view {
        if (!isValidTopic(topicId)) revert InvalidTopicId(topicId);
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

    // Restituisce lo Score stake leggibile per UI/test;
    function getStakeScore(address _member) public view returns (uint256) {
        return getStakeScoreForDeposit(stakeDeposited[_member]);
    }

    // =========================================================================
    //  Override ereditarietà
    // =========================================================================

    // Hook richiesto da ERC20Votes per aggiornare i checkpoint dei token stake.
    function _update(address from, address to, uint256 amount) internal override(ERC20, ERC20Votes) {
        super._update(from, to, amount);
    }

    // Risolve il conflitto di ereditarieta' tra ERC20Permit e Nonces.
    function nonces(address owner) public view virtual override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
