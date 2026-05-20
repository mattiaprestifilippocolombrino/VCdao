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
import { GovernanceToken, TimelockController } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const ETH_PRICE_USD = 2500; // Valore di riferimento ETH in USD per la tesi

// Schema EIP-712 per la firma della Verifiable Credential, identico a VPVerifier.sol
const VC_TYPES = {
    Issuer: [{ name: "id", type: "string" }],
    CredentialSubject: [
        { name: "id",         type: "string"   },
        { name: "university", type: "string"   },
        { name: "faculty",    type: "string"   },
        { name: "skills",     type: "string[]" },
    ],
    VerifiableCredential: [
        { name: "issuer",            type: "Issuer"            },
        { name: "issuanceDate",      type: "string"            },
        { name: "credentialSubject", type: "CredentialSubject" },
    ],
};

// Funzione helper per simulare una prova "legacy" senza EIP-712
function hashLegacyProof(proof: string): string {
    return ethers.keccak256(ethers.toUtf8Bytes(proof));
}

function skillIds(names: string[]): string[] {
    return names.map((name) => ethers.id(name));
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
    let timelock: TimelockController;
    let deployer: HardhatEthersSigner;
    let member1: HardhatEthersSigner;
    let member2: HardhatEthersSigner;
    let issuer: HardhatEthersSigner;

    let currentGasPrice: bigint;

    beforeEach(async function () {
        // Estrazione dinamica del gas price dalla rete locale Hardhat
        const feeData = await ethers.provider.getFeeData();
        currentGasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? ethers.parseUnits("1", "gwei");

        [deployer, member1, member2, issuer] = await ethers.getSigners();

        // 1. Deploy Timelock
        const Timelock = await ethers.getContractFactory("TimelockController");
        timelock = await Timelock.deploy(3600, [], [], deployer.address);
        await timelock.waitForDeployment();

        // 2. Deploy GovernanceToken
        const Token = await ethers.getContractFactory("GovernanceToken");
        token = await Token.deploy(await timelock.getAddress(), 5000n, 5000n);
        await token.waitForDeployment();

        // 3. Setup Trusted Issuer
        await token.setTrustedIssuer(issuer.address);

        // 4. Deploy Treasury and link it
        const Treasury_ = await ethers.getContractFactory("Treasury");
        const treasury = await Treasury_.deploy(await timelock.getAddress());
        await treasury.waitForDeployment();
        await token.setTreasury(await treasury.getAddress());
        
        // 2.b Deploy SkillCalculator
        const Calculator = await ethers.getContractFactory("SkillCalculator");
        const calculator = await Calculator.deploy();
        await calculator.waitForDeployment();
        await token.setSkillCalculator(await calculator.getAddress());

        // I membri entrano nella DAO (necessario per fare l'upgrade)
        await token.connect(member1).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(member1).delegate(member1.address);
        await token.connect(member2).joinDAO({ value: ethers.parseEther("5") });
        await token.connect(member2).delegate(member2.address);
    });

    // Simula la firma EIP-712 off-chain da parte dell'Università (Issuer)
    async function signVC(holderDid: string, issuerDid: string, skills: string[]) {
        const vcData = {
            issuer: { id: issuerDid },
            issuanceDate: "2026-01-15T10:00:00Z",
            credentialSubject: {
                id: holderDid, university: "University of Pisa",
                faculty: "Computer Science", skills,
            },
        };
        const signature = await issuer.signTypedData(
            { name: "Universal VC Protocol", version: "1" }, VC_TYPES, vcData
        );
        return { vcData, signature };
    }

    // Esegue una funzione impersonando il Timelock (necessario per forzare l'upgrade legacy)
    async function callAsTimelock<T>(fn: (signer: HardhatEthersSigner) => Promise<T>): Promise<T> {
        const addr = await timelock.getAddress();
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
        await deployer.sendTransaction({ to: addr, value: ethers.parseEther("1") });
        const signer = await ethers.getSigner(addr);
        const result = await fn(signer);
        await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [addr] });
        return result;
    }

    it("Calcolo costo esatto e overhead per upgradeSkillWithVC (EIP-712)", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member1.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        
        // Registriamo il DID (costo una tantum, separato dall'upgrade stesso)
        await token.connect(member1).registerDID(holderDid);
        
        // Generazione VC off-chain
        const { vcData, signature } = await signVC(holderDid, issuerDid, ["smart-contracts", "tokenomics"]);

        // Transazione 1: Upgrade con VC EIP-712 (Self-Sovereign)
        // L'utente chiama direttamente passando la prova crittografica.
        const txVP = await token.connect(member1).upgradeSkillWithVC(vcData, signature);
        const receiptVP = await txVP.wait();
        const gasTotal: bigint = receiptVP!.gasUsed;

        // Transazione 2: Upgrade legacy (Centralizzato)
        // Simulato chiamandolo dal Timelock, non effettua nessuna decodifica EIP-712.
        const txLeg = await callAsTimelock(s =>
            token.connect(s).upgradeSkill(member2.address, skillIds(["smart-contracts"]), hashLegacyProof("legacy skill"))
        );
        const receiptLeg = await (txLeg as any).wait();
        const gasLegacy: bigint = receiptLeg!.gasUsed;
        
        // Calcolo dell'overhead crittografico (ecrecover + decode)
        const overhead = gasTotal - gasLegacy;

        // Conversioni in ETH e USD
        const gasCostInEth = (gas: bigint) => ethers.formatEther(gas * currentGasPrice);
        const gasCostInUsd = (gas: bigint) => parseFloat(gasCostInEth(gas)) * ETH_PRICE_USD;

        console.log(`\n   ╔════════════════════════════════════════════════════════════════════════╗`);
        console.log(`   ║  RIEPILOGO GAS PER LA TESI — Rete Locale Hardhat                       ║`);
        console.log(`   ╠════════════════════════════════════════════════════════════════════════╣`);
        console.log(`   ║  Gas upgradeSkillWithVC:  ${String(gasTotal).padStart(10)} gas                        ║`);
        console.log(`   ║  Gas upgradeSkill legacy: ${String(gasLegacy).padStart(10)} gas                        ║`);
        console.log(`   ║  Overhead verifica VC:        +${String(overhead).padStart(10)} gas                        ║`);
        console.log(`   ╠════════════════════════════════════════════════════════════════════════╣`);
        console.log(`   ║  Costi Stimati (Gas Price: ${ethers.formatUnits(currentGasPrice, "gwei")} gwei, ETH: $${ETH_PRICE_USD})                   ║`);
        console.log(`   ║  Upgrade con VC:      ${gasCostInEth(gasTotal).padStart(15)} ETH  →  ${fmtUsd(gasCostInUsd(gasTotal)).padStart(10)}          ║`);
        console.log(`   ║  Solo Overhead VC:    ${gasCostInEth(overhead).padStart(15)} ETH  →  ${fmtUsd(gasCostInUsd(overhead)).padStart(10)}          ║`);
        console.log(`   ╚════════════════════════════════════════════════════════════════════════╝\n`);

        // Verifiche di coerenza di base
        expect(gasTotal).to.be.greaterThan(50000n);
        expect(gasTotal).to.be.lessThan(700000n);
        expect(overhead).to.be.greaterThan(0n);
    });
});
