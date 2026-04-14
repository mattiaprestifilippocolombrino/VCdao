// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Smart Contract che implementa il token usato per votare nella DAO.
// Chiunque può unirsi alla DAO chiamando joinDAO() e inviando ETH, ricevendo token 1:1000.
// Per aumentare il proprio peso di voto, un membro ottiene un UPGRADE DI COMPETENZA
// tramite proposta di governance (legacy) o presentando una Verifiable Credential (SSI).
//
// Modello Voting Power Composto (VPC) — applicato in MyGovernor._countVote:
//   ScoreTotale = pesoCompetenze × scoreCompetenze + pesoSoldi × scoreSoldi
//
// dove:
//   scoreCompetenze ∈ {0, 25, 50, 75, 100} (grado accademico verificato)
//   scoreSoldi      = min(ethDeposited / CAP, 1) × 100  ∈ [0, 100]
//   pesoCompetenze + pesoSoldi = 10.000 bp (configurabili al deploy del Governor)
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
        Student,       // scoreCompetenze =   0 (partenza, nessuna credenziale)
        BachelorDegree,// scoreCompetenze =  25
        MasterDegree,  // scoreCompetenze =  50
        PhD,           // scoreCompetenze =  75
        Professor      // scoreCompetenze = 100 (massimo)
    }

    //  Costanti

    //Tasso di conversione logico: 1 ETH = 1 token (con 18 decimali)
    uint256 public constant TOKENS_PER_ETH = 1;

    //Deposito massimo per membro: 100 ETH
    uint256 public constant MAX_DEPOSIT = 100 ether;

    //Cap dei token logico per la valutazione
    uint256 public constant TOKEN_CAP = 100 * 10**18;

    /// Massimo livello enum supportato (utile per UI/integrazioni).
    uint8 public constant MAX_DEGREE_LEVEL = 4;

    /// Denominatore per i calcoli in basis points (100% = 10.000 bp).
    uint256 public constant BASIS_POINTS = 10_000;

    /// Domain separator EIP-712 universale, precalcolato a compile-time.
    /// Identico al dominio usato off-chain da Veramo per firmare le VC.
    /// Essendo `constant`, il valore viene incorporato direttamente nel bytecode
    /// senza occupare storage e senza costi di SLOAD (risparmio ~600 gas).
    bytes32 public constant UNIVERSAL_DOMAIN_SEPARATOR =
        keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version)"),
                keccak256(bytes("Universal VC Protocol")),
                keccak256(bytes("1"))
            )
        );

    //Variabili di stato

    //Indirizzo del TimelockController, usato per eseguire gli upgrade di competenza autorizzati dalla governance
    address public timelock;

    //Indirizzo del Treasury, usato per inviare gli ETH ricevuti dai joinDAO() e dai mintTokens()
    address public treasury;

    //Indirizzo del deployer, usato per chiamare setTreasury() al deploy della DAO
    address public immutable deployer;

    //Issuer attendibile che firma le VC (es. universita).
    address public trustedIssuer;

    /// ETH cumulativi versati dal membro (in wei).
    /// Usato per calcolare scoreSoldi = min(ethDeposited / MAX_DEPOSIT, 1) × 100.
    mapping(address => uint256) public ethDeposited;

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

        // Punteggi di competenza nel range [0, 100].
        // Corrispondono alla componente scoreCompetenze della formula VPC.
        competenceScore[CompetenceGrade.Student]       = 0;
        competenceScore[CompetenceGrade.BachelorDegree]= 25;
        competenceScore[CompetenceGrade.MasterDegree]  = 50;
        competenceScore[CompetenceGrade.PhD]           = 75;
        competenceScore[CompetenceGrade.Professor]     = 100;
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

    /// Configura l'issuer fidato che firma le VC riconosciute dal contratto.
    /// Best practice DAO: il deployer può impostarlo solo al primo setup (bootstrap).
    /// Dopo la prima configurazione, solo la governance (timelock) può cambiarlo,
    /// garantendo che nessun singolo individuo possa modificare l'issuer unilateralmente.
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
        // CAP cumulativo: il deposito iniziale non può superare MAX_DEPOSIT.
        if (msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        // Token = contributo economico puro (1 ETH = 1.000 token).
        // Il voting power reale viene calcolato in MyGovernor._countVote tramite la formula VPC.
        uint256 tokenAmount = msg.value * TOKENS_PER_ETH;

        // Persistenza stato membro.
        isMember[msg.sender] = true;
        memberGrade[msg.sender] = CompetenceGrade.Student;
        baseTokens[msg.sender] = tokenAmount;
        ethDeposited[msg.sender] = msg.value;  // traccia ETH cumulativi per scoreSoldi

        // Mint al membro e inoltro ETH al treasury.
        _mint(msg.sender, tokenAmount);
        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();

        emit MemberJoined(msg.sender, msg.value, tokenAmount);
    }

    /// Mint successivi al join: contributo economico aggiuntivo.
    /// I token mintati sono proporzionali all'ETH depositato (1:1000, flat).
    /// Il voting power viene calcolato al momento del voto in MyGovernor._countVote.
    function mintTokens() external payable {
        if (!isMember[msg.sender]) revert NotMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (treasury == address(0)) revert TreasuryNotSet();
        // CAP cumulativo: la somma di tutti i depositi non può superare MAX_DEPOSIT.
        if (ethDeposited[msg.sender] + msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        uint256 newTokens = msg.value * TOKENS_PER_ETH;

        // Aggiorna tracking ETH e balance token.
        baseTokens[msg.sender] += newTokens;
        ethDeposited[msg.sender] += msg.value;
        _mint(msg.sender, newTokens);

        // Invia ETH al treasury.
        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();

        emit TokensMinted(msg.sender, msg.value, newTokens, competenceScore[memberGrade[msg.sender]]);
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
    Upgrade competenza tramite VC — Self-Sovereign (EIP-712)

    Best practice SSI: il membro presenta direttamente la propria VC firmata
    e il contratto la verifica crittograficamente, senza bisogno di una
    votazione di governance. Questo perché la validità della VC è un fatto
    OGGETTIVO (la firma ecrecover è matematicamente verificabile), non una
    decisione SOGGETTIVA che richiede consenso umano.

    Il membro chiama questa funzione in prima persona (msg.sender), dimostrando
    di essere il legittimo holder della credenziale. Questo incarna il principio
    fondamentale della SSI: "l'utente controlla la propria identità".

    Flusso:
    1. Verifica che msg.sender sia un membro con DID registrato
    2. Verifica che il DID nel credentialSubject corrisponda al DID del membro
    3. Recupera l'address del firmatario tramite ecrecover EIP-712
    4. Verifica che il firmatario sia il trustedIssuer
    5. Mappa il degreeTitle nell'enum di competenza
    6. Esegue l'upgrade senza intervento della governance
    */
    function upgradeCompetenceWithVP(
        VPVerifier.VerifiableCredential memory _vc,
        bytes memory _issuerSignature
    ) external {
        // Il chiamante (msg.sender) è il membro che presenta la propria VC.
        if (!isMember[msg.sender]) revert NotMember();
        if (trustedIssuer == address(0)) revert TrustedIssuerNotSet();

        // Verifica binding DID: il DID nel credentialSubject deve corrispondere
        // al DID registrato dal membro, garantendo che nessuno possa usare
        // la VC di un altro.
        if (bytes(memberDID[msg.sender]).length == 0) revert NoDIDRegistered();
        if (
            keccak256(bytes(_vc.credentialSubject.id)) !=
            keccak256(bytes(memberDID[msg.sender]))
        ) revert DIDMismatch();

        // Recupera l'address del firmatario usando la libreria VPVerifier.
        // Il domain separator è precalcolato come constant (0 gas di hashing).
        address recoveredIssuer = VPVerifier.recoverIssuer(
            _vc,
            _issuerSignature,
            UNIVERSAL_DOMAIN_SEPARATOR
        );
        // Verifica crittografica: solo le VC firmate dal trustedIssuer sono valide.
        if (recoveredIssuer != trustedIssuer) revert UntrustedIssuer();

        // Mappa il titolo testuale nell'enum di grado.
        CompetenceGrade newGrade = _getGradeFromTitle(
            _vc.credentialSubject.degreeTitle
        );

        // Costruisce la prova sintetica persistita on-chain.
        string memory proof = string(
            abi.encodePacked("VP-EIP712:", _vc.issuer.id)
        );

        // Esegue direttamente l'upgrade — nessun voto richiesto.
        _performUpgrade(msg.sender, newGrade, proof);

        // Evento dedicato per audit analytics del percorso VC.
        emit CompetenceUpgradedWithVP(
            msg.sender,
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
    Funzione di upgrade di competenza. Calcola il vecchio e il nuovo punteggio di competenza del membro
    per prevenire downgrade. Aggiorna internamente il grado del membro e inserisce la proof on-chain.
    Nel nuovo sistema VPC, non vengono più mintati token extra: l'incremento del potere
    di voto viene calcolato dinamicamente dal Governor al momento del voto.
    */
    function _performUpgrade(
        address _member,
        CompetenceGrade _newGrade,
        string memory _proof
    ) internal {
        uint256 newScore = competenceScore[_newGrade];
        uint256 oldScore = competenceScore[memberGrade[_member]];
        if (newScore <= oldScore) revert CannotDowngrade();

        // L'upgrade aggiorna il grado (scoreCompetenze) del membro.
        // Il nuovo voting power viene calcolato automaticamente in MyGovernor._countVote
        // alla prossima votazione — nessun token aggiuntivo viene mintato.
        memberGrade[_member] = _newGrade;
        competenceProof[_member] = _proof;

        emit CompetenceUpgraded(_member, _newGrade, 0, _proof);
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
    //  Funzioni di scoring per la formula VPC (lette da MyGovernor._countVote)
    // =====================================================================

    /*
    Restituisce lo scoreCompetenze del membro nel range [0, 100].
    Corrisponde al coefficiente del suo grado accademico verificato:
        Student       →   0
        BachelorDegree→  25
        MasterDegree  →  50
        PhD           →  75
        Professor     → 100
    */
    function getScoreCompetenze(address _member) public view returns (uint256) {
        return competenceScore[memberGrade[_member]];
    }

    function getScoreSoldi(address _member) public view returns (uint256) {
        uint256 soldiVersati = baseTokens[_member]; // Usa i Token mintati come base!
        if (soldiVersati >= TOKEN_CAP) return 100;
        return (soldiVersati * 100) / TOKEN_CAP;
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
