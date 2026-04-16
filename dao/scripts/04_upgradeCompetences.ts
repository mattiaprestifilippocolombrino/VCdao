/*
04_upgradeCompetences.ts — Upgrade competenze con VC firmata EIP-712

Flusso (Self-Sovereign, best practice SSI):
1) Legge le VC JSON generate da veramo/scripts/2-issue-credential.ts
2) Valida che ogni VC rispetti il formato minimale richiesto dal PoC
3) Registra i DID holder nel token (se non presenti)
4) Ogni membro chiama upgradeCompetenceWithVP DIRETTAMENTE, presentando
   la propria VC firmata — nessuna votazione di governance necessaria,
   perché la validità della VC è verificata crittograficamente (ecrecover)
*/

// Importiamo ethers da hardhat per interagire con la rete locale
import { ethers } from "hardhat";
// Helpers per manipolare il tempo e forzare il mining di blocchi
import { mine, time } from "@nomicfoundation/hardhat-network-helpers";
// Librerie Node.js per leggere file dal disco
import * as fs from "fs";
import * as path from "path";

const GRADE_NAMES: Record<number, string> = {
  0: "Student",
  1: "Bachelor",
  2: "Master",
  3: "PhD",
  4: "Professor",
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

const REQUIRED_CONTEXT = ["https://www.w3.org/2018/credentials/v1"];
const REQUIRED_TYPE = ["VerifiableCredential", "UniversityDegreeCredential"];
const ALLOWED_DEGREE_TITLES = new Set([
  "BachelorDegree",
  "MasterDegree",
  "PhD",
  "Professor",
]);

// ============================================================================
// 1. COSTANTI E DEFINIZIONE DELLA STRUTTURA DELLE W3C CREDENTIALS
// ============================================================================
// Array che esigono che le Verifiable Credentials contengano esattamente questi capi per essere valide (Anti-Fraud)
const VC_TOP_LEVEL_KEYS = [
  "@context",
  "type",
  "issuer",
  "issuanceDate",
  "credentialSubject",
  "proof",
];
// Chiavi richieste per l'oggetto Issuer (solo l'ID, ovvero il suo DID)
const ISSUER_KEYS = ["id"];
// Dati effettivi dello studente all'interno della Credenziale
const SUBJECT_KEYS = ["id", "university", "faculty", "degreeTitle", "grade"];
// Parametri della firma per l'algoritmo EIP-712
const PROOF_KEYS = ["type", "created", "proofPurpose", "verificationMethod", "proofValue"];

type ParsedCredential = {
  file: string;
  issuerDid: string;
  issuerAddress: string;
  issuanceDate: string;
  signature: string;
  credentialSubject: {
    id: string;
    university: string;
    faculty: string;
    degreeTitle: string;
    grade: string;
  };
};

function assertObject(value: unknown, field: string, file: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`VC non valida (${file}): '${field}' deve essere un oggetto`);
  }
  return value as Record<string, unknown>;
}

function assertString(value: unknown, field: string, file: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`VC non valida (${file}): campo '${field}' mancante o vuoto`);
  }
  return value;
}

function assertIso8601Second(value: string, field: string, file: string): string {
  const isoSecondRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
  if (!isoSecondRegex.test(value)) {
    throw new Error(
      `VC non valida (${file}): '${field}' deve rispettare YYYY-MM-DDTHH:MM:SSZ`
    );
  }
  return value;
}

function assertExactKeys(
  obj: Record<string, unknown>,
  expectedKeys: string[],
  field: string,
  file: string
): void {
  const found = Object.keys(obj).sort();
  const expected = [...expectedKeys].sort();
  if (found.length !== expected.length || found.some((k, i) => k !== expected[i])) {
    throw new Error(
      `VC non valida (${file}): '${field}' deve contenere solo [${expected.join(", ")}], trovati [${found.join(", ")}]`
    );
  }
}

function assertStringArrayExact(
  value: unknown,
  expected: readonly string[],
  field: string,
  file: string
): void {
  if (!Array.isArray(value) || value.length !== expected.length) {
    throw new Error(`VC non valida (${file}): '${field}' non conforme`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (value[i] !== expected[i]) {
      throw new Error(`VC non valida (${file}): '${field}' non conforme`);
    }
  }
}

function parseIssuerAddressFromDid(issuerDid: string, file: string): string {
  const didTail = issuerDid.split(":").pop();
  if (!didTail) {
    throw new Error(`VC non valida (${file}): issuer DID malformato (${issuerDid})`);
  }

  if (ethers.isAddress(didTail)) {
    return ethers.getAddress(didTail);
  }

  const isCompressedPubKey = /^0x[0-9a-fA-F]{66}$/.test(didTail);
  const isUncompressedPubKey = /^0x[0-9a-fA-F]{130}$/.test(didTail);
  if (!isCompressedPubKey && !isUncompressedPubKey) {
    throw new Error(
      `VC non valida (${file}): issuer DID non contiene né address né public key valida (${issuerDid})`
    );
  }
  return ethers.computeAddress(didTail);
}

// ============================================================================
// 2. FUNZIONE PRINCIPALE DI PARSING E VALIDAZIONE CREDENZIALI
// Questa funzione legge un file JSON dal disco e lo disassembla usando tutte le regole W3C
// ============================================================================
function parseCredential(filePath: string, fileName: string): ParsedCredential {
  // Legge file
  const content = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
  // Asserisce che ha esattamente i 6 valori Top Level
  assertExactKeys(content, VC_TOP_LEVEL_KEYS, "VC", fileName);

  assertStringArrayExact(content["@context"], REQUIRED_CONTEXT, "@context", fileName);
  assertStringArrayExact(content.type, REQUIRED_TYPE, "type", fileName);

  const issuerRaw = assertObject(content.issuer, "issuer", fileName);
  assertExactKeys(issuerRaw, ISSUER_KEYS, "issuer", fileName);
  const issuerDid = assertString(issuerRaw.id, "issuer.id", fileName);

  const issuanceDate = assertIso8601Second(
    assertString(content.issuanceDate, "issuanceDate", fileName),
    "issuanceDate",
    fileName
  );

  const subjectRaw = assertObject(content.credentialSubject, "credentialSubject", fileName);
  assertExactKeys(subjectRaw, SUBJECT_KEYS, "credentialSubject", fileName);
  const degreeTitle = assertString(
    subjectRaw.degreeTitle,
    "credentialSubject.degreeTitle",
    fileName
  );
  if (!ALLOWED_DEGREE_TITLES.has(degreeTitle)) {
    throw new Error(
      `VC non valida (${fileName}): degreeTitle non supportato (${degreeTitle})`
    );
  }

  const proofRaw = assertObject(content.proof, "proof", fileName);
  assertExactKeys(proofRaw, PROOF_KEYS, "proof", fileName);
  const proofType = assertString(proofRaw.type, "proof.type", fileName);
  const proofPurpose = assertString(proofRaw.proofPurpose, "proof.proofPurpose", fileName);
  if (proofType !== "EthereumEip712Signature2021") {
    throw new Error(`VC non valida (${fileName}): proof.type non supportato (${proofType})`);
  }
  if (proofPurpose !== "assertionMethod") {
    throw new Error(
      `VC non valida (${fileName}): proof.proofPurpose non supportato (${proofPurpose})`
    );
  }
  assertIso8601Second(
    assertString(proofRaw.created, "proof.created", fileName),
    "proof.created",
    fileName
  );
  assertString(proofRaw.verificationMethod, "proof.verificationMethod", fileName);

  return {
    file: fileName,
    issuerDid,
    issuerAddress: parseIssuerAddressFromDid(issuerDid, fileName),
    issuanceDate,
    signature: assertString(proofRaw.proofValue, "proof.proofValue", fileName),
    credentialSubject: {
      id: assertString(subjectRaw.id, "credentialSubject.id", fileName),
      university: assertString(subjectRaw.university, "credentialSubject.university", fileName),
      faculty: assertString(subjectRaw.faculty, "credentialSubject.faculty", fileName),
      degreeTitle,
      grade: assertString(subjectRaw.grade, "credentialSubject.grade", fileName),
    },
  };
}

async function main() {
  const signers = await ethers.getSigners();

  console.log("══════════════════════════════════════════════════");
  console.log("  CompetenceDAO — Upgrade competenze con VC minimale");
  console.log("══════════════════════════════════════════════════\n");

  const addressesPath = path.join(__dirname, "..", "deployedAddresses.json");
  const addresses = JSON.parse(fs.readFileSync(addressesPath, "utf8"));
  const token = await ethers.getContractAt("GovernanceToken", addresses.token);
  const governor = await ethers.getContractAt("MyGovernor", addresses.governor);

  const VOTING_DELAY = 1;
  const VOTING_PERIOD = 50;
  const TIMELOCK_DELAY = 3600;

  // ============================================================================
  // 3. AUTO-DELEGA
  // ============================================================================
  // Per poter votare su questa proposta, tutti gli account membri devono delegare i loro token a sè stessi.
  // Senza questo passaggio, il Governor OpenZeppelin considererà il loro peso di voto pari a zero.
  for (let i = 0; i < 15; i++) {
    const member = signers[i];
    const balance = await token.balanceOf(member.address); // Verifica quanti token possiedono
    const votes = await token.getVotes(member.address); // Verifica quanto peso di voto hanno attivo
    if (balance > 0n && votes === 0n) {
      // Se hanno token ma zero voti, auto-delegano
      await token.connect(member).delegate(member.address);
    }
  }

  console.log("\n📝 Lettura VC condivise e registrazione DID...");

  const tokenAddr = addresses.token;
  const targets: string[] = [];
  const values: bigint[] = [];
  const calldatas: string[] = [];
  const credsPath = path.join(__dirname, "..", "..", "shared-credentials");

  if (!fs.existsSync(credsPath)) {
    throw new Error(
      `Cartella credenziali non trovata: ${credsPath}. Esegui prima veramo/scripts/2-issue-credential.ts (o issue-for-dao.ts).`
    );
  }

  const credentialFiles = fs.readdirSync(credsPath).filter((f) => f.endsWith(".json")).sort();
  if (credentialFiles.length === 0) {
    throw new Error(`Nessun file VC JSON trovato in ${credsPath}.`);
  }

  // ============================================================================
  // 4. ESTRAZIONE E FILTRAGGIO CREDENZIALI
  // ============================================================================
  // L'indirizzo Ethereum "fidato" da cui le firme (EIP-712) dovranno provenire
  const trustedIssuer = ethers.getAddress(addresses.issuer);
  
  // Parso il contenuto di ogni file JSON
  const parsedCredentials = credentialFiles.map((file) =>
    parseCredential(path.join(credsPath, file), file)
  );

  // Filtro durissimo: tengo solo le credenziali emesse ESATTAMENTE dall'indirizzo Issuer deployato prima.
  const trustedCredentials = parsedCredentials.filter(
    (c) => c.issuerAddress === trustedIssuer
  );
  
  // Se non c'è neanche una credenziale valida, lo script si ferma e avvisa.
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

  const upgrades: Array<{ signer: (typeof signers)[number]; grade: string; label: string }> = [];
  for (const [grade, slots] of Object.entries(upgradeSlots)) {
    const available = trustedCredentials.filter(
      (c) => c.credentialSubject.degreeTitle === grade
    ).length;
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
      "Nessun upgrade pianificabile: mancano VC trusted per Bachelor/Master/PhD/Professor."
    );
  }
  console.log(`   📌 Upgrade pianificati da VC trusted: ${upgrades.length}`);

  const usedCredentialFiles = new Set<string>();
  const directUpgrades: { signer: any; label: string; vcDataObj: any; signature: string }[] = [];

  for (const u of upgrades) {
    const selected = trustedCredentials.find(
      (c) => !usedCredentialFiles.has(c.file) && c.credentialSubject.degreeTitle === u.grade
    );
    if (!selected) {
      const remainingForGrade = trustedCredentials.filter(
        (c) => !usedCredentialFiles.has(c.file) && c.credentialSubject.degreeTitle === u.grade
      ).length;
      throw new Error(
        `VC insufficiente per ${u.label} (${u.grade}). Rimaste ${remainingForGrade} VC trusted per questo grado.`
      );
    }
    usedCredentialFiles.add(selected.file);

    const holderDid = selected.credentialSubject.id;
    const vcDataObj = {
      issuer: {
        id: selected.issuerDid,
      },
      issuanceDate: selected.issuanceDate,
      credentialSubject: {
        id: selected.credentialSubject.id,
        university: selected.credentialSubject.university,
        faculty: selected.credentialSubject.faculty,
        degreeTitle: selected.credentialSubject.degreeTitle,
        grade: selected.credentialSubject.grade,
      },
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

    targets.push(tokenAddr);
    values.push(0n);
    calldatas.push(
      token.interface.encodeFunctionData("upgradeCompetenceWithVP", [
        vcDataObj,
        signature,
      ])
    );

    // Salva il riferimento signer→VC per la chiamata diretta
    directUpgrades.push({ signer: u.signer, label: u.label, vcDataObj, signature });

    console.log(`   🔏 ${u.label} (grado ${u.grade}) → pacchetto VC preparato`);
  }

  // ============================================================================
  // 5. UPGRADE DIRETTO — Self-Sovereign (Best Practice SSI)
  // ============================================================================
  // L'upgrade con VC è un'azione OGGETTIVA (verificata crittograficamente),
  // quindi non richiede una votazione di governance. Ogni membro chiama
  // upgradeCompetenceWithVP direttamente, presentando la propria VC firmata.
  // Questo incarna il principio SSI: "l'utente controlla la propria identità".
  console.log(`\n🔐 Upgrade self-sovereign (${directUpgrades.length} membri presentano le proprie VC)...`);

  for (const du of directUpgrades) {
    const tx = await token.connect(du.signer).upgradeCompetenceWithVP(du.vcDataObj, du.signature);
    await tx.wait();
    const grade = Number(await token.getMemberGrade(du.signer.address));
    console.log(`   ✅ ${du.label} → ${GRADE_NAMES[grade]} (verificato on-chain via EIP-712)`);
  }

  console.log("\n   🚀 Tutti gli upgrade VC completati! Le firme EIP-712 sono state verificate on-chain.\n");

  console.log("📊 Token dopo gli upgrade:");
  for (let i = 0; i < 15; i++) {
    const bal = await token.balanceOf(signers[i].address);
    const grade = Number(await token.getMemberGrade(signers[i].address));
    const proof = await token.competenceProof(signers[i].address);
    const proofTag = proof.startsWith("VP-EIP712:") ? " [VC ✓]" : "";
    console.log(`   Member ${i + 1}: ${ethers.formatUnits(bal, 18)} COMP (${GRADE_NAMES[grade]})${proofTag}`);
  }

  const supply = await token.totalSupply();
  console.log(`\n   📊 Supply totale: ${ethers.formatUnits(supply, 18)} COMP`);
  console.log(`   📊 Quorum (20%): ${ethers.formatUnits((supply * 20n) / 100n, 18)} COMP`);
  console.log(`   📊 Superquorum (70%): ${ethers.formatUnits((supply * 70n) / 100n, 18)} COMP`);

  console.log("\n══════════════════════════════════════════════════");
  console.log("  ✅ Upgrade VC completati! Prossimo: 05_depositTreasury.ts");
  console.log("══════════════════════════════════════════════════");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
