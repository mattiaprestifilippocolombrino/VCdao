/*
================================================================================
Script 5 — Full Flow POC (Veramo -> DAO logica)

OBIETTIVO:
Vostro ultimo script di simulazione ibrida (Offchain). In una situazione reale
non c'è bisogno della blockchain per verificare una W3C Credential se lo scopo
è ad esempio farsi far entrare tramite un tornello fisico, o loggarsi a un sito web.
Questa verifica è COMPLETAMENTE OFFCHAIN, simulando quello che le applicazioni 
fanno chiamando ethers.verifyTypedData internamente in Typescript.
================================================================================
*/

import * as fs from "fs"
import * as path from "path"
import { ethers } from "ethers"

import { agent } from "../agent/setup"
import {
  ACTORS,
  HOLDERS,
  CREDENTIALS_DIR,
  CREDENTIAL_CONTEXT,
  CREDENTIAL_TYPE,
  VC_TYPES,
  DISCLOSED_FIELD,
} from "../types/credentials"
import { issueDaoCompatibleCredentials } from "./issue-for-dao"

async function getOrCreateDID(alias: string): Promise<string> {
  try {
    const existing = await agent.didManagerGetByAlias({ alias })
    return existing.did
  } catch {
    const created = await agent.didManagerCreate({ alias, provider: "did:ethr:sepolia" })
    return created.did
  }
}

function parseIssuerAddressFromDid(issuerDid: string): string {
  const didTail = issuerDid.split(":").pop()
  if (!didTail) throw new Error(`Issuer DID malformato: ${issuerDid}`)
  if (ethers.isAddress(didTail)) return ethers.getAddress(didTail)
  if (/^0x[0-9a-fA-F]{66}$/.test(didTail) || /^0x[0-9a-fA-F]{130}$/.test(didTail)) {
    return ethers.computeAddress(didTail)
  }
  throw new Error(`Issuer DID senza address/public key valida: ${issuerDid}`)
}

async function main() {
  console.log("\n============== FULL FLOW SSI -> DAO ==============")
  console.log("--- Step 1: DID setup ---")

  // ============================================================================
  // 1. SETUP DEGLI IDENTIFICATIVI (DID)
  // ============================================================================
  // Genera "on-the-fly" gli identificativi decentralizzati per l'Issuer, il Verifier
  // e tutti gli Holder usando il DID provider "ethr".
  const issuerDid = await getOrCreateDID(ACTORS.ISSUER)
  const verifierDid = await getOrCreateDID(ACTORS.VERIFIER)
  for (const holder of HOLDERS) {
    await getOrCreateDID(holder.alias)
  }
  console.log(`🏛️  Issuer DID:   ${issuerDid}`)
  console.log(`🔍 Verifier DID: ${verifierDid}`)
  console.log(`🎓 Holder DID alias pronti: ${HOLDERS.length}`)

  // ============================================================================
  // 2. EMISSIONE DELLE CREDENZIALI
  // ============================================================================
  console.log("\n--- Step 2: Issue VC (modello unico) ---")
  await issueDaoCompatibleCredentials()

  // ============================================================================
  // 3. VERIFICA OFF-CHAIN E SELECTIVE DISCLOSURE
  // ============================================================================
  console.log("\n--- Step 3: Verify + selective processing ---")
  // Carica i dati del token per ricreare a mano lo stesso dominio EIP-712 usato dall'Issuer.
  const deployedPath = path.join(__dirname, "../../dao/deployedAddresses.json")
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf-8"))
  const domain = {
    name: "Universal VC Protocol",
    version: "1",
  }
  const trustedIssuer = ethers.getAddress(deployed.issuer)

  let ok = 0
  let failed = 0
  for (const holder of HOLDERS) {
    const filePath = path.join(__dirname, "..", CREDENTIALS_DIR, `${holder.alias}.json`)
    if (!fs.existsSync(filePath)) {
      failed++
      console.log(`❌ ${holder.displayName} — VC non trovata`)
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

      // Preparazione statica per la verifica della firma EIP-712 off-chain.
      // Dobbiamo ricostruire la stessa esatta struttura usata dall'issuer al momento della firma.
      const signablePayload = {
        issuer: vc.issuer,
        issuanceDate: vc.issuanceDate,
        credentialSubject: vc.credentialSubject,
      }
      
      // La funzione "verifyTypedData" prende in input la firma in Bytes e, calcolando 
      // i vari hash come fa lo smart contract, restituisce l'Indirizzo Pubblico di chi aveva firmato (ECDSA Recover).
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

      const disclosed = vc.credentialSubject?.[DISCLOSED_FIELD]
      if (disclosed === undefined) throw new Error(`claim ${DISCLOSED_FIELD} mancante`)

      console.log(`✅ ${holder.displayName} -> ${DISCLOSED_FIELD}: ${String(disclosed)}`)
      ok++
    } catch (error: any) {
      failed++
      console.log(`❌ ${holder.displayName} -> ${error?.message ?? "errore sconosciuto"}`)
    }
  }

  console.log("\n============== RIEPILOGO ==============")
  console.log(`VC validate: ${ok}`)
  console.log(`VC fallite: ${failed}`)
  console.log("Cartelle output:")
  console.log("- veramo/credentials")
  console.log("- dao/scripts/shared-credentials")

  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error("Errore nel full flow:", error.message)
  process.exit(1)
})
