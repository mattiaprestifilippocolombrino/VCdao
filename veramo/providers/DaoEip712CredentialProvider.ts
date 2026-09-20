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
  VerifiablePresentation,
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
  PRESENTATION_EIP712_DOMAIN,
  PRESENTATION_EIP712_TYPES,
  VC_TYPES,
  addressFromEthrDid,
} from "../types/credentials";

export const DAO_EIP712_PROOF = "EthereumEip712Signature2021";

function issuerDid(credential: any): string {
  return typeof credential.issuer === "string" ? credential.issuer : credential.issuer?.id;
}

function keyFor(identifier: any, keyRef?: string): IKey {
  const key = keyRef
    ? identifier.keys.find((candidate: IKey) => candidate.kid === keyRef)
    : identifier.keys.find((candidate: IKey) => candidate.type === "Secp256k1");
  if (!key) throw new Error(`Nessuna chiave Secp256k1 disponibile per ${identifier.did}`);
  return key;
}

function signerAddress(key: IKey): string {
  return ethers.computeAddress(`0x${key.publicKeyHex}`);
}

/**
 * Provider Veramo che conserva esattamente il typed-data accettato da
 * VPVerifier.sol. Il provider standard di Veramo usa invece uno schema EIP-712
 * generato dinamicamente, non compatibile con il contratto della DAO.
 */
export class DaoEip712CredentialProvider implements ICredentialProvider {
  getProofFormatsSupportedForKey(key: IKey): string[] {
    return key.type === "Secp256k1" ? [DAO_EIP712_PROOF] : [];
  }

  canIssueProofFormat(query: ProofFormatQuery): boolean {
    return query.proofFormat === DAO_EIP712_PROOF;
  }

  canVerifyDocumentType(query: TentativeVerificationQuery): boolean {
    return (query.document as any)?.proof?.type === DAO_EIP712_PROOF;
  }

  async createVerifiableCredential(
    args: ICreateVerifiableCredentialArgs,
    context: IssuerAgentContext,
  ): Promise<VerifiableCredential> {
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
    args: ICreateVerifiablePresentationArgs,
    context: IssuerAgentContext,
  ): Promise<VerifiablePresentation> {
    const holder = String(args.presentation.holder);
    const identifier = await context.agent.didManagerGet({ did: holder });
    const key = keyFor(identifier, args.keyRef);
    if (addressFromEthrDid(holder) !== signerAddress(key)) {
      throw new Error(`La chiave Veramo non controlla il DID holder ${holder}`);
    }

    const credentials = args.presentation.verifiableCredential ?? [];
    if (credentials.length !== 1 || typeof credentials[0] === "string") {
      throw new Error("La presentazione DAO deve contenere una sola VC JSON");
    }
    const issuanceDate = String(args.presentation.issuanceDate ?? new Date().toISOString());
    const challenge = args.challenge ?? "";
    const message = {
      holder,
      verifiableCredential: JSON.stringify(credentials[0]),
      challenge,
    };
    const proofValue = await context.agent.keyManagerSign({
      keyRef: key.kid,
      algorithm: "eth_signTypedData",
      data: JSON.stringify({
        domain: PRESENTATION_EIP712_DOMAIN,
        types: PRESENTATION_EIP712_TYPES,
        primaryType: "VerifiablePresentation",
        message,
      }),
    });

    return {
      "@context": [...CREDENTIAL_CONTEXT],
      type: ["VerifiablePresentation", "SkillCredentialPresentation"],
      holder,
      issuanceDate,
      verifiableCredential: credentials,
      proof: {
        type: DAO_EIP712_PROOF,
        created: issuanceDate,
        proofPurpose: "authentication",
        verificationMethod: key.kid,
        challenge,
        proofValue,
        eip712: {
          domain: PRESENTATION_EIP712_DOMAIN,
          types: PRESENTATION_EIP712_TYPES,
          primaryType: "VerifiablePresentation",
        },
      },
    } as VerifiablePresentation;
  }

  async verifyCredential(
    args: IVerifyCredentialArgs,
    _context: VerifierAgentContext,
  ): Promise<IVerifyResult> {
    try {
      const credential: any = args.credential;
      const recovered = ethers.verifyTypedData(EIP712_DOMAIN, VC_TYPES, {
        issuer: { id: issuerDid(credential) },
        issuanceDate: credential.issuanceDate,
        credentialSubject: credential.credentialSubject,
      }, credential.proof.proofValue);
      return { verified: recovered === addressFromEthrDid(issuerDid(credential)) };
    } catch (error) {
      return {
        verified: false,
        error: { errorCode: "invalid_signature", message: String(error) },
      };
    }
  }

  async verifyPresentation(
    args: IVerifyPresentationArgs,
    _context: VerifierAgentContext,
  ): Promise<IVerifyResult> {
    try {
      const presentation: any = args.presentation;
      const credential = presentation.verifiableCredential?.[0];
      if (!credential || credential.credentialSubject?.id !== presentation.holder) {
        throw new Error("Il subject della VC non coincide con l'holder della VP");
      }
      if (args.challenge && args.challenge !== presentation.proof.challenge) {
        throw new Error("La challenge della VP non coincide con quella richiesta");
      }
      const recovered = ethers.verifyTypedData(PRESENTATION_EIP712_DOMAIN, PRESENTATION_EIP712_TYPES, {
        holder: presentation.holder,
        verifiableCredential: JSON.stringify(credential),
        challenge: presentation.proof.challenge ?? "",
      }, presentation.proof.proofValue);
      const vcResult = await this.verifyCredential({ credential } as IVerifyCredentialArgs, _context);
      return {
        verified: vcResult.verified && recovered === addressFromEthrDid(presentation.holder),
      };
    } catch (error) {
      return {
        verified: false,
        error: { errorCode: "invalid_signature", message: String(error) },
      };
    }
  }
}
