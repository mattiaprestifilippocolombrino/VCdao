/*
04_upgradeCompetences.ts — Upgrade di competenza con Verifiable Presentation (VP) EIP-712

Script che dimostra il core della tesi: la DAO verifica on-chain una Verifiable Credential
firmata dall'Issuer fidato (Università) con EIP-712, ed effettua l'upgrade di competenza.

FLUSSO:
1. Le VC EIP-712 vengono generate off-chain dal modulo Veramo
2. I membri registrano il proprio DID nel GovernanceToken
3. Viene creata una proposta di governance batch con le VP
4. I membri votano FOR → la proposta viene approvata
5. La proposta viene messa in coda nel Timelock, poi eseguita
6. Il contratto verifica ogni firma EIP-712 on-chain e aggiorna i gradi

RISULTATO DOPO L'UPGRADE:
- I membri selezionati ricevono l'upgrade in base alle VC trusted realmente disponibili.
- Nessun dato viene simulato: se le VC richieste non esistono o non sono valide, lo script fallisce con errore esplicito.

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
const PROPOSAL_STATE_NAMES: Record<number, string> = {
    0: "Pending",
    1: "Active",
    2: "Canceled",
    3: "Defeated",
    4: "Succeeded",
    5: "Queued",
    6: "Expired",
    7: "Executed",
};

type ParsedCredential = {
    file: string;
    issuerDid: string;
    issuerAddress: string;
    issuanceDate: string;
    expirationDate: string;
    signature: string;
    subject: {
        codiceFiscale: string;
        dataNascita: string;
        exp: bigint;
        facolta: string;
        id: string;
        nbf: bigint;
        nominativo: string;
        titoloStudio: string;
        universita: string;
        voto: string;
    };
};

function assertString(value: unknown, field: string, file: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`VC non valida (${file}): campo '${field}' mancante o vuoto`);
    }
    return value;
}

function assertBigintLike(value: unknown, field: string, file: string): bigint {
    try {
        return BigInt(value as any);
    } catch {
        throw new Error(`VC non valida (${file}): campo '${field}' non numerico`);
    }
}

async function main() {
    const signers = await ethers.getSigners();

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

    // Garanzia di voting power: se lo script viene lanciato senza 03_delegateAll.ts,
    // auto-deleghiamo i membri che hanno token ma zero voti.
    for (let i = 0; i < 15; i++) {
        const member = signers[i];
        const balance = await token.balanceOf(member.address);
        const votes = await token.getVotes(member.address);
        if (balance > 0n && votes === 0n) {
            await token.connect(member).delegate(member.address);
        }
    }

    // ── FASE 1: Lettura delle VP generate per la DAO ──
    // Le credenziali sono generate dallo script veramo/scripts/issue-for-dao.ts
    // e salvate nella cartella condivisa dao/scripts/shared-credentials.
    // Lo script DAO li legge, estrae le firme e costruisce la proposta on-chain.

    console.log("\n📝 La DAO legge le VC condivise e registra i DID corretti...");

    const tokenAddr = addresses.token;
    const targets: string[] = [];
    const values: bigint[] = [];
    const calldatas: string[] = [];
    const veramoCredsPath = path.join(__dirname, "shared-credentials");

    if (!fs.existsSync(veramoCredsPath)) {
        throw new Error(
            `Cartella credenziali non trovata: ${veramoCredsPath}. Esegui prima veramo/scripts/issue-for-dao.ts.`
        );
    }

    const credentialFiles = fs
        .readdirSync(veramoCredsPath)
        .filter((f) => f.endsWith(".json"))
        .sort();
    if (credentialFiles.length === 0) {
        throw new Error(`Nessun file VC JSON trovato in ${veramoCredsPath}.`);
    }

    const trustedIssuer = ethers.getAddress(addresses.issuer);
    const parsedCredentials: ParsedCredential[] = credentialFiles.map((file) => {
        const filePath = path.join(veramoCredsPath, file);
        const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));

        const issuerDid = assertString(content?.issuer?.id, "issuer.id", file);
        const didTail = issuerDid.split(":").pop();
        if (!didTail) {
            throw new Error(`VC non valida (${file}): issuer DID malformato (${issuerDid})`);
        }

        let issuerAddress = "";
        if (ethers.isAddress(didTail)) {
            issuerAddress = ethers.getAddress(didTail);
        } else {
            const isCompressedPubKey = /^0x[0-9a-fA-F]{66}$/.test(didTail);
            const isUncompressedPubKey = /^0x[0-9a-fA-F]{130}$/.test(didTail);
            if (!isCompressedPubKey && !isUncompressedPubKey) {
                throw new Error(
                    `VC non valida (${file}): issuer DID non contiene né address né public key valida (${issuerDid})`
                );
            }
            issuerAddress = ethers.computeAddress(didTail);
        }

        const signature = assertString(content?.proof?.proofValue, "proof.proofValue", file);
        const issuanceDate = assertString(content?.issuanceDate, "issuanceDate", file);
        const expirationDate = assertString(content?.expirationDate, "expirationDate", file);
        const subjectRaw = content?.credentialSubject ?? {};

        return {
            file,
            issuerDid,
            issuerAddress,
            issuanceDate,
            expirationDate,
            signature,
            subject: {
                codiceFiscale: assertString(subjectRaw.codiceFiscale, "credentialSubject.codiceFiscale", file),
                dataNascita: assertString(subjectRaw.dataNascita, "credentialSubject.dataNascita", file),
                exp: assertBigintLike(subjectRaw.exp, "credentialSubject.exp", file),
                facolta: assertString(subjectRaw.facolta, "credentialSubject.facolta", file),
                id: assertString(subjectRaw.id, "credentialSubject.id", file),
                nbf: assertBigintLike(subjectRaw.nbf, "credentialSubject.nbf", file),
                nominativo: assertString(subjectRaw.nominativo, "credentialSubject.nominativo", file),
                titoloStudio: assertString(subjectRaw.titoloStudio, "credentialSubject.titoloStudio", file),
                universita: assertString(subjectRaw.universita, "credentialSubject.universita", file),
                voto: assertString(subjectRaw.voto, "credentialSubject.voto", file),
            },
        };
    });

    const trustedCredentials = parsedCredentials.filter(
        (c) => c.issuerAddress === trustedIssuer
    );
    if (trustedCredentials.length === 0) {
        throw new Error(
            `Nessuna VC firmata dall'issuer trusted (${trustedIssuer}). Rigenera le VC con l'issuer corretto.`
        );
    }

    const upgradeSlots: Record<string, number[]> = {
        Professor: [0, 1, 2, 3, 4],
        PhD: [5, 6, 7],
        MasterDegree: [8, 9],
        BachelorDegree: [10, 11, 12],
    };
    const labelByGrade: Record<string, string> = {
        Professor: "Professor",
        PhD: "PhD",
        MasterDegree: "Master",
        BachelorDegree: "Bachelor",
    };
    const upgrades: Array<{ signer: (typeof signers)[number], grade: string, label: string }> = [];
    for (const [grade, slots] of Object.entries(upgradeSlots)) {
        const available = trustedCredentials.filter((c) => c.subject.titoloStudio === grade).length;
        if (available === 0) continue;

        const countToUse = Math.min(available, slots.length);
        for (let i = 0; i < countToUse; i++) {
            upgrades.push({
                signer: signers[slots[i]],
                grade,
                label: `${labelByGrade[grade]} ${i + 1}`,
            });
        }

        if (available > slots.length) {
            console.log(
                `   ⚠️ Trovate ${available} VC per ${grade}, ma gli slot piano upgrade sono ${slots.length}. Le VC extra verranno ignorate.`
            );
        }
    }
    if (upgrades.length === 0) {
        throw new Error(
            "Nessun upgrade pianificabile: mancano VC trusted per i gradi Bachelor/Master/PhD/Professor."
        );
    }
    console.log(`   📌 Upgrade pianificati da VC trusted: ${upgrades.length}`);

    const usedCredentialFiles = new Set<string>();

    for (const u of upgrades) {
        const selected = trustedCredentials.find(
            (c) => !usedCredentialFiles.has(c.file) && c.subject.titoloStudio === u.grade
        );
        if (!selected) {
            const remainingForGrade = trustedCredentials.filter(
                (c) => !usedCredentialFiles.has(c.file) && c.subject.titoloStudio === u.grade
            ).length;
            throw new Error(
                `VC insufficiente per ${u.label} (${u.grade}). Rimaste ${remainingForGrade} VC trusted per questo grado.`
            );
        }
        usedCredentialFiles.add(selected.file);

        const holderDid = selected.subject.id;
        const vcDataObj = {
            issuerDid: selected.issuerDid,
            issuerAddress: selected.issuerAddress,
            subject: {
                codiceFiscale: selected.subject.codiceFiscale,
                dataNascita: selected.subject.dataNascita,
                exp: selected.subject.exp,
                facolta: selected.subject.facolta,
                id: selected.subject.id,
                nbf: selected.subject.nbf,
                nominativo: selected.subject.nominativo,
                titoloStudio: selected.subject.titoloStudio,
                universita: selected.subject.universita,
                voto: selected.subject.voto
            },
            issuanceDate: selected.issuanceDate,
            expirationDate: selected.expirationDate,
        };
        const signature = selected.signature;

        const currentDid = await token.memberDID(u.signer.address);
        if (currentDid.length === 0) {
            await token.connect(u.signer).registerDID(holderDid);
            console.log(`   🔑 DID registrato per ${u.label}: ${holderDid}`);
        } else if (currentDid !== holderDid) {
            throw new Error(
                `DID già registrato diverso per ${u.label}: current=${currentDid}, vc=${holderDid}`
            );
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

    // Validazione locale prima della proposta:
    // ogni payload deve usare lo stesso DID già registrato per il membro target.
    for (let i = 0; i < calldatas.length; i++) {
        const decoded = token.interface.decodeFunctionData(
            "upgradeCompetenceWithVP",
            calldatas[i]
        );
        const member = decoded[0] as string;
        const vc = decoded[1] as any;
        const registeredDid = await token.memberDID(member);
        if (registeredDid !== vc.subject.id) {
            throw new Error(
                `Payload DID mismatch su indice ${i}: member=${member}, registered=${registeredDid}, vc=${vc.subject.id}`
            );
        }
    }

    // ── FASE 2: Proposta di governance batch ──
    const description = `VP Batch upgrade da VC trusted (EIP-712) — count: ${upgrades.length}`;

    console.log(`\n📝 Creazione proposta batch (${upgrades.length} upgrade con VP)...`);
    const tx = await governor.propose(targets, values, calldatas, description);
    const receipt = await tx.wait();

    const proposalId = receipt!.logs
        .map((log: any) => { try { return governor.interface.parseLog(log); } catch { return null; } })
        .find((p: any) => p?.name === "ProposalCreated")?.args?.proposalId;

    // ── FASE 3: Votazione ──
    await mine(VOTING_DELAY + 1);
    // Votiamo con i 5 membri principali per rendere lo script stabile:
    // anche con supply più alta si raggiunge superquorum rapidamente.
    for (let i = 0; i < 5; i++) {
        await governor.connect(signers[i]).castVote(proposalId, 1); // FOR
    }

    let state = Number(await governor.state(proposalId));
    if (state !== 4) {
        console.log("   ⏳ Superquorum non raggiunto, attendo fine voting period...");
        await mine(VOTING_PERIOD + 1);
        state = Number(await governor.state(proposalId));
    }
    if (state !== 4) {
        const [againstVotes, forVotes, abstainVotes] = await governor.proposalVotes(proposalId);
        const quorumVotes = await governor.quorum(await governor.proposalSnapshot(proposalId));
        throw new Error(
            `Proposal non approvata: stato=${PROPOSAL_STATE_NAMES[state] ?? state}, for=${forVotes}, against=${againstVotes}, abstain=${abstainVotes}, quorum=${quorumVotes}`
        );
    }
    console.log("   ✅ Proposta approvata!");

    // ── FASE 4: Queue + Execute ──
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
