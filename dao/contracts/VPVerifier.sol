// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
    Libreria per la verifica on-chain di Verifiable Credentials (VC) tramite EIP-712.

    La DAO usa questa libreria per verificare che una credenziale di competenza
    sia stata firmata da un Issuer fidato (es. l'Università) prima di effettuare
    l'upgrade di competenza di un membro.

    Flusso di verifica:
    1. L'Issuer firma la VC off-chain usando EIP-712 (es. tramite ethers.js / Veramo)
    2. Il membro presenta la VC firmata alla DAO tramite proposta di governance
    3. La DAO ricostruisce l'hash EIP-712 e recupera il firmatario (ECDSA.recover)
    4. Se il firmatario corrisponde all'Issuer fidato → la VC è autentica

    La Selective Disclosure è implementata a livello di struttura dati:
    solo il campo `degreeLevel` viene usato dalla DAO per l'upgrade di competenza.
    I dati personali dell'holder (nome, corso, università) NON vengono mai
    passati on-chain, preservando la privacy.

    Standard di riferimento:
    - EIP-712: https://eips.ethereum.org/EIPS/eip-712
    - W3C VC Data Model: https://www.w3.org/TR/vc-data-model
    - Ispirato a: KrebitDAO/VCTypes.sol
*/

import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library VPVerifier {

    // =========================================================================
    //  Type Hash EIP-712 (costanti pre-calcolate)
    // =========================================================================

    /*
        EIP-712 richiede un "type hash" per ogni struct, calcolato come:
        keccak256("NomeStruct(tipo1 campo1,tipo2 campo2,...)")

        Per struct annidate, la definizione del tipo referenziato viene accodata
        in ordine alfabetico alla stringa del tipo genitore.
    */

    /// @dev keccak256("CredentialSubject(string id,address holderAddress,uint8 degreeLevel,uint256 nbf,uint256 exp)")
    bytes32 internal constant CREDENTIAL_SUBJECT_TYPEHASH =
        keccak256(
            "CredentialSubject("
            "string id,"
            "address holderAddress,"
            "uint8 degreeLevel,"
            "uint256 nbf,"
            "uint256 exp"
            ")"
        );

    /// @dev keccak256("VerifiableCredential(...)CredentialSubject(...)")
    ///      Il tipo CredentialSubject è accodato perché referenziato come campo annidato
    bytes32 internal constant VERIFIABLE_CREDENTIAL_TYPEHASH =
        keccak256(
            "VerifiableCredential("
            "string issuerDid,"
            "address issuerAddress,"
            "CredentialSubject subject,"
            "string issuanceDate,"
            "string expirationDate"
            ")"
            "CredentialSubject("
            "string id,"
            "address holderAddress,"
            "uint8 degreeLevel,"
            "uint256 nbf,"
            "uint256 exp"
            ")"
        );

    // =========================================================================
    //  Strutture dati — W3C Verifiable Credentials (sottoinsieme per SD)
    // =========================================================================

    /// @notice Dati certificati dell'holder. Solo `degreeLevel` viene usato dalla DAO.
    /// @dev Rappresenta il credentialSubject della VC, ridotto ai campi necessari
    ///      per la Selective Disclosure on-chain.
    struct CredentialSubject {
        string id;              // DID dell'holder (es. "did:ethr:sepolia:0x...")
        address holderAddress;  // Indirizzo Ethereum dell'holder
        uint8 degreeLevel;      // Livello certificato: 0=Student, 1=Bachelor, 2=Master, 3=PhD, 4=Professor
        uint256 nbf;            // Not-Before: inizio validità (UNIX timestamp)
        uint256 exp;            // Expiration: fine validità (UNIX timestamp)
    }

    /// @notice Credenziale verifiable firmata dall'Issuer con EIP-712
    /// @dev Corrisponde a una Verifiable Credential W3C semplificata.
    ///      La firma dell'Issuer su questa struttura è la prova crittografica
    ///      che il CredentialSubject è autentico.
    struct VerifiableCredential {
        string issuerDid;           // DID dell'issuer (es. "did:ethr:sepolia:0x...")
        address issuerAddress;      // Indirizzo Ethereum dell'issuer
        CredentialSubject subject;  // Dati certificati dell'holder
        string issuanceDate;        // Data di emissione (ISO 8601)
        string expirationDate;      // Data di scadenza (ISO 8601)
    }

    // =========================================================================
    //  Funzioni di hashing EIP-712
    // =========================================================================

    /// @notice Calcola lo struct hash EIP-712 del CredentialSubject
    /// @dev I campi `string` vengono hashati con keccak256 prima dell'encoding,
    ///      come richiesto dalla specifica EIP-712 per i tipi dinamici.
    function hashCredentialSubject(
        CredentialSubject memory cs
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            CREDENTIAL_SUBJECT_TYPEHASH,
            keccak256(bytes(cs.id)),
            cs.holderAddress,
            cs.degreeLevel,
            cs.nbf,
            cs.exp
        ));
    }

    /// @notice Calcola lo struct hash EIP-712 della VerifiableCredential
    /// @dev Il CredentialSubject annidato viene hashato ricorsivamente,
    ///      come richiesto da EIP-712 per le struct annidate.
    function hashVerifiableCredential(
        VerifiableCredential memory vc
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            VERIFIABLE_CREDENTIAL_TYPEHASH,
            keccak256(bytes(vc.issuerDid)),
            vc.issuerAddress,
            hashCredentialSubject(vc.subject),
            keccak256(bytes(vc.issuanceDate)),
            keccak256(bytes(vc.expirationDate))
        ));
    }

    // =========================================================================
    //  Verifica firma
    // =========================================================================

    /// @notice Recupera l'indirizzo Ethereum che ha firmato la VC
    /// @dev Ricostruisce il digest EIP-712 e usa ECDSA.recover per ottenere il signer.
    ///      Il digest è: keccak256("\x19\x01" || domainSeparator || structHash)
    /// @param vc La credenziale di cui verificare la firma
    /// @param signature Firma EIP-712 dell'issuer (65 bytes: r || s || v)
    /// @param domainSeparator Domain separator EIP-712 del contratto verificatore
    /// @return signer L'indirizzo Ethereum che ha prodotto la firma
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

    /// @notice Verifica che la credenziale sia valida temporalmente
    /// @dev Controlla che: nbf ≤ block.timestamp < exp
    /// @return valid true se la credenziale è nel suo periodo di validità
    function isTemporallyValid(
        CredentialSubject memory cs
    ) internal view returns (bool valid) {
        valid = (block.timestamp >= cs.nbf) && (block.timestamp < cs.exp);
    }
}
