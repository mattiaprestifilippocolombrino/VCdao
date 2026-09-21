/*
 * Script di emissione delle credenziali SSI usate dalla DAO.
 *
 * Il flusso importa l'issuer in Veramo, controlla che gli holder coincidano
 * con gli account Hardhat attesi, genera VC firmate in EIP-712 e le esporta
 * sia nell'archivio locale Veramo sia nella cartella condivisa con la DAO.
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
  DEFAULT_ORGANIZATION,
  HOLDERS,
  addressFromEthrDid,
  toDid,
} from "../types/credentials";

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`[ERRORE FATALE] Variabile ${name} mancante nel file .env`);
  return value;
}

function prepareDir(dirPath: string): void {
  // Ogni esecuzione rigenera solo gli output JSON, preservando eventuali file
  // di servizio già presenti nella directory.
  fs.mkdirSync(dirPath, { recursive: true });
  for (const file of fs.readdirSync(dirPath)) {
    if (file.endsWith(".json")) fs.unlinkSync(path.join(dirPath, file));
  }
}

function outputName(index: number, alias: string): string {
  return `${String(index + 1).padStart(2, "0")}_${alias}.json`;
}

/**
 * Controlla che il nodo RPC e il mnemonic descrivano gli stessi account.
 *
 * La funzione restituisce i wallet derivati solo dopo aver verificato:
 * - raggiungibilità del nodo;
 * - chain ID Hardhat 31337;
 * - presenza di eth_accounts;
 * - corrispondenza account per account con DAO_HARDHAT_MNEMONIC.
 */
async function verifyHardhatWallets(
  rpcUrl: string,
  mnemonic: string,
): Promise<Map<number, ethers.HDNodeWallet>> {
  // Una chiamata JSON-RPC diretta produce errori più chiari quando il nodo
  // Hardhat non è avviato o risponde in modo inatteso.
  const rpcCall = async (method: string): Promise<unknown> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json() as { result?: unknown; error?: { message?: string } };
      if (payload.error) throw new Error(payload.error.message ?? "errore JSON-RPC");
      return payload.result;
    } catch (error) {
      throw new Error(
        `Nodo Hardhat non raggiungibile su ${rpcUrl}. ` +
        `Avvialo dalla cartella dao con "npx hardhat node" e riprova. ` +
        `Dettaglio: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  };

  // Prima validiamo la rete, poi confrontiamo gli account RPC con quelli
  // derivati dal mnemonic configurato.
  const chainId = await rpcCall("eth_chainId");
  if (typeof chainId !== "string" || BigInt(chainId) !== 31_337n) {
    throw new Error(`La rete su ${rpcUrl} ha chainId ${String(chainId)}, atteso Hardhat 31337`);
  }

  const accounts = await rpcCall("eth_accounts");
  if (!Array.isArray(accounts)) {
    throw new Error(`Il nodo su ${rpcUrl} non ha restituito un elenco valido da eth_accounts`);
  }
  const rpcAccounts = accounts.map((address) => ethers.getAddress(String(address)));
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
        `ma DAO_HARDHAT_MNEMONIC deriva ${wallet.address}`,
      );
    }
    wallets.set(holder.signerIndex, wallet);
  }

  return wallets;
}

function assertTrustedIssuer(issuerAddress: string): void {
  // L'issuer Veramo deve essere tra quelli configurati dal deploy della DAO.
  const deployedPath = path.join(__dirname, "../../dao/deployedAddresses.json");
  if (!fs.existsSync(deployedPath)) {
    throw new Error("dao/deployedAddresses.json non trovato: eseguire prima il deploy Hardhat");
  }

  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  // Sono supportati sia il formato con lista sia quello storico con issuer singolo.
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

  // Segreti e configurazione arrivano dall'ambiente, così non finiscono nel repository.
  const issuerPrivateKey = requireEnv("DAO_ISSUER_PRIVATE_KEY");
  const hardhatMnemonic = requireEnv("DAO_HARDHAT_MNEMONIC");
  const kmsSecretKey = requireEnv("KMS_SECRET_KEY");
  const rpcUrl = process.env.DAO_HARDHAT_RPC_URL?.trim() || "http://127.0.0.1:8545";

  // I controlli iniziali evitano di creare credenziali con chiavi o rete errate.
  if (!ethers.isHexString(issuerPrivateKey, 32)) {
    throw new Error("DAO_ISSUER_PRIVATE_KEY deve contenere 32 byte esadecimali");
  }
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(kmsSecretKey)) {
    throw new Error("KMS_SECRET_KEY deve contenere 32 byte esadecimali");
  }

  const issuerWallet = new ethers.Wallet(issuerPrivateKey);
  assertTrustedIssuer(issuerWallet.address);
  const hardhatWallets = await verifyHardhatWallets(rpcUrl, hardhatMnemonic);

  // Le credenziali vengono salvate sia localmente sia nella cartella condivisa
  // usata dagli script Hardhat e dai test Solidity.
  const localCredentials = path.join(__dirname, "..", CREDENTIALS_DIR);
  const sharedCredentials = path.join(__dirname, "..", "..", DAO_SHARED_CREDENTIALS_DIR);
  for (const directory of [localCredentials, sharedCredentials]) {
    prepareDir(directory);
  }

  // Il database viene ricreato a ogni esecuzione perché questo è un issuer demo
  // riproducibile, non un servizio persistente di produzione.
  const databasePath = path.join(__dirname, "..", "database.sqlite");
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
  const { agent, dataSource } = await createDaoVeramoAgent(
    databasePath,
    kmsSecretKey.replace(/^0x/, ""),
    rpcUrl,
  );

  try {
    // Solo l'issuer viene importato nel KMS Veramo; gli holder restano wallet Hardhat.
    const issuerIdentity = await importEthereumWallet(agent, issuerWallet, "dao-issuer");

    console.log(`Issuer Veramo: ${issuerIdentity.did}`);
    console.log("DID holder verificati sugli account esposti dal nodo Hardhat.\n");

    for (const [index, holder] of HOLDERS.entries()) {
      // Il wallet esiste perché verifyHardhatWallets ha già controllato tutti gli holder.
      const holderWallet = hardhatWallets.get(holder.signerIndex)!;
      const holderDid = toDid(holderWallet.address);
      if (addressFromEthrDid(holderDid) !== holderWallet.address) {
        throw new Error(`DID holder non coerente con signer[${holder.signerIndex}]`);
      }

      const issuanceDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

      // Veramo costruisce la VC W3C; il provider custom firma il payload EIP-712
      // compatibile con la verifica Solidity.
      const credential = await agent.createVerifiableCredential({
        credential: {
          "@context": [...CREDENTIAL_CONTEXT],
          type: [...CREDENTIAL_TYPE],
          issuer: { id: issuerIdentity.did },
          issuanceDate,
          credentialSubject: {
            id: holderDid,
            organization: DEFAULT_ORGANIZATION.name,
            unit: holder.unit,
            skills: holder.skills,
          },
        },
        proofFormat: DAO_EIP712_PROOF,
        keyRef: issuerIdentity.keyId,
      });

      // Prima di salvare controlliamo che la VC prodotta da Veramo sia coerente
      // con l'account Hardhat del membro e che la firma sia verificabile.
      const credentialSubjectDid = String(credential.credentialSubject?.id ?? "");
      if (addressFromEthrDid(credentialSubjectDid) !== holderWallet.address) {
        throw new Error(
          `VC ${holder.alias} non coerente: subject ${credentialSubjectDid}, ` +
          `account Hardhat ${holderWallet.address}`,
        );
      }

      const vcVerification = await agent.verifyCredential({ credential });
      if (!vcVerification.verified) throw new Error(`VC ${holder.alias} non verificabile da Veramo`);

      await agent.dataStoreSaveVerifiableCredential({ verifiableCredential: credential });

      // Esportiamo la stessa VC nei due formati di nome richiesti dai consumatori.
      const fileName = outputName(index, holder.alias);
      fs.writeFileSync(path.join(localCredentials, `${holder.alias}.json`), JSON.stringify(credential, null, 2));
      fs.writeFileSync(path.join(sharedCredentials, fileName), JSON.stringify(credential, null, 2));

      console.log(
        `[${String(index + 1).padStart(2, "0")}/${HOLDERS.length}] ` +
        `${holderDid} → VC emessa, verificata e salvata da Veramo`,
      );
    }

    console.log(`\nDatastore Veramo: ${databasePath}`);
    console.log(`VC per la DAO:     ${sharedCredentials}`);
  } finally {
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

// Avvia lo script solo quando il file è eseguito direttamente da Node.
if (require.main === module) {
  issueDaoCompatibleCredentials().catch((error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
