/*
 * Flusso SSI di CompetenceDAO:
 * 1. importa nell'agent Veramo l'issuer che firma le credenziali;
 * 2. verifica che i DID subject derivino dagli account del nodo Hardhat;
 * 3. emette, verifica e salva le VC EIP-712 tramite Veramo;
 * 4. esporta le VC per gli script e i test della DAO.
 *
 * Non vengono create Verifiable Presentation. Il possesso del DID viene
 * dimostrato on-chain dal wallet che invia la transazione: lo script DAO
 * abbina credentialSubject.id al signer Hardhat con lo stesso address.
 */

// Carica automaticamente le variabili definite in veramo/.env.
import "dotenv/config";
// ethers offre wallet HD, address, validazione hex e client Ethereum.
import { ethers } from "ethers";
// fs legge configurazioni e scrive database/output JSON sul filesystem.
import * as fs from "fs";
// path costruisce percorsi validi senza dipendere dal sistema operativo.
import * as path from "path";
// Factory dell'agent e funzione che importa il wallet dell'issuer nel KMS.
import { createDaoVeramoAgent, importEthereumWallet } from "../agent";
// Nome del proof format che seleziona il provider custom.
import { DAO_EIP712_PROOF } from "../providers/DaoEip712CredentialProvider";
// Costanti condivise da emissione, verifica off-chain e contratti.
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
  // trim evita che spazi accidentali nel file .env alterino chiavi o URL.
  const value = process.env[name]?.trim();
  // Una configurazione mancante viene segnalata prima di eseguire operazioni.
  if (!value) throw new Error(`[ERRORE FATALE] Variabile ${name} mancante nel file .env`);
  // Da questo punto TypeScript sa che value è una stringa non vuota.
  return value;
}

function prepareDir(dirPath: string): void {
  // Ogni esecuzione produce un insieme completo e coerente di credenziali:
  // rimuoviamo quindi soltanto i precedenti output JSON, non altri file.
  // recursive crea anche eventuali directory genitore mancanti.
  fs.mkdirSync(dirPath, { recursive: true });
  // Leggiamo tutti gli elementi già presenti nella directory.
  for (const file of fs.readdirSync(dirPath)) {
    // Eliminiamo solo file JSON: altri file, come .gitkeep, vengono preservati.
    if (file.endsWith(".json")) fs.unlinkSync(path.join(dirPath, file));
  }
}

function outputName(index: number, alias: string): string {
  // Il prefisso numerico rende stabile e leggibile l'ordine dei file esportati.
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
  // Usiamo una richiesta JSON-RPC diretta prima di creare l'agent Veramo.
  // JsonRpcProvider ritenta automaticamente quando il nodo è spento; questa
  // chiamata invece fallisce subito con un messaggio che spiega come avviarlo.
  const rpcCall = async (method: string): Promise<unknown> => {
    // AbortController permette di interrompere fetch se il nodo non risponde.
    const controller = new AbortController();
    // Dopo tre secondi viene emesso il segnale di abort.
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      // Ogni chiamata JSON-RPC Ethereum è una richiesta HTTP POST con body JSON.
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // id collega richiesta e risposta; questi metodi non hanno parametri.
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }),
        signal: controller.signal,
      });
      // Anche una risposta HTTP non-2xx è considerata un errore di connessione.
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      // Convertiamo il body JSON nella forma minima prevista da JSON-RPC.
      const payload = await response.json() as { result?: unknown; error?: { message?: string } };
      // JSON-RPC può rispondere HTTP 200 ma contenere comunque un errore logico.
      if (payload.error) throw new Error(payload.error.message ?? "errore JSON-RPC");
      // Il chiamante controllerà il tipo concreto del risultato.
      return payload.result;
    } catch (error) {
      // Arricchiamo errori di rete, timeout e JSON-RPC con istruzioni operative.
      throw new Error(
        `Nodo Hardhat non raggiungibile su ${rpcUrl}. ` +
        `Avvialo dalla cartella dao con "npx hardhat node" e riprova. ` +
        `Dettaglio: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // Il timer non serve più sia in caso di successo sia in caso di errore.
      clearTimeout(timeout);
    }
  };

  // eth_chainId identifica la blockchain alla quale siamo collegati.
  const chainId = await rpcCall("eth_chainId");
  // JSON-RPC restituisce il chain ID in esadecimale: BigInt lo converte.
  if (typeof chainId !== "string" || BigInt(chainId) !== 31_337n) {
    throw new Error(`La rete su ${rpcUrl} ha chainId ${String(chainId)}, atteso Hardhat 31337`);
  }

  // eth_accounts restituisce gli account sbloccati e controllati dal nodo.
  const accounts = await rpcCall("eth_accounts");
  if (!Array.isArray(accounts)) {
    throw new Error(`Il nodo su ${rpcUrl} non ha restituito un elenco valido da eth_accounts`);
  }
  // Convertiamo ogni valore in stringa e address checksum validato.
  const rpcAccounts = accounts.map((address) => ethers.getAddress(String(address)));
  // La Map collega direttamente signerIndex al wallet derivato corrispondente.
  const wallets = new Map<number, ethers.HDNodeWallet>();

  // HOLDERS contiene tutti i membri per cui deve essere emessa una VC.
  for (const holder of HOLDERS) {
    // Deriviamo il wallet dal mnemonic usando il percorso Ethereum standard.
    const wallet = ethers.HDNodeWallet.fromPhrase(
      // Frase mnemonica configurata in .env.
      mnemonic,
      // undefined significa che il mnemonic non usa una passphrase aggiuntiva.
      undefined,
      // L'ultimo numero seleziona l'account Hardhat del membro.
      `m/44'/60'/0'/0/${holder.signerIndex}`,
    );
    // Il mnemonic è corretto solo se produce lo stesso account esposto dal nodo.
    if (rpcAccounts[holder.signerIndex] !== wallet.address) {
      throw new Error(
        `Hardhat signer[${holder.signerIndex}] è ${rpcAccounts[holder.signerIndex] ?? "assente"}, ` +
        `ma DAO_HARDHAT_MNEMONIC deriva ${wallet.address}`,
      );
    }
    // Conserviamo soltanto wallet che hanno superato il confronto.
    wallets.set(holder.signerIndex, wallet);
  }

  // Tutti gli holder sono stati controllati con successo.
  return wallets;
}

function assertTrustedIssuer(issuerAddress: string): void {
  // Il deploy salva la configurazione effettiva della DAO in questo file.
  const deployedPath = path.join(__dirname, "../../dao/deployedAddresses.json");
  if (!fs.existsSync(deployedPath)) {
    throw new Error("dao/deployedAddresses.json non trovato: eseguire prima il deploy Hardhat");
  }

  // Il file viene letto come testo UTF-8 e trasformato in oggetto JavaScript.
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf8"));

  // Compatibilità con entrambi i formati storici del file: lista di issuer o
  // singolo campo issuer. Ogni address viene normalizzato prima del confronto.
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
  // Intestazione puramente informativa per rendere riconoscibile lo script.
  console.log("══════════════════════════════════════════════════════════");
  console.log("  CompetenceDAO — emissione SSI tramite agent Veramo");
  console.log("══════════════════════════════════════════════════════════\n");

  // Tutti i segreti arrivano dall'ambiente e non sono inclusi nel repository.
  // Private key dell'ente che firma tutte le credenziali.
  const issuerPrivateKey = requireEnv("DAO_ISSUER_PRIVATE_KEY");
  // Mnemonic da cui Hardhat deriva gli account dei membri.
  const hardhatMnemonic = requireEnv("DAO_HARDHAT_MNEMONIC");
  // Segreto indipendente usato soltanto per cifrare il KMS locale.
  const kmsSecretKey = requireEnv("KMS_SECRET_KEY");
  // L'URL è configurabile; in assenza di valore usiamo il nodo Hardhat locale.
  const rpcUrl = process.env.DAO_HARDHAT_RPC_URL?.trim() || "http://127.0.0.1:8545";
  // Una private key Ethereum deve contenere esattamente 32 byte.
  if (!ethers.isHexString(issuerPrivateKey, 32)) {
    throw new Error("DAO_ISSUER_PRIVATE_KEY deve contenere 32 byte esadecimali");
  }
  // Anche SecretBox richiede 32 byte, con prefisso 0x facoltativo.
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(kmsSecretKey)) {
    throw new Error("KMS_SECRET_KEY deve contenere 32 byte esadecimali");
  }

  // Prima di creare file o database verifichiamo configurazione, issuer e nodo.
  // Se uno di questi controlli iniziali fallisce, non produciamo alcun output.
  // Wallet in memoria usato per ricavare address e importare la chiave nel KMS.
  const issuerWallet = new ethers.Wallet(issuerPrivateKey);
  // Evita di emettere VC firmate da una chiave che la DAO rifiuterebbe.
  assertTrustedIssuer(issuerWallet.address);
  // Verifica nodo e mnemonic e restituisce i wallet dei membri.
  const hardhatWallets = await verifyHardhatWallets(rpcUrl, hardhatMnemonic);

  // credentials/ è l'archivio locale Veramo; shared-credentials/ è il confine
  // di integrazione con gli script Hardhat e con i test Solidity.
  // __dirname è veramo/scripts; ".." risale alla cartella veramo.
  const localCredentials = path.join(__dirname, "..", CREDENTIALS_DIR);
  // Due ".." risalgono alla radice del repository.
  const sharedCredentials = path.join(__dirname, "..", "..", DAO_SHARED_CREDENTIALS_DIR);
  // Ripuliamo entrambe le destinazioni prima di iniziare una nuova emissione.
  for (const directory of [localCredentials, sharedCredentials]) {
    prepareDir(directory);
  }

  // Ogni esecuzione rappresenta una nuova sessione demo SSI riproducibile.
  // Il database precedente viene eliminato intenzionalmente: questo script è
  // un issuer locale dimostrativo, non un servizio persistente di produzione.
  const databasePath = path.join(__dirname, "..", "database.sqlite");
  // Evitiamo unlink su un file inesistente.
  if (fs.existsSync(databasePath)) fs.unlinkSync(databasePath);
  // Il prefisso 0x non fa parte dei 64 caratteri attesi da SecretBox.
  const { agent, dataSource } = await createDaoVeramoAgent(
    databasePath,
    kmsSecretKey.replace(/^0x/, ""),
    rpcUrl,
  );

  try {
    // Solo l'issuer viene gestito dall'agent e custodito nel KMS Veramo.
    const issuerIdentity = await importEthereumWallet(agent, issuerWallet, "dao-issuer");

    // Mostriamo soltanto il DID pubblico, mai private key o KMS secret.
    console.log(`Issuer Veramo: ${issuerIdentity.did}`);
    console.log("DID holder verificati sugli account esposti dal nodo Hardhat.\n");

    // entries fornisce sia la posizione sia il profilo dell'holder.
    for (const [index, holder] of HOLDERS.entries()) {
      // Il punto esclamativo comunica a TypeScript che il wallet esiste:
      // verifyHardhatWallets ha già controllato tutti gli indici di HOLDERS.
      const holderWallet = hardhatWallets.get(holder.signerIndex)!;
      // L'issuer inserisce nella VC il DID pubblico dell'holder, ma non importa
      // la sua chiave privata nel KMS. Sarà quel wallet a presentare la VC on-chain.
      const holderDid = toDid(holderWallet.address);
      if (addressFromEthrDid(holderDid) !== holderWallet.address) {
        throw new Error(`DID holder non coerente con signer[${holder.signerIndex}]`);
      }

      // Usiamo UTC senza millisecondi per ottenere una rappresentazione stabile.
      const issuanceDate = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

      // Veramo costruisce il documento W3C e il provider custom firma soltanto
      // i campi definiti nello schema EIP-712 condiviso con Solidity.
      const credential = await agent.createVerifiableCredential({
        // Dati W3C ancora non firmati.
        credential: {
          // Copiamo gli array readonly in normali array accettati da Veramo.
          "@context": [...CREDENTIAL_CONTEXT],
          type: [...CREDENTIAL_TYPE],
          // DID dell'issuer controllato dalla chiave presente nel KMS.
          issuer: { id: issuerIdentity.did },
          issuanceDate,
          credentialSubject: {
            // DID del membro che potrà presentare la VC on-chain.
            id: holderDid,
            // Dati descrittivi e skill incluse nella firma.
            organization: DEFAULT_ORGANIZATION.name,
            unit: holder.unit,
            skills: holder.skills,
          },
        },
        // Seleziona DaoEip712CredentialProvider.
        proofFormat: DAO_EIP712_PROOF,
        // Indica al KeyManager quale chiave dell'issuer deve firmare.
        keyRef: issuerIdentity.keyId,
      });

      // Controllo finale sull'oggetto realmente prodotto da Veramo: il DID
      // scritto nella VC deve risolvere esattamente nell'account Hardhat del membro.
      const credentialSubjectDid = String(credential.credentialSubject?.id ?? "");
      if (addressFromEthrDid(credentialSubjectDid) !== holderWallet.address) {
        throw new Error(
          `VC ${holder.alias} non coerente: subject ${credentialSubjectDid}, ` +
          `account Hardhat ${holderWallet.address}`,
        );
      }

      // Verifica immediata: non salviamo né esportiamo una VC non valida.
      const vcVerification = await agent.verifyCredential({ credential });
      if (!vcVerification.verified) throw new Error(`VC ${holder.alias} non verificabile da Veramo`);

      // `save` nella createVerifiableCredential è deprecato in Veramo.
      // Salviamo esplicitamente solo dopo avere verificato la firma della VC.
      await agent.dataStoreSaveVerifiableCredential({ verifiableCredential: credential });

      // La stessa VC viene esportata in due posizioni:
      // - credentials/: copia locale del modulo Veramo;
      // - shared-credentials/: input condiviso con Hardhat e i test Solidity.
      // Nome numerato per la copia condivisa, ad esempio 01_ai-data-lead.json.
      const fileName = outputName(index, holder.alias);
      // JSON.stringify(..., null, 2) genera un file leggibile e indentato.
      fs.writeFileSync(path.join(localCredentials, `${holder.alias}.json`), JSON.stringify(credential, null, 2));
      fs.writeFileSync(path.join(sharedCredentials, fileName), JSON.stringify(credential, null, 2));

      // Una riga di avanzamento conferma DID e completamento di ogni VC.
      console.log(
        `[${String(index + 1).padStart(2, "0")}/${HOLDERS.length}] ` +
        `${holderDid} → VC emessa, verificata e salvata da Veramo`,
      );
    }

    // Riepilogo delle due destinazioni principali.
    console.log(`\nDatastore Veramo: ${databasePath}`);
    console.log(`VC per la DAO:     ${sharedCredentials}`);
  } finally {
    // La connessione SQLite viene chiusa anche se una singola emissione fallisce.
    if (dataSource.isInitialized) await dataSource.destroy();
  }
}

// Questo controllo esegue main solo quando il file viene lanciato direttamente.
// Se il file viene importato da un test, la funzione resta disponibile senza partire.
if (require.main === module) {
  issueDaoCompatibleCredentials().catch((error) => {
    // Mostra un messaggio leggibile senza nascondere errori non standard.
    console.error(`\n${error instanceof Error ? error.message : error}`);
    // Segnala al terminale/CI che il comando non è riuscito.
    process.exitCode = 1;
  });
}
