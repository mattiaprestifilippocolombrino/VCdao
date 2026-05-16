/*
=============================================================================
  SCRIPT: issue-for-dao.ts
  SCOPO: Emettere Verifiable Credentials (VC) in formato EIP-712, 
         perfettamente allineate con gli Smart Contract `GovernanceToken.sol` 
         e `VPVerifier.sol` del progetto CompetenceDAO.
=============================================================================
*/

import "dotenv/config";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

// ── Modelli di dati condivisi ──────────────────────────────────────────────
import {
  CREDENTIAL_CONTEXT,
  CREDENTIAL_TYPE,
  VC_TYPES,
  CREDENTIALS_DIR,
  DAO_SHARED_CREDENTIALS_DIR,
  HOLDERS,
  UNIVERSITY_INFO,
  toDid,
  toIsoSecondPrecision,
} from "../types/credentials";

// ── Helpers ─────────────────────────────────────────────────────────────────
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`[ERRORE FATALE] Variabile d'ambiente ${name} mancante nel file .env`);
  }
  return value.trim();
}

function prepareDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  for (const file of fs.readdirSync(dirPath)) {
    if (file.endsWith(".json")) fs.unlinkSync(path.join(dirPath, file));
  }
}

function credentialFileName(index: number, alias: string): string {
  return `${String(index + 1).padStart(2, "0")}_${alias}.json`;
}

// ── Core Logic ──────────────────────────────────────────────────────────────
export async function issueDaoCompatibleCredentials(): Promise<void> {
  console.log("==========================================================");
  console.log("  Generazione VC EIP-712 per CompetenceDAO (Self-Sovereign)");
  console.log("==========================================================\n");

  // 1. Inizializzazione Issuer Wallet
  const issuerPrivateKey = requireEnv("DAO_ISSUER_PRIVATE_KEY");
  if (!ethers.isHexString(issuerPrivateKey, 32)) {
    throw new Error("DAO_ISSUER_PRIVATE_KEY deve essere una stringa hex da 32 byte.");
  }
  const issuerWallet = new ethers.Wallet(issuerPrivateKey);
  const issuerDid = toDid(issuerWallet.address);

  console.log(`🏛️  Issuer Wallet configurato: ${issuerWallet.address}`);
  console.log(`🆔 Issuer DID: ${issuerDid}\n`);

  // 2. Controllo coerenza con il Deploy della DAO
  const deployedPath = path.join(__dirname, "../../dao/deployedAddresses.json");
  if (!fs.existsSync(deployedPath)) {
    console.warn("⚠️  ATTENZIONE: deployedAddresses.json non trovato. La DAO non sembra deployata.");
    console.warn("Le credenziali verranno generate, ma potrebbero non essere valide on-chain.\n");
  } else {
    const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf-8"));
    const deployedIssuer = deployed.issuer ? ethers.getAddress(deployed.issuer) : null;
    
    if (deployedIssuer && deployedIssuer !== issuerWallet.address) {
      console.error("❌ ERRORE CRITICO DI COERENZA (MISTMATCH ISSUER) ❌");
      console.error(`   Il contratto GovernanceToken è stato deployato fidandosi di: ${deployedIssuer}`);
      console.error(`   Ma questo script sta firmando le VC con il wallet:           ${issuerWallet.address}`);
      console.error("");
      console.error("💡 SOLUZIONE OBBLIGATORIA:");
      console.error("   Devi rifare il deploy della DAO indicando l'indirizzo corretto dell'issuer.");
      console.error("   Esegui questo comando nel terminale della cartella 'dao/':");
      console.error(`   export DAO_TRUSTED_ISSUER=${issuerWallet.address} && npx hardhat run scripts/01_deploy.ts --network localhost\n`);
      throw new Error("Esecuzione interrotta per proteggere la consistenza del sistema DAO.");
    } else {
      console.log("✅ Coerenza Issuer verificata: Il GovernanceToken riconoscerà queste VC.\n");
    }
  }

  // 3. Preparazione directory
  const localDir = path.join(__dirname, "..", CREDENTIALS_DIR);
  const sharedDir = path.join(__dirname, "..", "..", DAO_SHARED_CREDENTIALS_DIR);
  prepareDir(localDir);
  prepareDir(sharedDir);

  // 4. Dominio EIP-712 universale (Allineato con GovernanceToken.sol)
  const domain = {
    name: "Universal VC Protocol",
    version: "1",
  };

  const hardhatMnemonic = requireEnv("DAO_HARDHAT_MNEMONIC");

  // 5. Generazione firme e file JSON per tutti gli holder
  console.log("📝 Generazione firme crittografiche EIP-712 in corso...\n");

  for (const [i, holder] of HOLDERS.entries()) {
    const holderWallet = ethers.HDNodeWallet.fromPhrase(
      hardhatMnemonic,
      undefined,
      `m/44'/60'/0'/0/${holder.signerIndex}`
    );
    const holderDid = toDid(holderWallet.address);
    const issuanceDate = toIsoSecondPrecision(new Date());

    // Payload EIP-712 perfettamente mappato alla struct VerifiableCredential di VPVerifier.sol
    const vcForSigning = {
      issuer: { id: issuerDid },
      issuanceDate,
      credentialSubject: {
        id: holderDid,
        university: UNIVERSITY_INFO.name,
        faculty: holder.faculty,
        degreeTitle: holder.degreeTitle,
        grade: holder.grade,
      },
    };

    // La firma tramite ethers genererà un signTypedData che VPVerifier.recoverIssuer decodificherà
    const proofValue = await issuerWallet.signTypedData(domain, VC_TYPES, vcForSigning);

    // Costruzione oggetto JSON W3C standard
    const credentialJson = {
      "@context": [...CREDENTIAL_CONTEXT],
      type: [...CREDENTIAL_TYPE],
      issuer: vcForSigning.issuer,
      issuanceDate: vcForSigning.issuanceDate,
      credentialSubject: vcForSigning.credentialSubject,
      proof: {
        type: "EthereumEip712Signature2021",
        created: issuanceDate,
        proofPurpose: "assertionMethod",
        verificationMethod: `${issuerDid}#controller`,
        proofValue, // Iniezione della firma EIP-712 nel JSON
      },
    };

    const localPath = path.join(localDir, `${holder.alias}.json`);
    const sharedPath = path.join(sharedDir, credentialFileName(i, holder.alias));

    fs.writeFileSync(localPath, JSON.stringify(credentialJson, null, 2), "utf-8");
    fs.writeFileSync(sharedPath, JSON.stringify(credentialJson, null, 2), "utf-8");

    console.log(`   [${String(i + 1).padStart(2, "0")}/${HOLDERS.length}] ✔️  ${holder.degreeTitle.padEnd(12)} per ${holderDid}`);
  }

  console.log("\n==========================================================");
  console.log("  🎉 Operazione completata con successo!");
  console.log(`  Cartella condivisa: ${sharedDir}`);
  console.log("==========================================================");
}

if (require.main === module) {
  issueDaoCompatibleCredentials().catch((error) => {
    console.error("\n" + error.message);
    process.exit(1);
  });
}
