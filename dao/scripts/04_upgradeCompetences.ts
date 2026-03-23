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
// I campi in CredentialSubject devono essere rigorosamente in ordine alfabetico
const VC_TYPES = {
    CredentialSubject: [
        { name: "codiceFiscale", type: "string" },
        { name: "dataNascita", type: "string" },
        { name: "exp", type: "uint256" },
        { name: "facolta", type: "string" },
        { name: "id", type: "string" },
        { name: "nbf", type: "uint256" },
        { name: "nominativo", type: "string" },
        { name: "titoloStudio", type: "string" },
        { name: "universita", type: "string" },
        { name: "voto", type: "string" },
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

    // ── FASE 2: Lettura delle VP da Veramo (Opzione B) ──
    // Il modulo Veramo ha generato off-chain i file JSON nella cartella "credentials".
    // Lo script DAO li legge, estrae le firme e costruisce la proposta on-chain.

    console.log("\n📝 La DAO legge le VC generate da Veramo...");

    // Dominio EIP-712 del GovernanceToken (deve corrispondere a quello nel contratto)
    const domain = {
        name: "CompetenceDAO Token",
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: addresses.token,
    };

    const now = await time.latest();
    const issuerDid = `did:ethr:0x${issuer.address.slice(2)}`;

    // Lista degli upgrade da applicare (con titoli descrittivi)
    const upgrades = [
        { signer: signers[0],  grade: "Professor", label: "Professor 1" },
        { signer: signers[1],  grade: "Professor", label: "Professor 2" },
        { signer: signers[2],  grade: "Professor", label: "Professor 3" },
        { signer: signers[3],  grade: "Professor", label: "Professor 4" },
        { signer: signers[4],  grade: "Professor", label: "Professor 5" },
        { signer: signers[5],  grade: "PhD", label: "PhD 1" },
        { signer: signers[6],  grade: "PhD", label: "PhD 2" },
        { signer: signers[7],  grade: "PhD", label: "PhD 3" },
        { signer: signers[8],  grade: "MasterDegree", label: "Master 1" },
        { signer: signers[9],  grade: "MasterDegree", label: "Master 2" },
        { signer: signers[10], grade: "BachelorDegree", label: "Bachelor 1" },
        { signer: signers[11], grade: "BachelorDegree", label: "Bachelor 2" },
        { signer: signers[12], grade: "BachelorDegree", label: "Bachelor 3" },
    ];

    const tokenAddr = addresses.token;
    const targets: string[] = [];
    const values: bigint[] = [];
    const calldatas: string[] = [];
    const veramoCredsPath = path.join(__dirname, "..", "..", "veramo", "credentials");

    for (const u of upgrades) {
        let vcDataObj: any = null;
        let signature = "";
        
        if (fs.existsSync(veramoCredsPath)) {
            const files = fs.readdirSync(veramoCredsPath);
            for (const file of files) {
                if (file.endsWith(".json")) {
                    const content = JSON.parse(fs.readFileSync(path.join(veramoCredsPath, file), "utf-8"));
                    if (content.credentialSubject?.titoloStudio === u.grade) {
                        vcDataObj = content;
                        signature = content.proof?.proofValue || "0x0";
                        break;
                    }
                }
            }
        }

        // Se non troviamo il JSON da Veramo, creiamo un mock hardcoded
        if (!vcDataObj) {
            console.log(`   ⚠️ JSON per ${u.label} non trovato in ${veramoCredsPath}. MOCK locale inserito.`);
            const holderDid = `did:ethr:0x${u.signer.address.slice(2)}`;
            vcDataObj = {
                issuerDid: issuerDid,
                issuerAddress: issuer.address,
                subject: {
                    codiceFiscale: "XXXXXX90A01Y000Z",
                    dataNascita: "1990-01-01",
                    exp: now + 86400 * 365,
                    facolta: "Computer Science",
                    id: holderDid,
                    nbf: now - 3600,
                    nominativo: "Mock Nominativo",
                    titoloStudio: u.grade,
                    universita: "Mock University",
                    voto: "110/110"
                },
                issuanceDate: new Date().toISOString(),
                expirationDate: new Date(Date.now() + 86400000 * 365).toISOString(),
            };
            signature = await issuer.signTypedData(domain, VC_TYPES, vcDataObj);
        } else {
            // Estrazione dati reali dal JSON Veramo per adattarli alla struct Solidity alfabetica
            const holderDid = vcDataObj.credentialSubject.id;
            
            try {
                await token.connect(u.signer).registerDID(holderDid);
                console.log(`   🔗 DID Registrato per signer: ${holderDid}`);
            } catch { /* Ignora se già registrato */ }

            // Mappiamo i campi del JSON nel formato esatto della struct Solidity in ordine alfabetico
            const solStruct = {
                issuerDid: vcDataObj.issuer.id || vcDataObj.issuer,
                issuerAddress: addresses.issuer, 
                subject: {
                    codiceFiscale: vcDataObj.credentialSubject.codiceFiscale || "XXXYYY00A01H501Z",
                    dataNascita: vcDataObj.credentialSubject.dataNascita || "1990-01-01",
                    exp: vcDataObj.credentialSubject.exp || now + 86400 * 365,
                    facolta: vcDataObj.credentialSubject.facolta || "Informatica",
                    id: holderDid,
                    nbf: vcDataObj.credentialSubject.nbf || now - 3600,
                    nominativo: vcDataObj.credentialSubject.nominativo || "N/A N/A",
                    titoloStudio: vcDataObj.credentialSubject.titoloStudio || "Student",
                    universita: vcDataObj.credentialSubject.universita || "University of Computer Science",
                    voto: vcDataObj.credentialSubject.voto || "N/A"
                },
                issuanceDate: vcDataObj.issuanceDate,
                expirationDate: vcDataObj.expirationDate || new Date(Date.now() + 86400000 * 365).toISOString(),
            };
            vcDataObj = solStruct;
        }

        // Prepara il calldata per upgradeCompetenceWithVP
        targets.push(tokenAddr);
        values.push(0n);
        calldatas.push(
            token.interface.encodeFunctionData("upgradeCompetenceWithVP", [
                u.signer.address, vcDataObj, signature,
            ])
        );

        console.log(`   🔏 ${u.label} (grado ${u.grade}) → pacchetto VP preparato`);
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
