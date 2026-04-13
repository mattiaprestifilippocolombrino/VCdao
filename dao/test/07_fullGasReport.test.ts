// ============================================================================
//  07_fullGasReport.test.ts — Report gas completo per tesi (DAO + SSI)
//
//  Misura il gas di OGNI operazione del progetto VC-DAO e produce un report
//  formattato con costi in ETH e USD su Mainnet, Arbitrum e Optimism.
//  Tutte le conversioni usano ethers.parseUnits / ethers.formatEther (libreria).
// ============================================================================

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import {
    GovernanceToken, MyGovernor, Treasury,
    MockStartup, TimelockController,
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ══════════════════════════════════════════════════════════════════════════
//  Parametri di mercato e funzioni di conversione (da libreria ethers.js)
// ══════════════════════════════════════════════════════════════════════════

/** Prezzo ETH in dollari (aggiornabile per la tesi) */
const ETH_PRICE_USD = 1900;

/** Gas price. Il live network viene popolato usando ethers.provider.getFeeData() */
let NETWORKS: { name: string; gasPrice: bigint }[] = [];

/** Costo in wei (gas × gasPrice). Usa moltiplicazione nativa bigint. */
function gasCostInWei(gasUsed: bigint, gasPrice: bigint): bigint {
    return gasUsed * gasPrice;
}

/** Converte gas in ETH con ethers.formatEther (libreria, divide per 10^18). */
function gasCostInEth(gasUsed: bigint, gasPrice: bigint): string {
    return ethers.formatEther(gasCostInWei(gasUsed, gasPrice));
}

/** Converte gas in USD tramite ethers.formatEther + prezzo di mercato. */
function gasCostInUsd(gasUsed: bigint, gasPrice: bigint): number {
    return parseFloat(ethers.formatEther(gasCostInWei(gasUsed, gasPrice))) * ETH_PRICE_USD;
}

/** Formatta valore USD per tabella */
function fmtUsd(usd: number): string {
    if (usd < 0.0001) return "< $0.0001";
    if (usd < 0.01) return `$${usd.toFixed(5)}`;
    if (usd < 1) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

// ── Tipi EIP-712 ─────────────────────────────────────────────────────────
const VC_TYPES = {
    Issuer: [{ name: "id", type: "string" }],
    CredentialSubject: [
        { name: "id", type: "string" },
        { name: "university", type: "string" },
        { name: "faculty", type: "string" },
        { name: "degreeTitle", type: "string" },
        { name: "grade", type: "string" },
    ],
    VerifiableCredential: [
        { name: "issuer", type: "Issuer" },
        { name: "issuanceDate", type: "string" },
        { name: "credentialSubject", type: "CredentialSubject" },
    ],
};
const EIP712_DOMAIN = { name: "Universal VC Protocol", version: "1" };

// ══════════════════════════════════════════════════════════════════════════
//  TEST SUITE
// ══════════════════════════════════════════════════════════════════════════

describe("Full Gas Report — Tutte le operazioni DAO + SSI", function () {
    let token: GovernanceToken;
    let treasury: Treasury;
    let timelock: TimelockController;
    let governor: MyGovernor;
    let mockStartup: MockStartup;
    let deployer: HardhatEthersSigner;
    let alice: HardhatEthersSigner;
    let bob: HardhatEthersSigner;
    let issuer: HardhatEthersSigner;

    const VOTING_DELAY = 1;
    const VOTING_PERIOD = 50;
    const TIMELOCK_DELAY = 3600;

    // Raccolta risultati
    const gasData: { cat: string; op: string; gas: bigint }[] = [];
    function record(cat: string, op: string, gas: bigint) {
        gasData.push({ cat, op, gas });
    }

    before(async function () {
        // Fetch current dynamic gas price from provider via ethers
        const feeData = await ethers.provider.getFeeData();
        const currentGasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? ethers.parseUnits("1", "gwei");

        NETWORKS = [
            { name: "Live Network (Dynamic)", gasPrice: currentGasPrice },
            { name: "Arbitrum (Ref)", gasPrice: ethers.parseUnits("100", "mwei") },
            { name: "Optimism (Ref)", gasPrice: ethers.parseUnits("10", "mwei") },
        ];

        [deployer, alice, bob, issuer] = await ethers.getSigners();

        const Timelock = await ethers.getContractFactory("TimelockController");
        timelock = await Timelock.deploy(TIMELOCK_DELAY, [], [], deployer.address);
        await timelock.waitForDeployment();

        const Token = await ethers.getContractFactory("GovernanceToken");
        token = await Token.deploy(await timelock.getAddress(), 10000n);
        await token.waitForDeployment();

        const Treasury_ = await ethers.getContractFactory("Treasury");
        treasury = await Treasury_.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();

        await token.setTreasury(await treasury.getAddress());
        await token.setTrustedIssuer(issuer.address);

        const Governor = await ethers.getContractFactory("MyGovernor");
        governor = await Governor.deploy(
            await token.getAddress(), await timelock.getAddress(),
            VOTING_DELAY, VOTING_PERIOD, 0, 20, 70
        );
        await governor.waitForDeployment();

        const MS = await ethers.getContractFactory("MockStartup");
        mockStartup = await MS.deploy();
        await mockStartup.waitForDeployment();

        const governorAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
        await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);
    });

    // Helper: impersona Timelock
    async function callAsTimelock<T>(fn: (signer: HardhatEthersSigner) => Promise<T>): Promise<T> {
        const addr = await timelock.getAddress();
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
        await deployer.sendTransaction({ to: addr, value: ethers.parseEther("1") });
        const signer = await ethers.getSigner(addr);
        const result = await fn(signer);
        await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [addr] });
        return result;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  1. DEPLOY
    // ═══════════════════════════════════════════════════════════════════
    describe("Deploy", function () {
        it("GovernanceToken", async function () {
            const F = await ethers.getContractFactory("GovernanceToken");
            const c = await F.deploy(await timelock.getAddress(), 10000n);
            const r = await c.deploymentTransaction()!.wait();
            record("Deploy", "GovernanceToken", r!.gasUsed);
        });
        it("MyGovernor", async function () {
            const F = await ethers.getContractFactory("MyGovernor");
            const c = await F.deploy(
                await token.getAddress(), await timelock.getAddress(),
                1, 50, 0, 20, 70
            );
            const r = await c.deploymentTransaction()!.wait();
            record("Deploy", "MyGovernor", r!.gasUsed);
        });
        it("Treasury", async function () {
            const F = await ethers.getContractFactory("Treasury");
            const c = await F.deploy(await timelock.getAddress());
            const r = await c.deploymentTransaction()!.wait();
            record("Deploy", "Treasury", r!.gasUsed);
        });
        it("TimelockController", async function () {
            const F = await ethers.getContractFactory("TimelockController");
            const c = await F.deploy(3600, [], [], deployer.address);
            const r = await c.deploymentTransaction()!.wait();
            record("Deploy", "TimelockController", r!.gasUsed);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    //  2. MEMBERSHIP
    // ═══════════════════════════════════════════════════════════════════
    describe("Membership", function () {
        it("joinDAO()", async function () {
            const tx = await token.connect(deployer).joinDAO({ value: ethers.parseEther("10") });
            record("Membership", "joinDAO()", (await tx.wait())!.gasUsed);
        });
        it("joinDAO() — 2° membro", async function () {
            const tx = await token.connect(alice).joinDAO({ value: ethers.parseEther("5") });
            record("Membership", "joinDAO() [2° membro]", (await tx.wait())!.gasUsed);
        });
        it("delegate()", async function () {
            const tx = await token.connect(deployer).delegate(deployer.address);
            record("Membership", "delegate(self)", (await tx.wait())!.gasUsed);
        });
        it("mintTokens()", async function () {
            await token.connect(alice).delegate(alice.address);
            await mine(1);
            const tx = await token.connect(alice).mintTokens({ value: ethers.parseEther("2") });
            record("Membership", "mintTokens()", (await tx.wait())!.gasUsed);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    //  3. SSI
    // ═══════════════════════════════════════════════════════════════════
    describe("SSI (DID + VC)", function () {
        it("registerDID()", async function () {
            const did = "did:ethr:sepolia:0x" + alice.address.slice(2);
            const tx = await token.connect(alice).registerDID(did);
            record("SSI", "registerDID()", (await tx.wait())!.gasUsed);
        });
        it("upgradeCompetenceWithVP() — verifica on-chain (self-sovereign)", async function () {
            const holderDid = "did:ethr:sepolia:0x" + alice.address.slice(2);
            const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
            const vcData = {
                issuer: { id: issuerDid },
                issuanceDate: "2026-01-15T10:00:00Z",
                credentialSubject: {
                    id: holderDid, university: "University of Pisa",
                    faculty: "Computer Science", degreeTitle: "MasterDegree", grade: "110/110",
                },
            };
            const signature = await issuer.signTypedData(EIP712_DOMAIN, VC_TYPES, vcData);
            // Self-sovereign: il membro chiama direttamente, nessun voto
            const tx = await token.connect(alice).upgradeCompetenceWithVP(vcData, signature);
            record("SSI", "upgradeCompetenceWithVP()", (await tx.wait())!.gasUsed);
        });
        it("upgradeCompetence() — legacy", async function () {
            await token.connect(bob).joinDAO({ value: ethers.parseEther("3") });
            const tx = await callAsTimelock(s =>
                token.connect(s).upgradeCompetence(bob.address, 3, "PhD in CS")
            );
            record("SSI", "upgradeCompetence() [legacy]", (await (tx as any).wait())!.gasUsed);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    //  4. GOVERNANCE
    // ═══════════════════════════════════════════════════════════════════
    describe("Governance", function () {
        let proposalId: bigint;
        let propTargets: string[];
        let propValues: bigint[];
        let propCalldatas: string[];
        const propDescription = "Test proposal — upgrade bob to Professor";

        it("propose()", async function () {
            await mine(1);
            propTargets = [await token.getAddress()];
            propValues = [0n];
            propCalldatas = [token.interface.encodeFunctionData("upgradeCompetence", [
                bob.address, 4, "Professor upgrade"
            ])];
            const tx = await governor.propose(propTargets, propValues, propCalldatas, propDescription);
            const r = await tx.wait();
            proposalId = r!.logs
                .map((l: any) => { try { return governor.interface.parseLog(l); } catch { return null; } })
                .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;
            record("Governance", "propose()", r!.gasUsed);
        });
        it("castVote()", async function () {
            await mine(VOTING_DELAY + 1);
            const tx = await governor.castVote(proposalId, 1);
            record("Governance", "castVote()", (await tx.wait())!.gasUsed);
        });
        it("queue()", async function () {
            await mine(VOTING_PERIOD + 1);
            const tx = await governor.queue(propTargets, propValues, propCalldatas, ethers.id(propDescription));
            record("Governance", "queue()", (await tx.wait())!.gasUsed);
        });
        it("execute()", async function () {
            await time.increase(TIMELOCK_DELAY + 1);
            const tx = await governor.execute(propTargets, propValues, propCalldatas, ethers.id(propDescription));
            record("Governance", "execute()", (await tx.wait())!.gasUsed);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    //  5. TREASURY
    // ═══════════════════════════════════════════════════════════════════
    describe("Treasury", function () {
        it("deposit()", async function () {
            const tx = await treasury.deposit({ value: ethers.parseEther("5") });
            record("Treasury", "deposit()", (await tx.wait())!.gasUsed);
        });
    });

    // ═══════════════════════════════════════════════════════════════════
    //  REPORT FINALE
    // ═══════════════════════════════════════════════════════════════════
    after(function () {
        const W = 100;
        const SEP = "═".repeat(W);

        console.log(`\n╔${SEP}╗`);
        console.log(`║  REPORT GAS COMPLETO — VC-DAO  |  ETH = $${ETH_PRICE_USD}  |  Conversioni: ethers.js${" ".repeat(W - 75)}║`);
        console.log(`╠${SEP}╣`);

        // Header
        const colOp = 32, colGas = 12;
        const hdr = `  ${"Operazione".padEnd(colOp)}│${"Gas".padStart(colGas)} │`;
        const netCols = NETWORKS.map(n => n.name.padStart(18)).join(" │");
        console.log(`║${hdr}${netCols.padStart(W - hdr.length - 1)}║`);
        console.log(`╠${"─".repeat(colOp + 2)}┼${"─".repeat(colGas + 1)}┼${"─".repeat(W - colOp - colGas - 5)}╣`);

        let lastCat = "";
        for (const d of gasData) {
            if (d.cat !== lastCat) {
                if (lastCat !== "") {
                    console.log(`║${"─".repeat(colOp + 2)}┼${"─".repeat(colGas + 1)}┼${"─".repeat(W - colOp - colGas - 5)}║`);
                }
                console.log(`║  ▸ ${d.cat}${" ".repeat(W - d.cat.length - 4)}║`);
                lastCat = d.cat;
            }
            const gasStr = Number(d.gas).toLocaleString("it-IT");
            const costs = NETWORKS.map(n => fmtUsd(gasCostInUsd(d.gas, n.gasPrice)).padStart(18)).join(" │");
            console.log(`║    ${d.op.padEnd(colOp - 2)}│${gasStr.padStart(colGas)} │${costs.padStart(W - colOp - colGas - 3)}║`);
        }

        console.log(`╠${SEP}╣`);

        // Overhead VC
        const vpGas = gasData.find(d => d.op.includes("upgradeCompetenceWithVP"))?.gas ?? 0n;
        const legGas = gasData.find(d => d.op.includes("[legacy]"))?.gas ?? 0n;
        const overhead = vpGas > legGas ? vpGas - legGas : 0n;

        console.log(`║  OVERHEAD VERIFICA VC ON-CHAIN (upgradeCompetenceWithVP − upgradeCompetence)${" ".repeat(W - 77)}║`);
        console.log(`║  VP: ${String(vpGas).padStart(8)} gas  │  Legacy: ${String(legGas).padStart(8)} gas  │  Overhead: +${String(overhead).padStart(8)} gas${" ".repeat(W - 76)}║`);
        console.log(`║${" ".repeat(W)}║`);

        for (const n of NETWORKS) {
            const costEth = gasCostInEth(overhead, n.gasPrice);
            const costUsd = fmtUsd(gasCostInUsd(overhead, n.gasPrice));
            console.log(`║    ${n.name.padEnd(20)} overhead: ${costEth.padStart(18)} ETH  →  ${costUsd.padStart(10)}${" ".repeat(Math.max(0, W - 71))}║`);
        }

        // Governance total
        const govTotal = gasData.filter(d => d.cat === "Governance").reduce((s, d) => s + d.gas, 0n);
        console.log(`║${" ".repeat(W)}║`);
        console.log(`║  CICLO GOVERNANCE (propose + vote + queue + execute): ${String(govTotal).padStart(10)} gas${" ".repeat(W - 66)}║`);
        for (const n of NETWORKS) {
            const costUsd = fmtUsd(gasCostInUsd(govTotal, n.gasPrice));
            console.log(`║    ${n.name.padEnd(20)} → ${costUsd.padStart(10)}${" ".repeat(W - 39)}║`);
        }

        console.log(`╠${SEP}╣`);
        console.log(`║  Gas prices: ethers.parseUnits("15","gwei") / parseUnits("100","mwei") / parseUnits("10","mwei")${" ".repeat(W - 97)}║`);
        console.log(`║  Conversione ETH: ethers.formatEther(gasUsed × gasPrice)  |  USD: parseFloat(formatEther) × $ETH${" ".repeat(W - 99)}║`);
        console.log(`╚${SEP}╝`);
    });
});
