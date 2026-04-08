// ============================================================================
//  06_gasEstimation.test.ts — Stima precisa gas e costi USD per upgradeCompetenceWithVP
//
//  Tutte le conversioni gas→ETH→USD usano ethers.parseUnits / ethers.formatEther
//  (funzioni di libreria) per garantire precisione aritmetica.
// ============================================================================

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import { GovernanceToken, MyGovernor, Treasury, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// ══════════════════════════════════════════════════════════════════════════
//  Parametri di mercato e funzioni di conversione (da libreria ethers.js)
// ══════════════════════════════════════════════════════════════════════════

/** Prezzo ETH in dollari (aggiornabile per la tesi) */
const ETH_PRICE_USD = 2500;

/** Scenari di gas price. Il primo viene popolato dinamicamente via Hardhat/ethers */
let NETWORKS: { name: string; gasPrice: bigint }[] = [];

/**
 * Calcola il costo in wei di una transazione (gas × gasPrice).
 * Usa la moltiplicazione nativa di bigint, identica a ethers internamente.
 */
function gasCostInWei(gasUsed: bigint, gasPrice: bigint): bigint {
    return gasUsed * gasPrice;
}

/**
 * Converte il costo gas in ETH usando ethers.formatEther (libreria).
 * ethers.formatEther divide automaticamente per 10^18.
 */
function gasCostInEth(gasUsed: bigint, gasPrice: bigint): string {
    return ethers.formatEther(gasCostInWei(gasUsed, gasPrice));
}

/**
 * Converte il costo gas in USD.
 * Il passaggio ETH→USD usa parseFloat su ethers.formatEther (libreria).
 */
function gasCostInUsd(gasUsed: bigint, gasPrice: bigint, ethPriceUsd: number = ETH_PRICE_USD): number {
    return parseFloat(ethers.formatEther(gasCostInWei(gasUsed, gasPrice))) * ethPriceUsd;
}

/** Formatta un valore USD per stampa tabellare */
function fmtUsd(usd: number): string {
    if (usd < 0.0001) return `< $0.0001`;
    if (usd < 0.01) return `$${usd.toFixed(5)}`;
    if (usd < 1) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

/** Stampa tabella costi per diverse reti */
function printCostTable(label: string, gasUsed: bigint) {
    console.log(`\n   ┌──────────────────────┬────────────────────┬─────────────────┐`);
    console.log(`   │ Rete                 │ Costo in ETH       │ Costo in USD    │`);
    console.log(`   ├──────────────────────┼────────────────────┼─────────────────┤`);
    for (const n of NETWORKS) {
        const eth = gasCostInEth(gasUsed, n.gasPrice);
        const usd = fmtUsd(gasCostInUsd(gasUsed, n.gasPrice));
        console.log(`   │ ${n.name.padEnd(20)} │ ${eth.padStart(18)} │ ${usd.padStart(15)} │`);
    }
    console.log(`   └──────────────────────┴────────────────────┴─────────────────┘`);
    console.log(`   Gas price calcolato con ethers.parseUnits() | ETH = $${ETH_PRICE_USD}`);
}

// ── Tipi EIP-712 (identici a VPVerifier.sol) ─────────────────────────────
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

describe("Gas Estimation — upgradeCompetenceWithVP (costi esatti)", function () {
    let token: GovernanceToken;
    let treasury: Treasury;
    let timelock: TimelockController;
    let governor: MyGovernor;
    let deployer: HardhatEthersSigner;
    let member1: HardhatEthersSigner;
    let member2: HardhatEthersSigner;
    let issuer: HardhatEthersSigner;

    const VOTING_DELAY = 1;
    const VOTING_PERIOD = 50;
    const TIMELOCK_DELAY = 3600;

    beforeEach(async function () {
        // Fetch current dynamic gas price from provider via ethers
        const feeData = await ethers.provider.getFeeData();
        const currentGasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? ethers.parseUnits("1", "gwei");

        NETWORKS = [
            { name: "Live Network (Dynamic)", gasPrice: currentGasPrice },
            { name: "Arbitrum One (Ref)",     gasPrice: ethers.parseUnits("100", "mwei") },
            { name: "Optimism / Base (Ref)",  gasPrice: ethers.parseUnits("10", "mwei") },
        ];

        [deployer, member1, member2, issuer] = await ethers.getSigners();

        const Timelock = await ethers.getContractFactory("TimelockController");
        timelock = await Timelock.deploy(TIMELOCK_DELAY, [], [], deployer.address);
        await timelock.waitForDeployment();

        const Token = await ethers.getContractFactory("GovernanceToken");
        token = await Token.deploy(await timelock.getAddress());
        await token.waitForDeployment();

        const Treasury_ = await ethers.getContractFactory("Treasury");
        treasury = await Treasury_.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();

        await token.setTreasury(await treasury.getAddress());
        await token.setTrustedIssuer(issuer.address);

        await token.joinDAO({ value: ethers.parseEther("10") });
        await token.delegate(deployer.address);

        const Governor = await ethers.getContractFactory("MyGovernor");
        governor = await Governor.deploy(
            await token.getAddress(), await timelock.getAddress(),
            VOTING_DELAY, VOTING_PERIOD, 0, 20, 70
        );
        await governor.waitForDeployment();

        const governorAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), governorAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
        await timelock.revokeRole(await timelock.DEFAULT_ADMIN_ROLE(), deployer.address);

        await token.connect(member1).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(member1).delegate(member1.address);
        await token.connect(member2).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(member2).delegate(member2.address);
        await mine(1);
    });

    // Helper: firma VC
    async function signVC(holderDid: string, issuerDid: string, degreeTitle: string) {
        const vcData = {
            issuer: { id: issuerDid },
            issuanceDate: "2026-01-15T10:00:00Z",
            credentialSubject: {
                id: holderDid, university: "University of Pisa",
                faculty: "Computer Science", degreeTitle, grade: "110/110",
            },
        };
        const signature = await issuer.signTypedData(
            { name: "Universal VC Protocol", version: "1" }, VC_TYPES, vcData
        );
        return { vcData, signature };
    }

    // Helper: impersona Timelock per chiamata diretta
    async function callAsTimelock<T>(fn: (signer: HardhatEthersSigner) => Promise<T>): Promise<T> {
        const addr = await timelock.getAddress();
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
        await deployer.sendTransaction({ to: addr, value: ethers.parseEther("1") });
        const signer = await ethers.getSigner(addr);
        const result = await fn(signer);
        await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [addr] });
        return result;
    }

    // ═════════════════════════════════════════════════════════════════════
    //  TEST A: Gas e costi USD per upgradeCompetenceWithVP
    // ═════════════════════════════════════════════════════════════════════
    it("A) Gas esatto e costi in ETH/USD per upgradeCompetenceWithVP", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member1.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member1).registerDID(holderDid);
        const { vcData, signature } = await signVC(holderDid, issuerDid, "PhD");

        // Self-sovereign: il membro chiama direttamente, nessun voto
        const tx = await token.connect(member1).upgradeCompetenceWithVP(vcData, signature);
        const receipt = await tx.wait();
        const gasUsed: bigint = receipt!.gasUsed;

        expect(await token.getMemberGrade(member1.address)).to.equal(3);

        console.log(`\n   ⛽ Gas misurato (upgradeCompetenceWithVP): ${gasUsed.toLocaleString()} gas`);
        printCostTable("upgradeWithVP", gasUsed);
    });

    // ═════════════════════════════════════════════════════════════════════
    //  TEST B: Overhead verifica VC (VP - Legacy) con costi USD
    // ═════════════════════════════════════════════════════════════════════
    it("B) Overhead verifica VC: VP vs Legacy", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member1.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);

        // Legacy (member2 → PhD)
        const txLegacy = await callAsTimelock(s =>
            token.connect(s).upgradeCompetence(member2.address, 3, "PhD in CS, UniPi 2025")
        );
        const gasLegacy: bigint = (await (txLegacy as any).wait())!.gasUsed;

        // VP (member1 → PhD) — Self-sovereign: il membro chiama direttamente
        await token.connect(member1).registerDID(holderDid);
        const { vcData, signature } = await signVC(holderDid, issuerDid, "PhD");
        const txVP = await token.connect(member1).upgradeCompetenceWithVP(vcData, signature);
        const gasVP: bigint = (await txVP.wait())!.gasUsed;
        const overhead = gasVP - gasLegacy;

        console.log(`\n   ┌───────────────────────────────────┬────────────────┐`);
        console.log(`   │ Operazione                        │ Gas            │`);
        console.log(`   ├───────────────────────────────────┼────────────────┤`);
        console.log(`   │ upgradeCompetence (legacy)        │ ${String(gasLegacy).padStart(14)} │`);
        console.log(`   │ upgradeCompetenceWithVP           │ ${String(gasVP).padStart(14)} │`);
        console.log(`   │ OVERHEAD verifica VC on-chain     │+${String(overhead).padStart(13)} │`);
        console.log(`   └───────────────────────────────────┴────────────────┘`);

        printCostTable("Overhead VC sola", overhead);

        expect(overhead).to.be.lessThan(100000n);
    });

    // ═════════════════════════════════════════════════════════════════════
    //  TEST C: Variazione gas per titolo
    // ═════════════════════════════════════════════════════════════════════
    it("C) Gas per titolo: BachelorDegree vs PhD vs Professor", async function () {
        const titles = ["BachelorDegree", "PhD", "Professor"];
        const members = [member1, member2, deployer];
        const results: { title: string; gas: bigint }[] = [];

        for (let i = 0; i < titles.length; i++) {
            const m = members[i];
            const holderDid = "did:ethr:sepolia:0x" + m.address.slice(2);
            const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
            await token.connect(m).registerDID(holderDid);
            const { vcData, signature } = await signVC(holderDid, issuerDid, titles[i]);
            // Self-sovereign: il membro chiama direttamente
            const tx = await token.connect(m).upgradeCompetenceWithVP(vcData, signature);
            const r = await tx.wait();
            results.push({ title: titles[i], gas: r!.gasUsed });
        }

        const delta = results[results.length - 1].gas - results[0].gas;

        console.log(`\n   ┌──────────────────┬────────────────┬──────────────────┐`);
        console.log(`   │ Titolo           │ Gas            │ Costo Mainnet    │`);
        console.log(`   ├──────────────────┼────────────────┼──────────────────┤`);
        for (const r of results) {
            const usd = fmtUsd(gasCostInUsd(r.gas, NETWORKS[0].gasPrice));
            console.log(`   │ ${r.title.padEnd(16)} │ ${String(r.gas).padStart(14)} │ ${usd.padStart(16)} │`);
        }
        console.log(`   ├──────────────────┼────────────────┼──────────────────┤`);
        console.log(`   │ Var. max         │ ${String(delta).padStart(14)} │ trascurabile     │`);
        console.log(`   └──────────────────┴────────────────┴──────────────────┘`);
    });

    // ═════════════════════════════════════════════════════════════════════
    //  TEST D: Riepilogo completo per la tesi
    // ═════════════════════════════════════════════════════════════════════
    it("D) Riepilogo costi completo per la tesi", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member1.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member1).registerDID(holderDid);
        const { vcData, signature } = await signVC(holderDid, issuerDid, "PhD");

        // VP — Self-sovereign: il membro chiama direttamente
        const txVP = await token.connect(member1).upgradeCompetenceWithVP(vcData, signature);
        const gasTotal: bigint = (await txVP.wait())!.gasUsed;

        const txLeg = await callAsTimelock(s =>
            token.connect(s).upgradeCompetence(member2.address, 3, "PhD")
        );
        const gasLegacy: bigint = (await (txLeg as any).wait())!.gasUsed;
        const overhead = gasTotal - gasLegacy;

        console.log(`\n   ╔════════════════════════════════════════════════════════════════════════╗`);
        console.log(`   ║  RIEPILOGO PER LA TESI — Verifica VC On-Chain (EIP-712)               ║`);
        console.log(`   ╠════════════════════════════════════════════════════════════════════════╣`);
        console.log(`   ║  Gas upgradeCompetenceWithVP:  ${String(gasTotal).padStart(10)} gas                        ║`);
        console.log(`   ║  Gas upgradeCompetence legacy: ${String(gasLegacy).padStart(10)} gas                        ║`);
        console.log(`   ║  Overhead verifica VC:        +${String(overhead).padStart(10)} gas                        ║`);
        console.log(`   ╠════════════════════════════════════════════════════════════════════════╣`);

        for (const n of NETWORKS) {
            const costWei = gasCostInWei(gasTotal, n.gasPrice);
            const costEth = gasCostInEth(gasTotal, n.gasPrice);
            const costUsd = fmtUsd(gasCostInUsd(gasTotal, n.gasPrice));
            console.log(`   ║  ${n.name.padEnd(20)} ${costEth.padStart(18)} ETH  →  ${costUsd.padStart(10)}    ║`);
        }

        console.log(`   ╠════════════════════════════════════════════════════════════════════════╣`);
        console.log(`   ║  OVERHEAD VC (solo verifica crittografica):                            ║`);
        for (const n of NETWORKS) {
            const costEth = gasCostInEth(overhead, n.gasPrice);
            const costUsd = fmtUsd(gasCostInUsd(overhead, n.gasPrice));
            console.log(`   ║    ${n.name.padEnd(20)} ${costEth.padStart(18)} ETH  →  ${costUsd.padStart(10)}  ║`);
        }

        console.log(`   ╠════════════════════════════════════════════════════════════════════════╣`);
        console.log(`   ║  Conversioni via: ethers.parseUnits(), ethers.formatEther()            ║`);
        console.log(`   ║  Prezzo ETH: $${ETH_PRICE_USD}  |  Gas prices: parseUnits("15","gwei") etc.     ║`);
        console.log(`   ╚════════════════════════════════════════════════════════════════════════╝`);

        expect(gasTotal).to.be.greaterThan(50000n);
        expect(gasTotal).to.be.lessThan(300000n);
    });
});
