Progetto 2: Gestione Verifiable Credential con Veramo – Mattia Prestifilippo
Questo progetto implementa un sistema di Self-Sovereign Identity basato sul framework Veramo.
Il sistema certifica il livello di competenza accademica di un individuo tramite una Verifiable Credential, rilasciata da un ente certificatore (Issuer).
Il sistema permette al possessore della VC (Holder) di condividere all’ente verificatore solo le parti della VC necessarie per la verifica, in questo caso le competenze, senza condividere dati sensibili. La validità della credenziale viene verificata dall’ente verificatore Verifier.

Attori del Sistema
Nel sistema sono presenti tre attori principali, che costituiscono la classica architettura SSI:
Issuer: Emettitore delle credenziali, che ha il compito di generare le Verifiable Credentials che attestano il titolo accademico degli individuo, firmandole crittograficamente. In questo esempio si tratta di un ente universitario.
Holder: Titolare delle credenziali, che detiene le VC all'interno del proprio wallet e sceglie liberamente a chi mostrarle e quale informazioni rivelare.
Verifier: Verificatore che richiede un attestato di competenza ad un individuo, e verifica che il certificato sia autentico e provenga da un'università approvata.

Modello Dati e Livelli di Competenza
Il sistema definisce 5 livelli accademici.
1. SimpleStudent: Studente semplice.
2. BachelorDegree: Laurea Triennale.
3. MasterDegree: Laurea Magistrale.
4. PhD: Dottorato di Ricerca.
5. Professor: Professore Universitario.
Una VC contiene il did dell’issuer, il did dell’holder, il suo nome, il livello di competenza accademica, il nome completo del livello e il nome dell’università dove ha ottenuto tale livello. Solo il livello di competenza accademica viene condiviso al Verifier, tramite Selective Disclousure.
 
Credentials.ts
File che contiene tutte le constanti relative all’issuer e agli holder, usate negli script per creare DID e VC, e per scegliere i campi delle VC su cui effettuare la Selective Disclousure.

Script 1: Creazione delle Identità Decentralizzate (DID)
Script in cui vengono creati i DID per tutti i partecipanti del sistema SSI.
Abbiamo una funzione getOrCreateDID() che crea un DID se non esiste, e in caso contrario lo recupera dal database.
Lo script crea usando getOrCreateDID(), i DID di 12 partecipanti in totale: 1 Issuer (l'Università), 10 Holder e 1 Verifier.

Script 2 — Emissione delle Verifiable Credentials (VC)
Script in cui l'Università funge da issuer e genera una VC per ognuno dei 10 holder.
Lo script recupera l'identità DID dell'issuer dal database. Recupera per ogni holder l’identità DID dal db. 
Poi prepara i dati “claims” da inserire nella VC. La VC viene poi creata (usando agent.createVerifiableCredential()) e firmata con EIP-712.
La VC viene salvata in un file json e nel DataStore di Veramo.

Script 3 — Selective Disclosure 
Script che dimostra la "Selective Disclosure" tra un Holder e il Verifier.
Il Verifier invia una richiesta in cui chiede esplicitamente una VC da cui vuole estrarre solo il degreeLevel.
L'Holder accetta e genera una Verifiable Presentation in cui inserisce
la sua VC. Il Verifier convalida la VP ed estrae solo l'informazione che gli serve.
Tramite la funzione agent.createSelectiveDisclosureRequest() il Verifier firma una richiesta in JWT in cui specifica il tipo di VC richiesta e i campi necessari, su cui viene effettuata la Selective DIsclousure.
L'holder legge la sua credenziale salvata in precedenza, genera una VP in cui inserisce la sua VC, e la firma con EIP-712 a dimostrazione di esserne il proprietario.
Il Verifier riceve la VP e ne verifica le firme e la validità crittografica, tramite la funzione agent.verifyPresentation().
Il verifier estra la VC dalla VP tramite la funzione vp.verifiableCredential, e effettua la Selective Disclosure, estraendo solo il livello necessario.

Script 4 — Verifica delle Verifiable Credentials
Script in cui il Verifier legge tutte le Verifiable Credentials che sono state emesse dall'Università e ne valuta la validità. Ai fini del funzionamento è sufficiente lo script 3, ma viene usato a scopo didattico per studiare la funzione agent.verifyCredential() di Veramo, autenticando la VC singolarmente. Nello script 3 viene autenticata a cascata dalla verifica della VP.
Il Verifier legge il file JSON che rappresenta la Credenziale, 
Usando la funzione agent.verifyCredential() Veramo utilizza un resolver locale per ottenere la chiave pubblica dell'Issuer. Estrae i dati tipizzati previsti dall'EIP-712 e verifica l'integrità della firma in locale.

Script 5 – Full Flow
Script che esegue All-in-One tutti gli step compresi negli script precedenti.

Selective Disclosure
L’unico campo rivelato dei dati claims è il degree level. I campi name, degreeName e University non vengono rivelati.

## Installazione

```bash
npm install
```

## Configurazione

```bash
cp .env.example .env
# Compila INFURA_PROJECT_ID e KMS_SECRET_KEY
```

## Esecuzione

### Flusso passo-passo

Esegui gli script **in ordine**:

```bash
# 1. Crea le 12 identità DID (did:ethr:sepolia)
npm run create-dids

# 2. L'università emette 10 VC con firma EIP-712
npm run issue-credential

# 3. ⭐ Selective Disclosure — gli holder rivelano SOLO degreeLevel
npm run selective-disclosure

# 4. Verifica crittografica di tutte le VC
npm run verify-credential
```

### Flusso completo (un solo comando)

```bash
npm run full-flow
```
