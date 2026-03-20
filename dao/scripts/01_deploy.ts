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
    // Ottieni il primo account Hardhat (il deployer/fondatore)
    const [deployer] = await ethers.getSigners();

    // Parametri di configurazione
    const TIMELOCK_DELAY = 3600;       // 1 ora di attesa prima dell'esecuzione
    const FOUNDER_DEPOSIT = "100";     // 100 ETH → 100.000 token per il deployer

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


    // Deploy del GovernanceToken. Riceve in inputl'indirizzo del Timelock, utilizzato dal token per fare gli upgrade.
    const Token = await ethers.getContractFactory("GovernanceToken");
    const token = await Token.deploy(await timelock.getAddress());
    await token.waitForDeployment();
    console.log(`2️⃣  GovernanceToken:    ${await token.getAddress()}`);

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
        70                              // superQuorum: 70% → approvazione immediata
    );
    await governor.waitForDeployment();
    console.log(`3️⃣  MyGovernor:         ${await governor.getAddress()}`);

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

    // Il deployer entra nella DAO e chiama joinDAO() con 100 ETH, ricevendo 100k token.
    // Gli ETH vengono trasferiti automaticamente al Treasury, poi delega i voti a sé stesso per attivare il voting power.
    await token.joinDAO({ value: ethers.parseEther(FOUNDER_DEPOSIT) });
    await token.delegate(deployer.address);
    console.log(`   🔑 Fondatore: ${FOUNDER_DEPOSIT} ETH → ${Number(FOUNDER_DEPOSIT) * 1000} COMP (delegato)`);

    // Deploy dei contratti StartupRegistry e MockStartup.
    const Registry = await ethers.getContractFactory("StartupRegistry");
    const registry = await Registry.deploy();
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
    const addresses = {
        token: await token.getAddress(),
        timelock: await timelock.getAddress(),
        governor: governorAddr,
        treasury: await treasury.getAddress(),
        registry: await registry.getAddress(),
        mockStartup: await mockStartup.getAddress(),
        deployer: deployer.address,
    };
    fs.writeFileSync(path.join(__dirname, "..", "deployedAddresses.json"), JSON.stringify(addresses, null, 2));

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ Deploy completo! Prossimo: 02_joinMembers.ts");
    console.log("══════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
