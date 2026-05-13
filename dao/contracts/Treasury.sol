// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./StartupRegistry.sol";

/*
Contratto che conserva i fondi della DAO e permette di investirli in startup
SOLO se l'operazione è stata approvata dalla governance e passa
attraverso il TimelockController.

Il Treasury NON è controllabile dal deployer né da nessun altro account.
L'UNICO indirizzo che può chiamare `invest()` è il TimelockController.
Questo garantisce che nessun singolo individuo possa spostare i fondi
senza il consenso della comunità (voto + timelock).

FLUSSO:
1. I membri depositano mintando token o inviando ETH direttamente
2. Un membro propone un investimento tramite il Governor
3. La comunità vota
4. Se approvata, la proposta viene messa in coda nel Timelock
5. Dopo il delay, il Timelock esegue Treasury.investStartup() → ETH va alla startup registrata
*/

contract Treasury is ReentrancyGuard {
    /// Indirizzo del TimelockController, l'unico che può ordinare investimenti.
    address public immutable timelock;

    /// Indirizzo che ha deployato il Treasury; puo' collegare il registry una sola volta nel setup.
    address public immutable deployer;

    /// Registry on-chain delle startup investibili.
    /// Il Treasury investe solo verso startup registrate e attive in questo contratto.
    StartupRegistry public startupRegistry;

    /// Mappa che mantiene lo storico di tutti gli investimenti effettuati,
    /// con chiave l'indirizzo startup e valore gli ETH investiti su di essa
    mapping(address => uint256) public investedIn;

    //Eventi
    /// @notice Emesso quando qualcuno deposita ETH nel Treasury
    /// @param depositor Chi ha depositato
    /// @param amount    Importo in wei
    event Deposited(address indexed depositor, uint256 amount);

    /// @notice Emesso quando il Treasury investe in una startup
    /// @param startupId ID registry della startup
    /// @param startup Indirizzo della startup che riceve i fondi
    /// @param amount  Importo in wei
    event Invested(uint256 indexed startupId, address indexed startup, uint256 amount);

    /// Emesso quando viene collegato o aggiornato il registry delle startup.
    event StartupRegistrySet(address indexed registry);

    // Errori custom
    /// @notice Errore: solo il Timelock può chiamare questa funzione
    error OnlyTimelock();

    /// @notice Errore: fondi insufficienti nel Treasury
    error InsufficientBalance();

    /// @notice Errore: il trasferimento ETH alla startup è fallito
    error TransferFailed();

    /// @notice Errore: l'indirizzo fornito è zero (non valido)
    error ZeroAddress();
    error OnlyDeployerOrTimelock(); // Solo deployer in bootstrap o Timelock dopo la governance.
    error RegistryAlreadySet(); // Registry già impostato durante il setup iniziale.
    error RegistryNotSet(); // Registry non ancora collegato al Treasury.
    error StartupInactive(); // Startup non attiva nel registry.
    error ZeroAmount(); // Importo ETH nullo.
    error UseRegisteredStartup(); // La funzione legacy invest() non deve essere usata.

    // Decorator che indica che solo il Timelock può chiamare la funzione decorata
    modifier onlyTimelock() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _;
    }

    // Costruttore che inizializza il Treasury impostando l'indirizzo del TimelockController
    constructor(address _timelock) {
        if (_timelock == address(0)) revert ZeroAddress();
        timelock = _timelock;
        deployer = msg.sender;
    }

    /*
    Collega il registry delle startup al Treasury.
    Durante il bootstrap può farlo il deployer una sola volta.
    Dopo il setup, eventuali sostituzioni devono passare dalla governance e quindi
    arrivare dal TimelockController.
    */
    function setStartupRegistry(address _registry) external {
        if (msg.sender != deployer && msg.sender != timelock) revert OnlyDeployerOrTimelock();
        if (address(startupRegistry) != address(0) && msg.sender != timelock) revert RegistryAlreadySet();
        if (_registry == address(0)) revert ZeroAddress();
        startupRegistry = StartupRegistry(_registry);
        emit StartupRegistrySet(_registry);
    }

    /// Funzione che permette a chiunque di depositare ETH nel Treasury.
    function deposit() external payable {
        if (msg.value == 0) revert ZeroAmount();
        emit Deposited(msg.sender, msg.value);
    }

    /// Funzione che permette al contratto di ricevere ETH direttamente, senza calldata.
    receive() external payable {
        if (msg.value == 0) revert ZeroAmount();
        emit Deposited(msg.sender, msg.value);
    }

    /// Funzione legacy disabilitata: gli investimenti devono passare dal registry.
    function invest(address, uint256) external view onlyTimelock {
        revert UseRegisteredStartup();
    }

    /*
    Funzione che permette alla DAO di investire ETH in una startup registrata e attiva.
    Solo il Timelock può chiamarla, dopo che una proposta di investimento è stata:
    1. creata nel Governor;
    2. votata dalla comunità;
    3. messa in coda nel Timelock;
    4. sbloccata dopo il delay.
    La funzione aggiorna prima lo storico investedIn e poi trasferisce gli ETH
    alla startup, seguendo il pattern Checks-Effects-Interactions.
    */
    function investStartup(
        uint256 _startupId,
        uint256 _amount
    ) external onlyTimelock nonReentrant {
        // Controlli di sicurezza
        if (address(startupRegistry) == address(0)) revert RegistryNotSet();
        if (_amount == 0) revert ZeroAmount();
        if (address(this).balance < _amount) revert InsufficientBalance();

        (, address startupWallet,, bool active) = startupRegistry.getStartup(_startupId);
        if (!active) revert StartupInactive();
        if (startupWallet == address(0)) revert ZeroAddress();

        // Registra l'investimento nello storico (Effects prima di Interactions)
        investedIn[startupWallet] += _amount;

        // Trasferisci ETH alla startup (Interactions)
        (bool success, ) = startupWallet.call{value: _amount}("");
        if (!success) revert TransferFailed();

        emit Invested(_startupId, startupWallet, _amount);
    }

    ///Restituisce il saldo in wei attuale del Treasury
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
