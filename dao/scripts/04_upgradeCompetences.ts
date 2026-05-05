/*
04_upgradeCompetences.ts — Upgrade competenze con VC firmata EIP-712 (multi-topic)

Flusso (Self-Sovereign, best practice SSI):
1) Legge le VC JSON generate da veramo/scripts/issue-for-dao.ts
2) Valida che ogni VC rispetti il formato minimale richiesto
3) Registra i DID holder nel token (se non presenti)
4) Ogni membro chiama upgradeCompetenceWithVP DIRETTAMENTE, presentando
   la propria VC firmata — nessuna votazione di governance necessaria,
   perché la validità è verificata crittograficamente (ecrecover on-chain)

I degreeTitle supportati ora includono suffisso topic: BachelorCS, MasterCE, PhDEE, ecc.
*/

import { ethers } from "hardhat";
import * as fs   from "fs";
import * as path from "path";

// Mappa enum numerico → label leggibile (indice enum CompetenceGrade nel contratto)
const GRADE_NAMES: Record<number, string> = {
  0:  "Student",
  1:  "BachelorCS", 2: "MasterCS",  3: "PhDCS",  4: "ProfessorCS",
  5:  "BachelorCE", 6: "MasterCE",  7: "PhDCE",  8: "ProfessorCE",
  9:  "BachelorEE", 10: "MasterEE", 11: "PhDEE", 12: "ProfessorEE",
};

// Set di tutti i degreeTitle validi (con suffisso topic).
const ALLOWED_DEGREE_TITLES = new Set([
  "BachelorCS", "MasterCS", "PhDCS", "ProfessorCS",
  "BachelorCE", "MasterCE", "PhDCE", "ProfessorCE",
  "BachelorEE", "MasterEE", "PhDEE", "ProfessorEE",
]);

const REQUIRED_CONTEXT = ["https://www.w3.org/2018/credentials/v1"];
const REQUIRED_TYPE    = ["VerifiableCredential", "UniversityDegreeCredential"];
const VC_TOP_LEVEL_KEYS = ["@context", "type", "issuer", "issuanceDate", "credentialSubject", "proof"];
const ISSUER_KEYS   = ["id"];
const SUBJECT_KEYS  = ["id", "university", "faculty", "degreeTitle", "grade"];
const PROOF_KEYS    = ["type", "created", "proofPurpose", "verificationMethod", "proofValue"];

type ParsedCredential = {
  file: string;
  issuerDid: string;
  issuerAddress: string;
  issuanceDate: string;
  signature: string;
  credentialSubject: {
    id: string; university: string; faculty: string; degreeTitle: string; grade: string;
  };
};

function assertObject(v: unknown, f: string, file: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new Error(`VC non valida (${file}): '${f}' deve essere un oggetto`);
  return v as Record<string, unknown>;
}
function assertString(v: unknown, f: string, file: string): string {
  if (typeof v !== "string" || v.trim().length === 0)
    throw new Error(`VC non valida (${file}): '${f}' mancante o vuoto`);
  return v;
}
function assertIso8601Second(v: string, f: string, file: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v))
    throw new Error(`VC non valida (${file}): '${f}' deve essere YYYY-MM-DDTHH:MM:SSZ`);
  return v;
}
function assertExactKeys(obj: Record<string,unknown>, keys: string[], f: string, file: string): void {
  const found = Object.keys(obj).sort();
  const exp   = [...keys].sort();
  if (found.length !== exp.length || found.some((k,i) => k !== exp[i]))
    throw new Error(`VC non valida (${file}): '${f}' deve avere [${exp.join(",")}], trovati [${found.join(",")}]`);
}
function assertStringArrayExact(v: unknown, exp: readonly string[], f: string, file: string): void {
  if (!Array.isArray(v) || v.length !== exp.length || v.some((x,i) => x !== exp[i]))
    throw new Error(`VC non valida (${file}): '${f}' non conforme`);
}
function parseIssuerAddress(did: string, file: string): string {
  const tail = did.split(":").pop()!;
  if (ethers.isAddress(tail)) return ethers.getAddress(tail);
  if (/^0x[0-9a-fA-F]{66}$/.test(tail) || /^0x[0-9a-fA-F]{130}$/.test(tail))
    return ethers.computeAddress(tail);
  throw new Error(`VC non valida (${file}): issuer DID non valido (${did})`);
}

function parseCredential(filePath: string, fileName: string): ParsedCredential {
  const c = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  assertExactKeys(c, VC_TOP_LEVEL_KEYS, "VC", fileName);
  assertStringArrayExact(c["@context"], REQUIRED_CONTEXT, "@context", fileName);
  assertStringArrayExact(c.type, REQUIRED_TYPE, "type", fileName);

  const issuerRaw = assertObject(c.issuer, "issuer", fileName);
  assertExactKeys(issuerRaw, ISSUER_KEYS, "issuer", fileName);
  const issuerDid  = assertString(issuerRaw.id, "issuer.id", fileName);
  const issuanceDate = assertIso8601Second(assertString(c.issuanceDate, "issuanceDate", fileName), "issuanceDate", fileName);

  const subjectRaw = assertObject(c.credentialSubject, "credentialSubject", fileName);
  assertExactKeys(subjectRaw, SUBJECT_KEYS, "credentialSubject", fileName);
  const degreeTitle = assertString(subjectRaw.degreeTitle, "credentialSubject.degreeTitle", fileName);
  if (!ALLOWED_DEGREE_TITLES.has(degreeTitle))
    throw new Error(`VC non valida (${fileName}): degreeTitle non supportato (${degreeTitle}). Validi: ${[...ALLOWED_DEGREE_TITLES].join(", ")}`);

  const proofRaw = assertObject(c.proof, "proof", fileName);
  assertExactKeys(proofRaw, PROOF_KEYS, "proof", fileName);
  if (assertString(proofRaw.type, "proof.type", fileName) !== "EthereumEip712Signature2021")
    throw new Error(`VC non valida (${fileName}): proof.type non supportato`);
  if (assertString(proofRaw.proofPurpose, "proof.proofPurpose", fileName) !== "assertionMethod")
    throw new Error(`VC non valida (${fileName}): proof.proofPurpose non supportato`);
  assertIso8601Second(assertString(proofRaw.created, "proof.created", fileName), "proof.created", fileName);
  assertString(proofRaw.verificationMethod, "proof.verificationMethod", fileName);

  return {
    file: fileName,
    issuerDid,
    issuerAddress: parseIssuerAddress(issuerDid, fileName),
    issuanceDate,
    signature: assertString(proofRaw.proofValue, "proof.proofValue", fileName),
    credentialSubject: {
      id:          assertString(subjectRaw.id,         "credentialSubject.id",         fileName),
      university:  assertString(subjectRaw.university,  "credentialSubject.university",  fileName),
      faculty:     assertString(subjectRaw.faculty,     "credentialSubject.faculty",     fileName),
      degreeTitle,
      grade:       assertString(subjectRaw.grade,       "credentialSubject.grade",       fileName),
    },
  };
}

async function main() {
  const signers = await ethers.getSigners();

  console.log("══════════════════════════════════════════════════");
  console.log("  CompetenceDAO — Upgrade competenze multi-topic con VC");
  console.log("══════════════════════════════════════════════════\n");

  const addresses = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployedAddresses.json"), "utf8"));
  const token = await ethers.getContractAt("GovernanceToken", addresses.token);

  // Auto-delega per attivare il voting power ERC20.
  console.log("🔑 Auto-delega per attivare stake voting power...");
  for (let i = 0; i < 15; i++) {
    const member  = signers[i];
    const balance = await token.balanceOf(member.address);
    const votes   = await token.getVotes(member.address);
    if (balance > 0n && votes === 0n) {
      await token.connect(member).delegate(member.address);
      console.log(`   Signer ${i} delegato`);
    }
  }

  // Legge le VC dalla cartella condivisa.
  const credsPath = path.join(__dirname, "..", "..", "shared-credentials");
  if (!fs.existsSync(credsPath))
    throw new Error(`Cartella credenziali non trovata: ${credsPath}. Esegui prima veramo/scripts/issue-for-dao.ts`);

  const credentialFiles = fs.readdirSync(credsPath).filter(f => f.endsWith(".json")).sort();
  if (credentialFiles.length === 0)
    throw new Error(`Nessun file VC JSON trovato in ${credsPath}.`);

  console.log("\n📝 Lettura e validazione VC...");
  const trustedIssuer   = ethers.getAddress(addresses.issuer);
  const parsedAll       = credentialFiles.map(f => parseCredential(path.join(credsPath, f), f));
  const trustedCreds    = parsedAll.filter(c => c.issuerAddress === trustedIssuer);

  if (trustedCreds.length === 0)
    throw new Error(`Nessuna VC firmata dall'issuer trusted (${trustedIssuer}).`);

  console.log(`   Trovate ${trustedCreds.length} VC valide su ${parsedAll.length} totali.`);

  // Piano upgrade: ogni grado si assegna a un signer specifico in base all'alias.
  // Il mapping alias → signerIndex è definito in credentials.ts (HOLDERS).
  // Qui usiamo l'ordine dei file (prefisso numerico) per associare le VC ai signer.
  // Per ogni VC trusted, tentiamo di abbinare il degreeTitle al signer corrispondente.

  /*
  Strategia: assegniamo le VC ai signer in ordine di file (prefisso numerico 01_, 02_, ...).
  L'holder.signerIndex in credentials.ts è già l'indice signer corretto.
  Quindi leggiamo signerIndex direttamente dal holderDid non è possibile on-chain,
  ma le VC sono ordinate per alias (01_bachelor-cs-1.json → signer 11, ecc.).
  Per semplicità, usiamo un mapping degreeTitle → lista di slotIndex, come prima.
  */
  const upgradeSlots: Record<string, number[]> = {
    ProfessorCS: [0, 1, 2],
    ProfessorCE: [3],
    ProfessorEE: [4],
    PhDCS:       [5, 6],
    PhDCE:       [7],
    MasterCS:    [8, 9],
    MasterCE:    [10],
    BachelorCS:  [11, 12],
  };

  const usedFiles = new Set<string>();
  const toUpgrade: { signer: any; label: string; vcDataObj: any; signature: string }[] = [];

  for (const [grade, slots] of Object.entries(upgradeSlots)) {
    const available = trustedCreds.filter(c => c.credentialSubject.degreeTitle === grade && !usedFiles.has(c.file));
    const count     = Math.min(available.length, slots.length);
    if (count === 0) continue;

    for (let i = 0; i < count; i++) {
      const cred = available[i];
      usedFiles.add(cred.file);

      const signer     = signers[slots[i]];
      const holderDid  = cred.credentialSubject.id;
      const vcDataObj  = {
        issuer:             { id: cred.issuerDid },
        issuanceDate:       cred.issuanceDate,
        credentialSubject:  cred.credentialSubject,
      };

      // Registra DID se mancante.
      const currentDid = await token.memberDID(signer.address);
      if (currentDid.length === 0) {
        await token.connect(signer).registerDID(holderDid);
        console.log(`   🔑 DID registrato per signer ${slots[i]} (${grade}): ${holderDid}`);
      } else if (currentDid !== holderDid) {
        throw new Error(`DID mismatch per signer ${slots[i]}: current=${currentDid}, vc=${holderDid}`);
      }

      toUpgrade.push({ signer, label: `${grade} (signer ${slots[i]})`, vcDataObj, signature: cred.signature });
    }

    if (available.length > slots.length)
      console.log(`   ⚠️  ${grade}: ${available.length} VC disponibili, ${slots.length} slot. Extra ignorati.`);
  }

  if (toUpgrade.length === 0)
    throw new Error("Nessun upgrade pianificabile: mancano VC trusted.");

  // Esegui gli upgrade diretti (Self-Sovereign SSI).
  console.log(`\n🔐 Upgrade self-sovereign (${toUpgrade.length} membri)...`);
  for (const u of toUpgrade) {
    const tx = await token.connect(u.signer).upgradeCompetenceWithVP(u.vcDataObj, u.signature);
    await tx.wait();
    const gradeNum = Number(await token.getMemberGrade(u.signer.address));
    console.log(`   ✅ ${u.label} → ${GRADE_NAMES[gradeNum]} (verificato on-chain via EIP-712)`);
  }

  // Riepilogo finale.
  console.log("\n📊 Stato post-upgrade:");
  const NUM_TOPICS = 3;
  const TOPIC_LABELS = ["CS", "CE", "EE"];
  for (let i = 0; i < 13; i++) {
    const member   = signers[i];
    const bal      = await token.balanceOf(member.address);
    const gradeNum = Number(await token.getMemberGrade(member.address));
    const skillVP  = await Promise.all(
      Array.from({ length: NUM_TOPICS }, (_, t) => token.getSkillVotes(member.address, t))
    );
    const skillStr = skillVP.map((v, t) => `${TOPIC_LABELS[t]}:${ethers.formatUnits(v, 18)}`).join(" | ");
    console.log(`   Signer ${String(i).padStart(2)}: ${ethers.formatUnits(bal, 18)} COMP (${GRADE_NAMES[gradeNum]}) | skill ${skillStr}`);
  }

  const stakeSupply = await token.totalSupply();
  console.log(`\n   📊 Supply stake:          ${ethers.formatUnits(stakeSupply, 18)} COMP`);
  for (let t = 0; t < NUM_TOPICS; t++) {
    const skillSup = await token.getTotalSkillSupply(t);
    console.log(`   📊 Supply skill ${TOPIC_LABELS[t]}:  ${ethers.formatUnits(skillSup, 18)} VP`);
  }

  console.log("\n══════════════════════════════════════════════════");
  console.log("  ✅ Upgrade VC completati! Prossimo: 05_depositTreasury.ts");
  console.log("══════════════════════════════════════════════════");
}

main().catch(e => { console.error(e); process.exitCode = 1; });
