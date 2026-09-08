// ============================================================================
//  05_gasEstimation.test.ts — Stima gas e costi per la tesi
//
//  Questo script utilizza le funzioni native di Hardhat/Ethers per misurare
//  il gas consumato dall'upgrade delle competenze con Verifiable Credentials (EIP-712)
//  e confrontarlo con un upgrade "legacy" (senza verifica crittografica on-chain).
//  L'obiettivo è estrarre metriche chiare e precise da includere nella tesi.
// ============================================================================

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { GovernanceSkill, GovernanceToken, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { LoadedCredential, loadCredentialForAddress } from "./helpers/sharedCredentials";

// -- Costanti di riferimento annuali per la tesi (medie 2024) --
// Gas price: media annuale Mainnet Ethereum 2024
const GAS_PRICE_WEI: bigint = 1_032_440_000n; // 1.03244 Gwei in wei
// ETH/USD: media annuale 2024
const ETH_PRICE_USD = 2638.48;

// Funzione helper per simulare una prova "legacy" senza EIP-712
function hashLegacyProof(proof: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(proof));
}

// Formatta un valore USD in formato testuale leggibile
function fmtUsd(usd: number): string {
    if (usd < 0.0001) return `< $0.0001`;
    if (usd < 0.01) return `$${usd.toFixed(5)}`;
    if (usd < 1) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

describe("Gas Estimation — Metriche per la Tesi", function () {
    let token: GovernanceToken;
    let skillModule: GovernanceSkill;
    let timelock: TimelockController;
    let deployer: HardhatEthersSigner;
    let member1: HardhatEthersSigner;
    let member2: HardhatEthersSigner;
    let issuer: HardhatEthersSigner;
    let memberCredential: LoadedCredential;


    beforeEach(async function () {

        [deployer, member1, issuer, member2] = await ethers.getSigners();
        memberCredential = loadCredentialForAddress(member1.address);
        if (memberCredential.issuerAddress !== issuer.address) {
            throw new Error("L'issuer della VC condivisa non coincide con il trusted issuer del test gas");
        }

        // 1. Deploy Timelock
        const Timelock = await ethers.getContractFactory("TimelockController");
        timelock = await Timelock.deploy(3600, [], [], deployer.address);
        await timelock.waitForDeployment();

        // 2. Deploy GovernanceToken
        const Token = await ethers.getContractFactory("GovernanceToken");
        token = await Token.deploy(await timelock.getAddress(), 5000n, 5000n);
        await token.waitForDeployment();

        // 3. Deploy Treasury and link it
        const Treasury_ = await ethers.getContractFactory("Treasury");
        const treasury = await Treasury_.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();
        await token.setTreasury(await treasury.getAddress());
        
        // 4. Deploy SkillCalculator e GovernanceSkill
        const Calculator = await ethers.getContractFactory("SkillCalculator");
        const calculator = await Calculator.deploy();
        await calculator.waitForDeployment();

        const Skill = await ethers.getContractFactory("GovernanceSkill");
        skillModule = await Skill.deploy(
            await token.getAddress(),
            await timelock.getAddress(),
            5000n,
            await calculator.getAddress()
        );
        await skillModule.waitForDeployment();
        await skillModule.setTrustedIssuer(issuer.address);

        // I membri entrano nella DAO (necessario per fare l'upgrade)
        await token.connect(member1).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(member1).delegate(member1.address);
        await token.connect(member2).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(member2).delegate(member2.address);
    });

    // Esegue una funzione impersonando il Timelock (necessario per forzare l'upgrade legacy)
    async function callAsTimelock<T>(fn: (signer: HardhatEthersSigner) => Promise<T>): Promise<T> {
        const addr = await timelock.getAddress();
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
        await deployer.sendTransaction({ to: addr, value: ethers.parseEther("1") });
        const signer = await ethers.getSigner(addr);
        try {
            return await fn(signer);
        } finally {
            await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [addr] });
        }
    }

    it("Calcolo costo esatto e overhead per upgradeSkillWithVC (EIP-712)", async function () {
        // Transazione 1: Upgrade con VC EIP-712 (Self-Sovereign)
        // L'utente presenta direttamente la VC reale generata in shared-credentials.
        await skillModule.connect(member1).registerDID(memberCredential.vcData.credentialSubject.id);
        const snapshot = await network.provider.send("evm_snapshot");
        const txVP = await skillModule.connect(member1).upgradeSkillWithVC(
            memberCredential.vcData,
            memberCredential.signature,
        );
        const receiptVP = await txVP.wait();
        const gasTotal: bigint = receiptVP!.gasUsed;

        const replay = await skillModule.connect(member1).upgradeSkillWithVC(
            memberCredential.vcData, memberCredential.signature,
        );
        const gasReplay = (await replay.wait())!.gasUsed;
        // Ripristina lo stesso membro e gli stessi checkpoint per un confronto omogeneo.
        await network.provider.send("evm_revert", [snapshot]);

        // Transazione 2: Upgrade legacy (Centralizzato)
        // Simulato chiamandolo dal Timelock, non effettua nessuna decodifica EIP-712.
        const txLeg = await callAsTimelock(s =>
            skillModule.connect(s).upgradeSkill(
                member1.address, memberCredential.vcData.credentialSubject.skills, hashLegacyProof("legacy skill"),
            )
        );
        const receiptLeg = await (txLeg as any).wait();
        const gasLegacy: bigint = receiptLeg!.gasUsed;
        
        // Differenza tra i due percorsi a parità di skill e stato iniziale (include calldata ed eventi).
        const overhead = gasTotal - gasLegacy;

        // Conversioni in ETH e USD
        const gasCostInEth = (gas: bigint) => ethers.formatEther(gas * GAS_PRICE_WEI);
        const gasCostInUsd = (gas: bigint) => parseFloat(gasCostInEth(gas)) * ETH_PRICE_USD;

        console.log(`\n   ╔════════════════════════════════════════════════════════════════════════╗`);
        console.log(`   ║  RIEPILOGO GAS PER LA TESI — Rete Locale Hardhat                       ║`);
        console.log(`   ╠════════════════════════════════════════════════════════════════════════╣`);
        console.log(`   ║  Gas upgradeSkillWithVC:  ${String(gasTotal).padStart(10)} gas                        ║`);
        console.log(`   ║  Gas upgradeSkill legacy: ${String(gasLegacy).padStart(10)} gas                        ║`);
        console.log(`   ║  Gas stessa VC ripetuta:  ${String(gasReplay).padStart(10)} gas                        ║`);
        console.log(`   ║  Overhead verifica VC:        +${String(overhead).padStart(10)} gas                        ║`);
        console.log(`   ╠════════════════════════════════════════════════════════════════════════╣`);
        console.log(`   ║  Costi Stimati (Gas Price: ${ethers.formatUnits(currentGasPrice, "gwei")} gwei, ETH: $${ETH_PRICE_USD})                   ║`);
        console.log(`   ║  Upgrade con VC:      ${gasCostInEth(gasTotal).padStart(15)} ETH  →  ${fmtUsd(gasCostInUsd(gasTotal)).padStart(10)}          ║`);
        console.log(`   ║  Solo Overhead VC:    ${gasCostInEth(overhead).padStart(15)} ETH  →  ${fmtUsd(gasCostInUsd(overhead)).padStart(10)}          ║`);
        console.log(`   ╚════════════════════════════════════════════════════════════════════════╝\n`);

        // Verifiche di coerenza di base
        expect(gasTotal).to.be.greaterThan(50000n);
        expect(gasTotal).to.be.lessThan(700000n);
        expect(gasReplay).to.be.lessThan(gasTotal);
        expect(overhead).to.be.greaterThan(0n);
    });
});
