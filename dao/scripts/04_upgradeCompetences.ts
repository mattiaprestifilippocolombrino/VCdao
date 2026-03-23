/*
04_upgradeCompetences.ts — Upgrade di competenza con Verifiable Presentation (VP) EIP-712

Script che dimostra il core della tesi: la DAO verifica on-chain una Verifiable Credential
firmata dall'Issuer fidato (Università) con EIP-712, ed effettua l'upgrade di competenza.

FLUSSO:
1. L'Issuer (signers[15]) firma le VC dei membri con EIP-712 off-chain
2. I membri registrano il proprio DID nel GovernanceToken
3. Viene creata una proposta di governance batch con le VP
4. I membri votano FOR → la proposta viene approvata
5. La proposta viene messa in coda nel Timelock, poi eseguita
6. Il contratto verifica ogni firma EIP-712 on-chain e aggiorna i gradi

RISULTATO DOPO L'UPGRADE:
- 5 Professors: base × 5   (Es: 100.000 × 5 = 500.000 COMP)
- 3 PhDs:       base × 4   (Es: 30.000 × 4 = 120.000 COMP)
- 2 Masters:    base × 3   (Es: 15.000 × 3 = 45.000 COMP)
- 3 Bachelors:  base × 2   (Es: 8.000 × 2 = 16.000 COMP)
- 2 Students:   nessun upgrade (restano base × 1)

ESECUZIONE: npx hardhat run scripts/04_upgradeCompetences.ts --network localhost
*/

import { ethers } from "hardhat";
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
import * as fs from "fs";
import * as path from "path";

// Nomi leggibili per i gradi
const GRADE_NAMES: Record<number, string> = {
    0: "Student", 1: "Bachelor", 2: "Master", 3: "PhD", 4: "Professor",
};

// Tipi EIP-712 per la VerifiableCredential (devono corrispondere a VPVerifier.sol)
const VC_TYPES = {
    CredentialSubject: [
        { name: "id", type: "string" },
        { name: "holderAddress", type: "address" },
        { name: "degreeLevel", type: "uint8" },
        { name: "nbf", type: "uint256" },
        { name: "exp", type: "uint256" },
    ],
    VerifiableCredential: [
        { name: "issuerDid", type: "string" },
        { name: "issuerAddress", type: "address" },
        { name: "subject", type: "CredentialSubject" },
        { name: "issuanceDate", type: "string" },
        { name: "expirationDate", type: "string" },
    ],
};

async function main() {
    const signers = await ethers.getSigners();
    const issuer = signers[15]; // L'Issuer fidato (Università)

    console.log("══════════════════════════════════════════════════");
    console.log("  CompetenceDAO — Upgrade competenze con VP EIP-712");
    console.log("══════════════════════════════════════════════════\n");

    // Carica gli indirizzi dei contratti
    const addressesPath = path.join(__dirname, "..", "deployedAddresses.json");
    const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
    const token = await ethers.getContractAt("GovernanceToken", addresses.token);
    const governor = await ethers.getContractAt("MyGovernor", addresses.governor);

    // Parametri di governance
    const VOTING_DELAY = 1;
    const VOTING_PERIOD = 50;
    const TIMELOCK_DELAY = 3600;

    // ── FASE 1: Registrazione DID dei membri ──
    // Ogni membro registra il proprio DID nel GovernanceToken.
    // Il DID è costruito a partire dall'indirizzo Ethereum.
    console.log("🔑 Registrazione DID dei membri...");
    for (let i = 0; i < 15; i++) {
        const did = `did:ethr:0x${signers[i].address.slice(2)}`;
        try {
            await token.connect(signers[i]).registerDID(did);
            console.log(`   ✅ ${signers[i].address.slice(0, 10)}... → ${did.slice(0, 30)}...`);
        } catch {
            // DID già registrato (script eseguito più volte)
            console.log(`   ⏭️  ${signers[i].address.slice(0, 10)}... → già registrato`);
        }
    }

    // ── FASE 2: Costruzione delle VP firmate dall'Issuer ──
    // L'Issuer (Università) firma una VC per ogni membro che deve fare upgrade.
    // I 2 Student (signers[13] e signers[14]) non vengono inclusi.

    // Dominio EIP-712 del GovernanceToken (deve corrispondere a quello nel contratto)
    const domain = {
        name: "CompetenceDAO Token",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: addresses.token,
    };

    const now = await time.latest();
    const issuerDid = `did:ethr:0x${issuer.address.slice(2)}`;

    // Lista degli upgrade da applicare (stessa struttura del vecchio script)
    const upgrades = [
        { signer: signers[0],  grade: 4, label: "Professor 1" },
        { signer: signers[1],  grade: 4, label: "Professor 2" },
        { signer: signers[2],  grade: 4, label: "Professor 3" },
        { signer: signers[3],  grade: 4, label: "Professor 4" },
        { signer: signers[4],  grade: 4, label: "Professor 5" },
        { signer: signers[5],  grade: 3, label: "PhD 1" },
        { signer: signers[6],  grade: 3, label: "PhD 2" },
        { signer: signers[7],  grade: 3, label: "PhD 3" },
        { signer: signers[8],  grade: 2, label: "Master 1" },
        { signer: signers[9],  grade: 2, label: "Master 2" },
        { signer: signers[10], grade: 1, label: "Bachelor 1" },
        { signer: signers[11], grade: 1, label: "Bachelor 2" },
        { signer: signers[12], grade: 1, label: "Bachelor 3" },
    ];

    console.log("\n📝 L'Issuer firma le VC con EIP-712...");

    // Per ogni upgrade, costruiamo: target, value, calldata con la VP firmata
    const tokenAddr = addresses.token;
    const targets: string[] = [];
    const values: bigint[] = [];
    const calldatas: string[] = [];

    for (const u of upgrades) {
        const holderDid = `did:ethr:0x${u.signer.address.slice(2)}`;

        // Costruisci la VC (Verifiable Credential) con i dati del membro
        const vcData = {
            issuerDid: issuerDid,
            issuerAddress: issuer.address,
            subject: {
                id: holderDid,
                holderAddress: u.signer.address,
                degreeLevel: u.grade,
                nbf: now - 3600,            // Valida da 1 ora fa
                exp: now + 86400 * 365,     // Scade tra 1 anno
            },
            issuanceDate: new Date().toISOString(),
            expirationDate: new Date(Date.now() + 86400000 * 365).toISOString(),
        };

        // L'Issuer firma la VC con EIP-712 (firma off-chain)
        const signature = await issuer.signTypedData(domain, VC_TYPES, vcData);

        // Prepara il calldata per upgradeCompetenceWithVP
        targets.push(tokenAddr);
        values.push(0n);
        calldatas.push(
            token.interface.encodeFunctionData("upgradeCompetenceWithVP", [
                u.signer.address, vcData, signature,
            ])
        );

        console.log(`   🔏 ${u.label} (grado ${u.grade}) → firma OK`);
    }

    // ── FASE 3: Proposta di governance batch ──
    const description = "VP Batch upgrade: 5 Professors, 3 PhDs, 2 Masters, 3 Bachelors (EIP-712)";

    console.log("\n📝 Creazione proposta batch (13 upgrade con VP)...");
    const tx = await governor.propose(targets, values, calldatas, description);
    const receipt = await tx.wait();

    const proposalId = receipt!.logs
        .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
        .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;

    // ── FASE 4: Votazione ──
    await mine(VOTING_DELAY + 1);
    await governor.connect(signers[0]).castVote(proposalId, 1); // FOR
    await governor.connect(signers[1]).castVote(proposalId, 1); // FOR

    const state = Number(await governor.state(proposalId));
    if (state !== 4) {
        console.log("   ⏳ Superquorum non raggiunto, attendo fine voting period...");
        await mine(VOTING_PERIOD + 1);
    }
    console.log("   ✅ Proposta approvata!");

    // ── FASE 5: Queue + Execute ──
    const descHash = ethers.id(description);
    await governor.queue(targets, values, calldatas, descHash);
    console.log("   🔒 Proposta in coda nel Timelock");

    await time.increase(TIMELOCK_DELAY + 1);
    await governor.execute(targets, values, calldatas, descHash);
    console.log("   🚀 Upgrade VP eseguiti! Le firme EIP-712 sono state verificate on-chain!\n");

    // ── Riepilogo ──
    console.log("📊 Token dopo gli upgrade (verificati con VP EIP-712):");
    const labels = [
        "Professor 1", "Professor 2", "Professor 3", "Professor 4", "Professor 5",
        "PhD 1", "PhD 2", "PhD 3", "Master 1", "Master 2",
        "Bachelor 1", "Bachelor 2", "Bachelor 3", "Student 1", "Student 2",
    ];
    for (let i = 0; i < 15; i++) {
        const bal = await token.balanceOf(signers[i].address);
        const grade = Number(await token.getMemberGrade(signers[i].address));
        const proof = await token.competenceProof(signers[i].address);
        const proofTag = proof.startsWith("VP-EIP712:") ? " [VP ✓]" : "";
        console.log(`   ${labels[i]}: ${ethers.formatUnits(bal, 18)} COMP (${GRADE_NAMES[grade]})${proofTag}`);
    }

    const supply = await token.totalSupply();
    console.log(`\n   📊 Supply totale: ${ethers.formatUnits(supply, 18)} COMP`);
    console.log(`   📊 Quorum (20%): ${ethers.formatUnits(supply * 20n / 100n, 18)} COMP`);
    console.log(`   📊 Superquorum (70%): ${ethers.formatUnits(supply * 70n / 100n, 18)} COMP`);

    console.log("\n══════════════════════════════════════════════════");
    console.log("  ✅ Upgrade VP completati! Prossimo: 05_depositTreasury.ts");
    console.log("══════════════════════════════════════════════════");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
