/*
Script 2 — Emissione delle Verifiable Credentials (VC)
Script in cui l'Università funge da "Issuer" e genera una VC per ognuno dei 10 holder.

Usiamo la firma crittografica 'EthereumEip712Signature2021'.
A differenza dei JWT, le firme EIP-712 possono essere lette facilmente
dai wallet Ethereum (es. MetaMask) e verificate dagli Smart Contract.
*/

import * as fs from 'fs'
import { agent } from '../agent/setup'
import {
  ACTORS,
  UNIVERSITY_INFO,
  HOLDERS,
  CredentialLevel,
  CREDENTIAL_LABELS,
  CREDENTIAL_TYPE,
  CREDENTIAL_CONTEXT,
  CREDENTIALS_DIR,
  getCredentialPath,
  UniversityCredentialSubject,
} from '../types/credentials'

// Mappa che collega il livello di competenza al nome completo del corso di studi.
// Il nome del corso (degreeName) sarà tenuto privato durante la Selective Disclosure.
const DEGREE_NAMES: Record<CredentialLevel, string> = {
  [CredentialLevel.SIMPLE_STUDENT]: 'Scienze Informatiche (in corso)',
  [CredentialLevel.BACHELOR_DEGREE]: 'Laurea Triennale in Informatica',
  [CredentialLevel.MASTER_DEGREE]: 'Laurea Magistrale in Computer Science',
  [CredentialLevel.PHD]: 'Dottorato in Informatica e Sistemi Distribuiti',
  [CredentialLevel.PROFESSOR]: 'Docente di Informatica',
}

async function main() {
  console.log('--- STEP 2: Emissione Verifiable Credentials (EIP-712) ---\n')

  // 1. Recuperiamo l'identità dell'Università dal database
  const issuer = await agent.didManagerGetByAlias({ alias: ACTORS.ISSUER })
  console.log(`L'Università (${issuer.did}) emette le credenziali:`)

  // Creiamo la cartella per salvare i file se non esiste
  if (!fs.existsSync(CREDENTIALS_DIR)) {
    fs.mkdirSync(CREDENTIALS_DIR, { recursive: true })
  }

  // 2. Iteriamo sui 10 holder e creiamo una VC per ciascuno
  let count = 0
  for (const holder of HOLDERS) {
    const holderIdentity = await agent.didManagerGetByAlias({ alias: holder.alias })

    // Prepariamo i dati ("claims") contenuti nella credenziale in ordine ALFABETICO rigoroso
    // per non rompere il TypeHash EIP-712 dinamico generato da Veramo.
    const now = Math.floor(Date.now() / 1000)

    const credentialSubject: UniversityCredentialSubject = {
      codiceFiscale: holder.codiceFiscale,
      dataNascita: holder.dataNascita,
      exp: now + 31536000 * 5,    // Scade tra 5 anni
      facolta: holder.facolta,
      id: holderIdentity.did,
      nbf: now - 3600,            // Valida da un'ora fa
      nominativo: holder.nominativo,
      titoloStudio: holder.level, // Stringa es. "BachelorDegree"
      universita: UNIVERSITY_INFO.name,
      voto: holder.voto
    }

    // Creiamo e firmiamo la credenziale con EIP-712
    const vc = await agent.createVerifiableCredential({
      credential: {
        issuer: { id: issuer.did },
        credentialSubject,
        type: [...CREDENTIAL_TYPE],
        '@context': [...CREDENTIAL_CONTEXT],
      },
      proofFormat: 'EthereumEip712Signature2021', // <-- NOVITÀ per la tesi!
    })

    // Salviamo la credenziale su un file JSON
    const filePath = getCredentialPath(holder.alias)
    fs.writeFileSync(filePath, JSON.stringify(vc, null, 2), 'utf-8')

    // Salviamo anche nel DataStore locale di Veramo (ci servirà nello Step 3)
    await agent.dataStoreSaveVerifiableCredential({ verifiableCredential: vc })

    count++
    console.log(`   ${count}/${HOLDERS.length} ✅ VC emessa per ${holder.nominativo} (${CREDENTIAL_LABELS[holder.level]})`)
  }

  console.log('\n✅ Tutte le 10 credenziali sono state create con successo!\n')
}

main().catch((error) => {
  console.error('Errore durante l\'emissione delle credenziali:', error.message)
  process.exit(1)
})
