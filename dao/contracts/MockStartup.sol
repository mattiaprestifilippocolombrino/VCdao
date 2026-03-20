// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
Contratto che simula una startup che riceve investimenti dalla DAO.
Verifica nei test che i fondi siano arrivati e registra automaticamente ogni investimento ricevuto.

*/
/// @title MockStartup
/// @notice Contratto fittizio che simula una startup ricevente investimenti
contract MockStartup {
    // ── Variabili di stato ──

    /// Totale ETH ricevuti da questo contratto
    uint256 public totalReceived;

    /// Numero di investimenti ricevuti
    uint256 public investmentCount;

    // ── Eventi ──

    /// Emesso ogni volta che il contratto riceve ETH
    /// @param from   Chi ha inviato i fondi (tipicamente il Treasury via Timelock)
    /// @param amount Importo in wei
    event FundsReceived(address indexed from, uint256 amount);

    // ── Funzione receive ──

    /// Permette al contratto di ricevere ETH e registra l'investimento
    /// Viene chiamata automaticamente quando qualcuno invia ETH al contratto
    receive() external payable {
        // Aggiorna il contatore e il totale
        totalReceived += msg.value;
        investmentCount++;

        emit FundsReceived(msg.sender, msg.value);
    }

    /// Restituisce il saldo ETH attuale del contratto
    /// @return Saldo in wei
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }
}
