// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

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
5. Dopo il delay, il Timelock esegue Treasury.invest() → ETH va alla startup
*/

contract Treasury {
    /// Indirizzo del TimelockController, l'unico che può ordinare investimenti
    address public timelock;

    /// Mappa che mantiene lo storico di tutti gli investimenti effettuati,
    /// con chiave l'indirizzo startup e valore gli ETH investiti su di essa
    mapping(address => uint256) public investedIn;

    //Eventi
    /// @notice Emesso quando qualcuno deposita ETH nel Treasury
    /// @param depositor Chi ha depositato
    /// @param amount    Importo in wei
    event Deposited(address indexed depositor, uint256 amount);

    /// @notice Emesso quando il Treasury investe in una startup
    /// @param startup Indirizzo della startup che riceve i fondi
    /// @param amount  Importo in wei
    event Invested(address indexed startup, uint256 amount);

    // Errori custom
    /// @notice Errore: solo il Timelock può chiamare questa funzione
    error OnlyTimelock();

    /// @notice Errore: fondi insufficienti nel Treasury
    error InsufficientBalance();

    /// @notice Errore: il trasferimento ETH alla startup è fallito
    error TransferFailed();

    /// @notice Errore: l'indirizzo fornito è zero (non valido)
    error ZeroAddress();

    // Decorator che indica che solo il Timelock può chiamare la funzione decorata
    modifier onlyTimelock() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _;
    }

    // Costruttore che inizializza il Treasury impostando l'indirizzo del TimelockController
    constructor(address _timelock) {
        if (_timelock == address(0)) revert ZeroAddress();
        timelock = _timelock;
    }

    /// Funzione che permette a chiunque di depositare ETH nel Treasury
    function deposit() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// Funzione che permette al contratto di ricevere ETH direttamente (senza calldata)
    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    /// Funzione che permette alla DAO di investire ETH in una startup. Solo il Timelock può chiamare questa funzione
    /// Prende in input l'indirizzo della startup destinataria e l'importo in wei da investire
    /// Viene chiamata dal Timelock dopo che una proposta di investimento è stata approvata e il delay è trascorso
    // Incrementa l'importo investito nella startup e trasferisce ETH alla startup
    function invest(address _startup, uint256 _amount) external onlyTimelock {
        // Controlli di sicurezza
        if (_startup == address(0)) revert ZeroAddress();
        if (address(this).balance < _amount) revert InsufficientBalance();

        // Registra l'investimento nello storico
        investedIn[_startup] += _amount;

        // Trasferisci ETH alla startup
        (bool success, ) = _startup.call{value: _amount}("");
        if (!success) revert TransferFailed();

        emit Invested(_startup, _amount);
    }

    ///Restituisce il saldo in wei attuale del Treasury
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
