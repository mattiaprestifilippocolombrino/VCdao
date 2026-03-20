/*
Script 3 — Selective Disclosure 
Script che dimostra la "Selective Disclosure" tra un Holder e il Verifier.
Il Verifier invia una richiesta (SDR) in cui chiede esplicitamente
una credenziale universitaria da cui vuole estrarre SOLO il "degreeLevel".
L'Holder accetta e genera una Verifiable Presentation in cui inserisce
la sua VC. La VP dimostra l'autenticità senza alterare la VC.
Il Verifier convalida la VP ed estrae solo l'informazione che gli serve.
*/

import { agent } from '../agent/setup'
import {
  ACTORS,
  HOLDERS,
  CREDENTIAL_TYPE,
  DISCLOSED_FIELD,
  ALL_CREDENTIAL_FIELDS,
  getCredentialPath,
} from '../types/credentials'
import * as fs from 'fs'

async function main() {
  console.log('--- STEP 3: Selective Disclosure (Focus della Tesi) ---\n')

  const verifier = await agent.didManagerGetByAlias({ alias: ACTORS.VERIFIER })

  // --- FASE 1: La richiesta del Verifier (SDR) ---
  console.log(`📌 Il Verifier ${verifier.did} crea la richiesta SDR.`)
  console.log(`   Chiede il campo: "${DISCLOSED_FIELD}"`)

  // Il Verifier firma una richiesta in JWT in cui specifica i campi necessari
  await agent.createSelectiveDisclosureRequest({
    data: {
      issuer: verifier.did,
      claims: [
        {
          claimType: DISCLOSED_FIELD,
          reason: 'Necessario per calcolare il peso del tuo voto nella DAO',
          essential: true,
        },
      ],
      credentials: [CREDENTIAL_TYPE[1]], // Tipo 'UniversityDegreeCredential'
    },
  })

  console.log('\n🎓 Ogni studente (Holder) risponde alla richiesta:\n')

  // --- FASE 2 e 3: Risposta degli Holder e Controllo del Verifier ---
  for (const holder of HOLDERS) {
    const holderIdentity = await agent.didManagerGetByAlias({ alias: holder.alias })

    // L'holder legge la sua credenziale salvata in precedenza (il suo wallet)
    const filePath = getCredentialPath(holder.alias)
    if (!fs.existsSync(filePath)) continue

    const vc = JSON.parse(fs.readFileSync(filePath, 'utf-8'))

    // L'holder genera una Presentation (VP) in cui inserisce la sua VC
    // e la firma con EIP-712 a dimostrazione di esserne il proprietario
    const vp = await agent.createVerifiablePresentation({
      presentation: {
        holder: holderIdentity.did,
        verifiableCredential: [vc],
      },
      proofFormat: 'EthereumEip712Signature2021',
    })

    // Il Verifier riceve la VP e ne verifica le firme e la validità crittografica
    const vpResult = await agent.verifyPresentation({ presentation: vp })

    if (vpResult.verified) {
      // Dato che usiamo firme EIP-712, Veramo codifica la VC interna come stringa
      const vcString = vp.verifiableCredential?.[0] as string
      const innerVc = JSON.parse(vcString)
      const credSubject = innerVc.credentialSubject

      // Ecco la Selective Disclosure: il Verifier estrae solo il livello
      const disclosedValue = credSubject?.[DISCLOSED_FIELD]

      console.log(`✅ ${holder.name}`)

      // Mostriamo al terminale cosa vede e cosa non vede il Verifier
      for (const field of ALL_CREDENTIAL_FIELDS) {
        if (field === DISCLOSED_FIELD) {
          console.log(`   🔸 ${field}: ${disclosedValue}`)
        } else {
          console.log(`   🔹 ${field}: [Nascosto per privacy]`)
        }
      }
      console.log()
    } else {
      console.log(`❌ ${holder.name} — Controllo fallito\n`)
    }
  }

  console.log('✅ Dimostrazione completata: La privacy è stata mantenuta.')
}

main().catch((error) => {
  console.error('Errore nella Selective Disclosure:', error.message)
  process.exit(1)
})
