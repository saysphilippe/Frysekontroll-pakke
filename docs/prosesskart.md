# Prosesskart

Oppdatert 5.11.2026. Kartene er skrevet i Mermaid og vises direkte på GitHub.

## Fra bilde til ferdig etikett («Frys ned»)
```mermaid
flowchart TD
  A[Åpne Frys ned på mobilen] --> B{Kjenner nettleseren en skriver?}
  B -- ja --> C[Kobler til av seg selv]
  B -- nei --> D[Trykk «Koble til skriver»]
  D -->|finner ikke skriveren| E["«Vis alle enheter (feilsøking)»"]
  E --> C
  D --> C
  C --> F[Appen leser rullen: kjent rull, skriverens svar eller husket størrelse]
  F --> G[Ta bilde av varen]
  G --> H[Bildet tolkes til navn, beskrivelse og søkeord]
  H --> I[Rett opp, velg antall pakker og plassering]
  I --> J{Lagre og skriv ut?}
  J -- uten utskrift --> K[Varen er lagret]
  J -- med utskrift --> L[Varen lagres, én etikett per pakke skrives ut]
  L --> K
```

## Etiketter i omganger (varesiden)
```mermaid
flowchart TD
  A[Åpne varen] --> B[Kortet «Etiketter»: Skrevet ut = N, om gangen = 10]
  B --> C[Skriv ut 10, fra nr. N+1]
  C --> D[Skjermen holdes våken, telleren øker for hver etikett]
  D --> E{Gikk alt bra?}
  E -- ja --> F[Sjekk hvor mange som kom ut]
  E -- nei, stoppet --> F
  F --> G[Rett tallet i «Skrevet ut» om det ikke stemmer]
  G --> H{Alle etiketter skrevet ut?}
  H -- nei --> C
  H -- ja --> I[Ferdig]
```
«Print testetikett» i skriverkortet skriver én etikett uten å røre telleren, for å sjekke skriver og størrelse.

## Ta ut en pakke
```mermaid
flowchart TD
  A[Skann QR-koden på pakken] --> B{Innlogget?}
  B -- nei --> C[Logg inn]
  C --> D
  B -- ja --> D{Samme enhet som la inn varen?}
  D -- nei --> E[Skriv passordet på nytt]
  E --> F
  D -- ja --> F[Trykk «Ta ut denne pakken»]
  F --> G{Allerede tatt ut?}
  G -- ja --> H[Beskjed om det, ingen ny nedtelling]
  G -- nei --> I[Antallet telles ned, historikken oppdateres]
  I --> J[«Legg tilbake» angrer]
```

## Endre og publisere (utvikling)
```mermaid
flowchart LR
  A[Endre kode] --> B[npm test]
  B --> C[Commit og push til main]
  C --> D[CI kjører testene]
  D --> E[npm run deploy for hånd]
  E --> F[Din Worker på workers.dev]
```
CI publiserer ikke; deploy gjøres for hånd. På en ny maskin må `npm install` kjøres først.
