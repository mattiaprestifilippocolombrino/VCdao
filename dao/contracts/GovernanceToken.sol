// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/* 
Smart Contract che implementa il token ERC20 usato per votare nella DAO.
Chiunque può unirsi alla DAO chiamando joinDAO() e inviando ETH.
Per aumentare il proprio potere di voto, un membro puo effettuare un UPGRADE DI COMPETENZA
presentando una Verifiable Credential (SSI).

Formula per calcolare il voting power di un membro:
ScoreTotale =  pesoSoldi × scoreSoldi + pesoCompetenze × scoreCompetenze
dove:
   scoreCompetenze ∈ {0, 25, 50, 75, 100}, a secondo del grado accademico presente nella VC
   scoreSoldi      = min(ethDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100]
   pesoCompetenze + pesoSoldi = 10.000 bp (configurabili al deploy del Token)

Il Voting Power è ora diviso in due componenti separate:
  - Componente economica (parteSoldi): rappresentata da token ERC20 mintati al joinDAO/mintTokens.
    Il bilancio token (e il relativo getPastVotes di ERC20Votes) traccia SOLO questa parte.
  - Componente competenza (parteCompetenze): NON genera token. Viene tracciata tramite
    checkpoint manuali Checkpoints.Trace208 (stesso tipo/clock usato da ERC20Votes),
    aggiornati ad ogni upgrade via _performUpgrade.
Il Governor combina le due componenti in _getVotes() e quorum()/superQuorum().
*/
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "./VPVerifier.sol";

/* Il token eredita ERC20 per le funzionalità base del token (transfer, balanceOf, ecc.),
 e ERC20Votes per la gestione del potere di voto economico nella DAO, con checkpoint basati
 sul blocco di inizio votazione e delega del potere di voto.
 I checkpoint delle skill seguono lo stesso standard (Checkpoints.Trace208, clock a blocchi).
*/
contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes {
    using Checkpoints for Checkpoints.Trace208;

    // Enumerazione che rappresenta i gradi di competenza.
    enum CompetenceGrade {
        Student,       // 0, scoreCompetenze =   0 (partenza, nessuna credenziale)
        BachelorDegree,// 1, scoreCompetenze =  25
        MasterDegree,  // 2, scoreCompetenze =  50
        PhD,           // 3, scoreCompetenze =  75
        Professor      // 4, scoreCompetenze = 100 (massimo)
    }

    //  Costanti

    //Deposito massimo per membro: 100 ETH
    uint256 public constant MAX_DEPOSIT = 100 ether;

    /// Massimo livello enum supportato (utile per UI/integrazioni).
    uint8 public constant MAX_DEGREE_LEVEL = 4;

    /// Denominatore basis points per effettuare i calcoli in %, che rappresenta il 100% = 10.000 bp.
    uint256 public constant BASIS_POINTS = 10_000;

    /// Domain separator EIP-712 universale, precalcolato a compile-time.
    bytes32 public constant UNIVERSAL_DOMAIN_SEPARATOR =
        keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version)"),
                keccak256(bytes("Universal VC Protocol")),
                keccak256(bytes("1"))
            )
        );

    //Variabili di stato

    /// Peso della componente accademica nella formula VPC, in percentuale bp.
    uint256 public immutable pesoCompetenze;

    /// Peso della componente economica nella formula VPC, in percentuale bp.
    uint256 public immutable pesoSoldi;

    /// Indirizzo del TimelockController.
    address public immutable timelock;

    //Indirizzo del Treasury.
    address public treasury;

    //Indirizzo del deployer.
    address public immutable deployer;

    //Issuer attendibile che firma le VC.
    address public trustedIssuer;

    /// Mapping che tiene traccia di quanti ETH ha depositato ogni membro (in wei).
    mapping(address => uint256) public ethDeposited;

    /// Mappa che associa ad ogni grado di competenza il relativo score.
    mapping(CompetenceGrade => uint256) public competenceScore;

    /// Mappa che associa ad ogni membro il suo grado di competenza.
    mapping(address => CompetenceGrade) public memberGrade;

    /// Mappa che tiene traccia degli indirizzi membri della DAO.
    mapping(address => bool) public isMember;

    /// Mappa che tiene traccia per ogni utente della proof dell'upgrade piu recente.
    mapping(address => string) public competenceProof;

    // ----- Binding DID <-> Address (1:1) -----

    /// Mappa che associa ogni membro al suo DID.
    mapping(address => string) public memberDID;

    /// Mappa che associa ogni DID al suo indirizzo.
    mapping(bytes32 => address) public didToAddress;

    // =====================================================================
    //  Checkpoint delle skill (componente competenza del voting power)
    //
    //  Stessa struttura usata da Votes/_delegateCheckpoints in ERC20Votes:
    //  Checkpoints.Trace208 con chiave uint48 (numero di blocco, clock()).
    //
    //  _skillVotesCheckpoints[account]: storico cumulativo del skill-VP di
    //    ogni utente, in wei. Cresce ad ogni upgrade; non può decrementare.
    //  _totalSkillSupplyCheckpoints: somma cumulativa di tutti i skill-VP
    //    emessi nella DAO, in wei. Usata dal Governor per quorum/superQuorum.
    // =====================================================================

    /// Storico per-utente del voting power di competenza (in wei).
    mapping(address => Checkpoints.Trace208) private _skillVotesCheckpoints;

    /// Storico della totalSupply del voting power di competenza (in wei).
    Checkpoints.Trace208 private _totalSkillSupplyCheckpoints;

    //  Eventi

    /// Emesso quando un address entra nella DAO con `joinDAO`.
    event MemberJoined(
        address indexed member,
        uint256 ethDeposited,
        uint256 tokensReceived
    );

    /// Emesso quando un membro esistente usa `mintTokens`.
    event TokensMinted(
        address indexed member,
        uint256 ethDeposited,
        uint256 tokensMinted,
        uint256 competenceScore
    );

    /// Evento comune a ogni upgrade di competenza (qualunque sorgente prova).
    event CompetenceUpgraded(
        address indexed member,
        CompetenceGrade newGrade,
        uint256 skillVotingPowerAdded,
        string proof
    );

    /// Emesso quando il binding DID viene registrato con successo.
    event DIDRegistered(address indexed member, string did);

    /// Emesso quando viene configurato/aggiornato il trusted issuer.
    event TrustedIssuerSet(address indexed issuer);

    /// Emesso solo per upgrade ottenuti con verifica VC/VP EIP-712.
    event CompetenceUpgradedWithVP(
        address indexed member,
        CompetenceGrade newGrade,
        uint8 degreeLevel,
        string issuerDid
    );

    //  Errori custom

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
    /// Il deposito ETH è troppo piccolo: produrrebbe 0 token per troncamento intero.
    error DepositTooSmall();

    // Errori dedicati al flusso DID/VC.
    error DIDAlreadyRegistered();
    error DIDAlreadyBound();
    error NoDIDRegistered();
    error DIDMismatch();
    error UntrustedIssuer();
    error InvalidDegreeLevel();
    error TrustedIssuerNotSet();
    error EmptyDID();

    //  Modifier di accesso

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

    /* Costruttore che prende come input l'indirizzo del TimelockController della DAO, il peso delle competenze 
    e il peso dei soldi. Inizializza il token, l'indirizzo del timelock e del deployer, imposta i pesiCompetenza
    e pesoSoldi e imposta la tabella dei coefficienti di competenza.
    */
    constructor(
        address _timelock,
        uint256 _pesoCompetenze,
        uint256 _pesoSoldi
    ) ERC20("CompetenceDAO Token", "COMP") ERC20Permit("CompetenceDAO Token") {
        if (_timelock == address(0)) revert ZeroAddress();
        if (_pesoCompetenze + _pesoSoldi != BASIS_POINTS)
            revert InvalidWeights();

        timelock = _timelock;
        deployer = msg.sender;
        pesoCompetenze = _pesoCompetenze;
        pesoSoldi = _pesoSoldi;

        // Punteggi di competenza nel range [0, 100].
        competenceScore[CompetenceGrade.Student] = 0;
        competenceScore[CompetenceGrade.BachelorDegree] = 25;
        competenceScore[CompetenceGrade.MasterDegree] = 50;
        competenceScore[CompetenceGrade.PhD] = 75;
        competenceScore[CompetenceGrade.Professor] = 100;
    }

    // =====================================================================
    //  Setup iniziale
    // =====================================================================

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
            // Bootstrap: prima configurazione, solo deployer
            if (msg.sender != deployer) revert OnlyDeployer();
        } else {
            // Post-bootstrap: solo governance può cambiare l'issuer
            if (msg.sender != timelock) revert OnlyTimelock();
        }
        trustedIssuer = _issuer;
        emit TrustedIssuerSet(_issuer);
    }

    // =====================================================================
    //  Membership e mint (componente economica)
    // =====================================================================

    /*
    Funzione che calcola i token da mintare per la componente economica della formula VPC.
    Formula applicata: pesoSoldi × ΔscoreSoldi (solo l'incremento dello score)
    dove scoreSoldi = min(ethDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100]
    */
    function _calculateMintedTokensForSoldi(
        uint256 depositAmt,
        uint256 oldDeposited
    ) internal view returns (uint256) {
        uint256 oldScore = getScoreSoldiForDeposit(oldDeposited);
        uint256 newScore = getScoreSoldiForDeposit(oldDeposited + depositAmt);
        uint256 scoreDiff = newScore - oldScore; // ΔscoreSoldi ∈ [0, 100]
        return (scoreDiff * pesoSoldi * 10 ** 18) / BASIS_POINTS;
    }

    /*
    Funzione che calcola scoreSoldi = min(deposited / MAX_DEPOSIT, 1) × 100.
    */
    function getScoreSoldiForDeposit(
        uint256 deposited
    ) public pure returns (uint256) {
        if (deposited >= MAX_DEPOSIT) return 100;
        return (deposited * 100) / MAX_DEPOSIT;
    }

    /* Funzione usata dagli utenti per entrare nella DAO, chiamabile da chiunque, senza passare da una proposal.
       Può essere chiamata solo dagli utenti che non sono ancora membri della DAO. Controlla che il treasury abbia
       un indirizzo assegnato, che il deposito sia superiore a 0 e inferiore al deposito massimo consentito.
       Calcola il numero di token da ricevere in base al deposito effettuato via formula VPC.
       In particolare la parte pesoSoldi × scoreSoldi. 
       Imposta il nuovo membro come attivo, con grado minimo Student e viene registrato il deposito effettuato.
       I token vengono mintati e inviati al membro. La funzione trasferisce gli ETH ricevuti direttamente al treasury.
    */
    function joinDAO() external payable {
        if (treasury == address(0)) revert TreasuryNotSet();
        if (isMember[msg.sender]) revert AlreadyMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        uint256 tokenAmount = _calculateMintedTokensForSoldi(msg.value, 0);
        if (tokenAmount == 0) revert DepositTooSmall();

        // Persistenza stato membro.
        isMember[msg.sender] = true;
        memberGrade[msg.sender] = CompetenceGrade.Student;
        ethDeposited[msg.sender] = msg.value;

        // Mint al membro (solo componente economica) e inoltro ETH al treasury.
        _mint(msg.sender, tokenAmount);
        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();

        emit MemberJoined(msg.sender, msg.value, tokenAmount);
    }

    /* Funzione che minta i token successivamente all'ingresso nella DAO, inviando ETH.
       Calcola e minta solo la componente economica aggiuntiva (pesoSoldi × ΔscoreSoldi).
    */
    function mintTokens() external payable {
        if (!isMember[msg.sender]) revert NotMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (treasury == address(0)) revert TreasuryNotSet();
        if (ethDeposited[msg.sender] + msg.value > MAX_DEPOSIT)
            revert ExceedsMaxDeposit();

        uint256 newTokens = _calculateMintedTokensForSoldi(
            msg.value,
            ethDeposited[msg.sender]
        );
        if (newTokens == 0) revert DepositTooSmall();

        // Aggiorna tracking ETH e balance token.
        ethDeposited[msg.sender] += msg.value;
        _mint(msg.sender, newTokens);

        // Invia ETH al treasury.
        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();

        emit TokensMinted(
            msg.sender,
            msg.value,
            newTokens,
            competenceScore[memberGrade[msg.sender]]
        );
    }

    /*  Funzione per la registrazione del DID di un membro.
        Verifica che il msg.sender sia un membro della DAO e che non abbia gia registrato un DID.
    */
    function registerDID(string calldata _did) external {
        if (!isMember[msg.sender]) revert NotMember();
        if (bytes(_did).length == 0) revert EmptyDID();
        if (bytes(memberDID[msg.sender]).length > 0)
            revert DIDAlreadyRegistered();

        bytes32 didHash = keccak256(bytes(_did));
        if (didToAddress[didHash] != address(0)) revert DIDAlreadyBound();

        memberDID[msg.sender] = _did;
        didToAddress[didHash] = msg.sender;

        emit DIDRegistered(msg.sender, _did);
    }

    // Funzione legacy per i test: upgrade di competenza senza verifica VC. Solo il timelock può chiamarla.
    function upgradeCompetence(
        address _member,
        CompetenceGrade _newGrade,
        string calldata _proof
    ) external onlyTimelock {
        if (!isMember[_member]) revert NotMember();
        _performUpgrade(_member, _newGrade, _proof);
    }

    /*
    Funzione che esegue l'upgrade di competenza di un membro tramite VC. 
    Usa la libreria VPVerifier per verificare una VC firmata EIP-712 e applica l'upgrade se valida.
    */
    function upgradeCompetenceWithVP(
        VPVerifier.VerifiableCredential memory _vc,
        bytes memory _issuerSignature
    ) external {
        if (!isMember[msg.sender]) revert NotMember();
        if (trustedIssuer == address(0)) revert TrustedIssuerNotSet();

        // Verifica binding DID.
        if (bytes(memberDID[msg.sender]).length == 0) revert NoDIDRegistered();
        if (
            keccak256(bytes(_vc.credentialSubject.id)) !=
            keccak256(bytes(memberDID[msg.sender]))
        ) revert DIDMismatch();

        // Recupera l'address del firmatario.
        address recoveredIssuer = VPVerifier.recoverIssuer(
            _vc,
            _issuerSignature,
            UNIVERSAL_DOMAIN_SEPARATOR
        );
        if (recoveredIssuer != trustedIssuer) revert UntrustedIssuer();

        // Mappa il titolo testuale nell'enum di grado.
        CompetenceGrade newGrade = _getGradeFromTitle(
            _vc.credentialSubject.degreeTitle
        );

        // Costruisce la prova sintetica persistita on-chain.
        string memory proof = string(
            abi.encodePacked("VP-EIP712:", _vc.issuer.id)
        );

        _performUpgrade(msg.sender, newGrade, proof);

        emit CompetenceUpgradedWithVP(
            msg.sender,
            newGrade,
            uint8(newGrade),
            _vc.issuer.id
        );
    }

    /// Parser semantico che ritorna l'enum del grado di competenza, a partire dalla stringa del titolo di studio.
    function _getGradeFromTitle(
        string memory _degreeTitle
    ) internal pure returns (CompetenceGrade) {
        bytes32 hashTitle = keccak256(bytes(_degreeTitle));
        if (hashTitle == keccak256(bytes("BachelorDegree")))
            return CompetenceGrade.BachelorDegree;
        if (hashTitle == keccak256(bytes("MasterDegree")))
            return CompetenceGrade.MasterDegree;
        if (hashTitle == keccak256(bytes("PhD"))) return CompetenceGrade.PhD;
        if (hashTitle == keccak256(bytes("Professor")))
            return CompetenceGrade.Professor;
        revert InvalidDegreeLevel();
    }

    /*
    Funzione interna di upgrade di competenza.

    IMPORTANTE - Separazione del VP:
    La componente di competenza NON viene più mintata come token ERC20.
    Viene invece calcolata la nuova quantità cumulativa di skill-VP del membro
    e salvata nei checkpoint manuali (stessa struttura Trace208 usata da ERC20Votes,
    con chiave = blocco corrente via clock()).

    In questo modo:
      - balanceOf(member)     → solo componente economica
      - getSkillVotes(member) → solo componente competenza
    Il Governor somma le due in _getVotes() per il VP totale.

    Formula: skillVP = (pesoCompetenze × scoreCompetenze × 10^18) / BASIS_POINTS
    Es: PhD, pesoCompetenze=5000 bp → (75 × 5000 × 10^18) / 10000 = 37.5 × 10^18
    */
    function _performUpgrade(
        address _member,
        CompetenceGrade _newGrade,
        string memory _proof
    ) internal {
        uint256 newScore = competenceScore[_newGrade];
        uint256 oldScore = competenceScore[memberGrade[_member]];
        if (newScore <= oldScore) revert CannotDowngrade();

        // ΔscoreCompetenze = newScore - oldScore  ∈ {25, 50, 75, 100}
        uint256 scoreDiff = newScore - oldScore;

        // Calcola il VP aggiuntivo di competenza in wei.
        // Se pesoCompetenze=0 (DAO puramente economica), skillVPAdded=0 ma
        // lo stato (grado, proof) viene comunque aggiornato correttamente.
        uint256 skillVPAdded = (scoreDiff * pesoCompetenze * 10 ** 18) / BASIS_POINTS;

        // Aggiorna stato del membro.
        memberGrade[_member] = _newGrade;
        competenceProof[_member] = _proof;

        // Aggiorna i checkpoint skill solo se c'è VP da aggiungere.
        if (skillVPAdded > 0) {
            // Chiave = blocco corrente (uint48), coerente con clock() di ERC20Votes.
            uint48 currentBlock = clock();

            // Skill VP cumulativo dell'utente: vecchio valore + delta.
            uint208 oldUserSkill = _skillVotesCheckpoints[_member].latest();
            uint208 newUserSkill = oldUserSkill + SafeCast.toUint208(skillVPAdded);
            _skillVotesCheckpoints[_member].push(currentBlock, newUserSkill);

            // Total skill supply: vecchio valore + delta.
            uint208 oldTotalSkill = _totalSkillSupplyCheckpoints.latest();
            uint208 newTotalSkill = oldTotalSkill + SafeCast.toUint208(skillVPAdded);
            _totalSkillSupplyCheckpoints.push(currentBlock, newTotalSkill);
        }

        emit CompetenceUpgraded(_member, _newGrade, skillVPAdded, _proof);
    }

    // =====================================================================
    //  Lettura del voting power di competenza (con storico a blocchi)
    //
    //  Queste funzioni sono il punto di accesso del Governor ai checkpoint
    //  della componente skill. Seguono la stessa convenzione di ERC20Votes:
    //  - getSkillVotes()          → valore corrente (latest checkpoint)
    //  - getPastSkillVotes()      → ricerca binaria sul blocco passato
    //  - getPastTotalSkillSupply()→ ricerca binaria sulla supply skill passata
    //
    //  La guardia "timepoint < clock()" replica _validateTimepoint di Votes
    //  per prevenire lookup nel futuro.
    // =====================================================================

    /// Restituisce il voting power di competenza corrente del membro (non storico).
    function getSkillVotes(address account) public view returns (uint256) {
        return _skillVotesCheckpoints[account].latest();
    }

    /*
    Restituisce il voting power di competenza del membro al blocco `timepoint`.
    Usa upperLookupRecent (ottimizzato per checkpoint recenti) coerentemente con
    come ERC20Votes legge i suoi checkpoint in getPastVotes().
    Requisito: timepoint deve essere un blocco già minato (< clock()).
    */
    function getPastSkillVotes(
        address account,
        uint256 timepoint
    ) public view returns (uint256) {
        // Replica la guardia di Votes._validateTimepoint.
        uint48 currentBlock = clock();
        if (timepoint >= currentBlock)
            revert ERC5805FutureLookup(timepoint, currentBlock);
        return _skillVotesCheckpoints[account].upperLookupRecent(
            SafeCast.toUint48(timepoint)
        );
    }

    /// Restituisce la totalSupply corrente del voting power di competenza (non storico).
    function getTotalSkillSupply() public view returns (uint256) {
        return _totalSkillSupplyCheckpoints.latest();
    }

    /*
    Restituisce la totalSupply del voting power di competenza al blocco `timepoint`.
    Usata dal Governor in quorum() e superQuorum() per includere la componente
    skill nel calcolo della base votante totale.
    */
    function getPastTotalSkillSupply(
        uint256 timepoint
    ) public view returns (uint256) {
        uint48 currentBlock = clock();
        if (timepoint >= currentBlock)
            revert ERC5805FutureLookup(timepoint, currentBlock);
        return _totalSkillSupplyCheckpoints.upperLookupRecent(
            SafeCast.toUint48(timepoint)
        );
    }

    //  Funzioni di lettura

    /// Getter semplice del grado membro.
    function getMemberGrade(
        address _member
    ) external view returns (CompetenceGrade) {
        return memberGrade[_member];
    }

    //  Funzioni di scoring per la formula VPC.

    /*
    Si ha scoreCompetenze ∈ {0, 25, 50, 75, 100}, a secondo del grado accademico del membro.
    */
    function getScoreCompetenze(address _member) public view returns (uint256) {
        return competenceScore[memberGrade[_member]];
    }

    /*
    Restituisce lo scoreSoldi attuale del membro.
    */
    function getScoreSoldi(address _member) public view returns (uint256) {
        return getScoreSoldiForDeposit(ethDeposited[_member]);
    }

    /*
    Calcola lo ScoreTotale VPC attuale del membro in wei.
    ScoreTotale_wei = parteSoldi (balanceOf) + parteCompetenze (getSkillVotes).
    Proprietà: getScoreTotale(m) == balanceOf(m) + getSkillVotes(m).
    */
    function getScoreTotale(address _member) public view returns (uint256) {
        return balanceOf(_member) + getSkillVotes(_member);
    }

    //  Override OZ richiesti da ereditarieta multipla (ERC20 + ERC20Votes + Permit)
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
