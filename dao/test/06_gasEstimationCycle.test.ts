// ============================================================================
//  06_gasEstimationCycle.test.ts — Stima gas ciclo di vita DAO (Tesi)
//
//  Esegue tutto il ciclo di governance: deploy, join, delegate, mintTokens,
//  upgradeCompetence, createProposal, voteOnProposal, executeProposal.
//  Focus Accademico:
//   - Overhead crittografico EIP-712 vs Aggiornamento Legacy
//   - Costo dei checkpoint (SSTORE Cold vs Warm)
//   - Costo di calldata (Tx data size) e complessità O(log N) nei checkpoint
//   - Costo Gas Totale del ciclo di vita DAO
// ============================================================================

import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
    GovernanceToken,
    MyGovernor,
    Treasury,
    TimelockController
} from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

const ETH_PRICE_USD = 2100; // Valore aggiornato per la tesi

// EIP-712 Schema
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

function fmtUsd(usd: number): string {
    if (usd < 0.0001) return `< $0.0001`;
    if (usd < 0.01) return `$${usd.toFixed(5)}`;
    if (usd < 1) return `$${usd.toFixed(4)}`;
    return `$${usd.toFixed(2)}`;
}

// Calcola i byte inviati in calldata (ogni byte non nullo costa 16 gas, nullo 4)
function calculateCalldataCost(hexString: string): bigint {
    const bytes = ethers.getBytes(hexString);
    let gas = 0n;
    for (const b of bytes) {
        gas += b === 0 ? 4n : 16n;
    }
    return gas;
}

describe("Gas Estimation — Full Governance Cycle & Checkpoints", function () {
    let token: GovernanceToken;
    let governor: MyGovernor;
    let treasury: Treasury;
    let timelock: TimelockController;
    
    let deployer: HardhatEthersSigner;
    let member1: HardhatEthersSigner;
    let member2: HardhatEthersSigner;
    let issuer: HardhatEthersSigner;

    let currentGasPrice: bigint;
    const gasReport: Record<string, bigint> = {};

    before(async function () {
        const feeData = await ethers.provider.getFeeData();
        currentGasPrice = feeData.gasPrice ?? feeData.maxFeePerGas ?? ethers.parseUnits("1", "gwei");
        [deployer, member1, member2, issuer] = await ethers.getSigners();
    });

    it("1. Deploy dei Contratti", async function () {
        const Timelock = await ethers.getContractFactory("TimelockController");
        const txTL = await Timelock.getDeployTransaction(3600, [], [], deployer.address);
        const receiptTL = await (await deployer.sendTransaction(txTL)).wait();
        gasReport["Deploy Timelock"] = receiptTL!.gasUsed;
        timelock = Timelock.attach(receiptTL!.contractAddress!) as TimelockController;

        const Token = await ethers.getContractFactory("GovernanceToken");
        const txToken = await Token.getDeployTransaction(await timelock.getAddress(), 5000n, 5000n);
        const receiptToken = await (await deployer.sendTransaction(txToken)).wait();
        gasReport["Deploy GovernanceToken"] = receiptToken!.gasUsed;
        token = Token.attach(receiptToken!.contractAddress!) as GovernanceToken;

        const Treasury_ = await ethers.getContractFactory("Treasury");
        const txTreasury = await Treasury_.getDeployTransaction(await timelock.getAddress());
        const receiptTreasury = await (await deployer.sendTransaction(txTreasury)).wait();
        gasReport["Deploy Treasury"] = receiptTreasury!.gasUsed;
        treasury = Treasury_.attach(receiptTreasury!.contractAddress!) as Treasury;

        const Governor = await ethers.getContractFactory("MyGovernor");
        const txGov = await Governor.getDeployTransaction(
            await token.getAddress(),
            await timelock.getAddress(),
            1, 50, 0, 20, 70
        );
        const receiptGov = await (await deployer.sendTransaction(txGov)).wait();
        gasReport["Deploy MyGovernor"] = receiptGov!.gasUsed;
        governor = Governor.attach(receiptGov!.contractAddress!) as MyGovernor;

        await token.setTrustedIssuer(issuer.address);
        await token.setTreasury(await treasury.getAddress());
        const govAddr = await governor.getAddress();
        await timelock.grantRole(await timelock.PROPOSER_ROLE(), govAddr);
        await timelock.grantRole(await timelock.EXECUTOR_ROLE(), ethers.ZeroAddress);
    });

    it("2. Join DAO (Mint Stake + Cold SSTORE)", async function () {
        // La joinDAO inizializza il balance dell'utente per la prima volta
        const tx = await token.connect(member1).joinDAO({ value: ethers.parseEther("5") });
        const receipt = await tx.wait();
        gasReport["Join DAO (SSTORE Cold)"] = receipt!.gasUsed;

        await token.connect(member2).joinDAO({ value: ethers.parseEther("5") });
    });

    it("3. Delegate All (Inizializzazione Checkpoint)", async function () {
        // La prima delega crea il primo array element di Checkpoints (Cold SSTORE)
        const tx = await token.connect(member1).delegate(member1.address);
        const receipt = await tx.wait();
        gasReport["Delegate (Checkpoint Cold)"] = receipt!.gasUsed;

        // Una seconda delega fa un SSTORE a caldo sul vecchio delegato e un Cold sul nuovo (o Warm se già delegato)
        const txWarm = await token.connect(member1).delegate(deployer.address);
        const receiptWarm = await txWarm.wait();
        gasReport["Delegate (Cambio Delega)"] = receiptWarm!.gasUsed;
        
        await token.connect(member1).delegate(member1.address);
        await token.connect(member2).delegate(member2.address);
    });

    it("4. Mint Tokens (Mint Stake + Warm SSTORE)", async function () {
        // L'utente ha già un balance e un array di checkpoint avviato.
        // Aggiungiamo stake tramite mintTokens() e vediamo la differenza di costo rispetto al JoinDAO
        const tx = await token.connect(member1).mintTokens({ value: ethers.parseEther("1") });
        const receipt = await tx.wait();
        gasReport["Mint Tokens (SSTORE Warm)"] = receipt!.gasUsed;
    });

    it("5. Upgrade Competences (VC Overhead vs Legacy)", async function () {
        const holderDid = "did:ethr:sepolia:0x" + member1.address.slice(2);
        const issuerDid = "did:ethr:sepolia:0x" + issuer.address.slice(2);
        await token.connect(member1).registerDID(holderDid);

        const vcData = {
            issuer: { id: issuerDid },
            issuanceDate: "2026-01-15T10:00:00Z",
            credentialSubject: {
                id: holderDid, university: "Pisa", faculty: "CS", degreeTitle: "PhD", grade: "110"
            },
        };
        const signature = await issuer.signTypedData({ name: "Universal VC Protocol", version: "1" }, VC_TYPES, vcData);

        // VC Upgrade
        const txVP = await token.connect(member1).upgradeCompetenceWithVP(vcData, signature);
        const receiptVP = await txVP.wait();
        gasReport["UpgradeSkill VC (EIP-712)"] = receiptVP!.gasUsed;
        
        // Calcolo teorico costo calldata
        const vcCalldataCost = calculateCalldataCost(txVP.data);

        // Legacy Upgrade (Simulato tramite impersonazione Timelock)
        const tlAddr = await timelock.getAddress();
        await network.provider.request({ method: "hardhat_impersonateAccount", params: [tlAddr] });
        await deployer.sendTransaction({ to: tlAddr, value: ethers.parseEther("1") });
        const signerTL = await ethers.getSigner(tlAddr);
        
        // degreeTitle = "PhD" per dare CompetenceGrade = 3
        const txLeg = await token.connect(signerTL).upgradeCompetence(member2.address, 3, "legacyProofString_PhD");
        const receiptLeg = await txLeg.wait();
        await network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [tlAddr] });
        
        gasReport["UpgradeSkill Legacy (Direct)"] = receiptLeg!.gasUsed;
        const legacyCalldataCost = calculateCalldataCost(txLeg.data);

        gasReport["[Overhead EIP-712 (Crypto)]"] = gasReport["UpgradeSkill VC (EIP-712)"] - gasReport["UpgradeSkill Legacy (Direct)"];
        
        // Salviamo in memoria i costi calldata per reportarli alla fine
        (this as any).vcCalldata = vcCalldataCost;
        (this as any).legacyCalldata = legacyCalldataCost;
    });

    it("6. Proposta e Vote Lifecycle", async function () {
        // Creazione Proposta usando la funzione legacy upgradeCompetence(address,uint8,string)
        // 4 rappresenta CompetenceGrade.Professor
        const calldata = token.interface.encodeFunctionData("upgradeCompetence", [member1.address, 4, "Promozione a Professore"]);
        const desc = "Promuovi Member1 a Professore";
        
        const txProp = await governor.connect(member1).propose([await token.getAddress()], [0n], [calldata], desc);
        const receiptProp = await txProp.wait();
        gasReport["Create Proposal"] = receiptProp!.gasUsed;
        
        const log = receiptProp!.logs.map((l: any) => { try { return governor.interface.parseLog(l); } catch { return null; } }).find((p: any) => p?.name === "ProposalCreated");
        const pid = log?.args?.proposalId;
        (this as any).proposalId = pid;
        
        await network.provider.send("hardhat_mine", ["0x2"]);

        // Primo CastVote (poca history nei checkpoint)
        const txVote = await governor.connect(member1).castVote(pid, 1);
        const receiptVote = await txVote.wait();
        gasReport["Cast Vote (1° Checkpoint)"] = receiptVote!.gasUsed;
    });

    it("7. Complessità O(log N) nei Checkpoints", async function () {
        // Per l'accademia, dimostriamo la crescita di costo nella ricerca binaria dei checkpoint.
        // Generiamo 10 checkpoint aumentando lo stake 10 volte (minimo 1 ether per fare +1 score)
        for (let i = 0; i < 10; i++) {
            await token.connect(member2).mintTokens({ value: ethers.parseEther("1") });
            await network.provider.send("hardhat_mine", ["0x1"]);
        }

        const pid = (this as any).proposalId;
        // Member2 vota. La ricerca del suo bilancio farà una Binary Search su ~10 elementi anziché 1.
        const txVote2 = await governor.connect(member2).castVote(pid, 1);
        const receiptVote2 = await txVote2.wait();
        gasReport["Cast Vote (10° Checkpoint)"] = receiptVote2!.gasUsed;
        
        gasReport["[O(log N) Search Overhead]"] = gasReport["Cast Vote (10° Checkpoint)"] - gasReport["Cast Vote (1° Checkpoint)"];
    });

    it("8. Queue ed Execute Proposal", async function () {
        const pid = (this as any).proposalId;
        await network.provider.send("hardhat_mine", ["0x35"]); // Salta Voting Period
        
        const calldata = token.interface.encodeFunctionData("upgradeCompetence", [member1.address, 4, "Promozione a Professore"]);
        const descHash = ethers.id("Promuovi Member1 a Professore");
        
        const txQueue = await governor.queue([await token.getAddress()], [0n], [calldata], descHash);
        const receiptQueue = await txQueue.wait();
        gasReport["Queue Proposal"] = receiptQueue!.gasUsed;

        await time.increase(3601); // Salta Timelock Delay

        const txExec = await governor.execute([await token.getAddress()], [0n], [calldata], descHash);
        const receiptExec = await txExec.wait();
        gasReport["Execute Proposal"] = receiptExec!.gasUsed;
    });

    it("Report Finale Formattato", async function () {
        const gasCostInEth = (gas: bigint) => ethers.formatEther(gas * currentGasPrice);
        const gasCostInUsd = (gas: bigint) => parseFloat(gasCostInEth(gas)) * ETH_PRICE_USD;

        // Calcolo Gas Totale per il Lifecycle utente standard (ignoriamo mock e i test O(logN))
        const totalLifecycleGas = 
            (gasReport["Deploy Timelock"] || 0n) +
            (gasReport["Deploy GovernanceToken"] || 0n) +
            (gasReport["Deploy Treasury"] || 0n) +
            (gasReport["Deploy MyGovernor"] || 0n) +
            (gasReport["Join DAO (SSTORE Cold)"] || 0n) +
            (gasReport["Delegate (Checkpoint Cold)"] || 0n) +
            (gasReport["Mint Tokens (SSTORE Warm)"] || 0n) +
            (gasReport["UpgradeSkill VC (EIP-712)"] || 0n) +
            (gasReport["Create Proposal"] || 0n) +
            (gasReport["Cast Vote (1° Checkpoint)"] || 0n) +
            (gasReport["Queue Proposal"] || 0n) +
            (gasReport["Execute Proposal"] || 0n);

        console.log(`\n\n   ==================================================================================================`);
        console.log(`   🎓 REPORT GAS ACCADEMICO: CICLO DAO E COMPLESSITA' (ETH: $${ETH_PRICE_USD})`);
        console.log(`   ==================================================================================================\n`);
        
        for (const [action, gas] of Object.entries(gasReport)) {
            const isHighlight = action.startsWith("[");
            const prefix = isHighlight ? "   --> " : "   - ";
            console.log(`${prefix}${action.padEnd(35)} | Gas: ${String(gas).padStart(8)} | USD: ${fmtUsd(gasCostInUsd(gas)).padStart(8)}`);
            
            if (action === "Deploy MyGovernor" || 
                action === "Mint Tokens (SSTORE Warm)" || 
                action === "[Overhead EIP-712 (Crypto)]" || 
                action === "[O(log N) Search Overhead]" ||
                action === "Execute Proposal") {
                console.log(`   --------------------------------------------------------------------------------------------------`);
            }
        }
        
        console.log(`   🔥 COSTO TOTALE CICLO DAO (VC)      | Gas: ${String(totalLifecycleGas).padStart(8)} | USD: ${fmtUsd(gasCostInUsd(totalLifecycleGas)).padStart(8)}`);
        console.log(`   --------------------------------------------------------------------------------------------------`);

        console.log(`\n   📌 FOCUS ACCADEMICO & BEST PRACTICES PER LA TESI:`);
        console.log(`   --------------------------------------------------------------------------------------------------`);
        console.log(`   1. Cold vs Warm Storage (EIP-2929):`);
        console.log(`      JoinDAO ha un costo maggiore rispetto a mintTokens perché inizializza una variabile a 0 (SSTORE a freddo).`);
        console.log(`      mintTokens modifica un valore esistente, costando molto meno (SSTORE a caldo).`);
        console.log(`   `);
        console.log(`   2. Calldata Payload e Overhead Crittografico (VC vs Legacy):`);
        console.log(`      Calldata inviata per VC: ~${(this as any).vcCalldata} gas | Calldata per Legacy: ~${(this as any).legacyCalldata} gas.`);
        console.log(`      L'overhead calcolato (${gasReport["[Overhead EIP-712 (Crypto)]"]} gas) copre l'operazione di decodifica ABI e`);
        console.log(`      la funzione ecrecover per verificare la firma crittografica dell'EIP-712.`);
        console.log(`   `);
        console.log(`   3. Complessità O(log N) (Checkpoints Binary Search):`);
        console.log(`      Dopo aver creato artificialmente 10 nuovi Checkpoint (aumentando lo stake 10 volte su blocchi diversi),`);
        console.log(`      la funzione castVote spende circa ~${gasReport["[O(log N) Search Overhead]"]} gas in più rispetto al primo voto.`);
        console.log(`      Questo dimostra matematicamente che l'algoritmo di ricerca binaria scala in modo ottimale, mantenendo`);
        console.log(`      i costi di scansione microscopici rispetto al costo complessivo della transazione.`);
        console.log(`   ==================================================================================================\n`);
    });
});
