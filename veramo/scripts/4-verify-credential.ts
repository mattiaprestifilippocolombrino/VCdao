/*
Script 4 — Verifica delle Verifiable Credentials
Il Verifier in questo passaggio legge tutte le Verifiable Credentials (VC) che sono state emesse dall'Università e ne valuta la validità.
Utilizzando le firme crittografiche (EIP-712), il sistema può garantire
tre cose:
1. La VC è stata emessa esattamente da quel DID (L'Università).
2. La VC non è stata alterata da quando è stata firmata (Integrità).
3. L'Holder indicato nella VC è il legittimo destinatario (Autenticità).
 */

import * as fs from 'fs'
import { agent } from '../agent/setup'
import {
  HOLDERS,
  CREDENTIAL_LABELS,
  getCredentialPath,
} from '../types/credentials'

async function main() {
  console.log('--- STEP 4: Verifica Crittografica VC (EIP-712) ---\n')

  let verificati = 0
  let falliti = 0

  for (const holder of HOLDERS) {
    const credPath = getCredentialPath(holder.alias)
    const label = CREDENTIAL_LABELS[holder.level]

    if (!fs.existsSync(credPath)) {
      console.log(`⚠️  ${holder.nominativo} [${label}] — file non trovato: ${credPath}`)
      falliti++
      continue
    }

    // Il Verifier legge il file JSON che rappresenta la Credenziale
    const vc = JSON.parse(fs.readFileSync(credPath, 'utf-8'))

    // Veramo utilizza un resolver locale ("ethr-did-resolver")
    // per ottenere la chiave pubblica dell'Issuer, estrae i dati "tipizzati"
    // previsti dall'EIP-712 e verifica l'integrità della firma in locale.
    const verificaResult = await agent.verifyCredential({ credential: vc })

    if (verificaResult.verified) {
      const tipoProof = vc.proof?.type || 'Sconosciuto'
      console.log(`✅ ${holder.nominativo} — ${label} (Firma: ${tipoProof})`)
      verificati++
    } else {
      console.log(`❌ ${holder.nominativo} —  VERIFICA FALLITA`)
      if (verificaResult.error) {
        console.log(`   Motivo: ${verificaResult.error.message}`)
      }
      falliti++
    }
  }

  console.log('\n--- Riepilogo ---')
  console.log(`✅ Convalidate: ${verificati}`)
  console.log(`❌ Fallite:     ${falliti}`)

  // Se almeno una credenziale non è valida blocchiamo il processo.
  if (falliti > 0) process.exit(1)
}

main().catch((error) => {
  console.error('Errore durante la verifica:', error.message)
  process.exit(1)
})
