import "reflect-metadata";
import { ethers } from "ethers";
import { addressFromEthrDid, toDid } from "./types/credentials";
import { DaoEip712CredentialProvider } from "./providers/DaoEip712CredentialProvider";

export interface VeramoAgentHandle {
  agent: any;
  dataSource: any;
}

export async function createDaoVeramoAgent(
  databasePath: string,
  kmsSecretKey: string,
  rpcUrl: string,
): Promise<VeramoAgentHandle> {
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

  const dataSource = new typeorm.DataSource({
    type: "sqlite",
    database: databasePath,
    synchronize: true,
    logging: false,
    entities: dataStore.Entities,
  });

  const privateKeyStore = new dataStore.PrivateKeyStore(
    dataSource,
    new kmsLocal.SecretBox(kmsSecretKey),
  );
  const providerName = "did:ethr";
  const agent = core.createAgent({
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
  agent: any,
  wallet: ethers.HDNodeWallet | ethers.Wallet,
  alias: string,
): Promise<{ did: string; keyId: string }> {
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
