// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
    Smart Contract che implementa il token usato per votare nella DAO.

    MEMBERSHIP:
    Chiunque può unirsi alla DAO chiamando joinDAO() e inviando ETH,
    ricevendo token in proporzione (1 ETH = 1.000 COMP).

    IDENTITÀ DECENTRALIZZATA (DID):
    Ogni membro può registrare il proprio DID (Decentralized Identifier)
    tramite registerDID(), creando un binding 1:1 tra indirizzo Ethereum e DID.
    Questo collegamento è necessario per l'upgrade di competenza con VC.

    UPGRADE DI COMPETENZA:
     upgradeCompetenceWithVP(): Il Timelock passa una
       Verifiable Credential firmata dall'Issuer con EIP-712. Il contratto verifica
       la firma on-chain, controlla il binding DID, e aggiorna il grado.

    Formula token: TokenMintati = ETH × 1.000 × CoefficienteCompetenza
*/

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "./VPVerifier.sol";

contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes {
    // =====================================================================
    //  Gradi di competenza
    // =====================================================================

    /*
        I gradi di competenza sono rappresentati da un'Enum.
        Il grado di partenza è Student (coefficiente 1).
    */
    enum CompetenceGrade {
        Student, // Coefficiente 1, grado di partenza
        BachelorDegree, // Coefficiente 2
        MasterDegree, // Coefficiente 3
        PhD, // Coefficiente 4
        Professor // Coefficiente 5
    }

    // =====================================================================
    //  Costanti
    // =====================================================================

    /// Tasso di conversione: 1 ETH = 1.000 token (con 18 decimali)
    uint256 public constant TOKENS_PER_ETH = 1000;

    /// Deposito massimo per membro: 100 ETH
    uint256 public constant MAX_DEPOSIT = 100 ether;

    /// Numero massimo di gradi di competenza (0..4)
    uint8 public constant MAX_DEGREE_LEVEL = 4;

    // =====================================================================
    //  Variabili di stato
    // =====================================================================

    /// Indirizzo del TimelockController (esegue upgrade autorizzati dalla governance)
    address public timelock;

    /// Indirizzo del Treasury (riceve gli ETH dai joinDAO e mintTokens)
    address public treasury;

    /// Indirizzo del deployer (setup iniziale: setTreasury, setTrustedIssuer)
    address public immutable deployer;

    /// Indirizzo dell'Issuer fidato (es. l'Università che firma le VC)
    /// Impostato dal deployer al deploy, modificabile dalla governance
    address public trustedIssuer;

    /// Coefficiente di competenza per ogni grado
    mapping(CompetenceGrade => uint256) public competenceScore;

    /// Token base ricevuti da ogni membro (prima degli upgrade)
    mapping(address => uint256) public baseTokens;

    /// Grado di competenza attuale di ogni membro
    mapping(address => CompetenceGrade) public memberGrade;

    /// Flag di membership
    mapping(address => bool) public isMember;

    /// Prova di competenza (stringa testuale o hash VP)
    mapping(address => string) public competenceProof;

    // ----- Binding DID ↔ Address (1:1) -----

    /// DID registrato per ogni membro (es. "did:ethr:sepolia:0x...")
    mapping(address => string) public memberDID;

    /// Mapping inverso: hash(DID) → indirizzo del membro (impedisce duplicati)
    mapping(bytes32 => address) public didToAddress;

    // =====================================================================
    //  Eventi
    // =====================================================================

    /// Emesso quando un nuovo membro entra nella DAO
    event MemberJoined(
        address indexed member,
        uint256 ethDeposited,
        uint256 tokensReceived
    );

    /// Emesso quando un membro minta token aggiuntivi
    event TokensMinted(
        address indexed member,
        uint256 ethDeposited,
        uint256 tokensMinted,
        uint256 competenceScore
    );

    /// Emesso quando un membro viene promosso (upgrade legacy o VP)
    event CompetenceUpgraded(
        address indexed member,
        CompetenceGrade newGrade,
        uint256 additionalTokens,
        string proof
    );

    /// Emesso quando un membro registra il proprio DID
    event DIDRegistered(address indexed member, string did);

    /// Emesso quando l'Issuer fidato viene impostato o aggiornato
    event TrustedIssuerSet(address indexed issuer);

    /// Emesso specificamente per un upgrade tramite VP verificata on-chain
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

    // Errori specifici per DID e VP
    error DIDAlreadyRegistered(); // Il membro ha già un DID registrato
    error DIDAlreadyBound(); // Il DID è già associato a un altro indirizzo
    error NoDIDRegistered(); // Il membro non ha registrato un DID
    error DIDMismatch(); // Il DID nella VC non corrisponde al DID del membro
    error UntrustedIssuer(); // La firma non proviene dall'Issuer fidato
    error InvalidDegreeLevel(); // Titolo studio non supportato
    error TrustedIssuerNotSet(); // L'Issuer fidato non è stato configurato
    error EmptyDID(); // Stringa DID vuota

    // =====================================================================
    //  Modifier
    // =====================================================================

    modifier onlyTimelock() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _;
    }

    modifier onlyDeployer() {
        if (msg.sender != deployer) revert OnlyDeployer();
        _;
    }

    modifier onlyDeployerOrTimelock() {
        if (msg.sender != deployer && msg.sender != timelock)
            revert OnlyDeployerOrTimelock();
        _;
    }

    // =====================================================================
    //  Costruttore
    // =====================================================================

    /*
        Inizializza il token, imposta timelock e deployer,
        e popola la tabella dei coefficienti di competenza.
        Il dominio EIP-712 viene inizializzato da ERC20Permit con nome "CompetenceDAO Token"
        e versione "1" — lo stesso dominio usato dall'Issuer per firmare le VC off-chain.
    */
    constructor(
        address _timelock
    ) ERC20("CompetenceDAO Token", "COMP") ERC20Permit("CompetenceDAO Token") {
        if (_timelock == address(0)) revert ZeroAddress();
        timelock = _timelock;
        deployer = msg.sender;

        competenceScore[CompetenceGrade.Student] = 1;
        competenceScore[CompetenceGrade.BachelorDegree] = 2;
        competenceScore[CompetenceGrade.MasterDegree] = 3;
        competenceScore[CompetenceGrade.PhD] = 4;
        competenceScore[CompetenceGrade.Professor] = 5;
    }

    // =====================================================================
    //  Setup iniziale (one-shot)
    // =====================================================================

    /// Imposta l'indirizzo del Treasury. Chiamabile una sola volta, solo dal deployer.
    function setTreasury(address _treasury) external onlyDeployer {
        if (treasury != address(0)) revert TreasuryAlreadySet();
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    /// Imposta o aggiorna l'Issuer fidato (es. l'Università).
    /// Al deploy viene chiamato dal deployer; successivamente solo la governance può cambiarlo.
    function setTrustedIssuer(address _issuer) external onlyDeployerOrTimelock {
        if (_issuer == address(0)) revert ZeroAddress();
        trustedIssuer = _issuer;
        emit TrustedIssuerSet(_issuer);
    }

    // =====================================================================
    //  Membership
    // =====================================================================

    /// Funzione per entrare nella DAO inviando ETH. Aperta a chiunque.
    function joinDAO() external payable {
        if (treasury == address(0)) revert TreasuryNotSet();
        if (isMember[msg.sender]) revert AlreadyMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        uint256 tokenAmount = msg.value * TOKENS_PER_ETH;

        // Salva stato membro: ora è Student con relativi token
        isMember[msg.sender] = true;
        memberGrade[msg.sender] = CompetenceGrade.Student;
        baseTokens[msg.sender] = tokenAmount;

        // Minta fisicamente i token sul suo account usando l'interfaccia ERC20
        _mint(msg.sender, tokenAmount);

        // Trasferisci tutti gli ETH al contratto Treasury (che è gestito dal Timelock)
        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();
        emit MemberJoined(msg.sender, msg.value, tokenAmount);
    }

    /// Minta token aggiuntivi inviando ETH. Il moltiplicatore dipende dal grado.
    function mintTokens() external payable {
        if (!isMember[msg.sender]) revert NotMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (treasury == address(0)) revert TreasuryNotSet();

        uint256 newBaseTokens = msg.value * TOKENS_PER_ETH;
        uint256 score = competenceScore[memberGrade[msg.sender]];
        uint256 tokensToMint = newBaseTokens * score;

        baseTokens[msg.sender] += newBaseTokens;
        _mint(msg.sender, tokensToMint);

        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();
        emit TokensMinted(msg.sender, msg.value, tokensToMint, score);
    }

    // =====================================================================
    //  Registrazione DID (binding 1:1)
    // =====================================================================

    /*
        Ogni membro della DAO può registrare il proprio Decentralized Identifier (DID).
        Il binding è 1:1: un indirizzo può avere al massimo un DID,
        e un DID può essere associato a un solo indirizzo.
        Questo binding è obbligatorio per l'upgrade di competenza tramite VP,
        perché la DAO verifica che il DID nella VC corrisponda a quello registrato.
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
    //  Upgrade di competenza — Legacy (string proof)
    // =====================================================================

    /// Promuove un membro con una prova testuale. Solo il Timelock (governance).
    function upgradeCompetence(
        address _member,
        CompetenceGrade _newGrade,
        string calldata _proof
    ) external onlyTimelock {
        if (!isMember[_member]) revert NotMember();
        _performUpgrade(_member, _newGrade, _proof);
    }

    // =====================================================================
    //  Upgrade di competenza — Con Verifiable Presentation (core della tesi)
    // =====================================================================

    /*
        Promuove un membro verificando on-chain una Verifiable Credential
        firmata dall'Issuer fidato con EIP-712.

        Verifica eseguita dal contratto:
        1. Il membro deve aver registrato un DID
        2. Il DID nella VC deve corrispondere al DID registrato dal membro
        3. La firma EIP-712 deve provenire dall'Issuer fidato (ECDSA.recover)
        4. Il degreeTitle nella VC deve essere valido (Bachelor/Master/PhD/Professor)
        Dopo la verifica, il contratto mappa degreeTitle → CompetenceGrade
        e applica l'upgrade con la stessa formula token della modalità legacy.
    */
    function upgradeCompetenceWithVP(
        address _member,
        VPVerifier.VerifiableCredential memory _vc,
        bytes memory _issuerSignature
    ) external onlyTimelock {
        // Controlli di membership
        if (!isMember[_member]) revert NotMember();
        if (trustedIssuer == address(0)) revert TrustedIssuerNotSet();

        // Controllo binding DID
        if (bytes(memberDID[_member]).length == 0) revert NoDIDRegistered();
        if (
            keccak256(bytes(_vc.credentialSubject.id)) !=
            keccak256(bytes(memberDID[_member]))
        ) revert DIDMismatch();

        // ----------------------------------------------------------------------
        // Calcolo del Dominio Universale EIP-712
        // Non usiamo _domainSeparatorV4() perché lega la firma a DAO e Blockchain specifiche.
        // Vogliamo che la VC sia utilizzabile su qualsiasi sistema.
        // ----------------------------------------------------------------------
        bytes32 universalDomainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version)"),
                keccak256(bytes("Universal VC Protocol")),
                keccak256(bytes("1"))
            )
        );

        // Verifica firma EIP-712: recupera il firmatario matematicamente (ECDSA)
        address recoveredIssuer = VPVerifier.recoverIssuer(
            _vc,
            _issuerSignature,
            universalDomainSeparator
        );
        // Se la firma recuperata NON COMBACIA con il trustedIssuer, si tratta di un falso/attacco
        if (recoveredIssuer != trustedIssuer) revert UntrustedIssuer();

        // Mapping semantico: string TitoloStudio -> CompetenceGrade
        CompetenceGrade newGrade = _getGradeFromTitle(
            _vc.credentialSubject.degreeTitle
        );

        // Costruisci la proof string (riferimento alla VP verificata)
        string memory proof = string(
            abi.encodePacked("VP-EIP712:", _vc.issuer.id)
        );

        // Applica l'upgrade
        _performUpgrade(_member, newGrade, proof);

        // 4. Emette l'evento (la prova crittografica off-chain ora "diventa" l'attestato on-chain)
        emit CompetenceUpgradedWithVP(
            _member,
            newGrade,
            uint8(newGrade),
            _vc.issuer.id
        );
    }

    // =====================================================================
    //  Utility Semantic Parsing
    // =====================================================================
    /*
        Questa funzione trasforma l'attestato descrittivo W3C ("Master Degree") 
        nel peso numerico della gerarchia On-Chain, agendo da Traduttore Semantico.
    */
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

    // =====================================================================
    //  Logica interna di upgrade (condivisa tra legacy e VP)
    // =====================================================================

    /*
        Calcola i token aggiuntivi e aggiorna grado e prova.
        Formula: additionalTokens = baseTokens × (nuovoScore - vecchioScore)
    */
    function _performUpgrade(
        address _member,
        CompetenceGrade _newGrade,
        string memory _proof
    ) internal {
        uint256 newScore = competenceScore[_newGrade];
        uint256 oldScore = competenceScore[memberGrade[_member]];
        if (newScore <= oldScore) revert CannotDowngrade();

        uint256 additionalTokens = baseTokens[_member] * (newScore - oldScore);

        memberGrade[_member] = _newGrade;
        competenceProof[_member] = _proof;

        _mint(_member, additionalTokens);
        emit CompetenceUpgraded(_member, _newGrade, additionalTokens, _proof);
    }

    // =====================================================================
    //  Funzioni di lettura
    // =====================================================================

    /// Restituisce il grado di competenza di un membro
    function getMemberGrade(
        address _member
    ) external view returns (CompetenceGrade) {
        return memberGrade[_member];
    }

    // =====================================================================
    //  Override richiesti per risolvere conflitti di ereditarietà
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
