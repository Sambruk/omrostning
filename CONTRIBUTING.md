# Bidra till Omröstning

Tack för att du vill bidra! Det här projektet underhålls av [Sambruk](https://sambruk.se).
Här är riktlinjerna för att komma igång och få in ändringar smidigt.

## Komma igång

```bash
git clone https://github.com/Sambruk/omrostning.git
cd omrostning
cp .env.example .env      # fyll i egna värden
docker compose up -d
```

Frontend (HTML/CSS/JS) är volym-mountad och uppdateras direkt. Backend startar om för att
hämta kodändringar:

```bash
docker compose restart hackaton-ideas-app
```

## Rapportera buggar och föreslå funktioner

- Skapa ett **issue** och beskriv problemet eller idén tydligt.
- För buggar: ta med steg för att återskapa, förväntat vs faktiskt beteende, och miljö
  (webbläsare, OS).
- Säkerhetsproblem ska **inte** rapporteras som publika issues — kontakta Sambruk direkt.

## Skicka in ändringar (Pull Requests)

1. Forka repot eller skapa en gren från `main` (`git checkout -b min-andring`).
2. Gör fokuserade ändringar — en sak per PR.
3. Testa lokalt att appen startar och att berörda flöden fungerar (rösta, admin, resultat).
4. Skriv en tydlig commit-titel och beskrivning.
5. Öppna en PR mot `main` och beskriv vad och varför.

## Kodstil

- **Inga ramverk** i frontend — vanilla HTML, CSS och JavaScript. Håll dig till befintliga mönster.
- Backend är Node.js + Express + PostgreSQL. Håll endpoints små och konsekventa med befintlig kod.
- Matcha omgivande kod: namngivning, indentering, kommentarstäthet.
- Använd relativa URL:er i frontend så appen fungerar bakom valfritt reverse-proxy-prefix.

## Säkerhet och hemligheter

- **Committa aldrig `.env`** eller andra hemligheter (DB-lösenord, tokens, PAT). De är redan
  `.gitignore`:ade — håll det så.
- Nya konfigvärden läggs till i `.env.example` (utan riktiga värden) och dokumenteras i `README.md`.

## Licens

Genom att bidra godkänner du att dina bidrag licensieras under projektets licens,
**Apache License 2.0** (se [LICENSE](LICENSE)).
