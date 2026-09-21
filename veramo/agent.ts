// Abilita i metadati usati da TypeORM per descrivere le tabelle SQLite.
import "reflect-metadata";
// ethers gestisce wallet, chiavi pubbliche e address Ethereum.
import { ethers } from "ethers";
// Questi import sono solo tipi: non aggiungono codice al programma eseguito.
import type {
  ICredentialPlugin,
  IDataStore,
  IDIDManager,
  IKeyManager,
  TAgent,
} from "@veramo/core-types" with { "resolution-mode": "import" };
import type { DataSource } from "typeorm";
// Funzioni comuni per convertire in modo sicuro DID e address.
import { addressFromEthrDid, toDid } from "./types/credentials";
// Provider che firma le VC nello stesso formato compreso da Solidity.
import { DaoEip712CredentialProvider } from "./providers/DaoEip712CredentialProvider";

/**
 * Metodi disponibili nell'agent Veramo della DAO.
 *
 * - IDIDManager: importa e legge il DID dell'issuer;
 * - IKeyManager: usa la chiave custodita dal KMS per firmare;
 * - IDataStore: salva le VC verificate nel database SQLite;
 * - ICredentialPlugin: crea e verifica le Verifiable Credential.
 */
export type DaoAgent = TAgent<IDIDManager & IKeyManager & IDataStore & ICredentialPlugin>;

/** Risorse restituite al chiamante e da chiudere al termine del lavoro. */
export interface VeramoAgentHandle {
  // Oggetto principale attraverso cui vengono chiamati i metodi Veramo.
  agent: DaoAgent;
  // Connessione SQLite, da chiudere quando il lavoro è terminato.
  dataSource: DataSource;
}

/**
 * Costruisce l'agent Veramo usato da CompetenceDAO.
 *
 * Il database conserva:
 * - il DID gestito dell'issuer;
 * - i riferimenti alle chiavi;
 * - la chiave privata cifrata dal KMS;
 * - le VC emesse e già verificate.
 *
 * Gli holder non vengono importati nell'agent: il loro DID è pubblico e il
 * controllo del relativo wallet viene dimostrato quando inviano la transazione
 * a GovernanceSkill.
 */
export async function createDaoVeramoAgent(
  databasePath: string,
  kmsSecretKey: string,
  rpcUrl: string,
): Promise<VeramoAgentHandle> {
  // I pacchetti Veramo sono moduli ESM. Li carichiamo dinamicamente per usarli
  // correttamente da questo progetto TypeScript configurato come Node16.
  const [core, keyManager, kmsLocal, didManager, didEthr, credentialW3c, dataStore, typeorm] =
    await Promise.all([
      // Crea e coordina l'agent.
      import("@veramo/core"),
      // Collega riferimenti logici delle chiavi e implementazioni KMS.
      import("@veramo/key-manager"),
      // Offre KMS locale e cifratura SecretBox.
      import("@veramo/kms-local"),
      // Registra e recupera le identità gestite.
      import("@veramo/did-manager"),
      // Implementa il metodo did:ethr.
      import("@veramo/did-provider-ethr"),
      // Espone createVerifiableCredential e verifyCredential.
      import("@veramo/credential-w3c"),
      // Contiene store, entità e migrazioni per SQLite.
      import("@veramo/data-store"),
      // Libreria ORM utilizzata per aprire il database.
      import("typeorm"),
    ]);

  // Veramo pubblica migrazioni versionate per il proprio schema. Usarle evita
  // i cambiamenti impliciti e potenzialmente distruttivi di synchronize=true.
  const dataSource = new typeorm.DataSource({
    // Driver scelto per il database locale.
    type: "sqlite",
    // Percorso del file database.sqlite ricevuto dal chiamante.
    database: databasePath,
    // Non modifichiamo automaticamente lo schema confrontando le entità.
    synchronize: false,
    // Usiamo invece gli aggiornamenti di schema pubblicati da Veramo.
    migrations: dataStore.migrations,
    // Le migrazioni mancanti vengono applicate durante l'apertura.
    migrationsRun: true,
    // Disabilita i log SQL ordinari per mantenere leggibile il terminale.
    logging: false,
    // Elenco delle tabelle necessarie a DID, chiavi e credenziali.
    entities: dataStore.Entities,
  });
  // Apre fisicamente SQLite e applica le eventuali migrazioni.
  await dataSource.initialize();

  // PrivateKeyStore salva il materiale privato cifrato. SecretBox usa la
  // KMS_SECRET_KEY fornita dall'ambiente e mai scritta nel codice sorgente.
  const privateKeyStore = new dataStore.PrivateKeyStore(
    dataSource,
    // Cifra e decifra le private key usando il segreto del KMS.
    new kmsLocal.SecretBox(kmsSecretKey),
  );
  // Questo progetto usa esclusivamente DID Ethereum sulla rete Hardhat 31337.
  const providerName = "did:ethr";
  const agent = core.createAgent<IDIDManager & IKeyManager & IDataStore & ICredentialPlugin>({
    // Ogni plugin aggiunge un gruppo di metodi all'agent finale.
    plugins: [
      new keyManager.KeyManager({
        // KeyStore conserva i metadati; il materiale privato resta nel KMS.
        store: new dataStore.KeyStore(dataSource),
        // Il nome "local" sarà usato quando importiamo la chiave dell'issuer.
        kms: { local: new kmsLocal.KeyManagementSystem(privateKeyStore) },
      }),
      new didManager.DIDManager({
        // DIDStore collega DID, provider e chiave controller.
        store: new dataStore.DIDStore(dataSource),
        // Se non viene specificato altro, il DIDManager usa did:ethr.
        defaultProvider: providerName,
        providers: {
          // La chiave dinamica dell'oggetto vale "did:ethr".
          [providerName]: new didEthr.EthrDIDProvider({
            // Le chiavi create/importate dal provider finiscono nel KMS local.
            defaultKms: "local",
            // Hardhat usa per convenzione chain ID 31337.
            networks: [{ chainId: 31337, rpcUrl }],
          }),
        },
      }),
      // DataStore rende disponibili i metodi per salvare e leggere le VC.
      new dataStore.DataStore(dataSource),
      // Provider custom: produce lo stesso typed-data EIP-712 verificato in Solidity.
      new credentialW3c.CredentialPlugin([new DaoEip712CredentialProvider()]),
    ],
  });

  // Restituiamo anche il DataSource perché il chiamante deve poterlo chiudere.
  return { agent, dataSource };
}

export async function importEthereumWallet(
  // Agent già configurato con DIDManager e KeyManager.
  agent: DaoAgent,
  // Sono accettati sia wallet derivati da mnemonic sia wallet da private key.
  wallet: ethers.HDNodeWallet | ethers.Wallet,
  // Nome umano con cui riconoscere l'identità nel datastore.
  alias: string,
): Promise<{ did: string; keyId: string }> {
  // Il DID contiene direttamente l'address Ethereum in formato checksum.
  const did = toDid(wallet.address);
  if (addressFromEthrDid(did) !== ethers.getAddress(wallet.address)) {
    throw new Error(`Il DID ${did} non coincide con il wallet ${wallet.address}`);
  }

  // Il fragment #controller identifica la chiave che controlla il DID issuer.
  const keyId = `${did}#controller`;

  // didManagerImport registra DID e chiave nel DIDManager. La private key viene
  // inoltrata al KMS locale, che la cifra prima di salvarla nel database.
  await agent.didManagerImport({
    // Identificatore decentralizzato completo.
    did,
    // Etichetta locale; non fa parte della firma della VC.
    alias,
    // Provider responsabile di questo DID.
    provider: "did:ethr",
    // Chiave principale associata all'identità.
    controllerKeyId: keyId,
    keys: [{
      // Identificatore univoco della chiave dentro Veramo.
      kid: keyId,
      // Nome del KMS configurato sopra.
      kms: "local",
      // Curva crittografica usata da Ethereum.
      type: "Secp256k1",
      // Veramo vuole l'esadecimale senza il prefisso 0x.
      privateKeyHex: wallet.privateKey.slice(2),
    }],
    // L'issuer non pubblica endpoint o altri servizi DID in questa demo.
    services: [],
  });

  // keyId servirà al provider per chiedere al KMS di firmare la VC.
  return { did, keyId };
}
