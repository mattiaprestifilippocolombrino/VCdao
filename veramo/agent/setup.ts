/**
 * Configurazione dell'Agente Veramo (SSI)
 *
 * Questo è il "motore" del nostro sistema. Qui attiviamo i plugin necessari
 * per gestire identità, credenziali e crittografia in modo standardizzato (W3C).
 */

import 'dotenv/config'

import {
  createAgent,
  IDIDManager,
  IResolver,
  IDataStore,
  IDataStoreORM,
  IKeyManager,
  ICredentialPlugin,
} from '@veramo/core'

import { DIDManager } from '@veramo/did-manager'
import { EthrDIDProvider } from '@veramo/did-provider-ethr'
import { KeyManager } from '@veramo/key-manager'
import { KeyManagementSystem, SecretBox } from '@veramo/kms-local'

// Plugin per la firma nativa di Ethereum (EIP-712)
import { CredentialPlugin } from '@veramo/credential-w3c'
import { CredentialProviderEIP712 } from '@veramo/credential-eip712'

// Plugin per omettere i dati sensibili ed estrarre solo la competenza
import { SelectiveDisclosure, ISelectiveDisclosure } from '@veramo/selective-disclosure'

import { DIDResolverPlugin } from '@veramo/did-resolver'
import { getResolver as ethrDidResolver } from 'ethr-did-resolver'
import { getResolver as webDidResolver } from 'web-did-resolver'

import {
  Entities,
  KeyStore,
  DIDStore,
  PrivateKeyStore,
  DataStore,
  DataStoreORM,
  migrations,
} from '@veramo/data-store'
import { DataSource } from 'typeorm'

// --- Controlli di sicurezza iniziali ---
const INFURA_PROJECT_ID = process.env.INFURA_PROJECT_ID
if (!INFURA_PROJECT_ID) {
  throw new Error('❌ Manca INFURA_PROJECT_ID nel file .env')
}

const KMS_SECRET_KEY = process.env.KMS_SECRET_KEY
if (!KMS_SECRET_KEY || KMS_SECRET_KEY.length !== 64) {
  throw new Error('❌ Manca KMS_SECRET_KEY (hex da 64 caratteri) nel file .env')
}

const DATABASE_FILE = process.env.DATABASE_FILE || 'database.sqlite'

// --- Inizializzazione del Database locale (SQLite) ---
const dbConnection = new DataSource({
  type: 'sqlite',
  database: DATABASE_FILE,
  synchronize: false,
  migrations,
  migrationsRun: true,
  logging: ['error', 'info', 'warn'],
  entities: Entities,
}).initialize()

// --- Costruzione dell'Agente centrale ---
export const agent = createAgent<
  IDIDManager & IKeyManager & IDataStore & IDataStoreORM & IResolver & ICredentialPlugin & ISelectiveDisclosure
>({
  plugins: [
    // 1. Gestore delle chiavi private, cifrate con una password (KMS_SECRET_KEY)
    new KeyManager({
      store: new KeyStore(dbConnection),
      kms: {
        local: new KeyManagementSystem(
          new PrivateKeyStore(dbConnection, new SecretBox(KMS_SECRET_KEY)),
        ),
      },
    }),

    // 2. Gestore delle identità (DID): usiamo indirizzi Ethereum sul network Sepolia
    new DIDManager({
      store: new DIDStore(dbConnection),
      defaultProvider: 'did:ethr:sepolia',
      providers: {
        'did:ethr:sepolia': new EthrDIDProvider({
          defaultKms: 'local',
          network: 'sepolia',
          rpcUrl: 'https://sepolia.infura.io/v3/' + INFURA_PROJECT_ID,
        }),
      },
    }),

    // 3. Risolutore per leggere i DID registrati su blockchain o sul web
    new DIDResolverPlugin({
      ...ethrDidResolver({ infuraProjectId: INFURA_PROJECT_ID }),
      ...webDidResolver(),
    }),

    // 4. Plugin per Creare/Verificare Credenziali con firme EIP-712
    new CredentialPlugin([new CredentialProviderEIP712()]),

    // 5. Plugin per le Richieste Incomplete (rivelazione selettiva) usate nella tesi
    new SelectiveDisclosure(),

    // 6. Plugin per conservare e interrogare le credenziali tramite il DB
    new DataStore(dbConnection),
    new DataStoreORM(dbConnection),
  ],
})
