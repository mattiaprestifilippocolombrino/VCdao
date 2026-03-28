// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Smart Contract che implementa il token usato per votare nella DAO.
// Chiunque può unirsi alla DAO chiamando joinDAO() e inviando ETH, e ricevendo token in proporzione.
// Per aumentare il proprio peso di voto, un membro può richiedere un UPGRADE DI COMPETENZA tramite proposta di governance.
// I membri votano e, se approvata, il Timelock della DAO chiama upgradeCompetence().
// I membri possono acquistare token aggiuntivi chiamando mintTokens().
// TokenMintati = ETH × 1.000 × CoefficienteCompetenza
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "./VPVerifier.sol";

///Il token eredita ERC20 per le funzionalità base del token (transfer, balanceOf, ecc.),
/// e ERC20Votes per la gestione del potere di voto nella DAO, con checkpoint basati sul
// blocco di inizio votazione e delega del potere di voto.
contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes {
    /*
I gradi di competenza sono rappresentati da una Enum chiamata CompetenceGrade,
in cui il grado di partenza è Student con 1, BachelorDegree con 2, MasterDegree con 3,
PhD con 4 e Professor con 5.
*/
    enum CompetenceGrade {
        Student, // coefficiente 1 (default all'ingresso)
        BachelorDegree, // coefficiente 2
        MasterDegree, // coefficiente 3
        PhD, // coefficiente 4
        Professor // coefficiente 5
    }

    //  Costanti

    //Tasso di conversione: 1 ETH = 1.000 token (con 18 decimali)
    uint256 public constant TOKENS_PER_ETH = 1000;

    //Deposito massimo per membro: 100 ETH
    uint256 public constant MAX_DEPOSIT = 100 ether;

    /// Massimo livello enum supportato (utile per UI/integrazioni).
    uint8 public constant MAX_DEGREE_LEVEL = 4;

    //Variabili di stato

    //Indirizzo del TimelockController, usato per eseguire gli upgrade di competenza autorizzati dalla governance
    address public timelock;

    //Indirizzo del Treasury, usato per inviare gli ETH ricevuti dai joinDAO() e dai mintTokens()
    address public treasury;

    //Indirizzo del deployer, usato per chiamare setTreasury() al deploy della DAO
    address public immutable deployer;

    //Issuer attendibile che firma le VC (es. universita).
    address public trustedIssuer;

    /// Mappa grado -> coefficiente usato nei calcoli di mint/upgrade.
    mapping(CompetenceGrade => uint256) public competenceScore;

    /// Base contributiva del membro (somma quote base da depositi).
    /// Serve per calcolare i bonus di upgrade senza perdere storico.
    mapping(address => uint256) public baseTokens;

    /// Grado corrente del membro.
    mapping(address => CompetenceGrade) public memberGrade;

    /// Stato membership: true dopo joinDAO riuscita.
    mapping(address => bool) public isMember;

    /// Prova dell'upgrade piu recente (es. hash/riferimento VC o testo legacy).
    mapping(address => string) public competenceProof;

    // ----- Binding DID <-> Address (1:1) -----

    /// DID registrato dal membro.
    /// Viene usato per verificare coerenza identitaria durante upgrade via VC.
    mapping(address => string) public memberDID;

    /// Indice inverso hash(DID) -> address per garantire unicita DID nella DAO.
    mapping(bytes32 => address) public didToAddress;

    // =====================================================================
    //  Eventi
    // =====================================================================

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
        uint256 additionalTokens,
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

    // =====================================================================
    //  Errori custom
    // =====================================================================

    error OnlyTimelock();
    error OnlyDeployer();
    error OnlyDeployerOrTimelock();
    error AlreadyMember();
    error NotMember();
    error ZeroDeposit();
    error ExceedsMaxDeposit();
    error CannotDowngrade();
    error ZeroAddress();
    error TreasuryNotSet();
    error TreasuryAlreadySet();
    error TreasuryTransferFailed();

    // Errori dedicati al flusso DID/VC.
    error DIDAlreadyRegistered();
    error DIDAlreadyBound();
    error NoDIDRegistered();
    error DIDMismatch();
    error UntrustedIssuer();
    error InvalidDegreeLevel();
    error TrustedIssuerNotSet();
    error EmptyDID();

    // =====================================================================
    //  Modifier di accesso
    // =====================================================================

    // Access control: blocca la funzione se caller != timelock.
    modifier onlyTimelock() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _;
    }

    // Access control: blocca la funzione se caller != deployer.
    modifier onlyDeployer() {
        if (msg.sender != deployer) revert OnlyDeployer();
        _;
    }

    // Access control: consente solo deployer o timelock.
    modifier onlyDeployerOrTimelock() {
        if (msg.sender != deployer && msg.sender != timelock)
            revert OnlyDeployerOrTimelock();
        _;
    }

    // =====================================================================
    //  Costruttore
    // =====================================================================

    /*
        Inizializza nome/simbolo token, ruoli base e tabella coefficienti.
        ERC20Permit usa lo stesso nome per il dominio EIP-712 del permit.
    */
    constructor(
        address _timelock
    ) ERC20("CompetenceDAO Token", "COMP") ERC20Permit("CompetenceDAO Token") {
        if (_timelock == address(0)) revert ZeroAddress();
        timelock = _timelock;
        deployer = msg.sender;

        // Inizializzazione coefficienti economici.
        // Il valore cresce con il livello, quindi upgrade => maggiore potere economico/voto.
        competenceScore[CompetenceGrade.Student] = 1;
        competenceScore[CompetenceGrade.BachelorDegree] = 2;
        competenceScore[CompetenceGrade.MasterDegree] = 3;
        competenceScore[CompetenceGrade.PhD] = 4;
        competenceScore[CompetenceGrade.Professor] = 5;
    }

    // =====================================================================
    //  Setup iniziale
    // =====================================================================

    /// Configura treasury una sola volta.
    /// Motivazione: evitare rotazioni arbitrarie della destinazione fondi.
    function setTreasury(address _treasury) external onlyDeployer {
        if (treasury != address(0)) revert TreasuryAlreadySet();
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    /// Configura issuer fidato che firma le VC riconosciute dal contratto.
    /// In setup puo farlo il deployer, poi solo governance (timelock).
    function setTrustedIssuer(address _issuer) external onlyDeployerOrTimelock {
        if (_issuer == address(0)) revert ZeroAddress();
        trustedIssuer = _issuer;
        emit TrustedIssuerSet(_issuer);
    }

    // =====================================================================
    //  Membership e mint
    // =====================================================================

    /// Onboarding membro:
    /// - verifica prerequisiti
    /// - assegna grado iniziale Student
    /// - minta token base
    /// - inoltra ETH al treasury
    function joinDAO() external payable {
        if (treasury == address(0)) revert TreasuryNotSet();
        if (isMember[msg.sender]) revert AlreadyMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        // Calcolo quota base token dal deposito in ETH.
        uint256 tokenAmount = msg.value * TOKENS_PER_ETH;

        // Persistenza stato iniziale membro.
        isMember[msg.sender] = true;
        memberGrade[msg.sender] = CompetenceGrade.Student;
        baseTokens[msg.sender] = tokenAmount;

        // Mint immediato al membro.
        _mint(msg.sender, tokenAmount);

        // Trasferisce gli ETH al treasury con low-level call.
        // Se fallisce, revert totale per mantenere coerenza stato/fondi.
        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();

        emit MemberJoined(msg.sender, msg.value, tokenAmount);
    }

    /// Mint successivi al join:
    /// la quota base del nuovo deposito e moltiplicata per il grado corrente.
    function mintTokens() external payable {
        if (!isMember[msg.sender]) revert NotMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (treasury == address(0)) revert TreasuryNotSet();

        // Nuova quota base derivata dal deposito corrente.
        uint256 newBaseTokens = msg.value * TOKENS_PER_ETH;
        // Coefficiente del grado attuale del membro.
        uint256 score = competenceScore[memberGrade[msg.sender]];
        // Quantita finale da mintare.
        uint256 tokensToMint = newBaseTokens * score;

        // Aggiorna base cumulata (usata nei bonus futuri) e minta.
        baseTokens[msg.sender] += newBaseTokens;
        _mint(msg.sender, tokensToMint);

        // Invia ETH raccolti al treasury.
        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();

        emit TokensMinted(msg.sender, msg.value, tokensToMint, score);
    }

    /*  Registrazione DID (binding 1:1)
        Registra un DID per il caller membro. Un membro puo registrare un solo DID
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

        bytes32 didHash = keccak256(bytes(_did));
        if (didToAddress[didHash] != address(0)) revert DIDAlreadyBound();

        memberDID[msg.sender] = _did;
        didToAddress[didHash] = msg.sender;

        emit DIDRegistered(msg.sender, _did);
    }

    // =====================================================================
    //  Upgrade competenza - Legacy
    // =====================================================================

    /// Upgrade legacy governato da proposta on-chain.
    /// Non verifica firma VC: usa prova testuale `_proof`.
    function upgradeCompetence(
        address _member,
        CompetenceGrade _newGrade,
        string calldata _proof
    ) external onlyTimelock {
        if (!isMember[_member]) revert NotMember();
        _performUpgrade(_member, _newGrade, _proof);
    }

    /*
Upgrade competenza tramite VC (EIP-712)
Usa la libreria VPVerifier per verificare una VC firmata e applica l'upgrade se valida.
Controlla se il membro e' esistente e se è configurato l'issuer fidato.
Controlla se il DID del membro e' coerente con il DID nel credentialSubject.
Calcola il typehash del dominio EIP-712.
Recupera l'address del firmatario usando le funzioni della libreria VPVerifier sulla firma EIP-712 contenuta nella VC.
Controlla se l'issuer recuperato e' uguale al trustedIssuer. In caso di successo, mappa il titolo testuale nell'enum di grado.
Costruisce una stringa prova sintetica persistita on-chain. Esegue l'aggiornamento del grado del membro, tramite la funzione _performUpgrade.
    */
    function upgradeCompetenceWithVP(
        address _member,
        VPVerifier.VerifiableCredential memory _vc,
        bytes memory _issuerSignature
    ) external onlyTimelock {
        // Controlla se il membro e' esistente e se è configurato l'issuer fidato.
        if (!isMember[_member]) revert NotMember();
        if (trustedIssuer == address(0)) revert TrustedIssuerNotSet();

        // Controlla se il DID del membro e' coerente con il DID nel credentialSubject.
        if (bytes(memberDID[_member]).length == 0) revert NoDIDRegistered();
        if (
            keccak256(bytes(_vc.credentialSubject.id)) !=
            keccak256(bytes(memberDID[_member]))
        ) revert DIDMismatch();

        // Calcola il typehash del dominio EIP-712.
        bytes32 universalDomainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version)"),
                keccak256(bytes("Universal VC Protocol")),
                keccak256(bytes("1"))
            )
        );

        // Recupera l'address del firmatario usando le funzioni della libreria VPVerifier sulla firma  EIP-712 contenuta nella VC.
        address recoveredIssuer = VPVerifier.recoverIssuer(
            _vc,
            _issuerSignature,
            universalDomainSeparator
        );
        // Controlla se l'issuer recuperato e' uguale al trustedIssuer.
        if (recoveredIssuer != trustedIssuer) revert UntrustedIssuer();

        // In caso di successo, mappa il titolo testuale nell'enum di grado.
        CompetenceGrade newGrade = _getGradeFromTitle(
            _vc.credentialSubject.degreeTitle
        );

        // Costruisce una stringa prova sintetica persistita on-chain.
        string memory proof = string(
            abi.encodePacked("VP-EIP712:", _vc.issuer.id)
        );

        // Esegue l'aggiornamento del grado del membro, tramite la funzione _performUpgrade.
        _performUpgrade(_member, newGrade, proof);

        // Evento dedicato per audit analytics del percorso VC.
        emit CompetenceUpgradedWithVP(
            _member,
            newGrade,
            uint8(newGrade),
            _vc.issuer.id
        );
    }

    // =====================================================================
    //  Utility parsing semantico
    // =====================================================================

    /// Parser semantico titolo -> enum.
    /// Usa hash bytes per confronto stringhe gas-efficient.
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
    Funzione di upgrade di competenza. Calcola il vecchio e il nuovo punteggio di competenza del membro.
    Calcola i token aggiuntivi da mintare in base ai token mintati in precedenza dal membro, moltiplicati
    per la differenza tra il nuovo e il vecchio punteggio di competenza.
    Aggiorna il grado del membro e inserisce la proof di competenza on-chain.
    */
    function _performUpgrade(
        address _member,
        CompetenceGrade _newGrade,
        string memory _proof
    ) internal {
        uint256 newScore = competenceScore[_newGrade];
        uint256 oldScore = competenceScore[memberGrade[_member]];
        if (newScore <= oldScore) revert CannotDowngrade();

        // Delta moltiplicatore applicato alla base contributiva del membro.
        uint256 additionalTokens = baseTokens[_member] * (newScore - oldScore);

        // Aggiorna grado/prova prima del mint per coerenza di stato.
        memberGrade[_member] = _newGrade;
        competenceProof[_member] = _proof;

        // Mint del bonus e tracciamento evento.
        _mint(_member, additionalTokens);
        emit CompetenceUpgraded(_member, _newGrade, additionalTokens, _proof);
    }

    // =====================================================================
    //  Funzioni di lettura
    // =====================================================================

    /// Getter semplice del grado membro.
    function getMemberGrade(
        address _member
    ) external view returns (CompetenceGrade) {
        return memberGrade[_member];
    }

    // =====================================================================
    //  Override OZ richiesti da ereditarieta multipla (ERC20 + ERC20Votes + Permit)
    // =====================================================================

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
