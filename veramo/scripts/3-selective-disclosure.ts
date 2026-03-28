/*
================================================================================
SCRIPT 3: Selective Disclosure (Policy-driven)

CONTESTO DIDATTICO (SSI):
La Selective Disclosure è un principio chiave della Privacy by Design.
Invece di rivelare all'azienda/DAO tutta la tua identità (Nome, Cognome, Voti), 
riveli SOLO il claim richiesto (es. il titolo di studio). In questo PoC,
simuliamo un Verifier che off-chain decide programmaticamente di scartare i dati
personali mostrando a schermo solo la "Competence", mantenendo la validità crittografica.
================================================================================
*/

import * as fs from "fs"
import * as path from "path"
import { ethers } from "ethers"
import {
  HOLDERS,
  DISCLOSED_FIELD,
  ALL_CREDENTIAL_FIELDS,
  CREDENTIAL_CONTEXT,
  CREDENTIAL_TYPE,
  CREDENTIALS_DIR,
  VC_TYPES,
} from "../types/credentials"

function parseIssuerAddressFromDid(issuerDid: string): string {
  const didTail = issuerDid.split(":").pop()
  if (!didTail) throw new Error(`Issuer DID malformato: ${issuerDid}`)
  if (ethers.isAddress(didTail)) return ethers.getAddress(didTail)
  if (/^0x[0-9a-fA-F]{66}$/.test(didTail) || /^0x[0-9a-fA-F]{130}$/.test(didTail)) {
    return ethers.computeAddress(didTail)
  }
  throw new Error(`Issuer DID senza address/public key valida: ${issuerDid}`)
}

function assertIsoSecond(iso: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso)) {
    throw new Error(`Formato ISO non valido: ${iso}`)
  }
}

async function main() {
  console.log("--- STEP 3: Selective Disclosure (policy-driven) ---\n")
  console.log(`📌 Claim richiesto dal verifier: "${DISCLOSED_FIELD}"\n`)

  // ============================================================================
  // 1. CARICAMENTO INDIRIZZI E CHIAVI DAO
  // ============================================================================
  // Serve per ricreare il dominio EIP-712 identico a quello con cui l'Issuer ha firmato.
  const deployedPath = path.join(__dirname, "../../dao/deployedAddresses.json")
  if (!fs.existsSync(deployedPath)) {
    throw new Error(`File ${deployedPath} non trovato. Esegui prima dao/scripts/01_deploy.ts`)
  }
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf-8"))
  if (!deployed?.token || !ethers.isAddress(deployed.token)) {
    throw new Error("deployedAddresses.json non contiene un token valido")
  }
  if (!deployed?.issuer || !ethers.isAddress(deployed.issuer)) {
    throw new Error("deployedAddresses.json non contiene un issuer valido")
  }

  const domain = {
    name: "Universal VC Protocol",
    version: "1",
  }
  const trustedIssuer = ethers.getAddress(deployed.issuer)

  for (const holder of HOLDERS) {
    const filePath = path.join(__dirname, "..", CREDENTIALS_DIR, `${holder.alias}.json`)
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  ${holder.displayName} — VC assente (${filePath})`)
      continue
    }

    try {
      const vc = JSON.parse(fs.readFileSync(filePath, "utf-8"))

      if (JSON.stringify(vc["@context"]) !== JSON.stringify(CREDENTIAL_CONTEXT)) {
        throw new Error("@context non conforme")
      }
      if (JSON.stringify(vc.type) !== JSON.stringify(CREDENTIAL_TYPE)) {
        throw new Error("type non conforme")
      }
      assertIsoSecond(String(vc.issuanceDate))
      assertIsoSecond(String(vc.proof?.created))

      // ============================================================================
      // 2. VERIFICA FIRMA EIP-712 (Anti-Spoofing)
      // ============================================================================
      // Prima di fidarsi dei dati letti (anche se filtrati), il verifier 
      // DEVE essere sicuro che il payload sia stato originato dall'Issuer giusto.
      const signablePayload = {
        issuer: vc.issuer,
        issuanceDate: vc.issuanceDate,
        credentialSubject: vc.credentialSubject,
      }

      const recovered = ethers.verifyTypedData(
        domain,
        VC_TYPES,
        signablePayload,
        String(vc.proof?.proofValue ?? "")
      )
      const recoveredAddress = ethers.getAddress(recovered)
      const issuerFromDid = parseIssuerAddressFromDid(String(vc.issuer?.id ?? ""))

      if (recoveredAddress !== trustedIssuer || issuerFromDid !== trustedIssuer) {
        throw new Error("issuer non trusted")
      }

      // ============================================================================
      // 3. SELECTIVE DISCLOSURE (Filtraggio Dati off-chain)
      // ============================================================================
      // Qui scartiamo i dati privati (es. nome e voti) ed estraiamo programmaticamente
      // solo il "DISCLOSED_FIELD" (es. il degreeTitle) per mostrarlo in UI.
      const disclosedValue = vc.credentialSubject?.[DISCLOSED_FIELD]
      if (disclosedValue === undefined) {
        throw new Error(`claim "${DISCLOSED_FIELD}" non trovato`)
      }

      console.log(`✅ ${holder.displayName}`)
      for (const field of ALL_CREDENTIAL_FIELDS) {
        if (field === DISCLOSED_FIELD) {
          console.log(`   🔸 ${field}: ${String(disclosedValue)}`)
        } else {
          console.log(`   🔹 ${field}: [Hidden by verifier policy]`)
        }
      }
      console.log()
    } catch (error: any) {
      console.log(`❌ ${holder.displayName} — Disclosure fallita`)
      console.log(`   Motivo: ${error?.message ?? "errore sconosciuto"}\n`)
    }
  }
}

main().catch((error) => {
  console.error("Errore nella Selective Disclosure:", error.message)
  process.exit(1)
})
