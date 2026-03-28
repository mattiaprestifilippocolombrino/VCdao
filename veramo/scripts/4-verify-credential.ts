/*
================================================================================
SCRIPT 4: Verifica crittografica VC (modello unico Veramo/DAO)

CONTESTO DIDATTICO:
Dimostra come la validazione avvenga in modo matematico. Chi riceve la Credenziale
prende i dati in chiaro (payload), li ri-hasha usando il protocollo descritto dal
"domain" EIP-712 (Nome, Versione, ChainId, Contract Address), e, tramite la firma e 
l'hashing, recupera matematicamente l'indirizzo pubblico di chi aveva firmato (l'Università).
Se l'indirizzo coincide, la competenza è considerata valida e inalterata.
================================================================================
*/

import * as fs from "fs"
import * as path from "path"
import { ethers } from "ethers"
import {
  CREDENTIAL_CONTEXT,
  CREDENTIAL_TYPE,
  CREDENTIALS_DIR,
  VC_TYPES,
  HOLDERS,
  CREDENTIAL_LABELS,
} from "../types/credentials"

function parseIssuerAddressFromDid(issuerDid: string): string {
  const didTail = issuerDid.split(":").pop()
  if (!didTail) throw new Error(`Issuer DID malformato: ${issuerDid}`)

  if (ethers.isAddress(didTail)) return ethers.getAddress(didTail)

  const isCompressedPubKey = /^0x[0-9a-fA-F]{66}$/.test(didTail)
  const isUncompressedPubKey = /^0x[0-9a-fA-F]{130}$/.test(didTail)
  if (!isCompressedPubKey && !isUncompressedPubKey) {
    throw new Error(`Issuer DID senza address/public key valida: ${issuerDid}`)
  }
  return ethers.computeAddress(didTail)
}

function assertIsoSecond(iso: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(iso)) {
    throw new Error(`Formato ISO non valido (atteso second precision): ${iso}`)
  }
}

async function main() {
  console.log("--- STEP 4: Verifica Crittografica VC (EIP-712) ---\n")

  // ============================================================================
  // 1. CARICAMENTO PARAMETRI DAO E DOMINIO
  // ============================================================================
  // Poiché usiamo le firme EIP-712, il dominio (che include il chainId e l'indirizzo del contratto)
  // è essenziale per la rigenerazione esatta dell'Hash (digest).
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

  let verifiedCount = 0
  let failedCount = 0

  for (const holder of HOLDERS) {
    const filePath = path.join(__dirname, "..", CREDENTIALS_DIR, `${holder.alias}.json`)
    const label = CREDENTIAL_LABELS[holder.degreeTitle]

    if (!fs.existsSync(filePath)) {
      console.log(`⚠️  ${holder.displayName} [${label}] — file non trovato: ${filePath}`)
      failedCount++
      continue
    }

    try {
      // ============================================================================
      // 2. LETTURA E VALIDAZIONE FORMATO W3C
      // ============================================================================
      // Come il contratto Solidity richiede, anche qui si validano rigorosamente
      // i campi standard delle Verifiable Credentials.
      const vc = JSON.parse(fs.readFileSync(filePath, "utf-8"))

      if (JSON.stringify(vc["@context"]) !== JSON.stringify(CREDENTIAL_CONTEXT)) {
        throw new Error("@context non conforme")
      }
      if (JSON.stringify(vc.type) !== JSON.stringify(CREDENTIAL_TYPE)) {
        throw new Error("type non conforme")
      }
      assertIsoSecond(String(vc.issuanceDate))
      assertIsoSecond(String(vc.proof?.created))
      if (vc.proof?.type !== "EthereumEip712Signature2021") {
        throw new Error("proof.type non conforme")
      }
      if (vc.proof?.proofPurpose !== "assertionMethod") {
        throw new Error("proof.proofPurpose non conforme")
      }

      // ============================================================================
      // 3. VERIFICA CRITTOGRAFICA (ECDSA RECOVER)
      // ============================================================================
      // Estrae i dati immutabili e la firma, e compie la stessa magia matematica 
      // del contratto "VPVerifier.sol" chiamando `ethers.verifyTypedData`.
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

      if (recoveredAddress !== trustedIssuer) {
        throw new Error(
          `firma non trusted: recovered=${recoveredAddress}, trusted=${trustedIssuer}`
        )
      }
      if (issuerFromDid !== trustedIssuer) {
        throw new Error(`issuer DID non trusted: did=${issuerFromDid}, trusted=${trustedIssuer}`)
      }

      console.log(`✅ ${holder.displayName} — ${label} (issuer: ${recoveredAddress})`)
      verifiedCount++
    } catch (error: any) {
      console.log(`❌ ${holder.displayName} — VERIFICA FALLITA`)
      console.log(`   Motivo: ${error?.message ?? "errore sconosciuto"}`)
      failedCount++
    }
  }

  console.log("\n--- Riepilogo ---")
  console.log(`✅ Convalidate: ${verifiedCount}`)
  console.log(`❌ Fallite:     ${failedCount}`)

  if (failedCount > 0) process.exit(1)
}

main().catch((error) => {
  console.error("Errore durante la verifica:", error.message)
  process.exit(1)
})
