/*
SCRIPT che emette Verifiable Credential (VC) firmate EIP-712, riusabili 
sia off-chain (tool VC) sia on-chain (smart contract di verifica).

FLUSSO: Carica chiavi e configurazione da file env.
Costruisce il dominio EIP-712 condiviso. Genera una VC per ognuno dei 14 holder.
Firma la VC con il wallet issuer Salva i JSON relativi alle VC, in una cartella condivisa con la DAO.
*/

// Import che carica automaticamente le variabili definite nel file .env dentro la variabile d'ambiente process.env.
import "dotenv/config"


/* Libreria Ethereum usata per validare private key e address, creare wallet, derivare wallet da mnemonic e 
firmare typed data EIP-712.
*/
import { ethers } from "ethers"
// Modulo per leggere/scrivere file e creare directory.
import * as fs from "fs"
// Modulo per costruire path portabili tra Linux/macOS/Windows.
import * as path from "path"

// Costanti e funzioni implementate in types/credentials.ts, utilizzate per definire il modello VC.
import {
  CREDENTIAL_CONTEXT, // @context standard della VC
  CREDENTIAL_TYPE, // Tipi VC (VerifiableCredential + UniversityDegreeCredential).
  VC_TYPES, // Definizione dei campi usati per produrre la firma EIP-712.
  CREDENTIALS_DIR, // Cartella locale (lato veramo) dove salvare le VC.
  DAO_SHARED_CREDENTIALS_DIR, // Cartella condivisa lato DAO dove salvare le VC.
  HOLDERS, //elenco degli holder per cui emettere le VC
  UNIVERSITY_INFO, // Metadati universita da inserire nel payload VC.
  toDid, // converte address Ethereum in DID
  toIsoSecondPrecision, //normalizza le date in formato ISO senza millisecondi
} from "../types/credentials"

//Funzioni di utilita

//Questa funzione legge una variabile di ambiente obbligatoria. Se non esiste, o è vuota, lancia errore subito.
//Recupera il valore da process.env. Controlla che non sia vuoto o composto da soli spazi. Restituisce il valore pulito senza spazi iniziali/finali.
function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    throw new Error(`Variabile ${name} mancante`)
  }
  return value.trim()
}

/*
Funzione che prepara una cartella di output. Crea la directory se non esiste e 
cancella tutti i vecchi file .json che potrebbero essere rimasti da esecuzioni precedenti.
*/
function prepareDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
  for (const file of fs.readdirSync(dirPath)) {
    if (file.endsWith(".json")) fs.unlinkSync(path.join(dirPath, file))
  }
}


/*
Serve a generare un nome file ordinato. Esempio: 01_master-1.json, 02_master-2.json.
padStart(2, "0") aggiunge lo zero davanti ai numeri piccoli, così i file restano ordinati bene anche alfabeticamente.
*/
function credentialFileName(index: number, alias: string): string {
  return `${String(index + 1).padStart(2, "0")}_${alias}.json`
}


// Funzione principale
export async function issueDaoCompatibleCredentials(): Promise<void> {

  console.log("--- Emissione VC compatibili DAO (modello unico VC) ---")

  // 1) Caricamento configurazione

  // Carichiamo dal file .env la private key dell'issuer che firmera tutte le VC.
  const issuerPrivateKey = requireEnv("DAO_ISSUER_PRIVATE_KEY")

  // Controlliamo che la private key sia una hex string lunga esattamente 32 byte.
  if (!ethers.isHexString(issuerPrivateKey, 32)) {
    throw new Error("DAO_ISSUER_PRIVATE_KEY non valido: atteso private key 32-byte hex")
  }

  // Mnemonic usata per rigenerare i wallet degli holder in modo deterministico.
  const hardhatMnemonic = requireEnv("DAO_HARDHAT_MNEMONIC")

  // Percorso al file contenente gli indirizzi deployati dei contratti DAO. Sono presenti gli indirizzi del token, del timelock, del governor, del registry e dell'issuer.
  const deployedPath = path.join(__dirname, "../../dao/deployedAddresses.json")

  // Se il file deployedAddresses.json non esiste non conosciamo il contesto di deploy e interrompiamo con messaggio chiaro.
  if (!fs.existsSync(deployedPath)) {
    throw new Error(`File ${deployedPath} non trovato. Esegui prima dao/scripts/01_deploy.ts`)
  }

  // Carichiamo il JSON deployedAddresses.json
  const deployed = JSON.parse(fs.readFileSync(deployedPath, "utf-8"))

  // Estraiamo l'address del token deployato.
  const tokenAddressRaw = deployed?.token

  // Verifichiamo che l'indirizzo del token sia valido.
  if (!tokenAddressRaw || !ethers.isAddress(tokenAddressRaw)) {
    throw new Error("deployedAddresses.json non contiene un token address valido")
  }

  // Normalizziamo l'indirizzo del token in formato checksum (EIP-55).
  const tokenAddress = ethers.getAddress(tokenAddressRaw)
  // BUG: INDIRIZZO DEL TOKEN USATO IN UNA VERSIONE PRECEDENTE, ORA MAI USATO. DA RIMUOVERE.

  // Istanziamo il wallet issuer usando la private key validata dell'issuer.
  const issuerWallet = new ethers.Wallet(issuerPrivateKey)

  // Convertiamo l'address dell'issuer in DID compatibile con il formato usato.
  const issuerDid = toDid(issuerWallet.address)


  // Se nel deploy è registrato un issuer fidato, deve coincidere con la chiave usata per firmare le VC.
  if (deployed.issuer && ethers.isAddress(deployed.issuer)) {
    const deployedIssuer = ethers.getAddress(deployed.issuer)
    if (deployedIssuer !== issuerWallet.address) {
      throw new Error(
        `Issuer mismatch: deployed=${deployedIssuer}, privateKey=${issuerWallet.address}`
      )
    }
  }

  // Costruiamo il percorso della cartella locale e della cartella condivisa con la DAO dove salvare le VC, e le inizializza in stato pulito.
  const localCredentialsDir = path.join(__dirname, "..", CREDENTIALS_DIR)
  const daoSharedDir = path.join(__dirname, "..", "..", DAO_SHARED_CREDENTIALS_DIR)
  prepareDir(localCredentialsDir)
  prepareDir(daoSharedDir)

  /*
  Creiamo il dominio EIP-712, che serve a contestualizzare la firma typed data.
  In questo caso abbiamo scelto un dominio universale, cioè non legato a una chain o a uno specifico smart contract.
  In questo modo la firma può essere verificata ovunque.
  */
  const domain = {
    name: "Universal VC Protocol", // Nome del dominio di firma.
    version: "1", // Versione del dominio.
  }

  // 3) Emissione credenziali

  // Itera tutti gli holder definiti nel file di configurazione. Per ogni holder viene generato un wallet dalla mnemonic.
  //In base alla stringa mnemonic viene generata una master key e da questa vengono derivati i wallet degli holder, in modo deterministico.
  //In base all'indice dell'holder vienederivato il wallet dell'holder.
  for (const [i, holder] of HOLDERS.entries()) {
    const holderWallet = ethers.HDNodeWallet.fromPhrase(
      hardhatMnemonic,
      undefined,
      `m/44'/60'/0'/0/${holder.signerIndex}`
    )

    // Converte l'address holder in DID.
    const holderDid = toDid(holderWallet.address)

    // Viene generato il timestamp di emissione a precisione secondi.
    const issuanceDate = toIsoSecondPrecision(new Date())

    // Viene costruito il payload contenente i dati, derivati precedentemente, o importati da credential.ts.
    // Questo payload contien i dati che devono essere firmati.
    const vcForSigning = {
      issuer: { id: issuerDid }, // DID dell'issuer
      issuanceDate, // Timestamp di emissione.
      credentialSubject: {
        id: holderDid, // DID del holder
        university: UNIVERSITY_INFO.name, // Universita emittente.
        faculty: holder.faculty, // Facolta.
        degreeTitle: holder.degreeTitle, // Titolo di studio.
        grade: holder.grade, // Voto finale.
      },
    }

    // Prende i dati della credenziale e li fa firmare crittograficamente al wallet dell’issuer con EIP-712.
    const proofValue = await issuerWallet.signTypedData(domain, VC_TYPES, vcForSigning)
    /*
    IssuerWallet è il soggetto che possiede la chiave privata dell’issuer. 
    Con signTypedData() non firma una semplice stringa libera, ma firma dei dati strutturati secondo lo standard EIP-712.
    Il parametro domain serve a definire il contesto della firma. 
    Il parametro VC_TYPES descrive la forma esatta dei dati da firmare. Dice quali campi da firmare esistono, 
    in che ordine stanno e di che tipo sono. 
    Il parametro vcForSigning, contiene i valori concreti della credenziale. 
    La funzione costruisce internamente un hash digest, hashando prima singolarmente i campi:
    id, university, faculty, degreeTitle e grade, ovvero i campi del credentialSubject.
    Poi vengono hashati: issuer, issuanceDate e credentialSubject.
    Poi viene hashato il dominio e la struttura dei tipi da firmare. Poi questi hash vengono combinati in un unico hash digest.
    Questo hash digest viene poi firmato dal wallet dell’issuer, con la sua chiave privata, usando EIP-712.
    Il risultato finale, ovvero la firma digitale vera e propria, viene salvato in proofValue, in formato esadecimale.
    L’issuer sta dicendo crittograficamente che quei dati sono autentici. Se qualcuno modifica anche solo un campo della credenziale, per esempio il voto o il titolo, la firma non risulterà più valida.
    */



    // Costruzione del JSON VC finale, contenente anche i dati da non firmare e la proof
    const credentialJson = {
      "@context": [...CREDENTIAL_CONTEXT], // JSON-LD context.
      type: [...CREDENTIAL_TYPE], // Tipi VC.
      issuer: vcForSigning.issuer, // Issuer DID.
      issuanceDate: vcForSigning.issuanceDate, // Data emissione.
      credentialSubject: vcForSigning.credentialSubject, // Dati attestati.
      proof: {
        type: "EthereumEip712Signature2021", // Tipo prova conforme stack Ethereum.
        created: issuanceDate, // Timestamp creazione prova.
        proofPurpose: "assertionMethod", // Lo scopo: attestazione.
        verificationMethod: `${issuerDid}#controller`, // Metodo DID usato per verifica.
        proofValue, // Firma reale.
      },
    }

    // Costruzione dei path dove salvare le VC.
    const localPath = path.join(localCredentialsDir, `${holder.alias}.json`)
    const sharedPath = path.join(daoSharedDir, credentialFileName(i, holder.alias))

    // Scrittura dei file JSON.
    fs.writeFileSync(localPath, JSON.stringify(credentialJson, null, 2), "utf-8")
    fs.writeFileSync(sharedPath, JSON.stringify(credentialJson, null, 2), "utf-8")

    // Log di avanzamento batch.
    console.log(`✅ VC ${i + 1}/${HOLDERS.length} -> ${localPath} | ${sharedPath}`)
  }

  // Log finali di riepilogo.
  console.log("\n✅ VC generate con successo.")
  console.log(`Issuer: ${issuerWallet.address}`)
  console.log("Domain EIP-712: Universale (No ChainId, No Contract)")
}

// Entry point invocato quando lo script viene eseguito direttamente da CLI.
async function main() {
  await issueDaoCompatibleCredentials()
}

// Esegue `main()` solo in esecuzione diretta (`node script.ts`).
// Se il file viene importato, non parte automaticamente.
if (require.main === module) {
  main().catch((error) => {
    console.error("Errore in issue-for-dao:", error.message)
    process.exit(1)
  })
}
