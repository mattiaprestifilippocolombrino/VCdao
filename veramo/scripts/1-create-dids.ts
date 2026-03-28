/*
================================================================================
SCRIPT 1: Creazione delle Identità Decentralizzate (DID)

CONTESTO DIDATTICO (SSI):
Nel paradigma Self-Sovereign Identity, l'identità non è fornita da un ente centrale
(come Google o lo Stato). Ogni attore genera la propria identità, detta DID (Decentralized
Identifier), ancorandola crittograficamente (in questo caso su rete Ethereum - ethr DID).
Questo script genera i DID per l'Università, per gli Studenti e per il Verificatore.
================================================================================
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

  // ============================================================================
  // 1. SETUP ISSUER (L'Università)
  // ============================================================================
  // L'Issuer è colui che firmerà le credenziali.
  console.log(`\n🏛️  Issuer: ${UNIVERSITY_INFO.name}`)
  const issuer = await getOrCreateDID(ACTORS.ISSUER)
  console.log(`   ${issuer.isNew ? 'Creato' : 'Esistente'}: ${issuer.did}`)

  // ============================================================================
  // 2. SETUP HOLDERS (Studenti e Professori)
  // ============================================================================
  // Gli holder sono coloro che riceveranno le credenziali (il loro indirizzo).
  console.log(`\n🎓 Holder (${HOLDERS.length} totali):`)
  for (const holder of HOLDERS) {
    const result = await getOrCreateDID(holder.alias)
    const label = CREDENTIAL_LABELS[holder.degreeTitle]
    console.log(`   - ${holder.displayName} [${label}]`)
    console.log(`     DID: ${result.did}`)
  }

  // ============================================================================
  // 3. SETUP VERIFICATORE
  // ============================================================================
  // Simula un'entità terza (es. un'azienda) che leggerà le VC e chiederà i dati.
  console.log('\n🔍 Verifier:')
  const verifier = await getOrCreateDID(ACTORS.VERIFIER)
  console.log(`   ${verifier.isNew ? 'Creato' : 'Esistente'}: ${verifier.did}`)

  console.log('\n✅ Identità DID pronte all\'uso!')
}

main().catch((error) => {
  console.error('Errore durante la creazione delle identità:', error.message)
  process.exit(1)
})
