// ethers costruisce address Ethereum e verifica firme EIP-712.
import { ethers } from "ethers";
// Tipi forniti dal nucleo Veramo per provider, agent e risultati di verifica.
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
// Contratto che ogni provider di credenziali Veramo deve implementare.
import type {
  ICredentialProvider,
  ProofFormatQuery,
  TentativeVerificationQuery,
} from "@veramo/credential-w3c" with { "resolution-mode": "import" };
// Schema condiviso con lo script di emissione e con la verifica Solidity.
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
  // Il modello W3C permette issuer="did:..." oppure issuer={ id: "did:..." }.
  return typeof credential.issuer === "string" ? credential.issuer : credential.issuer?.id;
}

/**
 * Seleziona la chiave richiesta dal chiamante oppure la prima Secp256k1.
 * Le firme Ethereum del progetto richiedono una chiave sulla curva secp256k1.
 */
function keyFor(identifier: any, keyRef?: string): IKey {
  // Se keyRef è presente cerchiamo esattamente quella chiave.
  const key = keyRef
    ? identifier.keys.find((candidate: IKey) => candidate.kid === keyRef)
    // Senza keyRef scegliamo una chiave compatibile con Ethereum.
    : identifier.keys.find((candidate: IKey) => candidate.type === "Secp256k1");
  // Firmare senza una chiave corretta sarebbe impossibile e ambiguo.
  if (!key) throw new Error(`Nessuna chiave Secp256k1 disponibile per ${identifier.did}`);
  return key;
}

/** Converte la chiave pubblica Veramo nel corrispondente address Ethereum. */
function signerAddress(key: IKey): string {
  // publicKeyHex è salvata senza 0x; computeAddress richiede una hex string.
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
    // Array vuoto significa: questo provider non sa usare quella chiave.
    return key.type === "Secp256k1" ? [DAO_EIP712_PROOF] : [];
  }

  /** Permette al CredentialPlugin di scegliere questo provider per EIP-712. */
  canIssueProofFormat(query: ProofFormatQuery): boolean {
    // true fa scegliere questa classe al CredentialPlugin.
    return query.proofFormat === DAO_EIP712_PROOF;
  }

  /**
   * Dichiara verificabili soltanto documenti VC con il proof type atteso.
   * Una VP non viene quindi instradata alla verifica delle credenziali.
   */
  canVerifyDocumentType(query: TentativeVerificationQuery): boolean {
    // query.document può essere una VC o una VP: lo leggiamo in modo flessibile.
    const document = query.document as any;
    // Servono sia il proof type corretto sia il tipo W3C VerifiableCredential.
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
    // La data può essere fornita dal chiamante; in sua assenza viene generata ora.
    const issuanceDate = String(args.credential.issuanceDate ?? new Date().toISOString());
    // Estraiamo il DID dichiarato nel documento da firmare.
    const did = issuerDid(args.credential);

    // Recuperiamo l'identità gestita da Veramo e la chiave indicata da keyRef.
    const identifier = await context.agent.didManagerGet({ did });
    const key = keyFor(identifier, args.keyRef);

    // Prima di firmare controlliamo che la chiave selezionata controlli davvero
    // l'address incorporato nel DID issuer.
    if (addressFromEthrDid(did) !== signerAddress(key)) {
      throw new Error(`La chiave Veramo non controlla il DID issuer ${did}`);
    }

    // Questi sono gli unici campi firmati. La struttura e l'ordine devono
    // restare identici a VC_TYPES e ai type-hash usati dal contratto Solidity.


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
    // ICredentialProvider richiede questo metodo, ma CompetenceDAO usa solo VC.
    // Fallire esplicitamente evita di reintrodurre per errore un secondo flusso VP.
    throw new Error("Le Verifiable Presentation non sono supportate da CompetenceDAO");
  }

  /** Verifica firma e identità dell'issuer di una VC già esistente. */
  async verifyCredential(
    args: IVerifyCredentialArgs,
    _context: VerifierAgentContext,
  ): Promise<IVerifyResult> {
    try {
      // La VC arriva dall'API generica Veramo e viene letta come documento JSON.
      const credential: any = args.credential;

      // verifyTypedData ricalcola il digest EIP-712 e recupera dalla firma
      // l'address che l'ha prodotta. Non è necessario accedere alla private key.
      const recovered = ethers.verifyTypedData(EIP712_DOMAIN, VC_TYPES, {
        // Gli stessi campi e lo stesso ordine usati durante la firma.
        issuer: { id: issuerDid(credential) },
        issuanceDate: credential.issuanceDate,
        credentialSubject: credential.credentialSubject,
      }, credential.proof.proofValue);
      // La VC è valida solo se il firmatario coincide con il DID issuer dichiarato.
      return { verified: recovered === addressFromEthrDid(issuerDid(credential)) };
    } catch (error) {
      // Input malformati e firme non valide vengono restituiti come esito di
      // verifica negativo, senza interrompere l'intero agent Veramo.
      return {
        // Codice stabile utile a chi chiama verifyCredential.
        verified: false,
        // String(error) conserva un messaggio leggibile anche per errori non Error.
        error: { errorCode: "invalid_signature", message: String(error) },
      };
    }
  }

  async verifyPresentation(
    _args: IVerifyPresentationArgs,
    _context: VerifierAgentContext,
  ): Promise<never> {
    // Metodo presente solo per rispettare l'interfaccia del plugin Veramo.
    throw new Error("Le Verifiable Presentation non sono supportate da CompetenceDAO");
  }
}
