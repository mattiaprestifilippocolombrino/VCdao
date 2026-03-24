import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

type Grade = "BachelorDegree" | "MasterDegree" | "PhD" | "Professor";

const VC_TYPES: Record<string, Array<{ name: string; type: string }>> = {
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

const UNIVERSITY_NAME = "University of Computer Science";
const FACULTY_NAME = "Informatica";

const UPGRADE_PLAN: Array<{ signerIndex: number; grade: Grade; label: string }> = [
  { signerIndex: 0, grade: "Professor", label: "Professor 1" },
  { signerIndex: 1, grade: "Professor", label: "Professor 2" },
  { signerIndex: 2, grade: "Professor", label: "Professor 3" },
  { signerIndex: 3, grade: "Professor", label: "Professor 4" },
  { signerIndex: 4, grade: "Professor", label: "Professor 5" },
  { signerIndex: 5, grade: "PhD", label: "PhD 1" },
  { signerIndex: 6, grade: "PhD", label: "PhD 2" },
  { signerIndex: 7, grade: "PhD", label: "PhD 3" },
  { signerIndex: 8, grade: "MasterDegree", label: "Master 1" },
  { signerIndex: 9, grade: "MasterDegree", label: "Master 2" },
  { signerIndex: 10, grade: "BachelorDegree", label: "Bachelor 1" },
  { signerIndex: 11, grade: "BachelorDegree", label: "Bachelor 2" },
  { signerIndex: 12, grade: "BachelorDegree", label: "Bachelor 3" },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Variabile ${name} mancante`);
  }
  return value.trim();
}

function buildFiscalCode(index: number): string {
  const n = String(index).padStart(2, "0");
  return `DAOHLD${n}A01H501Z`;
}

async function main() {
  console.log("--- Emissione VC compatibili DAO (EIP-712 strict) ---");

  const issuerPrivateKey = requireEnv("DAO_ISSUER_PRIVATE_KEY");
  if (!ethers.isHexString(issuerPrivateKey, 32)) {
    throw new Error("DAO_ISSUER_PRIVATE_KEY non valido: atteso private key 32-byte hex");
  }
  const hardhatMnemonic = requireEnv("DAO_HARDHAT_MNEMONIC");

  const deployedPath = path.join(__dirname, "../../dao/deployedAddresses.json");
  if (!fs.existsSync(deployedPath)) {
    throw new Error(
      `File ${deployedPath} non trovato. Esegui prima dao/scripts/01_deploy.ts`
    );
  }
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf-8"));
  const tokenAddressRaw = deployed?.token;
  if (!tokenAddressRaw || !ethers.isAddress(tokenAddressRaw)) {
    throw new Error("deployedAddresses.json non contiene un token address valido");
  }
  const tokenAddress = ethers.getAddress(tokenAddressRaw);

  const issuerWallet = new ethers.Wallet(issuerPrivateKey);
  const issuerDid = `did:ethr:0x${issuerWallet.address.slice(2)}`;
  const chainId = 31337;

  if (deployed.issuer && ethers.isAddress(deployed.issuer)) {
    const deployedIssuer = ethers.getAddress(deployed.issuer);
    if (deployedIssuer !== issuerWallet.address) {
      throw new Error(
        `Issuer mismatch: deployed=${deployedIssuer}, privateKey=${issuerWallet.address}`
      );
    }
  }

  const outDir = path.join(__dirname, "../../dao/scripts/shared-credentials");
  fs.mkdirSync(outDir, { recursive: true });
  for (const file of fs.readdirSync(outDir)) {
    if (file.endsWith(".json")) fs.unlinkSync(path.join(outDir, file));
  }

  const domain = {
    name: "CompetenceDAO Token",
    version: "1",
    chainId,
    verifyingContract: tokenAddress,
  };

  const now = Math.floor(Date.now() / 1000);

  for (const [i, item] of UPGRADE_PLAN.entries()) {
    const holderWallet = ethers.HDNodeWallet.fromPhrase(
      hardhatMnemonic,
      undefined,
      `m/44'/60'/0'/0/${item.signerIndex}`
    );
    const holderAddress = holderWallet.address;
    const holderDid = `did:ethr:0x${holderAddress.slice(2)}`;

    const issuanceDate = new Date().toISOString();
    const exp = now + 60 * 60 * 24 * 365 * 5;
    const nbf = now - 3600;
    const expirationDate = new Date(exp * 1000).toISOString();

    const vcForSigning = {
      issuerDid,
      issuerAddress: issuerWallet.address,
      subject: {
        codiceFiscale: buildFiscalCode(i + 1),
        dataNascita: "1990-01-01",
        exp,
        facolta: FACULTY_NAME,
        id: holderDid,
        nbf,
        nominativo: item.label,
        titoloStudio: item.grade,
        universita: UNIVERSITY_NAME,
        voto: "N/A",
      },
      issuanceDate,
      expirationDate,
    };

    const proofValue = await issuerWallet.signTypedData(domain, VC_TYPES, vcForSigning);
    const credentialJson = {
      issuer: { id: issuerDid },
      credentialSubject: vcForSigning.subject,
      issuanceDate,
      expirationDate,
      proof: {
        type: "EthereumEip712Signature2021",
        created: issuanceDate,
        proofPurpose: "assertionMethod",
        verificationMethod: `${issuerDid}#controller`,
        proofValue,
      },
      meta: {
        holderAddress,
        signerIndex: item.signerIndex,
        grade: item.grade,
        tokenAddress,
        chainId,
      },
    };

    const outPath = path.join(
      outDir,
      `${String(i + 1).padStart(2, "0")}_${item.label.replace(/\s+/g, "_").toLowerCase()}.json`
    );
    fs.writeFileSync(outPath, JSON.stringify(credentialJson, null, 2), "utf-8");
    console.log(`✅ VC ${i + 1}/${UPGRADE_PLAN.length} -> ${outPath}`);
  }

  console.log("\n✅ VC DAO generate con successo (strict, no fallback).");
  console.log(`Issuer: ${issuerWallet.address}`);
  console.log(`Token domain: ${tokenAddress} (chainId ${chainId})`);
}

main().catch((error) => {
  console.error("Errore in issue-for-dao:", error.message);
  process.exit(1);
});
