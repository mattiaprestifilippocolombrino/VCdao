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
        Student, // Coefficiente 1, grado di partenza
        BachelorDegree, // Coefficiente 2
        MasterDegree, // Coefficiente 3
        PhD, // Coefficiente 4
        Professor // Coefficiente 5
    }

    //  Costanti

    //Tasso di conversione: 1 ETH = 1.000 token (con 18 decimali)
    uint256 public constant TOKENS_PER_ETH = 1000;

    //Deposito massimo per membro: 100 ETH
    uint256 public constant MAX_DEPOSIT = 100 ether;

    //Variabili di stato

    //Indirizzo del TimelockController, usato per eseguire gli upgrade di competenza autorizzati dalla governance
    address public timelock;

    //Indirizzo del Treasury, usato per inviare gli ETH ricevuti dai joinDAO() e dai mintTokens()
    address public treasury;

    //Indirizzo del deployer, usato per chiamare setTreasury() al deploy della DAO
    address public immutable deployer;

    //Mappa che associa ad ogni grado di competenza il relativo coefficiente.
    mapping(CompetenceGrade => uint256) public competenceScore;

    //Mappa che associa ad ogni membro il numero di token ricevuti prima dell'upgrade di competenza.
    mapping(address => uint256) public baseTokens;

    //Mappa che associa ad ogni membro il suo grado di competenza.
    mapping(address => CompetenceGrade) public memberGrade;

    //Mappa che associa ad ogni membro il flag isMember.
    mapping(address => bool) public isMember;

    //Mappa che associa ad ogni membro la proof relativa alla competenza.
    mapping(address => string) public competenceProof;

    //  Eventi

    //Emesso quando un nuovo membro entra nella DAO. Prende in input l'indirizzo del membro, il deposito di ETH e i token ricevuti.
    event MemberJoined(
        address indexed member,
        uint256 ethDeposited,
        uint256 tokensReceived
    );

    //Emesso quando un membro minta token aggiuntivi. Prende in input l'indirizzo del membro, il deposito di ETH, i token mintati e il coefficiente di competenza.
    event TokensMinted(
        address indexed member,
        uint256 ethDeposited,
        uint256 tokensMinted,
        uint256 competenceScore
    );

    //Emesso quando un membro viene promosso a un grado superiore. Prende in input l'indirizzo del membro, il nuovo grado di competenza, i token aggiuntivi ricevuti e la proof relativa alla competenza.
    event CompetenceUpgraded(
        address indexed member,
        CompetenceGrade newGrade,
        uint256 additionalTokens,
        string proof
    );

    //Errori custom
    error OnlyTimelock(); // Solo il Timelock può chiamare questa funzione
    error OnlyDeployer(); // Solo il deployer può chiamare questa funzione
    error AlreadyMember(); // L'indirizzo è già un membro della DAO
    error NotMember(); // L'indirizzo non è un membro della DAO
    error ZeroDeposit(); // Devi inviare almeno un po' di ETH
    error ExceedsMaxDeposit(); // Superato il deposito massimo di 100 ETH
    error CannotDowngrade(); // Non puoi scendere di grado
    error ZeroAddress(); // Indirizzo non valido
    error TreasuryNotSet(); // Il Treasury non è stato ancora impostato
    error TreasuryAlreadySet(); // Il Treasury è già stato impostato
    error TreasuryTransferFailed(); // Trasferimento ETH al Treasury fallito

    // ======================================================================
    //  Modifier
    // ======================================================================

    /// Decorator che indica obbliga la funzione interna ad essere eseguita solo dal TimeLockController.
    modifier onlyTimelock() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _;
    }

    /// Decorator che indica obbliga la funzione interna ad essere eseguita solo dal deployer.
    modifier onlyDeployer() {
        if (msg.sender != deployer) revert OnlyDeployer();
        _;
    }

    /* Costruttore che prende come input l'indirizzo del TimelockController della DAO, 
     inizializza il token, l'indirizzo del timelock e del deployer 
     e imposta la tabella dei coefficienti di competenza.
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

    /*  Funzione di setup one shot che Imposta l'indirizzo del Treasury. 
        Prende in input l'indirizzo del treasury e può essere chiamata una sola volta, solo dal deployer.
        È necessaria perché il Treasury viene deployato dopo il GovernanceToken.
    */
    function setTreasury(address _treasury) external onlyDeployer {
        if (treasury != address(0)) revert TreasuryAlreadySet();
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    /* Funzione usata dagli utenti per entrare nella DAO, chiamabile da chiunque, senza passare da una proposal.
       Può essere chiamata solo dagli utenti che non sono ancora membri della DAO. Controlla che il treasury abbia
       un indirizzo assegnato, che il deposito sia superiore a 0 e inferiore al deposito massimo consentito.
       Calcola il numero di token da ricevere in base al deposito effettuato. Imposta il membro come attivo, come
       Student e il deposito effettuato. Minta i token e li invia al membro. Trasferisce gli ETH ricevuti 
       direttamente al treasury.
    */
    function joinDAO() external payable {
        if (treasury == address(0)) revert TreasuryNotSet();
        if (isMember[msg.sender]) revert AlreadyMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (msg.value > MAX_DEPOSIT) revert ExceedsMaxDeposit();

        // 1 ETH (1e18 wei) × 1000 = 1.000 token (1e21 con 18 decimali)
        uint256 tokenAmount = msg.value * TOKENS_PER_ETH;

        // Registra il membro, come Student
        isMember[msg.sender] = true;
        memberGrade[msg.sender] = CompetenceGrade.Student;
        baseTokens[msg.sender] = tokenAmount;

        _mint(msg.sender, tokenAmount);

        // Trasferisci gli ETH al Treasury
        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();
        emit MemberJoined(msg.sender, msg.value, tokenAmount);
    }

    /* Funzione che minta i token successivamente all'ingresso nella DAO, inviando ETH.
       I token tengono conto del grado di competenza dell'utente. La funzione controlla che il membro
       sia effettivamente un membro della DAO, che il treasury abbia un indirizzo assegnato
       e che il deposito inviato sia superiore a 0.
       La formula per calcolare i token mintati è: tokenMintati = ETH × 1.000 × coefficienteCompetenza.
       I baseTokens vengono aggiornati per i futuri calcoli di upgrade. Gli ETH vengono trasferiti 
       direttamente al Treasury.
    */
    function mintTokens() external payable {
        if (!isMember[msg.sender]) revert NotMember();
        if (msg.value == 0) revert ZeroDeposit();
        if (treasury == address(0)) revert TreasuryNotSet();

        // Calcola i token base aggiuntivi (senza moltiplicatore)
        uint256 newBaseTokens = msg.value * TOKENS_PER_ETH;

        // Applica il moltiplicatore di competenza
        uint256 score = competenceScore[memberGrade[msg.sender]];
        uint256 tokensToMint = newBaseTokens * score;

        // Aggiorna i token base (per futuri upgrade)
        baseTokens[msg.sender] += newBaseTokens;

        _mint(msg.sender, tokensToMint);

        // Trasferisci gli ETH al Treasury
        (bool success, ) = treasury.call{value: msg.value}("");
        if (!success) revert TreasuryTransferFailed();

        emit TokensMinted(msg.sender, msg.value, tokensToMint, score);
    }

    /* Funzione che promuove un membro a un grado superiore in base alle competenze dimostrat
       e dalla proof portata. Essendo una funzione di governance della DAO, può essere chiamata
       solo dal Timelock dopo approvazione della governance.
       Viene controllato che l'utente sia un membro della DAO, e che il grado sia superiore a quello corrente.
       Viene calcolato il numero di token aggiuntivi da mintare moltiplicando i baseTokens per la differenza
       tra il nuovo e il vecchio coefficiente di competenza. I token aggiuntivi vengono mintati
       e inviati al membro. Il grado di competenza del membro e la proof vengono aggiornati.
    */
    function upgradeCompetence(
        address _member,
        CompetenceGrade _newGrade,
        string calldata _proof
    ) external onlyTimelock {
        if (!isMember[_member]) revert NotMember();

        uint256 newScore = competenceScore[_newGrade];
        uint256 oldScore = competenceScore[memberGrade[_member]];
        if (newScore <= oldScore) revert CannotDowngrade();

        // Calcola i token aggiuntivi: base × (nuovoScore - vecchioScore)
        uint256 additionalTokens = baseTokens[_member] * (newScore - oldScore);

        // Aggiorna il grado e la prova di competenza
        memberGrade[_member] = _newGrade;
        competenceProof[_member] = _proof;

        // Minta i token aggiuntivi
        _mint(_member, additionalTokens);
        emit CompetenceUpgraded(_member, _newGrade, additionalTokens, _proof);
    }

    /// Funzione che restituisce il grado di competenza di un membro
    function getMemberGrade(
        address _member
    ) external view returns (CompetenceGrade) {
        return memberGrade[_member];
    }

    //  Override richiesti per risolvere conflitti di ereditarietà: Viene richiesto di effettuare
    //  l'override della funzione _update e nonces per risolvere conflitti di ereditarietà tra ERC20, ERC20Votes e ERC20Permit.

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
