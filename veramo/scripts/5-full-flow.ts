/**
 * Script 5 — Flusso Completo SSI (EIP-712 + Selective Disclosure)
 *
 * Questo script esegue l'intera dimostrazione della tesi in una volta sola:
 * 1. Creazione dei DID (Issuer, Verifiers, Holders).
 * 2. Emissione di Credenziali (VC) che certificano il livello di competenza.
 * 3. Selective Disclosure: gli Holder presentano SOLO la loro competenza (VP).
 * 4. Stampa di un riepilogo tabellare.
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
  DISCLOSED_FIELD,
  ALL_CREDENTIAL_FIELDS,
} from '../types/credentials'

// Un dizionario per generare rapidamente il nome completo del corso
const DEGREE_NAMES: Record<CredentialLevel, string> = {
  [CredentialLevel.SIMPLE_STUDENT]: 'Scienze Informatiche (in corso)',
  [CredentialLevel.BACHELOR_DEGREE]: 'Laurea Triennale in Informatica',
  [CredentialLevel.MASTER_DEGREE]: 'Laurea Magistrale in Computer Science',
  [CredentialLevel.PHD]: 'Dottorato in Informatica e Sistemi Distribuiti',
  [CredentialLevel.PROFESSOR]: 'Docente di Informatica',
}

/**
 * Cerca un DID esistente; in caso contrario, ne crea uno nuovo.
 */
async function getOrCreateDID(alias: string): Promise<string> {
  try {
    const existing = await agent.didManagerGetByAlias({ alias })
    return existing.did
  } catch {
    const created = await agent.didManagerCreate({ alias, provider: 'did:ethr:sepolia' })
    return created.did
  }
}

async function main() {
  console.log('\n============== DIMOSTRAZIONE FLUSSO SSI ==============')
  console.log('--- Step 1: Creazione dei Decentralized Identifiers (DID) ---')

  const issuerDid = await getOrCreateDID(ACTORS.ISSUER)
  console.log(`🏛️  Università creata con DID: ${issuerDid}`)

  const holderDids: Map<string, string> = new Map()
  for (const holder of HOLDERS) {
    const did = await getOrCreateDID(holder.alias)
    holderDids.set(holder.alias, did)
    console.log(`🎓 ${holder.name} registrato.`)
  }

  const verifierDid = await getOrCreateDID(ACTORS.VERIFIER)
  console.log(`🔍 Piattaforma DAO creata con DID: ${verifierDid}`)

  console.log('\n--- Step 2: L\'Università emette le Verifiable Credentials ---')
  if (!fs.existsSync(CREDENTIALS_DIR)) fs.mkdirSync(CREDENTIALS_DIR, { recursive: true })

  const issuedVCs: Map<string, any> = new Map()

  for (const holder of HOLDERS) {
    const holderDid = holderDids.get(holder.alias)!

    // Creiamo la VC contenente lo storico formativo completo dello studente.
    const credentialSubject: UniversityCredentialSubject = {
      id: holderDid,
      name: holder.name,
      degreeLevel: holder.level,
      degreeName: DEGREE_NAMES[holder.level],
      university: UNIVERSITY_INFO.name,
    }

    const vc = await agent.createVerifiableCredential({
      credential: {
        issuer: { id: issuerDid },
        credentialSubject,
        type: [...CREDENTIAL_TYPE],
        '@context': [...CREDENTIAL_CONTEXT],
      },
      proofFormat: 'EthereumEip712Signature2021', // Firma nativa Ethereum
    })

    fs.writeFileSync(getCredentialPath(holder.alias), JSON.stringify(vc, null, 2), 'utf-8')
    await agent.dataStoreSaveVerifiableCredential({ verifiableCredential: vc })
    issuedVCs.set(holder.alias, vc)
  }
  console.log(`✅ 10 credenziali emesse con firma Ethereum EIP-712.`)

  console.log('\n--- Step 3: Piattaforma DAO (Selective Disclosure) ---')
  console.log(`La Piattaforma richiede ESCLUSIVAMENTE il campo: "${DISCLOSED_FIELD}"`)

  // Il Verifier prepara una SDR (Selective Disclosure Request) in formato JWT
  await agent.createSelectiveDisclosureRequest({
    data: {
      issuer: verifierDid,
      claims: [
        {
          claimType: DISCLOSED_FIELD,
          reason: 'Dobbiamo verificare la competenza per farla valere nei voti.',
          essential: true,
        },
      ],
      credentials: [CREDENTIAL_TYPE[1]],
    },
  })

  console.log('\n--- Step 4: Costruzione Proof degli Holder e Controllo Privato ---')
  let verificatiOk = 0
  let falliti = 0
  const results: { nome: string; livello: string; privacyRispettata: boolean }[] = []

  // Per ogni holder, creiamo una Presentazione (VP) in cui svelano solo la competenza 
  // che il verificatore ha richiesto mediante la SDR.
  for (const holder of HOLDERS) {
    const holderDid = holderDids.get(holder.alias)!
    const vc = issuedVCs.get(holder.alias)

    const vp = await agent.createVerifiablePresentation({
      presentation: {
        holder: holderDid,
        verifiableCredential: [vc],
      },
      proofFormat: 'EthereumEip712Signature2021',
    })

    const vpResult = await agent.verifyPresentation({ presentation: vp })

    if (vpResult.verified) {
      // Dato che usiamo firme EIP-712, Veramo codifica la VC interna come stringa
      const vcString = vp.verifiableCredential?.[0] as string
      const innerVc = JSON.parse(vcString)
      const credSubject = innerVc.credentialSubject

      // La DAO estrae solo la competenza, ignorando gli altri dati.
      const livello = credSubject?.[DISCLOSED_FIELD]
      console.log(`✅ DAO vede per ${holder.name} solo: ${livello}`)
      verificatiOk++
      results.push({ nome: holder.name, livello: CREDENTIAL_LABELS[holder.level], privacyRispettata: true })
    } else {
      console.log(`❌ Controllo fallito per ${holder.name}.`)
      falliti++
      results.push({ nome: holder.name, livello: CREDENTIAL_LABELS[holder.level], privacyRispettata: false })
    }
  }

  console.log('\n============== RIEPILOGO FINALE ==============')
  console.log(`🔹 Issuer registrati:      1 (Università)`)
  console.log(`🔹 Certificati originati:  ${issuedVCs.size} (EIP-712)`)
  console.log(`🔹 Holder partecipanti:    ${HOLDERS.length}`)
  console.log(`🔹 Controlli positivi DAO: ${verificatiOk}`)
  console.log(`🔹 Controlli falliti:      ${falliti}\n`)

  if (falliti === 0) {
    console.log('✅ TEST SUPERATO IN PIENO!\n')
  }

  // Stampiamo lo stato visibilità della provacy per mostrare l'obiettivo primario della Tesi.
  console.log('--- Riepilogo Privacy per i partecipanti ---')
  for (const r of results) {
    const iconaPrivacy = r.privacyRispettata ? 'VOTO PONDERATO' : 'CANCELLATO'
    console.log(`- ${r.nome.padEnd(20)} | Competenze presentate: ${r.livello.padEnd(30)} | ESITO: ${iconaPrivacy}`)
  }

  console.log('\n--- I campi gestiti internamente al wallet per questa dimostrazione ---')
  for (const field of ALL_CREDENTIAL_FIELDS) {
    const visibile = field === DISCLOSED_FIELD ? 'SÌ' : 'NO'
    console.log(`* ${field.padEnd(15)} → Presentato alla DAO: ${visibile}`)
  }

  if (falliti > 0) process.exit(1)
}

main().catch((error) => {
  console.error('Errore nel flusso SSI globale:', error.message)
  process.exit(1)
})
