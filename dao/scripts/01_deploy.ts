/*
01_deploy.ts — Deploy di tutti i contratti + fondatore entra nella DAO
ESECUZIONE: npx hardhat run scripts/01_deploy.ts --network localhost

ORDINE DI DEPLOY:
1. TimelockController: Esegue le azioni approvate dalla governance, dopo il periodo di attesa
2. GovernanceToken: Token ERC20 con voting e membership (joinDAO)
3. MyGovernor: Contratto di governance (proposte, voti, quorum)
4. Treasury: Custodisce gli ETH della DAO
5. StartupRegistry: Registro delle startup (facoltativo)
6. MockStartup: Startup fittizia per i test di investimento

DOPO IL DEPLOY:
Il fondatore (deployer) chiama joinDAO() con 100 ETH → 100.000 COMP
Gli ETH del fondatore vanno nel Treasury automaticamente
Il fondatore delega i voti a sé stesso per poter votare
I ruoli del Timelock vengono configurati (solo il Governor può proporre)
Gli indirizzi dei contratti vengono salvati in deployedAddresses.json
*/

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

async function main() {
    // Ottieni tutti gli account Hardhat (il primo è il deployer/fondatore)
    const signers = await ethers.getSigners();
    const deployer = signers[0];

    // Parametri di configurazione
    const TIMELOCK_DELAY = 3600;       // 1 ora di attesa prima dell'esecuzione
    const FOUNDER_DEPOSIT = "100";     // 100 ETH → 100.000 token per il deployer
    // Pesi formula VPC (basis points, devono sommare a 10.000).
    const PESO_COMPETENZE = parseInt(process.env.PESO_COMPETENZE ?? "5000");
    const PESO_SOLDI      = parseInt(process.env.PESO_SOLDI      ?? "5000");
    if (PESO_COMPETENZE + PESO_SOLDI !== 10000)
        throw new Error(`PESO_COMPETENZE + PESO_SOLDI deve essere 10000`);

    console.log("══════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Deploy completo");
    console.log("══════════════════════════════════════════════════");
    console.log(`  Deployer: ${deployer.address}\n`);

    // Deploy del TimelockController, che ritarda ed esegue le proposte approvate.
    // Parametri: delay (1h), proposers (vuoti, aggiunti dopo), executors (vuoti),
    //            admin (deployer, poi revocato per decentralizzare)
    //La prima funzione chiede la factory, la componente che permette di creare istanze del contratto.
    //La seconda funzione crea l'istanza del contratto, chiamando il costruttore con i parametri specificati ed eseguendo il deploy.
    //La terza funzione attende che la transazione venga minata e che il contratto venga realmente creato sulla blockchain
    const Timelock = await ethers.getContractFactory("TimelockController");
    const timelock = await Timelock.deploy(TIMELOCK_DELAY, [], [], deployer.address);
    await timelock.waitForDeployment();
    console.log(`1️⃣  TimelockController: ${await timelock.getAddress()}`);


    // Deploy del GovernanceToken.
    const Token = await ethers.getContractFactory("GovernanceToken");
    const token = await Token.deploy(await timelock.getAddress());
    await token.waitForDeployment();
    console.log(`2️⃣  GovernanceToken:    ${await token.getAddress()}`);
    console.log(`   └─ scoreCompetenze: Student=0, Bachelor=25, Master=50, PhD=75, Professor=100`);

    // Deploy del contratto MyGovernor, impostando i parametri di governance principali.
    // Riceve come parametri token, timelock, votingDelay(1), votingPeriod(50),
    //            proposalThreshold(0), quorumPercent(20%), superQuorum(70%)
    // La DAO aspetta 1 blocco prima di votare, poi 50 blocchi per votare.
    // Serve lo 0% dei token ad un utente per proporre (da aggiornare), poi serve il 20% della supply per il quorum, 
    // poi serve il 70% della supply per l'approvazione immediata tramite superquorum.
    const Governor = await ethers.getContractFactory("MyGovernor");
    const governor = await Governor.deploy(
        await token.getAddress(),       // Token per il voting power
        await timelock.getAddress(),    // Timelock per eseguire le proposte
        1,                              // votingDelay: 1 blocco prima di votare
        50,                             // votingPeriod: 50 blocchi per votare
        0,                              // proposalThreshold: 0 COMP per proporre
        20,                             // quorumPercent: 20% della supply
        70,                             // superQuorum: 70% → approvazione immediata
        PESO_COMPETENZE,                // peso accademico in bp
        PESO_SOLDI                      // peso economico in bp
    );
    await governor.waitForDeployment();
    console.log(`3️⃣  MyGovernor:         ${await governor.getAddress()}`);
    console.log(`   └─ pesoCompetenze=${PESO_COMPETENZE} bp | pesoSoldi=${PESO_SOLDI} bp`);

    // Deploy del Treasury della DAO. Riceve come parametro l'indirizzo del Timelock, 
    // in quanto solo il Timelock può chiamare invest().
    const Treasury = await ethers.getContractFactory("Treasury");
    const treasury = await Treasury.deploy(await timelock.getAddress());
    await treasury.waitForDeployment();
    console.log(`4️⃣  Treasury:           ${await treasury.getAddress()}`);

    // Viene effettuato il collegamento tra Token e Treasury, in modo che il token sappia 
    // dove inviare gli ETH mintati dagli utenti che entrano nella DAO. 
    // setTreasury() può essere chiamata una sola volta dal deployer.
    await token.setTreasury(await treasury.getAddress());
    console.log(`   🔗 Token → Treasury collegato`);

    // Imposta l'Issuer fidato (es. Università) per la verifica delle VC.
    // Best practice: issuer esplicito via env, senza fallback impliciti.
    const issuerFromEnv = process.env.DAO_TRUSTED_ISSUER;
    if (!issuerFromEnv || !ethers.isAddress(issuerFromEnv)) {
        throw new Error(
            "Variabile DAO_TRUSTED_ISSUER mancante o non valida. Esempio: DAO_TRUSTED_ISSUER=0xabc... npx hardhat run scripts/01_deploy.ts --network localhost"
        );
    }
    const issuerAddress = ethers.getAddress(issuerFromEnv);

    await token.setTrustedIssuer(issuerAddress);
    console.log(`   🏛️ Issuer fidato impostato: ${issuerAddress}`);

    // Il deployer entra nella DAO e chiama joinDAO() con 100 ETH, ricevendo 100k token.
    // Gli ETH vengono trasferiti automaticamente al Treasury, poi delega i voti a sé stesso per attivare il voting power.
    await token.joinDAO({ value: ethers.parseEther(FOUNDER_DEPOSIT) });
    await token.delegate(deployer.address);
    console.log(`   🔑 Fondatore: ${FOUNDER_DEPOSIT} ETH → ${Number(FOUNDER_DEPOSIT) * 1000} COMP (delegato)`);

    // Deploy dei contratti StartupRegistry e MockStartup.
    const Registry = await ethers.getContractFactory("StartupRegistry");
    const registry = await Registry.deploy(await timelock.getAddress());
    await registry.waitForDeployment();
    const MS = await ethers.getContractFactory("MockStartup");
    const mockStartup = await MS.deploy();
    await mockStartup.waitForDeployment();
    console.log(`5️⃣  StartupRegistry:    ${await registry.getAddress()}`);
    console.log(`6️⃣  MockStartup:        ${await mockStartup.getAddress()}`);

    // Configurazione ruoli del Timelock
    // PROPOSER_ROLE → solo il Governor può mettere in coda le proposte
    // EXECUTOR_ROLE → chiunque (address(0)) può eseguire dopo il delay
    // CANCELLER_ROLE → il Governor può cancellare proposte
    // Infine revochiamo l'admin al deployer, in modo che la DAO è completamente decentralizzata.
    // Il PROPOSER_ROLE del TimeLockController è assegnato al contratto MyGovernor stesso. In realtà 
    // chiunque può inviare una richiesta di proposal, ma solo il governor può sottometterla al TimeLockController.
    const governorAddr = await governor.getAddress();
    await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddr);
    await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
    await timelock.grantRole(await timelock.CANCELLER_ROLE(), governorAddr);
    await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);
    console.log(`\n🔐 Ruoli Timelock configurati`);


    // Tutti gli indirizzi dei contratti vengono salvati in un file JSON, in modo che
    // gli script successivi possano riconnettersi ai contratti deployati.
    // Prepariamo un oggetto Javascript con tutte le mappature Chiave-Indirizzo per la persistenza
    const addresses = {
        token: await token.getAddress(),         // Token per deleghe e pesi di voto
        timelock: await timelock.getAddress(),   // Controller di esecuzione ritardata
        governor: governorAddr,                  // Motore logico delle votazioni
        treasury: await treasury.getAddress(),   // Conto corrente della DAO
        registry: await registry.getAddress(),   // Anagrafica startup supportate
        mockStartup: await mockStartup.getAddress(), // Startup fittizia del test finale
        deployer: deployer.address,              // Chi ha avviato il setup
        issuer: issuerAddress,                   // Università fidata
    };
    
    // Serializziamo l'oggetto in JSON stringificato
    // Salviamo tutto su file locale (deployedAddresses.json) per gli step successivi
    fs.writeFileSync(path.join(__dirname, "..", "deployedAddresses.json"), JSON.stringify(addresses, null, 2));

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ Deploy completo! Prossimo: 02_joinMembers.ts");
    console.log("══════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
