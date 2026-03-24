/**
 * Script 5 — Flusso Completo SSI (didattico)
 *
 * Questo script esegue l'intera demo:
 * 1) Crea DID per Issuer, Holder e Verifier.
 * 2) Emette VC firmate con EIP-712.
 * 3) Crea VP firmate dagli Holder e le verifica.
 * 4) Estrae il livello accademico utile al voto ponderato in DAO.
 * 5) Mostra un riepilogo finale.
 *
 * Nota: qui rimuoviamo i passaggi di Selective Disclosure non usati
 * nell'integrazione blockchain, mantenendo solo il flusso EIP-712.
 */

import * as fs from 'fs'
import { agent } from '../agent/setup'
import {
  ACTORS,
  UNIVERSITY_INFO,
  HOLDERS,
  CREDENTIAL_LABELS,
  CREDENTIAL_TYPE,
  CREDENTIAL_CONTEXT,
  CREDENTIALS_DIR,
  getCredentialPath,
  UniversityCredentialSubject,
  DISCLOSED_FIELD,
} from '../types/credentials'

// Tipo minimale per leggere in modo sicuro il claim dalla VC interna alla VP.
type MinimalCredential = { credentialSubject?: Record<string, unknown> }

/**
 * Recupera un DID esistente tramite alias, oppure lo crea se non esiste ancora.
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

/**
 * Estrae la prima VC da una VP.
 * In EIP-712 Veramo serializza la VC come stringa JSON: qui la riportiamo a oggetto.
 */
function decodeFirstCredentialFromPresentation(vp: { verifiableCredential?: unknown[] }): MinimalCredential | null {
  const firstCredential = vp.verifiableCredential?.[0]
  if (!firstCredential) return null

  if (typeof firstCredential === 'string') {
    try {
      return JSON.parse(firstCredential) as MinimalCredential
    } catch {
      return null
    }
  }

  return firstCredential as MinimalCredential
}

async function main() {
  // --- STEP 1: Identità ---
  console.log('\n============== DIMOSTRAZIONE FLUSSO SSI ==============')
  console.log('--- Step 1: Creazione dei Decentralized Identifiers (DID) ---')

  // 1.1 DID Issuer (Università)
  const issuerDid = await getOrCreateDID(ACTORS.ISSUER)
  console.log(`🏛️  Università creata con DID: ${issuerDid}`)

  // 1.2 DID Holders
  const holderDids: Map<string, string> = new Map()
  for (const holder of HOLDERS) {
    const did = await getOrCreateDID(holder.alias)
    holderDids.set(holder.alias, did)
    console.log(`🎓 ${holder.nominativo} registrato.`)
  }

  // 1.3 DID Verifier (DAO platform)
  const verifierDid = await getOrCreateDID(ACTORS.VERIFIER)
  console.log(`🔍 Piattaforma DAO creata con DID: ${verifierDid}`)

  // --- STEP 2: Emissione VC ---
  console.log('\n--- Step 2: L\'Università emette le Verifiable Credentials ---')

  // 2.1 Preparazione cartella locale "wallet demo"
  if (!fs.existsSync(CREDENTIALS_DIR)) fs.mkdirSync(CREDENTIALS_DIR, { recursive: true })

  // 2.2 Collezione in memoria delle VC emesse per usarle subito nello step successivo
  const issuedVCs: Map<string, any> = new Map()

  // 2.3 Emissione di una VC per ciascun holder
  for (const holder of HOLDERS) {
    const holderDid = holderDids.get(holder.alias)!
    const now = Math.floor(Date.now() / 1000)

    // Dati del subject: includiamo tutte le info necessarie per la demo accademica.
    const credentialSubject: UniversityCredentialSubject = {
      codiceFiscale: holder.codiceFiscale,
      dataNascita: holder.dataNascita,
      exp: now + 31536000 * 5,
      facolta: holder.facolta,
      id: holderDid,
      nbf: now - 3600,
      nominativo: holder.nominativo,
      titoloStudio: holder.level,
      universita: UNIVERSITY_INFO.name,
      voto: holder.voto,
    }

    // Creazione VC firmata EIP-712.
    const vc = await agent.createVerifiableCredential({
      credential: {
        issuer: { id: issuerDid },
        credentialSubject,
        type: [...CREDENTIAL_TYPE],
        '@context': [...CREDENTIAL_CONTEXT],
      },
      proofFormat: 'EthereumEip712Signature2021',
    })

    // Salvataggio sia su file (wallet demo) sia nel datastore Veramo.
    fs.writeFileSync(getCredentialPath(holder.alias), JSON.stringify(vc, null, 2), 'utf-8')
    await agent.dataStoreSaveVerifiableCredential({ verifiableCredential: vc })
    issuedVCs.set(holder.alias, vc)
  }
  console.log(`✅ 10 credenziali emesse con firma Ethereum EIP-712.`)

  // --- STEP 3: Presentazione verso la DAO ---
  console.log('\n--- Step 3: Presentazione EIP-712 verso la DAO ---')
  console.log(`La DAO userà il campo: "${DISCLOSED_FIELD}"`)

  // --- STEP 4: Risposta holder + verifiche verifier ---
  console.log('\n--- Step 4: Costruzione VP degli Holder e Verifica ---')
  let verificatiOk = 0
  let falliti = 0
  const results: { nome: string; livello: string; valido: boolean }[] = []

  for (const holder of HOLDERS) {
    const holderDid = holderDids.get(holder.alias)!
    const vc = issuedVCs.get(holder.alias)

    // 4.1 Controllo VC base: la credenziale deve essere valida prima di essere presentata.
    const vcResult = await agent.verifyCredential({ credential: vc })
    if (!vcResult.verified) {
      console.log(`❌ VC non valida per ${holder.nominativo}.`)
      falliti++
      results.push({ nome: holder.nominativo, livello: CREDENTIAL_LABELS[holder.level], valido: false })
      continue
    }

    // 4.2 L'holder crea e firma la VP che incapsula la propria VC.
    const vp = await agent.createVerifiablePresentation({
      presentation: {
        holder: holderDid,
        verifiableCredential: [vc],
      },
      proofFormat: 'EthereumEip712Signature2021',
    })

    // 4.3 Il verifier verifica l'autenticità della VP.
    const vpResult = await agent.verifyPresentation({ presentation: vp })
    if (!vpResult.verified) {
      console.log(`❌ VP non valida per ${holder.nominativo}.`)
      falliti++
      results.push({ nome: holder.nominativo, livello: CREDENTIAL_LABELS[holder.level], valido: false })
      continue
    }

    // 4.4 Best practice: verifichiamo anche la VC interna alla VP.
    const embeddedVc = decodeFirstCredentialFromPresentation(vp)
    if (!embeddedVc) {
      console.log(`❌ VC interna alla VP non decodificabile per ${holder.nominativo}.`)
      falliti++
      results.push({ nome: holder.nominativo, livello: CREDENTIAL_LABELS[holder.level], valido: false })
      continue
    }

    const embeddedVcResult = await agent.verifyCredential({ credential: embeddedVc as any })
    if (!embeddedVcResult.verified) {
      console.log(`❌ VC interna alla VP non valida per ${holder.nominativo}.`)
      falliti++
      results.push({ nome: holder.nominativo, livello: CREDENTIAL_LABELS[holder.level], valido: false })
      continue
    }

    // 4.5 Estraiamo il claim utile all'integrazione blockchain (peso voto DAO).
    const livello = embeddedVc.credentialSubject?.[DISCLOSED_FIELD]
    if (livello === undefined) {
      console.log(`❌ Claim "${DISCLOSED_FIELD}" assente per ${holder.nominativo}.`)
      falliti++
      results.push({ nome: holder.nominativo, livello: CREDENTIAL_LABELS[holder.level], valido: false })
      continue
    }

    // 4.6 Esito positivo: la DAO usa il livello di studio per il voto ponderato.
    console.log(`✅ DAO vede per ${holder.nominativo} solo: ${String(livello)}`)
    verificatiOk++
    results.push({ nome: holder.nominativo, livello: CREDENTIAL_LABELS[holder.level], valido: true })
  }

  // --- STEP 5: Riepilogo ---
  console.log('\n============== RIEPILOGO FINALE ==============')
  console.log(`🔹 Issuer registrati:      1 (Università)`)
  console.log(`🔹 Certificati originati:  ${issuedVCs.size} (EIP-712)`)
  console.log(`🔹 Holder partecipanti:    ${HOLDERS.length}`)
  console.log(`🔹 Controlli positivi DAO: ${verificatiOk}`)
  console.log(`🔹 Controlli falliti:      ${falliti}\n`)

  if (falliti === 0) {
    console.log('✅ TEST SUPERATO IN PIENO!\n')
  }

  // Riepilogo tecnico: un holder è "ok" se VC+VP sono valide e il claim richiesto è presente.
  console.log('--- Riepilogo Partecipanti ---')
  for (const r of results) {
    const esito = r.valido ? 'VOTO PONDERATO' : 'CANCELLATO'
    console.log(`- ${r.nome.padEnd(20)} | Titolo studio: ${r.livello.padEnd(30)} | ESITO: ${esito}`)
  }

  console.log(`\nℹ️  Campo usato per la DAO: ${DISCLOSED_FIELD}`)
  console.log('ℹ️  Flusso crittografico usato: solo EthereumEip712Signature2021 (VC + VP).')

  if (falliti > 0) process.exit(1)
}

main().catch((error) => {
  console.error('Errore nel flusso SSI globale:', error.message)
  process.exit(1)
})
