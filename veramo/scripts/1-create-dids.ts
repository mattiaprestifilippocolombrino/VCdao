/*
Script 1 — Creazione delle Identità Decentralizzate (DID)
Script in cui vengono creati i DID per tutti i partecipanti del sistema SSI.
Sono previsti 12 partecipanti in totale: 1 Issuer (L'Università), 10 Holder 
(Gli studenti e professori) e 1 Verifier (La piattaforma DAO).
*/

import { agent } from '../agent/setup'
import { ACTORS, UNIVERSITY_INFO, HOLDERS, CREDENTIAL_LABELS } from '../types/credentials'

/**
Funzione che crea un DID se non esiste, altrimenti lo recupera dal database.
 */
async function getOrCreateDID(alias: string): Promise<{ did: string; isNew: boolean }> {
  try {
    const existing = await agent.didManagerGetByAlias({ alias })
    return { did: existing.did, isNew: false }
  } catch {
    const created = await agent.didManagerCreate({
      alias,
      provider: 'did:ethr:sepolia',
    })
    return { did: created.did, isNew: true }
  }
}

async function main() {
  console.log('--- STEP 1: Creazione Identità (DID) ---')

  // 1. Creazione dell'identità dell'Università (Issuer)
  console.log(`\n🏛️  Issuer: ${UNIVERSITY_INFO.name}`)
  const issuer = await getOrCreateDID(ACTORS.ISSUER)
  console.log(`   ${issuer.isNew ? 'Creato' : 'Esistente'}: ${issuer.did}`)

  // 2. Creazione delle identità per i 10 studenti/professori (Holder)
  console.log('\n🎓 Holder (10 totali):')
  for (const holder of HOLDERS) {
    const result = await getOrCreateDID(holder.alias)
    const label = CREDENTIAL_LABELS[holder.level]
    console.log(`   - ${holder.name} [${label}]`)
    console.log(`     DID: ${result.did}`)
  }

  // 3. Creazione dell'identità del Verifier
  console.log('\n🔍 Verifier:')
  const verifier = await getOrCreateDID(ACTORS.VERIFIER)
  console.log(`   ${verifier.isNew ? 'Creato' : 'Esistente'}: ${verifier.did}`)

  console.log('\n✅ 12 identità DID pronte all\'uso!')
}

main().catch((error) => {
  console.error('Errore durante la creazione delle identità:', error.message)
  process.exit(1)
})
