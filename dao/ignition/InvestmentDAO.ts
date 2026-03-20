// ============================================================================
//  InvestmentDAO Ignition Module — Deploy completo con Hardhat Ignition
// ============================================================================
//
//  COSA FA QUESTO MODULO:
//  ──────────────────────
//  Hardhat Ignition è il sistema di deploy dichiarativo di Hardhat.
//  Invece di scrivere script imperativi (deploy A, poi B, poi C...),
//  definiamo i contratti e le loro dipendenze, e Ignition gestisce
//  l'ordine di deploy automaticamente.
//
//  ORDINE DI DEPLOY:
//  1. GovernanceToken  — nessuna dipendenza
//  2. TimelockController — nessuna dipendenza (parametro: minDelay)
//  3. MyGovernor — dipende da Token + Timelock
//  4. Treasury — dipende da Timelock (solo il Timelock può chiamare invest)
//  5. StartupRegistry — nessuna dipendenza
//  6. MockStartup — nessuna dipendenza
//
//  SETUP RUOLI (post-deploy):
//  - PROPOSER_ROLE  → Governor (propone operazioni al Timelock)
//  - EXECUTOR_ROLE  → address(0) (chiunque può eseguire dopo il delay)
//  - CANCELLER_ROLE → Governor (può cancellare operazioni in coda)
//  - ADMIN_ROLE     → revocato dal deployer (sicurezza)
// ============================================================================

import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

// ── Parametri di governance (modificabili per test/produzione) ──
const VOTING_DELAY = 1;            // 1 blocco di attesa prima del voto
const VOTING_PERIOD = 50;          // 50 blocchi di finestra di voto
const PROPOSAL_THRESHOLD = 0;     // chiunque può proporre (didattico)
const QUORUM_PERCENT = 20;         // 20% della supply per raggiungere il quorum
const SUPER_QUORUM_PERCENT = 70;   // 70% per il superquorum (approvazione rapida)
const TIMELOCK_MIN_DELAY = 3600;   // 1 ora di delay nel Timelock (in secondi)

// ── Hash dei ruoli del TimelockController (precalcolati con keccak256) ──
const PROPOSER_ROLE = "0xb09aa5aeb3702cfd50b6b62bc4532604938f21248a27a1d5ca736082b6819cc1";
const EXECUTOR_ROLE = "0xd8aa0f3194971a2a116679f7c2090f6939c8d4e01a2a8d7e41d55e5351469e63";
const CANCELLER_ROLE = "0xfd643c72710c63c0180259aba6b2d05451e3591a24e58b62239378085726f783";
const ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// ============================================================================
//  Modulo principale: InvestmentDAO
// ============================================================================
const InvestmentDAOModule = buildModule("InvestmentDAOModule", (m) => {

    // Account del deployer (primo account Hardhat)
    const deployer = m.getAccount(0);

    // ── 1. GovernanceToken ──
    // Token ERC20 con voti delegabili. Il deployer riceve 1.000.000 INV.
    const token = m.contract("GovernanceToken");

    // ── 2. TimelockController ──
    // Strato di sicurezza: impone un ritardo (1h) prima di eseguire operazioni.
    // - proposers/executors vuoti: li configuriamo dopo con grantRole
    // - admin = deployer (temporaneo, verrà revocato)
    const timelock = m.contract("TimelockController", [
        TIMELOCK_MIN_DELAY,
        [],              // proposers (vuoto, configuriamo dopo)
        [],              // executors (vuoto, configuriamo dopo)
        deployer,        // admin temporaneo
    ]);

    // ── 3. MyGovernor ──
    // Il "cervello" della DAO: proposte, voti, quorum, superquorum, timelock.
    const governor = m.contract("MyGovernor", [
        token,                  // Token ERC20Votes
        timelock,               // TimelockController
        VOTING_DELAY,           // Ritardo prima del voto (blocchi)
        VOTING_PERIOD,          // Durata del voto (blocchi)
        PROPOSAL_THRESHOLD,     // Soglia per proporre
        QUORUM_PERCENT,         // Quorum 20%
        SUPER_QUORUM_PERCENT,   // Superquorum 70%
    ]);

    // ── 4. Treasury ──
    // Custodisce gli ETH della DAO. Solo il Timelock può chiamare invest().
    const treasury = m.contract("Treasury", [timelock]);

    // ── 5. StartupRegistry ──
    // Registro delle startup (didattico, rende il progetto realistico).
    const registry = m.contract("StartupRegistry");

    // ── 6. MockStartup ──
    // Startup fittizia per test e demo.
    const mockStartup = m.contract("MockStartup");

    // ══════════════════════════════════════════════════════════
    //  Setup ruoli del TimelockController
    // ══════════════════════════════════════════════════════════

    // Il Governor diventa PROPOSER (solo lui può proporre operazioni al Timelock)
    const grantProposer = m.call(timelock, "grantRole", [PROPOSER_ROLE, governor], {
        id: "grantProposerRole",
    });

    // Chiunque (address zero) può eseguire operazioni scadute il delay
    const grantExecutor = m.call(timelock, "grantRole", [EXECUTOR_ROLE, ZERO_ADDRESS], {
        id: "grantExecutorRole",
    });

    // Il Governor può cancellare operazioni in coda
    const grantCanceller = m.call(timelock, "grantRole", [CANCELLER_ROLE, governor], {
        id: "grantCancellerRole",
    });

    // Il deployer rinuncia al ruolo admin → il Timelock si auto-gestisce
    // IMPORTANTE: facciamo questo PER ULTIMO, dopo aver concesso tutti i ruoli!
    m.call(timelock, "revokeRole", [ADMIN_ROLE, deployer], {
        id: "revokeAdminRole",
        after: [grantProposer, grantExecutor, grantCanceller],
    });

    return {
        token,
        timelock,
        governor,
        treasury,
        registry,
        mockStartup,
    };
});

export default InvestmentDAOModule;
