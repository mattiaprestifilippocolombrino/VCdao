// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/* 
Smart Contract che implementa il token ERC20 usato per votare nella DAO.
Chiunque può unirsi alla DAO chiamando joinDAO() e inviando ETH.
Per aumentare il proprio potere di voto, un membro puo effettuare un UPGRADE DI COMPETENZA
presentando una Verifiable Credential (SSI).

Formula per calcolare il voting power di un membro: Il numero totale dei token rappresenta
il potere di voto del membro. Viene calcolato usando la seguente formula:
ScoreTotale =  pesoSoldi × scoreSoldi + pesoCompetenze × scoreCompetenze
dove:
   scoreCompetenze ∈ {0, 25, 50, 75, 100}, a secondo del grado accademico presente nella VC
   scoreSoldi      = min(ethDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100]
   pesoCompetenze + pesoSoldi = 10.000 bp (configurabili al deploy del Token)
Si nota che ScoreTotale = parteCompetenze + parteSoldi. 
La parteSoldi della formula viene calcolata al momento del minting di token via deposito di ETH, (joinDAO / mintTokens)
 sottoforma di token, usando la prima parte della formula.
La parteCompetenze viene calcolata al momento dell'upgrade competenze via VC, ottenendo token secondo
la seconda parte della formula. 
Il totale dei token del membro = ScoreTotale (in unità intere × 10^18).
*/
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/utils/Nonces.sol";
import "./VPVerifier.sol";

/* Il token eredita ERC20 per le funzionalità base del token (transfer, balanceOf, ecc.),
 e ERC20Votes per la gestione del potere di voto nella DAO, con checkpoint basati sul
blocco di inizio votazione e delega del potere di voto.
*/
contract GovernanceToken is ERC20, ERC20Permit, ERC20Votes {
    // Enumerazione che rappresenta i gradi di competenza.
    enum CompetenceGrade {
        Student, // 0, scoreCompetenze =   0 (partenza, nessuna credenziale)
        BachelorDegree, // 1, scoreCompetenze =  25
        MasterDegree, // 2, scoreCompetenze =  50
        PhD, // 3, scoreCompetenze =  75
        Professor // 4, scoreCompetenze = 100 (massimo)
    }

    //  Costanti

    //Deposito massimo per membro: 100 ETH
    uint256 public constant MAX_DEPOSIT = 100 ether;

    /// Massimo livello enum supportato (utile per UI/integrazioni).
    uint8 public constant MAX_DEGREE_LEVEL = 4;

    /// Denominatore basis points per effettuare i calcoli in %, che rappresenta il 100% = 10.000 bp.
    uint256 public constant BASIS_POINTS = 10_000;

    /// Domain separator EIP-712 universale, precalcolato a compile-time, identico al dominio usato off-chain da Veramo per firmare le VC.
    /// Essendo `constant`, il valore viene incorporato direttamente nel bytecode senza occupare storage e senza costi di SLOAD (risparmio ~600 gas).
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

    /// Indirizzo del TimelockController, usato per eseguire le operazioni approvate dalla governance.
    /// è immutable per sicurezza e risparmio gas.
    address public immutable timelock;

    //Indirizzo del Treasury, usato per inviare gli ETH ricevuti dai joinDAO() e dai mintTokens()
    address public treasury;

    //Indirizzo del deployer, usato per chiamare setTreasury() al deploy della DAO
    address public immutable deployer;

    //Issuer attendibile che firma le VC (es. universita).
    address public trustedIssuer;

    /// Mapping che tiene traccia di quanti ETH ha depositato ogni membro (in wei).
    mapping(address => uint256) public ethDeposited;

    /// Mappa che associa ad ogni grado di competenza il relativo score, usato per calcolare il potere di voto del membro.
    mapping(CompetenceGrade => uint256) public competenceScore;

    /// Mappa che associa ad ogni membro il suo grado di competenza.
    mapping(address => CompetenceGrade) public memberGrade;

    /// Mappa che tiene traccia degli indirizzi membri della DAO.
    mapping(address => bool) public isMember;

    /// Mappa che tiene  traccia per ogni utente della proof dell'upgrade piu recente.
    mapping(address => string) public competenceProof;

    // ----- Binding DID <-> Address (1:1) -----

    /// Mappa che associa ogni membro al suo DID. Viene usato per verificare coerenza identitaria durante upgrade via VC.
    mapping(address => string) public memberDID;

    /// Mappa che associa ogni DID al suo indirizzo, per garantire l'unicita dei DID nella DAO.
    mapping(bytes32 => address) public didToAddress;

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
        // Corrispondono alla componente scoreCompetenze della formula VPC.
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
    //  Membership e mint
    // =====================================================================

    /*
    Funzione che calcola i token da mintare per la componente economica della formula VPC.
    Formula applicata: pesoSoldi × ΔscoreSoldi (solo l'incremento dello score)
    dove scoreSoldi = min(ethDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100]
    Prende il vecchio score, il nuovo score, effettua la differenza, e moltiplica per il pesoSoldi,
    calcolando i token da mintare. Il risultato è in wei (× 10^18).
    Es: pesoSoldi=5000 bp, oldDeposited=5, amount = 3, newDeposited=8 → oldScore=50, newScore=80 → ΔscoreSoldi=30 → (30 × 5000 × 10^18) / 10000 = + 15 × 10^18 token
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
        // Il deposito iniziale non può superare MAX_DEPOSIT.
        if (msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        uint256 tokenAmount = _calculateMintedTokensForSoldi(msg.value, 0);
        // Se il membro deposita 0 ETH, non riceve token e non diventa membro, poichè non avrebbe voting power.
        if (tokenAmount == 0) revert DepositTooSmall();

        // Persistenza stato membro.
        isMember[msg.sender] = true;
        memberGrade[msg.sender] = CompetenceGrade.Student;
        ethDeposited[msg.sender] = msg.value; // traccia ETH cumulativi per scoreSoldi

        // Mint al membro e inoltro ETH al treasury.
        _mint(msg.sender, tokenAmount);
        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();

        emit MemberJoined(msg.sender, msg.value, tokenAmount);
    }

    /* Funzione che minta i token successivamente all'ingresso nella DAO, inviando ETH.
       La funzione controlla che il membro sia effettivamente un membro della DAO, che il treasury abbia un indirizzo assegnato
       e che il deposito inviato sia superiore a 0.
       Controlla che gli ETH depositati dal membro sommati a quelli che sta per depositare non superino MAX_DEPOSIT.
       Calcola il numero di token da ricevere in base al deposito effettuato via formula VPC.
       In particolare la parte pesoSoldi × scoreSoldi. Si tiene conto degli ETH già depositati per il calcolo dello score.
       Viene aggiornato il conto degli ETH depositati dall'utente. Vengono mintati i token.
        Gli ETH vengono trasferiti direttamente al Treasury.
    */
    function mintTokens() external payable {
        if (!isMember[msg.sender]) revert NotMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (treasury == address(0)) revert TreasuryNotSet();
        // CAP cumulativo: la somma di tutti i depositi non può superare MAX_DEPOSIT.
        if (ethDeposited[msg.sender] + msg.value > MAX_DEPOSIT)
            revert ExceedsMaxDeposit();

        uint256 newTokens = _calculateMintedTokensForSoldi(
            msg.value,
            ethDeposited[msg.sender]
        );
        // Protezione: deposito troppo piccolo per produrre token aggiuntivi.
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

        bytes32 didHash = keccak256(bytes(_did));
        if (didToAddress[didHash] != address(0)) revert DIDAlreadyBound();

        memberDID[msg.sender] = _did;
        didToAddress[didHash] = msg.sender;

        emit DIDRegistered(msg.sender, _did);
    }

    // Funzione legacy, usata per i test, in cui un membro esegue l'upgrade di competenza senza verifica VC, passando un grado di competenza
    // e una proof testuale. Solo il timelock puo chiamare questa funzione.
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

        // Esegue direttamente l'upgrade, senza passare dalla governance.
        _performUpgrade(msg.sender, newGrade, proof);

        // Evento dedicato per audit analytics del percorso VC.
        emit CompetenceUpgradedWithVP(
            msg.sender,
            newGrade,
            uint8(newGrade),
            _vc.issuer.id
        );
    }

    /// Parser semantico che ritorna l'enum del grado di competenza, a partire dalla stringa del titolo di studio.
    /// Usa hash per confronto stringhe gas-efficient.
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
 Funzione di upgrade di competenza, che si occupa di effettuare nella DAO le modifiche,
 dopo che la VC è stata verificata. La funzione calcola il vecchio e il nuovo punteggio di competenza del membro.
 Calcola i token aggiuntivi da mintare in base alla formula di VP, in particolare alla parte: pesoCompetenze × ΔscoreCompetenze.
 Si ha ΔscoreCompetenze = newScore - oldScore  ∈ {25, 50, 75, 100}
 Viene quindi effettuata la differenza tra il vecchio score e il nuovo, e viene moltiplicata
  per il pesoCompetenze e divisa per 10000, mintando i token aggiuntivi al membro.
 Aggiorna il grado del membro e inserisce la proof di competenza on-chain.
 Es: Upgrade Student→PhD (Δ=75), pesoCompetenze=5000 bp → (75 × 5000 × 10^18) / 10000 = 37.5 × 10^18 token
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
        // pesoCompetenze × ΔscoreCompetenze / BASIS_POINTS (scalato 10^18)
        // NB: se pesoCompetenze=0 (DAO puramente economica), tokensToMint=0 ma
        // lo stato (grado, proof) viene comunque aggiornato correttamente.
        uint256 tokensToMint = (scoreDiff * pesoCompetenze * 10 ** 18) /
            BASIS_POINTS;

        memberGrade[_member] = _newGrade;
        competenceProof[_member] = _proof;

        if (tokensToMint > 0) {
            _mint(_member, tokensToMint);
        }

        emit CompetenceUpgraded(_member, _newGrade, tokensToMint, _proof);
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
    (Student → 0, BachelorDegree → 25, MasterDegree → 50, PhD → 75, Professor → 100)
    */
    function getScoreCompetenze(address _member) public view returns (uint256) {
        return competenceScore[memberGrade[_member]];
    }

    /*
    Restituisce lo scoreSoldi attuale del membro. Si ha scoreSoldi = min(ethDeposited / MAX_DEPOSIT, 1) × 100  ∈ [0, 100].
    */
    function getScoreSoldi(address _member) public view returns (uint256) {
        return getScoreSoldiForDeposit(ethDeposited[_member]);
    }

    /*
    Calcola lo ScoreTotale VPC attuale del membro in wei.
    Si ricorda che ScoreTotale_wei = (pesoCompetenze × scoreCompetenze + pesoSoldi × scoreSoldi) × 10^18 / BASIS_POINTS
    Proprietà garantita: getScoreTotale(m) == balanceOf(m). Funzione usata per i test.
    */
    function getScoreTotale(address _member) public view returns (uint256) {
        uint256 scoreC = getScoreCompetenze(_member);
        uint256 scoreS = getScoreSoldi(_member);
        return
            ((pesoCompetenze * scoreC + pesoSoldi * scoreS) * 10 ** 18) /
            BASIS_POINTS;
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
