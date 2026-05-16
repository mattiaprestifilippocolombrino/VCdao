// ============================================================================
//  04_treasury.test.ts — Test del Treasury e flusso investimento startup
//
//  Verifica:
//    - deposit() e receive(): accettano ETH da chiunque
//    - invest() legacy: deve revertare (UseRegisteredStartup)
//    - investStartup(): solo Timelock, startup attiva, amount > 0, balance sufficiente
//    - setStartupRegistry: one-shot dal deployer, poi solo dal Timelock
//    - Flusso governance completo: proposta investimento → vote → execute → ETH a startup
//    - StartupRegistry: registerStartup, deactivateStartup, reactivateStartup
// ============================================================================

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import {
    GovernanceToken,
    MyGovernor,
    Treasury,
    StartupRegistry,
    TimelockController,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ────────────────────────────────────────────────────────────────────────────
//  Helper: impersona il Timelock per chiamate dirette
// ────────────────────────────────────────────────────────────────────────────
async function asTimelock(
    timelock: TimelockController,
    funder:   HardhatEthersSigner,
    fn:       (s: HardhatEthersSigner) => Promise<any>
) {
    const addr = await timelock.getAddress();
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
    await funder.sendTransaction({ to: addr, value: ethers.parseEther("2") });
    const signer = await ethers.getSigner(addr);
    const result = await fn(signer);
    await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [addr] });
    return result;
}

// Helper: estrae il proposalId dai log
async function getProposalId(governor: MyGovernor, tx: any): Promise<bigint> {
    const receipt = await tx.wait();
    return receipt!.logs
        .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
        .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;
}

// ────────────────────────────────────────────────────────────────────────────
//  Suite
// ────────────────────────────────────────────────────────────────────────────
describe("Treasury & StartupRegistry — Investimenti e Access Control", function () {
    let token:    GovernanceToken;
    let governor: MyGovernor;
    let treasury: Treasury;
    let registry: StartupRegistry;
    let timelock: TimelockController;
    let deployer: HardhatEthersSigner;
    let alice:    HardhatEthersSigner;
    let startup:  HardhatEthersSigner; // wallet della startup

    const VOTING_DELAY   = 1;
    const VOTING_PERIOD  = 50;
    const TIMELOCK_DELAY = 3600;

    beforeEach(async function () {
        [deployer, alice, startup] = await ethers.getSigners();

        // 1. Timelock
        const TL = await ethers.getContractFactory("TimelockController");
        timelock = await TL.deploy(TIMELOCK_DELAY, [], [], deployer.address);
        await timelock.waitForDeployment();

        // 2. Token
        const TK = await ethers.getContractFactory("GovernanceToken");
        token = await TK.deploy(await timelock.getAddress(), 5000n, 5000n);
        await token.waitForDeployment();

        // 3. Treasury
        const TR = await ethers.getContractFactory("Treasury");
        treasury = await TR.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();

        // 4. StartupRegistry (solo il Timelock può registrare startup)
        const SR = await ethers.getContractFactory("StartupRegistry");
        registry = await SR.deploy(await timelock.getAddress());
        await registry.waitForDeployment();

        // 5. Setup: collega treasury al token e registry al treasury
        await token.setTreasury(await treasury.getAddress());
        await treasury.setStartupRegistry(await registry.getAddress());

        // 6. Governor
        const GV = await ethers.getContractFactory("MyGovernor");
        governor = await GV.deploy(
            await token.getAddress(), await timelock.getAddress(),
            VOTING_DELAY, VOTING_PERIOD, 0, 20, 70
        );
        await governor.waitForDeployment();

        const govAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), govAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
        await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

        // 7. Deployer entra nella DAO (100 ETH → 50 token, auto-delegati)
        await token.joinDAO({ value: ethers.parseEther("100") });
        await token.delegate(deployer.address);
        await mine(1);
    });

    // ========================================================================
    //  SEZIONE 1 — Depositi nel Treasury
    // ========================================================================
    describe("1. Depositi nel Treasury", function () {

        it("deposit() accetta ETH e aggiorna il saldo", async function () {
            const before = await treasury.getBalance();
            await treasury.connect(alice).deposit({ value: ethers.parseEther("5") });
            expect(await treasury.getBalance()).to.equal(before + ethers.parseEther("5"));
        });

        it("receive() accetta ETH inviati direttamente", async function () {
            await alice.sendTransaction({
                to: await treasury.getAddress(),
                value: ethers.parseEther("3"),
            });
            expect(await treasury.getBalance()).to.be.gte(ethers.parseEther("3"));
        });

        it("deposit() revert ZeroAmount se inviato 0 ETH", async function () {
            await expect(
                treasury.connect(alice).deposit({ value: 0 })
            ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
        });

        it("joinDAO trasferisce gli ETH dal membro al Treasury", async function () {
            const before = await treasury.getBalance();
            await token.connect(alice).joinDAO({ value: ethers.parseEther("10") });
            await token.connect(alice).delegate(alice.address);
            // Il Treasury riceve gli ETH dal GovernanceToken
            expect(await treasury.getBalance()).to.equal(before + ethers.parseEther("10"));
        });
    });

    // ========================================================================
    //  SEZIONE 2 — StartupRegistry
    // ========================================================================
    describe("2. StartupRegistry", function () {

        it("registerStartup: solo il Timelock può registrare", async function () {
            await expect(
                registry.connect(alice).registerStartup("StartupX", startup.address, "desc")
            ).to.be.revertedWithCustomError(registry, "OnlyTimelock");
        });

        it("registerStartup: il Timelock può registrare una startup", async function () {
            await asTimelock(timelock, deployer,
                s => registry.connect(s).registerStartup("StartupA", startup.address, "Desc A"));

            expect(await registry.startupCount()).to.equal(1n);
            const [name, wallet, , active] = await registry.getStartup(0);
            expect(name).to.equal("StartupA");
            expect(wallet).to.equal(startup.address);
            expect(active).to.be.true;
        });

        it("deactivateStartup: il Timelock può disattivare", async function () {
            await asTimelock(timelock, deployer,
                s => registry.connect(s).registerStartup("StartupB", startup.address, "Desc B"));
            await asTimelock(timelock, deployer,
                s => registry.connect(s).deactivateStartup(0));

            const [, , , active] = await registry.getStartup(0);
            expect(active).to.be.false;
        });

        it("reactivateStartup: ripristina lo stato active", async function () {
            await asTimelock(timelock, deployer,
                s => registry.connect(s).registerStartup("StartupC", startup.address, "Desc C"));
            await asTimelock(timelock, deployer,
                s => registry.connect(s).deactivateStartup(0));
            await asTimelock(timelock, deployer,
                s => registry.connect(s).reactivateStartup(0));

            expect(await registry.isActive(0)).to.be.true;
        });

        it("getStartup: revert StartupNotFound per ID inesistente", async function () {
            await expect(registry.getStartup(99)).to.be.revertedWithCustomError(
                registry, "StartupNotFound"
            );
        });
    });

    // ========================================================================
    //  SEZIONE 3 — investStartup() via Timelock diretto
    // ========================================================================
    describe("3. investStartup() — Access Control e Guard", function () {

        beforeEach(async function () {
            // Registra una startup e metti ETH nel treasury
            await asTimelock(timelock, deployer,
                s => registry.connect(s).registerStartup("TestStartup", startup.address, "Test"));
            // Il treasury ha già ETH dal joinDAO del deployer (100 ETH)
        });

        it("invest() legacy revert UseRegisteredStartup", async function () {
            await expect(
                asTimelock(timelock, deployer,
                    s => treasury.connect(s).invest(startup.address, ethers.parseEther("1")))
            ).to.be.revertedWithCustomError(treasury, "UseRegisteredStartup");
        });

        it("investStartup revert OnlyTimelock se chiamato da non-Timelock", async function () {
            await expect(
                treasury.connect(alice).investStartup(0, ethers.parseEther("1"))
            ).to.be.revertedWithCustomError(treasury, "OnlyTimelock");
        });

        it("investStartup revert ZeroAmount se amount = 0", async function () {
            await expect(
                asTimelock(timelock, deployer, s => treasury.connect(s).investStartup(0, 0n))
            ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
        });

        it("investStartup revert InsufficientBalance se il treasury è vuoto", async function () {
            // Deploy un treasury fresh senza fondi
            const TR2 = await ethers.getContractFactory("Treasury");
            const tr2 = await TR2.deploy(await timelock.getAddress());
            await tr2.waitForDeployment();
            await tr2.setStartupRegistry(await registry.getAddress());

            await expect(
                asTimelock(timelock, deployer,
                    s => tr2.connect(s).investStartup(0, ethers.parseEther("1")))
            ).to.be.revertedWithCustomError(tr2, "InsufficientBalance");
        });

        it("investStartup revert StartupInactive se la startup è disattivata", async function () {
            await asTimelock(timelock, deployer,
                s => registry.connect(s).deactivateStartup(0));

            await expect(
                asTimelock(timelock, deployer,
                    s => treasury.connect(s).investStartup(0, ethers.parseEther("1")))
            ).to.be.revertedWithCustomError(treasury, "StartupInactive");
        });

        it("investStartup esegue il trasferimento ETH alla startup e aggiorna investedIn", async function () {
            const amount = ethers.parseEther("10");
            const startupBefore = await ethers.provider.getBalance(startup.address);

            await asTimelock(timelock, deployer,
                s => treasury.connect(s).investStartup(0, amount));

            // Il saldo della startup è aumentato di amount
            const startupAfter = await ethers.provider.getBalance(startup.address);
            expect(startupAfter - startupBefore).to.equal(amount);

            // Lo storico investedIn è aggiornato
            expect(await treasury.investedIn(startup.address)).to.equal(amount);
        });

        it("investStartup emette l'evento Invested", async function () {
            await expect(
                asTimelock(timelock, deployer,
                    s => treasury.connect(s).investStartup(0, ethers.parseEther("5")))
            ).to.emit(treasury, "Invested")
                .withArgs(0n, startup.address, ethers.parseEther("5"));
        });
    });

    // ========================================================================
    //  SEZIONE 4 — Flusso governance completo: investimento via proposta
    // ========================================================================
    describe("4. Flusso governance end-to-end: investimento in startup", function () {

        it("proposta di investimento CS: approve → queue → execute → ETH alla startup", async function () {
            // Setup: registra startup e verifica saldo treasury
            await asTimelock(timelock, deployer,
                s => registry.connect(s).registerStartup("Startup Gov", startup.address, "end-to-end"));

            const investAmount = ethers.parseEther("20");
            const startupBalBefore = await ethers.provider.getBalance(startup.address);

            // Proposta: chiama Treasury.investStartup(0, 20 ETH) — topic CS
            const calldata = treasury.interface.encodeFunctionData("investStartup", [0, investAmount]);
            const desc     = "Investimento di 20 ETH in Startup Gov (CS)";

            const tx  = await governor.proposeWithTopic(
                [await treasury.getAddress()], [0n], [calldata], desc, 0
            );
            const pid = await getProposalId(governor, tx);

            // Vota FOR (deployer ha 100% supply → supera ogni quorum)
            await mine(VOTING_DELAY + 1);
            await governor.castVote(pid, 1);
            await mine(VOTING_PERIOD + 1);
            expect(await governor.state(pid)).to.equal(4); // Succeeded

            // Queue e attesa timelock
            await governor.queue(
                [await treasury.getAddress()], [0n], [calldata], ethers.id(desc)
            );
            await time.increase(TIMELOCK_DELAY + 1);

            // Execute
            await governor.execute(
                [await treasury.getAddress()], [0n], [calldata], ethers.id(desc)
            );
            expect(await governor.state(pid)).to.equal(7); // Executed

            // La startup ha ricevuto gli ETH
            const startupBalAfter = await ethers.provider.getBalance(startup.address);
            expect(startupBalAfter - startupBalBefore).to.equal(investAmount);
        });
    });

    // ========================================================================
    //  SEZIONE 5 — setStartupRegistry access control
    // ========================================================================
    describe("5. setStartupRegistry access control", function () {

        it("revert OnlyDeployerOrTimelock se chiamato da terzi", async function () {
            await expect(
                treasury.connect(alice).setStartupRegistry(await registry.getAddress())
            ).to.be.revertedWithCustomError(treasury, "OnlyDeployerOrTimelock");
        });

        it("revert RegistryAlreadySet se il deployer prova a cambiarlo una seconda volta", async function () {
            // Il registry è già stato impostato nel beforeEach
            await expect(
                treasury.setStartupRegistry(await registry.getAddress())
            ).to.be.revertedWithCustomError(treasury, "RegistryAlreadySet");
        });
    });
});
