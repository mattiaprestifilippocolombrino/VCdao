/*
 * Flusso SSI di CompetenceDAO:
 * 1. importa nell'agent Veramo l'issuer e i wallet holder di Hardhat;
 * 2. emette e salva le VC EIP-712 tramite Veramo;
 * 3. crea e salva una VP firmata dal relativo holder;
 * 4. esporta VC e VP per gli script e i test della DAO.
 */

import "dotenv/config";
import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { createDaoVeramoAgent, importEthereumWallet } from "../agent";
import { DAO_EIP712_PROOF } from "../providers/DaoEip712CredentialProvider";
import {
  CREDENTIAL_CONTEXT,
  CREDENTIAL_TYPE,
  CREDENTIALS_DIR,
  DAO_SHARED_CREDENTIALS_DIR,
  DAO_SHARED_PRESENTATIONS_DIR,
  DEFAULT_ORGANIZATION,
  HOLDERS,
  PRESENTATIONS_DIR,
  addressFromEthrDid,
} from "../types/credentials";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[ERRORE FATALE] Variabile ${name} mancante nel file .env`);
  return value;
}

function prepareDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
  for (const file of fs.readdirSync(dirPath)) {
    if (file.endsWith(".json")) fs.unlinkSync(path.join(dirPath, file));
  }
}

function outputName(index: number, alias: string): string {
  return `${String(index + 1).padStart(2, "0")}_${alias}.json`;
}

async function verifyHardhatWallets(
  rpcUrl: string,
  mnemonic: string,
): Promise<Map<number, ethers.HDNodeWallet>> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const rpcAccounts = (await provider.send("eth_accounts", []) as string[])
    .map((address) => ethers.getAddress(address));
  const wallets = new Map<number, ethers.HDNodeWallet>();

  for (const holder of HOLDERS) {
    const wallet = ethers.HDNodeWallet.fromPhrase(
      mnemonic,
      undefined,
      `m/44'/60'/0'/0/${holder.signerIndex}`,
    );
    if (rpcAccounts[holder.signerIndex] !== wallet.address) {
      throw new Error(
        `Hardhat signer[${holder.signerIndex}] è ${rpcAccounts[holder.signerIndex] ?? "assente"}, ` +
        `ma il mnemonic Veramo deriva ${wallet.address}`,
      );
    }
    wallets.set(holder.signerIndex, wallet);
  }

  return wallets;
}

function assertTrustedIssuer(issuerAddress: string): void {
  const deployedPath = path.join(__dirname, "../../dao/deployedAddresses.json");
  if (!fs.existsSync(deployedPath)) {
    throw new Error("dao/deployedAddresses.json non trovato: eseguire prima il deploy Hardhat");
  }

  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));
  const trusted = (deployed.trustedIssuers ?? (deployed.issuer ? [deployed.issuer] : []))
    .map((address: string) => ethers.getAddress(address));
  if (!trusted.includes(ethers.getAddress(issuerAddress))) {
    throw new Error(
      `GovernanceSkill considera trusted [${trusted.join(", ")}], ` +
      `ma l'agent Veramo usa ${issuerAddress}`,
    );
  }
}

export async function issueDaoCompatibleCredentials(): Promise<void> {
  console.log("══════════════════════════════════════════════════════════");
  console.log("  CompetenceDAO — emissione SSI tramite agent Veramo");
  console.log("══════════════════════════════════════════════════════════\n");

  const issuerPrivateKey = requireEnv("DAO_ISSUER_PRIVATE_KEY");
  const hardhatMnemonic = requireEnv("DAO_HARDHAT_MNEMONIC");
  const kmsSecretKey = requireEnv("KMS_SECRET_KEY");
  const rpcUrl = process.env.DAO_HARDHAT_RPC_URL?.trim() || "http://127.0.0.1:8545";
  if (!ethers.isHexString(issuerPrivateKey, 32)) {
    throw new Error("DAO_ISSUER_PRIVATE_KEY deve contenere 32 byte esadecimali");
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(kmsSecretKey)) {
    throw new Error("KMS_SECRET_KEY deve contenere 32 byte esadecimali");
  }

  const issuerWallet = new ethers.Wallet(issuerPrivateKey);
  assertTrustedIssuer(issuerWallet.address);
  const hardhatWallets = await verifyHardhatWallets(rpcUrl, hardhatMnemonic);

  const localCredentials = path.join(__dirname, "..", CREDENTIALS_DIR);
  const sharedCredentials = path.join(__dirname, "..", "..", DAO_SHARED_CREDENTIALS_DIR);
  const localPresentations = path.join(__dirname, "..", PRESENTATIONS_DIR);
  const sharedPresentations = path.join(__dirname, "..", "..", DAO_SHARED_PRESENTATIONS_DIR);
  for (const directory of [localCredentials, sharedCredentials, localPresentations, sharedPresentations]) {
    prepareDir(directory);
  }

  // Ogni esecuzione rappresenta una nuova sessione demo SSI riproducibile.
  const databasePath = path.join(__dirname, "..", "database.sqlite");
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
  const { agent, dataSource } = await createDaoVeramoAgent(
    databasePath,
    kmsSecretKey.replace(/^0x/, ""),
    rpcUrl,
  );

  try {
    const managedWallets = new Map<string, { did: string; keyId: string }>();
    const issuerIdentity = await importEthereumWallet(agent, issuerWallet, "dao-issuer");
    managedWallets.set(issuerWallet.address, issuerIdentity);

    console.log(`Issuer Veramo: ${issuerIdentity.did}`);
    console.log("DID holder verificati sugli account esposti dal nodo Hardhat.\n");

    for (const [index, holder] of HOLDERS.entries()) {
      const holderWallet = hardhatWallets.get(holder.signerIndex)!;
      let holderIdentity = managedWallets.get(holderWallet.address);
      if (!holderIdentity) {
        holderIdentity = await importEthereumWallet(agent, holderWallet, holder.alias);
        managedWallets.set(holderWallet.address, holderIdentity);
      }
      if (addressFromEthrDid(holderIdentity.did) !== holderWallet.address) {
        throw new Error(`DID holder non coerente con signer[${holder.signerIndex}]`);
      }

      const issuanceDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
      const credential = await agent.createVerifiableCredential({
        credential: {
          "@context": [...CREDENTIAL_CONTEXT],
          type: [...CREDENTIAL_TYPE],
          issuer: { id: issuerIdentity.did },
          issuanceDate,
          credentialSubject: {
            id: holderIdentity.did,
            organization: DEFAULT_ORGANIZATION.name,
            unit: holder.unit,
            skills: holder.skills,
          },
        },
        proofFormat: DAO_EIP712_PROOF,
        keyRef: issuerIdentity.keyId,
        save: true,
      });
      const vcVerification = await agent.verifyCredential({ credential });
      if (!vcVerification.verified) throw new Error(`VC ${holder.alias} non verificabile da Veramo`);

      const challenge = `competencedao:onboarding:${holderWallet.address.toLowerCase()}`;
      const presentation = await agent.createVerifiablePresentation({
        presentation: {
          "@context": [...CREDENTIAL_CONTEXT],
          type: ["VerifiablePresentation", "SkillCredentialPresentation"],
          holder: holderIdentity.did,
          issuanceDate,
          verifiableCredential: [credential],
        },
        challenge,
        proofFormat: DAO_EIP712_PROOF,
        keyRef: holderIdentity.keyId,
        save: true,
      });
      const vpVerification = await agent.verifyPresentation({ presentation, challenge });
      if (!vpVerification.verified) throw new Error(`VP ${holder.alias} non verificabile da Veramo`);

      const fileName = outputName(index, holder.alias);
      fs.writeFileSync(path.join(localCredentials, `${holder.alias}.json`), JSON.stringify(credential, null, 2));
      fs.writeFileSync(path.join(sharedCredentials, fileName), JSON.stringify(credential, null, 2));
      fs.writeFileSync(path.join(localPresentations, `${holder.alias}.json`), JSON.stringify(presentation, null, 2));
      fs.writeFileSync(path.join(sharedPresentations, fileName), JSON.stringify(presentation, null, 2));

      console.log(
        `[${String(index + 1).padStart(2, "0")}/${HOLDERS.length}] ` +
        `${holderIdentity.did} → VC emessa, salvata e presentata da Veramo`,
      );
    }

    console.log(`\nDatastore Veramo: ${databasePath}`);
    console.log(`VC per la DAO:     ${sharedCredentials}`);
    console.log(`VP per la DAO:     ${sharedPresentations}`);
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

if (require.main === module) {
  issueDaoCompatibleCredentials().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
