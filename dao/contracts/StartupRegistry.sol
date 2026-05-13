// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
Contratto che mantiene un registro on-chain di startup/progetti verso cui la DAO può investire.
Invece di proporre investimenti verso indirizzi "random", la DAO può
verificare che la startup sia registrata e attiva.
Solo la governance (TimelockController) può registrare o
disattivare startup.
*/

contract StartupRegistry {
    /*
    Struttura dati che rappresenta una startup investibile.
    Il wallet è l'indirizzo che riceverà gli ETH dal Treasury.
    Il flag active permette alla governance di sospendere una startup senza cancellare
    lo storico o cambiare gli ID già usati nelle proposte.
    */
    struct Startup {
        string name; // Nome della startup
        address wallet; // Indirizzo wallet che riceverà gli investimenti
        string description; // Breve descrizione del progetto
        bool active; // true = la startup può ricevere investimenti
    }

    // Variabili di stato

    /// Indirizzo del TimelockController (unica autorità per registrazione/disattivazione)
    address public timelock;

    /// Contatore delle startup registrate (usato come ID)
    uint256 public startupCount;

    /// Mapping ID → dati della startup
    mapping(uint256 => Startup) public startups;

    // Eventi

    /// Emesso quando una nuova startup viene registrata
    event StartupRegistered(uint256 indexed id, string name, address wallet);

    /// Emesso quando una startup viene disattivata
    event StartupDeactivated(uint256 indexed id);

    /// Emesso quando una startup viene riattivata
    event StartupReactivated(uint256 indexed id);

    // Errori

    /// Solo il TimelockController (governance) può eseguire questa azione
    error OnlyTimelock();

    /// L'ID della startup non esiste
    error StartupNotFound();

    /// L'indirizzo fornito è zero
    error ZeroAddress();

    // Modifier

    /// Permette l'accesso solo alla governance (TimelockController)
    modifier onlyTimelock() {
        if (msg.sender != timelock) revert OnlyTimelock();
        _;
    }

    /*
    Costruttore che imposta il TimelockController come unica autorità del registry.
    In questo modo registrazioni, disattivazioni e riattivazioni possono arrivare
    solo da proposte approvate dalla governance.
    */
    constructor(address _timelock) {
        if (_timelock == address(0)) revert ZeroAddress();
        timelock = _timelock;
    }

    // Funzioni pubbliche

    /*
    Registra una nuova startup nel registro.
    L'ID assegnato è il valore corrente di startupCount e viene poi incrementato.
    Solo il Timelock può chiamare questa funzione, quindi ogni inserimento deve essere
    stato approvato tramite il normale ciclo di governance.

    @param _name        Nome della startup.
    @param _wallet      Indirizzo wallet della startup.
    @param _description Breve descrizione del progetto.
    @return id          ID assegnato alla startup.
    */
    function registerStartup(
        string calldata _name,
        address _wallet,
        string calldata _description
    ) external onlyTimelock returns (uint256 id) {
        if (_wallet == address(0)) revert ZeroAddress();

        // L'ID è semplicemente il contatore corrente (parte da 0)
        id = startupCount;
        startups[id] = Startup({
            name: _name,
            wallet: _wallet,
            description: _description,
            active: true
        });

        // Incrementa il contatore per la prossima startup
        startupCount++;

        emit StartupRegistered(id, _name, _wallet);
    }

    /*
    Disattiva una startup registrata.
    Una startup disattivata resta nello storico, ma il Treasury non potrà più
    investire verso di essa finché non viene riattivata.
    */
    function deactivateStartup(uint256 _id) external onlyTimelock {
        if (_id >= startupCount) revert StartupNotFound();
        startups[_id].active = false;

        emit StartupDeactivated(_id);
    }

    /// Riattiva una startup precedentemente disattivata dalla governance.
    function reactivateStartup(uint256 _id) external onlyTimelock {
        if (_id >= startupCount) revert StartupNotFound();
        startups[_id].active = true;

        emit StartupReactivated(_id);
    }

    /*
    Restituisce i dati completi di una startup.
    È usata dal Treasury prima di investire per recuperare wallet e stato active.
    */
    function getStartup(
        uint256 _id
    )
        external
        view
        returns (
            string memory name,
            address wallet,
            string memory description,
            bool active
        )
    {
        if (_id >= startupCount) revert StartupNotFound();
        Startup storage s = startups[_id];
        return (s.name, s.wallet, s.description, s.active);
    }

    /// Verifica se una startup è attiva e quindi potenzialmente investibile.
    function isActive(uint256 _id) external view returns (bool) {
        if (_id >= startupCount) revert StartupNotFound();
        return startups[_id].active;
    }
}
