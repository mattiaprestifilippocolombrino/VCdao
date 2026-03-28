/*
Script 2 — Emissione VC (modello unico)

Questo script è l'entry-point didattico consigliato:
- emette VC dal modulo Veramo
- salva in `veramo/credentials`
- copia le stesse VC in `dao/scripts/shared-credentials`
così il modulo DAO può consumarle direttamente.
*/

import { issueDaoCompatibleCredentials } from "./issue-for-dao"

async function main() {
  console.log("--- STEP 2: Emissione Verifiable Credentials (modello unico) ---\n")
  await issueDaoCompatibleCredentials()
}

main().catch((error) => {
  console.error("Errore durante l'emissione delle credenziali:", error.message)
  process.exit(1)
})
