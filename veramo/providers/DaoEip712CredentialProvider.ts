// Provider Veramo per credenziali firmate nel formato EIP-712 atteso dalla DAO.
import { ethers } from "ethers";
import type {
  ICreateVerifiableCredentialArgs,
  ICreateVerifiablePresentationArgs,
  IKey,
  IssuerAgentContext,
  IVerifyCredentialArgs,
  IVerifyPresentationArgs,
  IVerifyResult,
  VerifiableCredential,
  VerifierAgentContext,
} from "@veramo/core-types" with { "resolution-mode": "import" };
import type {
  ICredentialProvider,
  ProofFormatQuery,
  TentativeVerificationQuery,
} from "@veramo/credential-w3c" with { "resolution-mode": "import" };
import {
  CREDENTIAL_CONTEXT,
  CREDENTIAL_TYPE,
  EIP712_DOMAIN,
  VC_TYPES,
  addressFromEthrDid,
} from "../types/credentials";

// Nome standard dichiarato dentro proof.type di ogni VC emessa.
export const DAO_EIP712_PROOF = "EthereumEip712Signature2021";

/** Legge il DID issuer sia dalla forma stringa sia dalla forma `{ id }`. */
function issuerDid(credential: any): string {
  return typeof credential.issuer === "string" ? credential.issuer : credential.issuer?.id;
}

/**
 * Seleziona la chiave richiesta dal chiamante oppure la prima Secp256k1.
 * Le firme Ethereum del progetto richiedono una chiave sulla curva secp256k1.
 */
function keyFor(identifier: any, keyRef?: string): IKey {
  const key = keyRef
    ? identifier.keys.find((candidate: IKey) => candidate.kid === keyRef)
    : identifier.keys.find((candidate: IKey) => candidate.type === "Secp256k1");
  if (!key) throw new Error(`Nessuna chiave Secp256k1 disponibile per ${identifier.did}`);
  return key;
}

/** Converte la chiave pubblica Veramo nel corrispondente address Ethereum. */
function signerAddress(key: IKey): string {
  return ethers.computeAddress(`0x${key.publicKeyHex}`);
}

/**
 * Provider Veramo che conserva esattamente il typed-data accettato da
 * VPVerifier.sol. Il provider standard di Veramo usa invece uno schema EIP-712
 * generato dinamicamente, non compatibile con il contratto della DAO.
 */
export class DaoEip712CredentialProvider implements ICredentialProvider {
  /** Il provider accetta il proof format DAO solo per chiavi Ethereum. */
  getProofFormatsSupportedForKey(key: IKey): string[] {
    return key.type === "Secp256k1" ? [DAO_EIP712_PROOF] : [];
  }

  /** Permette al CredentialPlugin di scegliere questo provider per EIP-712. */
  canIssueProofFormat(query: ProofFormatQuery): boolean {
    return query.proofFormat === DAO_EIP712_PROOF;
  }

  /**
   * Dichiara verificabili soltanto documenti VC con il proof type atteso.
   * Una VP non viene quindi instradata alla verifica delle credenziali.
   */
  canVerifyDocumentType(query: TentativeVerificationQuery): boolean {
    const document = query.document as any;
    return document?.proof?.type === DAO_EIP712_PROOF
      && document?.type?.includes("VerifiableCredential");
  }

  /**
   * Crea e firma una VC.
   * args contiene documento, proof format e keyRef richiesti dal chiamante.
   * context permette al provider di usare DIDManager e KeyManager dell'agent.
   */
  async createVerifiableCredential(
    args: ICreateVerifiableCredentialArgs,
    context: IssuerAgentContext,
  ): Promise<VerifiableCredential> {
    // Il payload firmato deve restare allineato a VC_TYPES e ai type-hash Solidity.
    const issuanceDate = String(args.credential.issuanceDate ?? new Date().toISOString());
    const did = issuerDid(args.credential);

    const identifier = await context.agent.didManagerGet({ did });
    const key = keyFor(identifier, args.keyRef);

    if (addressFromEthrDid(did) !== signerAddress(key)) {
      throw new Error(`La chiave Veramo non controlla il DID issuer ${did}`);
    }

    const signingPayload = {
      issuer: { id: did },
      issuanceDate,
      credentialSubject: args.credential.credentialSubject,
    };
    const proofValue = await context.agent.keyManagerSign({
      keyRef: key.kid,
      algorithm: "eth_signTypedData",
      data: JSON.stringify({
        domain: EIP712_DOMAIN,
        types: VC_TYPES,
        primaryType: "VerifiableCredential",
        message: signingPayload,
      }),
    });

    return {
      "@context": [...CREDENTIAL_CONTEXT],
      type: [...CREDENTIAL_TYPE],
      ...signingPayload,
      proof: {
        type: DAO_EIP712_PROOF,
        created: issuanceDate,
        proofPurpose: "assertionMethod",
        verificationMethod: key.kid,
        proofValue,
        eip712: {
          domain: EIP712_DOMAIN,
          types: VC_TYPES,
          primaryType: "VerifiableCredential",
        },
      },
    } as VerifiableCredential;
  }

  async createVerifiablePresentation(
    _args: ICreateVerifiablePresentationArgs,
    _context: IssuerAgentContext,
  ): Promise<never> {
    // CompetenceDAO usa solo VC: le VP falliscono esplicitamente.
    throw new Error("Le Verifiable Presentation non sono supportate da CompetenceDAO");
  }

  /** Verifica firma e identità dell'issuer di una VC già esistente. */
  async verifyCredential(
    args: IVerifyCredentialArgs,
    _context: VerifierAgentContext,
  ): Promise<IVerifyResult> {
    try {
      // La verifica recupera l'address dalla firma EIP-712 e lo confronta con il DID issuer.
      const credential: any = args.credential;

      const recovered = ethers.verifyTypedData(EIP712_DOMAIN, VC_TYPES, {
        issuer: { id: issuerDid(credential) },
        issuanceDate: credential.issuanceDate,
        credentialSubject: credential.credentialSubject,
      }, credential.proof.proofValue);
      return { verified: recovered === addressFromEthrDid(issuerDid(credential)) };
    } catch (error) {
      // Errori di formato o firma diventano un risultato di verifica negativo.
      return {
        verified: false,
        error: { errorCode: "invalid_signature", message: String(error) },
      };
    }
  }

  async verifyPresentation(
    _args: IVerifyPresentationArgs,
    _context: VerifierAgentContext,
  ): Promise<never> {
    throw new Error("Le Verifiable Presentation non sono supportate da CompetenceDAO");
  }
}
