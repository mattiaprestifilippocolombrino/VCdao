// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/*
Libreria Solidity utile a verificare on-chain una VC firmata off-chain con EIP-712.
Prende i dati della credenziale, ricostruisce esattamente lo stesso hash digest che era stato firmato off-chain,
e poi usa la firma per recuperare la chiave pubblica di chi lo ha firmato.
Il contratto chiamante confronta poi questo address con il trusted issuer. Se coincidono, la VC è valida.
*/

// Utility OpenZeppelin per recuperare l'address firmatario partendo dalla firma e dal digest, via ECDSA.
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

library VPVerifier {
    /*
Costruiamo il typeHash, ovver l'hash della struttura dei campi che compongono la VC. Hashiamo la struttura del 
credentialSubject, con al suo interno i campi id, university, faculty, degreeTitle, grade. I nomi e 
l'ordine dei campi DEVONO essere identici a quelli usati off-chain durante l'emissione della VC.
*/
    bytes32 internal constant ISSUER_TYPEHASH = keccak256("Issuer(string id)");

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

    // Ricostruiamo il typeHash della struct principale VerifiableCredential,
    // contenente issuer, issuanceDate e credentialSubject in modo annidato, come richiede EIP-712.

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

    //Creazione struct per contenere i dati della VC.
    // Identita dell'issuer (espresso come DID).
    struct Issuer {
        string id;
    }

    // Struct contenente i dati certificati relativi all'holder, CredentialSubject.
    struct CredentialSubject {
        string id; // DID holder
        string university; // Università
        string faculty; // facolta / corso
        string degreeTitle; // titolo: BachelorDegree | MasterDegree | PhD | Professor
        string grade; // voto finale
    }

    // Struct contenente i dati della VC informativi, da certificare
    struct VerifiableCredential {
        Issuer issuer; // DID issuer
        string issuanceDate; // Data di emissione
        CredentialSubject credentialSubject; // payload dati utente
    }

    //Funzioni di hashing EIP-712. Le stringhe vanno sempre pre-hashate con `keccak256(bytes(...))`.
    // Hash EIP-712 della struct `Issuer`. Hasha il typeHash e l'id dell'issuer.
    function hashIssuer(Issuer memory issuer) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(ISSUER_TYPEHASH, keccak256(bytes(issuer.id))));
    }

    // Hash EIP-712 della struct `CredentialSubject`. Viene hashato il typeHash e tutti i valori assunti dai campi.
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

    // Hash EIP-712 della credenziale completa. Per campi struct annidati
    // usa i rispettivi hash (`hashIssuer`, `hashCredentialSubject`), chiamando la funzione completa.
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

    /*
        Recover Signer. Ricrea digest EIP-712 usando le funzioni precedentemente implementate. 
        Viene ricreato il digest EIP-712 concatenando il prefisso standard `0x1901`, il domainSeparator e il digest.
        Il digest finale deve combaciare bit-a-bit con quello usato dal firmatario off-chain.
        A partire dal digest e dalla firma, viene recuperato l'address relativo alla chiave pubblica che ha prodotto la firma.
        Il chiamante confronta poi questo address con il trusted issuer. Se coincidono, la VC è valida.
    */
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
