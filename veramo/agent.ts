// Agent Veramo locale per emettere e verificare le credenziali della DAO.
import "reflect-metadata";
import { ethers } from "ethers";
import type {
  ICredentialPlugin,
  IDataStore,
  IDIDManager,
  IKeyManager,
  TAgent,
} from "@veramo/core-types" with { "resolution-mode": "import" };
import type { DataSource } from "typeorm";
import { addressFromEthrDid, toDid } from "./types/credentials";
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
  agent: DaoAgent;
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
  // Veramo espone moduli ESM: gli import dinamici evitano incompatibilità con
  // la configurazione TypeScript Node16 del progetto.
  const [core, keyManager, kmsLocal, didManager, didEthr, credentialW3c, dataStore, typeorm] =
    await Promise.all([
      import("@veramo/core"),
      import("@veramo/key-manager"),
      import("@veramo/kms-local"),
      import("@veramo/did-manager"),
      import("@veramo/did-provider-ethr"),
      import("@veramo/credential-w3c"),
      import("@veramo/data-store"),
      import("typeorm"),
    ]);

  // Lo schema SQLite viene aggiornato con le migrazioni ufficiali Veramo, non
  // con synchronize=true, per evitare modifiche implicite al database.
  const dataSource = new typeorm.DataSource({
    type: "sqlite",
    database: databasePath,
    synchronize: false,
    migrations: dataStore.migrations,
    migrationsRun: true,
    logging: false,
    entities: dataStore.Entities,
  });
  await dataSource.initialize();

  // Il materiale privato dell'issuer viene cifrato dal KMS locale con la chiave
  // ricevuta dall'ambiente.
  const privateKeyStore = new dataStore.PrivateKeyStore(
    dataSource,
    new kmsLocal.SecretBox(kmsSecretKey),
  );

  // L'agent gestisce DID Ethereum sulla rete Hardhat e usa un provider custom
  // per produrre firme EIP-712 compatibili con i contratti Solidity.
  const providerName = "did:ethr";
  const agent = core.createAgent<IDIDManager & IKeyManager & IDataStore & ICredentialPlugin>({
    plugins: [
      new keyManager.KeyManager({
        store: new dataStore.KeyStore(dataSource),
        kms: { local: new kmsLocal.KeyManagementSystem(privateKeyStore) },
      }),
      new didManager.DIDManager({
        store: new dataStore.DIDStore(dataSource),
        defaultProvider: providerName,
        providers: {
          [providerName]: new didEthr.EthrDIDProvider({
            defaultKms: "local",
            networks: [{ chainId: 31337, rpcUrl }],
          }),
        },
      }),
      new dataStore.DataStore(dataSource),
      new credentialW3c.CredentialPlugin([new DaoEip712CredentialProvider()]),
    ],
  });

  return { agent, dataSource };
}

export async function importEthereumWallet(
  agent: DaoAgent,
  wallet: ethers.HDNodeWallet | ethers.Wallet,
  alias: string,
): Promise<{ did: string; keyId: string }> {
  // Importa il wallet Ethereum come identità did:ethr controllata dal KMS Veramo.
  const did = toDid(wallet.address);
  if (addressFromEthrDid(did) !== ethers.getAddress(wallet.address)) {
    throw new Error(`Il DID ${did} non coincide con il wallet ${wallet.address}`);
  }

  const keyId = `${did}#controller`;

  await agent.didManagerImport({
    did,
    alias,
    provider: "did:ethr",
    controllerKeyId: keyId,
    keys: [{
      kid: keyId,
      kms: "local",
      type: "Secp256k1",
      privateKeyHex: wallet.privateKey.slice(2),
    }],
    services: [],
  });

  return { did, keyId };
}
