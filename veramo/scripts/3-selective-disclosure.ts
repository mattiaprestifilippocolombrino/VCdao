/*
Script 3 — Selective Disclosure (didattica + best practice SSI per questo stack)

Obiettivo:
1) Il Verifier richiede SOLO il claim necessario ("titoloStudio") con una SDR.
2) L'Holder presenta una VP firmata (EIP-712) che contiene una VC valida.
3) Il Verifier valida SDR + VP + VC e usa solo il campo richiesto.

Nota tecnica importante:
Questo progetto usa strettamente EIP-712 per tutte le prove crittografiche (VC e VP).
La SDR è mantenuta come oggetto locale di policy/verifica, senza token JWT.
*/

import * as fs from 'fs'
import { randomBytes } from 'crypto'
import type { ISelectiveDisclosureRequest } from '@veramo/selective-disclosure'
import { agent } from '../agent/setup'
import {
  ACTORS,
  HOLDERS,
  CREDENTIAL_TYPE,
  DISCLOSED_FIELD,
  ALL_CREDENTIAL_FIELDS,
  getCredentialPath,
} from '../types/credentials'

// Dominio applicativo della dimostrazione: aiuta a separare i contesti di verifica.
const VP_DOMAIN = 'dao-voting-demo.local'

// Tipo minimale della VC che ci serve in questo script, mantenuto semplice per chiarezza didattica.
type MinimalCredential = { credentialSubject?: Record<string, unknown> }

/**
 * Costruisce la SDR in modo esplicito:
 * - il verifier richiede un solo claim
 * - definisce il motivo
 * - restringe gli issuer accettati (best practice: trust boundary chiara)
 */
function buildSdr(verifierDid: string, trustedIssuerDid: string): ISelectiveDisclosureRequest {
  return {
    issuer: verifierDid,
    claims: [
      {
        claimType: DISCLOSED_FIELD,
        reason: 'Necessario per calcolare il peso del voto nella DAO',
        essential: true,
        credentialType: CREDENTIAL_TYPE[1],
        issuers: [{ did: trustedIssuerDid, url: 'https://university.example/ssi' }],
      },
    ],
    credentials: [CREDENTIAL_TYPE[1]],
  }
}

/**
 * Con EIP-712 la VC interna alla VP viene serializzata come stringa.
 * Questa utility la normalizza in oggetto JSON per i controlli successivi.
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
  console.log('--- STEP 3: Selective Disclosure (Focus della Tesi) ---\n')

  // Recuperiamo DID del verifier e dell'issuer per fissare in modo robusto la catena di fiducia.
  const verifier = await agent.didManagerGetByAlias({ alias: ACTORS.VERIFIER })
  const issuer = await agent.didManagerGetByAlias({ alias: ACTORS.ISSUER })

  // Creiamo la SDR come oggetto tipizzato locale (solo policy/verifica lato applicativo).
  const sdr = buildSdr(verifier.did, issuer.did)

  console.log(`📌 Verifier: ${verifier.did}`)
  console.log(`📌 Issuer fidato: ${issuer.did}`)
  console.log(`📌 Claim richiesto: "${DISCLOSED_FIELD}"`)
  console.log('📌 SDR locale preparata (no JWT, policy in-memory)')

  // Challenge e domain: best practice per legare la VP a una singola sessione.
  const challenge = randomBytes(16).toString('hex')
  console.log(`📌 Session challenge: ${challenge}`)
  console.log(`📌 Session domain: ${VP_DOMAIN}\n`)

  console.log('🎓 Ogni Holder risponde alla richiesta:\n')

  // Eseguiamo il ciclo completo holder per holder: pre-check wallet, VP, verifiche, estrazione claim minimo.
  for (const holder of HOLDERS) {
    const holderIdentity = await agent.didManagerGetByAlias({ alias: holder.alias })
    const filePath = getCredentialPath(holder.alias)

    // Se la VC non esiste nel wallet locale, saltiamo l'holder e passiamo al successivo.
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  ${holder.nominativo} — VC assente (${filePath})`)
      continue
    }

    // Carichiamo la VC dal wallet e verifichiamo subito la firma dell'issuer.
    const vc = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
    const vcResult = await agent.verifyCredential({ credential: vc })
    if (!vcResult.verified) {
      console.log(`❌ ${holder.nominativo} — VC non valida: ${vcResult.error?.message || 'errore sconosciuto'}`)
      continue
    }

    // Confrontiamo la SDR col wallet locale: almeno il claim essenziale deve essere soddisfatto.
    const sdrWalletCheck = await agent.getVerifiableCredentialsForSdr({
      did: holderIdentity.did,
      sdr: {
        subject: holderIdentity.did,
        claims: sdr.claims,
        credentials: sdr.credentials,
      },
    })
    const missingEssentialClaim = sdrWalletCheck.some(
      (requestedClaim) => requestedClaim.essential === true && requestedClaim.credentials.length === 0,
    )
    if (missingEssentialClaim) {
      console.log(`❌ ${holder.nominativo} — wallet non soddisfa i claim essenziali della SDR`)
      continue
    }

    // L'holder crea la VP firmandola con la propria chiave (proof of possession).
    const vp = await agent.createVerifiablePresentation({
      presentation: {
        holder: holderIdentity.did,
        verifiableCredential: [vc],
      },
      proofFormat: 'EthereumEip712Signature2021',
      challenge,
      domain: VP_DOMAIN,
    })

    // Il verifier controlla la firma della VP (autenticità holder + integrità payload VP).
    const vpResult = await agent.verifyPresentation({
      presentation: vp,
      challenge,
      domain: VP_DOMAIN,
    })
    if (!vpResult.verified) {
      console.log(`❌ ${holder.nominativo} — VP non valida: ${vpResult.error?.message || 'errore sconosciuto'}`)
      continue
    }

    // Verifichiamo anche la VC incapsulata nella VP (best practice: non fidarsi solo della VP).
    const embeddedVc = decodeFirstCredentialFromPresentation(vp)
    if (!embeddedVc) {
      console.log(`❌ ${holder.nominativo} — VC interna alla VP non decodificabile`)
      continue
    }

    const embeddedVcResult = await agent.verifyCredential({ credential: embeddedVc as any })
    if (!embeddedVcResult.verified) {
      console.log(
        `❌ ${holder.nominativo} — VC interna alla VP non valida: ${embeddedVcResult.error?.message || 'errore sconosciuto'}`,
      )
      continue
    }

    // Convalidiamo formalmente la VP rispetto alla SDR: il claim richiesto deve essere presente.
    const sdrValidation = await agent.validatePresentationAgainstSdr({
      presentation: vp,
      sdr,
    })
    if (!sdrValidation.valid) {
      console.log(`❌ ${holder.nominativo} — VP non conforme alla SDR`)
      continue
    }

    // Estraiamo solo il claim autorizzato dalla SDR: minimizzazione dei dati trattati.
    const matchedClaim = sdrValidation.claims.find((claim) => claim.claimType === DISCLOSED_FIELD)
    const disclosedCredential = matchedClaim?.credentials?.[0]?.verifiableCredential as MinimalCredential | undefined
    const disclosedValue = disclosedCredential?.credentialSubject?.[DISCLOSED_FIELD]

    if (disclosedValue === undefined) {
      console.log(`❌ ${holder.nominativo} — claim "${DISCLOSED_FIELD}" non trovato`)
      continue
    }

    // Log didattico: rendiamo visibile solo il campo richiesto e mascheriamo gli altri.
    console.log(`✅ ${holder.nominativo}`)
    for (const field of ALL_CREDENTIAL_FIELDS) {
      if (field === DISCLOSED_FIELD) {
        console.log(`   🔸 ${field}: ${String(disclosedValue)}`)
      } else {
        console.log(`   🔹 ${field}: [Non processato dal verifier]`)
      }
    }
    console.log()
  }

  // Chiusura didattica: in questo progetto le prove crittografiche rimangono strettamente EIP-712.
  console.log('✅ Dimostrazione completata.')
  console.log('ℹ️  Flusso crittografico usato: solo EthereumEip712Signature2021 (VC + VP).')
}

main().catch((error) => {
  console.error('Errore nella Selective Disclosure:', error.message)
  process.exit(1)
})
