import { createAgent, IDIDManager, IKeyManager, IDataStore, ICredentialPlugin } from '@veramo/core'
import { CredentialPlugin } from '@veramo/credential-w3c'
import { CredentialProviderEIP712 } from '@veramo/credential-eip712'
import { ethers } from 'ethers'
import * as fs from 'fs'
import * as path from 'path'
import {
  CredentialLevel,
  CREDENTIAL_TYPE,
  CREDENTIAL_CONTEXT,
  UNIVERSITY_INFO
} from '../types/credentials'

// Wallet Hardhat di default: "test test test test test test test test test test test junk"
const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk'

// Livelli da assegnare ai primi 10 account (Signer 1 al 10)
const HOLDER_LEVELS = [
  CredentialLevel.SIMPLE_STUDENT,
  CredentialLevel.SIMPLE_STUDENT,
  CredentialLevel.BACHELOR_DEGREE,
  CredentialLevel.BACHELOR_DEGREE,
  CredentialLevel.MASTER_DEGREE,
  CredentialLevel.MASTER_DEGREE,
  CredentialLevel.PHD,
  CredentialLevel.PHD,
  CredentialLevel.PROFESSOR,
  CredentialLevel.PROFESSOR,
]

// Percorso condiviso con la DAO
const SHARED_CREDENTIALS_DIR = path.join(__dirname, '../../dao/scripts/shared-credentials')

// Questa funzione crea "al volo" un issuer EIP-712 usando la Private Key di Hardhat
async function issueVC(issuerWallet: ethers.HDNodeWallet, holderAddress: string, level: CredentialLevel, i: number) {
  // Prepariamo l'Agent Veramo leggero "usa e getta" per firmare con la chiave locale
  const agent = createAgent<ICredentialPlugin>({
    plugins: [
      new CredentialPlugin([new CredentialProviderEIP712()])
    ]
  })

  // Dati della credenziale (CredentialSubject)
  // Nota: VPVerifier.sol si aspetta campi esatti: id, holderAddress, degreeLevel, nbf, exp
  const nbf = Math.floor(Date.now() / 1000) - 3600 // Valido da 1 ora fa
  const exp = Math.floor(Date.now() / 1000) + 31536000 * 5 // Scade tra 5 anni

  // Mappatura Livello stringa -> uint8 (come in Solidity)
  let levelInt = 0
  if (level === CredentialLevel.BACHELOR_DEGREE) levelInt = 1
  else if (level === CredentialLevel.MASTER_DEGREE) levelInt = 2
  else if (level === CredentialLevel.PHD) levelInt = 3
  else if (level === CredentialLevel.PROFESSOR) levelInt = 4

  const didHolder = `did:ethr:${holderAddress}`
  
  const credentialSubject = {
    id: didHolder,
    holderAddress: holderAddress,
    degreeLevel: levelInt,
    nbf: nbf,
    exp: exp
  }

  // Costruiamo la VC compatibile EIP-712 per Veramo
  // Poichè non usiamo il DB KMS completo, passiamo un signer ethers.js personalizzato
  // a Veramo tramite l'opzione EIP712
  const vc = await agent.createVerifiableCredential({
    credential: {
      issuer: { id: `did:ethr:${issuerWallet.address}` },
      issuanceDate: new Date().toISOString(),
      expirationDate: new Date(exp * 1000).toISOString(),
      credentialSubject,
      type: [...CREDENTIAL_TYPE],
      '@context': [...CREDENTIAL_CONTEXT],
    },
    proofFormat: 'EthereumEip712Signature2021',
    save: false,
    options: {
      eip712Domain: {
        name: "CompetenceDAO Token", // Stesso dominio del nostro Smart Contract
        version: "1",
        chainId: 31337, // Hardhat Localhost Chain ID
        verifyingContract: "0x0000000000000000000000000000000000000000" // Placeholder, la DAO ignora il verifyingContract address su domain ricostruito
      },
      // Passiamo il metodo di firma Ethers per saltare il KMS locale
      signMethod: async (data: any) => {
        const types = { ...data.types }
        delete types.EIP712Domain
        return await issuerWallet.signTypedData(data.domain, types, data.message)
      }
    }
  })

  const filePath = path.join(SHARED_CREDENTIALS_DIR, `holder_${i}.json`)
  fs.writeFileSync(filePath, JSON.stringify(vc, null, 2), 'utf-8')
  console.log(`✅ Emessa VC EIP-712 per l'holder ${i} (${level}) in ${filePath}`)
}

async function main() {
  console.log("--- Emissione Verifiable Credentials (Veramo -> DAO) ---")
  console.log("Issuer: Università (Hardhat Signer 15)")

  if (!fs.existsSync(SHARED_CREDENTIALS_DIR)) {
    fs.mkdirSync(SHARED_CREDENTIALS_DIR, { recursive: true })
  }

  // Hardhat Signer 15 è il nostro "Trusted Issuer"
  const issuerWallet = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, "m/44'/60'/0'/0/15")
  console.log(`Identità Issuer (Signer 15): ${issuerWallet.address}\n`)

  for (let i = 0; i < 10; i++) {
    // I membri della DAO vanno dal Signer 1 al 10
    const holderWallet = ethers.HDNodeWallet.fromPhrase(HARDHAT_MNEMONIC, undefined, `m/44'/60'/0'/0/${i + 1}`)
    const level = HOLDER_LEVELS[i]
    await issueVC(issuerWallet, holderWallet.address, level, i + 1)
  }

  console.log("\n✅ Tutte le 10 VC sono state emesse off-chain da Veramo!")
  console.log("👉 Ora il modulo DAO può leggerle dalla cartella 'shared-credentials' e inoltrarle on-chain.")
}

main().catch(console.error)
