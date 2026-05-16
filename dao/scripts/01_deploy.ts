/*
01_deploy.ts — Deploy completo di tutti i contratti della CompetenceDAO
ESECUZIONE: npx hardhat run scripts/01_deploy.ts --network localhost

PREREQUISITI:
  - Hardhat node locale in esecuzione: npx hardhat node
  - Variabile d'ambiente DAO_TRUSTED_ISSUER impostata con l'address dell'issuer fidato (università).
    Esempio: DAO_TRUSTED_ISSUER=0xAbc... npx hardhat run scripts/01_deploy.ts --network localhost

ORDINE DI DEPLOY:
  1. TimelockController — Ritarda l'esecuzione delle proposte approvate (1 ora di delay).
  2. GovernanceToken    — Token ERC20Votes con sistema di membership e VP multi-topic.
  3. MyGovernor        — Motore di governance: gestisce proposte, voti e quorum.
  4. Treasury          — Custodisce gli ETH della DAO; solo il Timelock può investirli.
  5. StartupRegistry   — Registro on-chain delle startup verso cui la DAO può investire.
  6. MockStartup       — Startup fittizia per i test locali del flusso di investimento.

CONFIGURAZIONE POST-DEPLOY:
  - Il fondatore (deployer, signers[0]) entra nella DAO con 100 ETH via joinDAO().
  - Il fondatore delega i propri voti a sé stesso per attivare il voting power ERC20Votes.
  - I ruoli del Timelock vengono assegnati: solo il Governor può proporre; chiunque può eseguire.
  - Il DEFAULT_ADMIN_ROLE viene revocato al deployer → la DAO è completamente decentralizzata.
  - Gli indirizzi vengono salvati in deployedAddresses.json per gli script successivi.

FORMULA VP (con pesi 50/50):
  VP_totale(account, topic) = VP_stake(account) + VP_skill(account, topic)
  VP_stake  = min(stakeDeposited / 100 ETH, 1) × weightStake  × 10^18 / BASIS_POINTS
  VP_skill  = skillScore(grado, topic)          × weightSkill × 10^18 / BASIS_POINTS
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";

async function main() {
    // ── Account ──────────────────────────────────────────────────────────────
    // Hardhat mette a disposizione 20 account di test con 10.000 ETH ciascuno.
    // signers[0] è il deployer e il fondatore della DAO.
    const signers  = await ethers.getSigners();
    const deployer = signers[0];

    // ── Parametri di configurazione ──────────────────────────────────────────
    // Il TIMELOCK_DELAY è il numero di secondi che devono passare tra la coda
    // e l'esecuzione di una proposta. In produzione si usa 24-72 ore.
    const TIMELOCK_DELAY  = 3600;   // 1 ora (in secondi)
    const FOUNDER_DEPOSIT = "100";  // ETH depositati dal fondatore (massimo consentito)

    // I pesi della formula VP sono espressi in basis points (1 bp = 0.01%).
    // Devono sommare a 10.000 (100%). Qui il 50% va allo stake e il 50% alle skill.
    const WEIGHT_SKILL = parseInt(process.env.WEIGHT_SKILL ?? "5000");
    const WEIGHT_STAKE = parseInt(process.env.WEIGHT_STAKE ?? "5000");
    if (WEIGHT_SKILL + WEIGHT_STAKE !== 10_000)
        throw new Error(`WEIGHT_SKILL (${WEIGHT_SKILL}) + WEIGHT_STAKE (${WEIGHT_STAKE}) deve essere 10.000`);

    console.log("══════════════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Deploy completo");
    console.log("══════════════════════════════════════════════════════════");
    console.log(`  Deployer:     ${deployer.address}`);
    console.log(`  weightStake:  ${WEIGHT_STAKE} bp (${WEIGHT_STAKE / 100}%)`);
    console.log(`  weightSkill:  ${WEIGHT_SKILL} bp (${WEIGHT_SKILL / 100}%)`);
    console.log(`  timelockDelay: ${TIMELOCK_DELAY}s\n`);

    // ── 1. TimelockController ─────────────────────────────────────────────────
    // Il Timelock è il "cancelliere" della DAO: tutte le decisioni approvate
    // devono aspettare qui per il delay configurato prima di essere eseguite.
    // Questo dà tempo alla comunità di reagire a proposte malevole.
    //
    // Parametri del costruttore:
    //   minDelay   → secondi minimi tra coda ed esecuzione
    //   proposers  → [] vuoto: verrà assegnato al Governor subito dopo
    //   executors  → [] vuoto: verrà assegnato a address(0) = chiunque
    //   admin      → deployer, poi revocato per decentralizzare
    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(TIMELOCK_DELAY, [], [], deployer.address);
    await timelock.waitForDeployment();
    console.log(`1️⃣  TimelockController: ${await timelock.getAddress()}`);

    // ── 2. GovernanceToken ───────────────────────────────────────────────────
    // Implementa ERC20 + ERC20Votes per i token stake, e aggiunge checkpoint
    // per il VP skill (multi-topic: CS=0, CE=1, EE=2).
    // Il costruttore richiede: indirizzo Timelock, weightSkill, weightStake.
    const Token = await ethers.getContractFactory("GovernanceToken");
    const token = await Token.deploy(
        await timelock.getAddress(),
        WEIGHT_SKILL,
        WEIGHT_STAKE
    );
    await token.waitForDeployment();
    console.log(`2️⃣  GovernanceToken:    ${await token.getAddress()}`);
    console.log(`   └─ skillScore: Student=0 | Bachelor=25 | Master=50 | PhD=75 | Professor=100`);

    // ── 3. MyGovernor ────────────────────────────────────────────────────────
    // Motore di governance multi-topic.
    // Ogni proposta è associata a un topicId (CS/CE/EE) via proposeWithTopic().
    // Il voting power usato è VP_stake + VP_skill(topic).
    // Il quorum e il superquorum vengono calcolati sulla supply totale del topic.
    //
    // Parametri del costruttore:
    //   token_               → GovernanceToken (IVotes)
    //   timelock_            → TimelockController
    //   votingDelay_         → blocchi prima che inizi il voto (1 blocco ≈ 12s)
    //   votingPeriod_        → blocchi di durata del voto (50 blocchi ≈ 10 min)
    //   proposalThreshold_   → VP minimi per proporre (0 = chiunque)
    //   quorumNumerator_     → % supply per il quorum (20 = 20%)
    //   superQuorumNumerator_→ % supply per approvazione immediata (70 = 70%)
    const Governor = await ethers.getContractFactory("MyGovernor");
    const governor = await Governor.deploy(
        await token.getAddress(),
        await timelock.getAddress(),
        1,   // votingDelay: 1 blocco
        50,  // votingPeriod: 50 blocchi
        0,   // proposalThreshold: 0 token (nessun requisito)
        20,  // quorumPercent: 20% della supply totale del topic
        70   // superQuorum: 70% → approvazione immediata prima della fine del period
    );
    await governor.waitForDeployment();
    console.log(`3️⃣  MyGovernor:         ${await governor.getAddress()}`);
    console.log(`   └─ votingDelay=1 blk | votingPeriod=50 blk | quorum=20% | superquorum=70%`);

    // ── 4. Treasury ───────────────────────────────────────────────────────────
    // Custodisce tutti gli ETH depositati dai membri tramite joinDAO().
    // Solo il TimelockController può chiamare investStartup() per spostare i fondi.
    // Questo garantisce che nessun individuo possa spendere i fondi senza il voto.
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(await timelock.getAddress());
    await treasury.waitForDeployment();
    console.log(`4️⃣  Treasury:           ${await treasury.getAddress()}`);

    // Collega il Treasury al Token: joinDAO() e increaseStake() invieranno gli
    // ETH direttamente al Treasury. setTreasury() è one-shot: solo il deployer
    // può chiamarla e solo una volta.
    await token.setTreasury(await treasury.getAddress());
    console.log(`   🔗 GovernanceToken → Treasury collegato`);

    // ── Issuer fidato ────────────────────────────────────────────────────────
    // L'issuer è l'entità (es. università) che firma le Verifiable Credential
    // con EIP-712. Il contratto verificherà che ogni VC sia firmata da questo
    // address prima di accettare un upgrade di competenza.
    // Obbligatorio come variabile d'ambiente per sicurezza (nessun fallback implicito).
    const issuerFromEnv = process.env.DAO_TRUSTED_ISSUER;
    if (!issuerFromEnv || !ethers.isAddress(issuerFromEnv))
        throw new Error(
            "DAO_TRUSTED_ISSUER mancante o non valido.\n" +
            "Esempio: DAO_TRUSTED_ISSUER=0xAbc... npx hardhat run scripts/01_deploy.ts --network localhost"
        );
    const issuerAddress = ethers.getAddress(issuerFromEnv);
    await token.setTrustedIssuer(issuerAddress);
    console.log(`   🏛️  Issuer fidato: ${issuerAddress}`);

    // ── Fondatore entra nella DAO ─────────────────────────────────────────────
    // Il deployer (signers[0]) entra come primo membro con il deposito massimo.
    // Formula: tokens = 100 × weightStake × 1e18 / (100 ETH × 10000) = 50 token (con peso 50%)
    // Gli ETH vengono trasferiti automaticamente al Treasury.
    // La delega è necessaria per attivare il voting power ERC20Votes:
    // senza delegate(), i token non vengono conteggiati nel voto.
    // La delega è assolutamente necessaria affinché il token pesi nel voto:
    await token.joinDAO({ value: ethers.parseEther(FOUNDER_DEPOSIT) });
    await token.delegate(deployer.address);
    const deployerBal = await token.balanceOf(deployer.address);
    console.log(`   🔑 Fondatore: ${FOUNDER_DEPOSIT} ETH → ${ethers.formatEther(deployerBal)} COMP (delegato)`);

    // ── 5. StartupRegistry ────────────────────────────────────────────────────
    // Registro on-chain delle startup verso cui la DAO può investire.
    // Solo il Timelock può registrare, disattivare o riattivare startup.
    // In questo modo ogni startup deve essere approvata dalla governance.
    const Registry = await ethers.getContractFactory("StartupRegistry");
    const registry = await Registry.deploy(await timelock.getAddress());
    await registry.waitForDeployment();
    console.log(`5️⃣  StartupRegistry:    ${await registry.getAddress()}`);

    // ── 6. MockStartup ────────────────────────────────────────────────────────
    // Contratto fittizio che simula una startup con wallet per ricevere ETH.
    // Usata per verificare che il flusso investimento funzioni correttamente.
    const MS = await ethers.getContractFactory("MockStartup");
    const mockStartup = await MS.deploy();
    await mockStartup.waitForDeployment();
    console.log(`6️⃣  MockStartup:        ${await mockStartup.getAddress()}`);

    // Collega il Registry al Treasury: investStartup() verificherà che la
    // startup target sia registrata e attiva in questo registry.
    await treasury.setStartupRegistry(await registry.getAddress());
    console.log(`   🔗 Treasury → StartupRegistry collegato`);

    // ── Registrazione MockStartup (solo per demo locale) ──────────────────────
    // In produzione, ogni startup deve essere registrata via proposta di governance.
    // Qui impersoniamo il Timelock per registrare la MockStartup come ID 0,
    // così il flusso locale di test funziona senza dover fare una governance completa.
    // Nota: hardhat_impersonateAccount è disponibile solo sulla rete Hardhat locale.
    const timelockAddr = await timelock.getAddress();
    let impersonated = false;
    try {
        await ethers.provider.send("hardhat_impersonateAccount", [timelockAddr]);
        impersonated = true;
        // Finanzia il Timelock con 1 ETH per pagare il gas dell'impersonazione
        await deployer.sendTransaction({ to: timelockAddr, value: ethers.parseEther("1") });
        const timelockSigner = await ethers.getSigner(timelockAddr);
        await registry.connect(timelockSigner).registerStartup(
            "MockStartup Demo",
            await mockStartup.getAddress(),
            "Startup fittizia per il flusso dimostrativo locale"
        );
        console.log(`   🏢 MockStartup registrata nel registry con ID 0`);
    } catch {
        console.log(`   ℹ️  Registra le startup via governance prima di investire.`);
    } finally {
        if (impersonated)
            await ethers.provider.send("hardhat_stopImpersonatingAccount", [timelockAddr]);
    }

    // ── Configurazione ruoli Timelock ─────────────────────────────────────────
    // Il Timelock usa un sistema di ruoli per controllare chi può fare cosa:
    //   PROPOSER_ROLE  → solo il Governor può mettere in coda le proposte approvate
    //   EXECUTOR_ROLE  → address(0) = chiunque può eseguire dopo il delay
    //   CANCELLER_ROLE → il Governor può cancellare proposte (emergenza)
    // Infine revochiamo DEFAULT_ADMIN_ROLE al deployer:
    // da questo momento nessuno ha controllo assoluto → la DAO è decentralizzata.
    const governorAddr = await governor.getAddress();
    await timelock.grantRole(await timelock.PROPOSER_ROLE(),  governorAddr);
    await timelock.grantRole(await timelock.EXECUTOR_ROLE(),  ethers.ZeroAddress);
    await timelock.grantRole(await timelock.CANCELLER_ROLE(), governorAddr);
    await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);
    console.log(`\n🔐 Ruoli Timelock configurati (admin revocato al deployer)`);

    // ── Salvataggio indirizzi ─────────────────────────────────────────────────
    // Tutti gli indirizzi vengono salvati in deployedAddresses.json.
    // Gli script successivi (02..08) leggeranno da questo file per connettersi
    // ai contratti già deployati senza rideploy.
    const addresses = {
        token:        await token.getAddress(),
        timelock:     await timelock.getAddress(),
        governor:     governorAddr,
        treasury:     await treasury.getAddress(),
        registry:     await registry.getAddress(),
        mockStartup:  await mockStartup.getAddress(),
        mockStartupId: 0,                            // ID della MockStartup nel registry
        deployer:     deployer.address,
        issuer:       issuerAddress,
        weightSkill:  WEIGHT_SKILL,
        weightStake:  WEIGHT_STAKE,
    };
    fs.writeFileSync(
        path.join(__dirname, "..", "deployedAddresses.json"),
        JSON.stringify(addresses, null, 2)
    );

    // ── Riepilogo ────────────────────────────────────────────────────────────
    const treasuryBal = await treasury.getBalance();
    console.log("\n══════════════════════════════════════════════════════════");
    console.log("  📋 RIEPILOGO DEPLOY");
    console.log("══════════════════════════════════════════════════════════");
    console.log(`  Treasury balance: ${ethers.formatEther(treasuryBal)} ETH`);
    console.log(`  Token supply:     ${ethers.formatEther(await token.totalSupply())} COMP`);
    console.log(`  Fondatore VP:     ${ethers.formatEther(await token.getVotes(deployer.address))} COMP`);
    console.log("\n  ✅ Deploy completato! Prossimo step: npx hardhat run scripts/02_joinMembers.ts --network localhost");
    console.log("══════════════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
