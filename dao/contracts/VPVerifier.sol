// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
    Libreria per la verifica on-chain di Verifiable Credentials (VC) tramite EIP-712.

    La DAO usa questa libreria per verificare che una credenziale di competenza
    sia stata firmata da un Issuer fidato (es. l'Università) prima di effettuare
    l'upgrade di competenza di un membro.

    Flusso di verifica:
    1. L'Issuer firma la VC off-chain usando EIP-712 
    2. Il membro presenta la VC firmata alla DAO tramite proposta di governance
    3. La DAO ricostruisce l'hash EIP-712 e recupera il firmatario (ECDSA.recover)
    4. Se il firmatario corrisponde all'Issuer fidato → la VC è autentica

    Questa versione usa una VC minimale: il payload on-chain contiene
    solo i campi strettamente necessari all'upgrade di competenza.

    Standard di riferimento:
    - EIP-712: https://eips.ethereum.org/EIPS/eip-712
    - W3C VC Data Model: https://www.w3.org/TR/vc-data-model
*/

// Importazione della libreria OpenZeppelin per recuperare gli indirizzi dalle firme ECDSA (Elliptic Curve Digital Signature Algorithm)
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

// =========================================================================
// 1. DEFINIZIONE DELLE COSTANTI E DEI TYPEHASH (EIP-712)
// =========================================================================
library VPVerifier {
    // EIP-712 type hashes per la VC minimale del PoC.
    // La signature copre solo i dati semantici richiesti:
    // issuer.id, issuanceDate, credentialSubject.{id,university,faculty,degreeTitle,grade}
    bytes32 internal constant ISSUER_TYPEHASH =
        keccak256("Issuer(string id)");

    bytes32 internal constant CREDENTIAL_SUBJECT_TYPEHASH =
        keccak256(
            "CredentialSubject("
            "string id,"
            "string university,"
            "string faculty,"
            "string degreeTitle,"
            "string grade"
            ")"
        );

    // Le dipendenze annidate sono accodate in ordine alfabetico:
    // CredentialSubject, Issuer.
    bytes32 internal constant VERIFIABLE_CREDENTIAL_TYPEHASH =
        keccak256(
            "VerifiableCredential("
            "Issuer issuer,"
            "string issuanceDate,"
            "CredentialSubject credentialSubject"
            ")"
            "CredentialSubject("
            "string id,"
            "string university,"
            "string faculty,"
            "string degreeTitle,"
            "string grade"
            ")"
            "Issuer("
            "string id"
            ")"
        );

    // =========================================================================
    //  Strutture dati — VC minimale del PoC
    // =========================================================================

    struct Issuer {
        string id;
    }

    /// @notice Dati essenziali certificati dell'holder.
    struct CredentialSubject {
        string id; // DID dell'holder
        string university; // Issuing institution name
        string faculty; // Faculty / program
        string degreeTitle; // BachelorDegree | MasterDegree | PhD | Professor
        string grade; // Final grade
    }

    /// @notice VC minimale firmata dall'issuer con EIP-712.
    struct VerifiableCredential {
        Issuer issuer; // issuer.id DID
        string issuanceDate; // Data di emissione (ISO 8601)
        CredentialSubject credentialSubject; // Dati certificati dell'holder
    }

    // =========================================================================
    //  2. FUNZIONI DI HASHING EIP-712 (Digest Creation)
    // =========================================================================
    // Per verificare una firma EIP-712, lo smart contract deve ricreare lo stesso
    // identico hash (digest) che è stato firmato off-chain. Queste funzioni
    // hasano i singoli componenti della credenziale.

    function hashIssuer(Issuer memory issuer) internal pure returns (bytes32) {
        return keccak256(abi.encode(ISSUER_TYPEHASH, keccak256(bytes(issuer.id))));
    }

    function hashCredentialSubject(
        CredentialSubject memory cs
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    CREDENTIAL_SUBJECT_TYPEHASH,
                    keccak256(bytes(cs.id)),
                    keccak256(bytes(cs.university)),
                    keccak256(bytes(cs.faculty)),
                    keccak256(bytes(cs.degreeTitle)),
                    keccak256(bytes(cs.grade))
                )
            );
    }

    function hashVerifiableCredential(
        VerifiableCredential memory vc
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    VERIFIABLE_CREDENTIAL_TYPEHASH,
                    hashIssuer(vc.issuer),
                    keccak256(bytes(vc.issuanceDate)),
                    hashCredentialSubject(vc.credentialSubject)
                )
            );
    }

    // =========================================================================
    //  3. VERIFICA FIRMA CRITTOGRAFICA (Recupero Address)
    // =========================================================================
    // Questa funzione incapsula tutto: ricrea l'hash completo partendo dai dati forniti
    // e usa ECDSA.recover() per scoprire "chi" ha firmato quell'hash.
    // L'indirizzo recuperato deve poi essere confrontato dal chiamante con l'Issuer fidato.

    function recoverIssuer(
        VerifiableCredential memory vc,
        bytes memory signature,
        bytes32 domainSeparator
    ) internal pure returns (address signer) {
        bytes32 structHash = hashVerifiableCredential(vc);
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", domainSeparator, structHash)
        );
        signer = ECDSA.recover(digest, signature);
    }
}
