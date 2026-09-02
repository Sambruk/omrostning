# Hackaton Ideas — Pairwise Wiki Survey

En modern omtolkning av allourideas.org (pairwise wiki survey) för att ranka
hackaton-utmaningar. Publikt röst-UI + admingränssnitt + Express/Postgres-backend.

## Arkitektur
- Backend: Node/Express + PostgreSQL (mönster från `samverkan`)
- Frontend: vanilla HTML/CSS/JS
- Routing: `https://app.sambruk.se/ideas/` (publik) + `/ideas/admin` (admin)
- Portar: app 14100, postgres 14533 (network_mode: bridge, pratar via 172.17.0.1)
- Förmoderering: nya förslag → pending → admin godkänner innan röstbara
- Admin-lösenord: i `/opt/app/hackaton-ideas/.env` (IDEAS_ADMIN_PASSWORD)

## Klart
- [x] Undersökt allourideas-repot (Rails-monolit + pairwise-api, gammalt) → beslut: bygga om kärnan
- [x] Kartlagt miljö (app.sambruk.se, samverkan-mönster, lediga portar)
- [x] Projektstruktur + secrets + TODO.md
- [x] db/schema.sql (questions, ideas, votes)
- [x] backend: package.json, db.js, scoring.js (Bayesiansk poäng + aktivt parval), auth.js (HMAC-token), server.js
- [x] frontend: index (röst A vs B + tangentbord), results (live-ranking), admin (login/frågor/moderering/dashboard/export)
- [x] frontend: gemensam style.css (ljust/mörkt) + common.js
- [x] docker-compose.yml (standalone) + .env
- [x] nginx: location /ideas/ tillagd i befintlig conf (app.sambruk.se-blocket), reload OK
- [x] Fixat env-krock: ADMIN_PASSWORD → IDEAS_ADMIN_PASSWORD (host-env override)
- [x] Verifierat internt + externt: login, skapa fråga, par, röstning, poäng, results
- [x] Verifierat förmoderering (förslag pending→godkänn), CSV-export
- [x] Seedad ren demo-fråga (id 2) med 6 hackaton-utmaningar, 0 röster

- [x] Sambruk-logga i topbaren på alla sidor (mörkt läge: inverterad)
- [x] QR-kod: backend SVG-endpoint /api/qr.svg + utskrivbar /share-sida + QR-knapp per fråga i admin
- [x] Fixat 404: /ideas/ tillagd även i vibecoder-domänens 443-block (var bara i app.sambruk.se)

- [x] Redigera alternativ i admin (inline, flerradig) — PATCH /api/admin/ideas/:id
- [x] Anti-abuse: självhostad SVG-CAPTCHA-grind (svg-captcha) före röstning
- [x] Anti-abuse: rate-limit per IP (RATE_LIMIT_PER_MIN, default 40/min) → 429
- [x] Anti-abuse: en röst per par per voter (par-exkludering + 409 på dubbelröst), "alla par jämförda"-läge

- [x] Fler-användarplattform: magic-link-konton (passwordless), ägarskap på omröstningar
  - users + login_tokens-tabeller, questions.owner_id (migrering i db.js, körs vid start)
  - auth: /api/auth/request|verify|me, user-token 30d, single-use magic link 30 min
  - /api/user/* (CRUD ägar-scopat), super-admin (/admin) kvar parallellt
  - publika listan visar bara officiella (owner_id IS NULL); användares når via egen länk
  - skapa.html + creator.js: Sambruk-intro (bekräfta innan konto), dashboard, delningslänk/QR
  - nodemailer/mailer.js, SMTP+PUBLIC_URL i compose
- [x] **E-postleverans**: löst — appen skickar via Postal (`sambruk-postal-u917…:25`) med autentisering,
      inte via lokal postfix. Kontrollerat 2026-08-31: SMTP-handskakning OK och skarpt utskick
      2026-08-27 utan `[mailer] send failed`. Kvarstår att bekräfta att mejlen inte hamnar i skräpposten.

## Möjliga nästa steg (ej gjorda – be om dem vid behov)
- [ ] Flera samtidiga frågor / kategorier under hackatonet
- [ ] Cache-Control: no-cache på JS/CSS (slippa hård-omladdning vid uppdatering)
- [ ] "Kan inte välja"-statistik i admin-dashboarden
- [ ] Skydd mot upprepad röstning utöver anonym voter-id (t.ex. rate limit)

## UI/UX-översyn 2026-08-20
- [x] Skala upp hela gränssnittet (bas 18px, clamp-baserade rubriker, större kort/knappar/fält)
- [x] Färgsätt efter Sambruks grafiska profil (grön #3F7A11 / #58A618, kontrast kontrollerad ≥5:1)
- [x] Förenkla röstsidan (en uppmaning i stället för två, kompakt rubrik, hela duellen på en skärm)
- [x] Alternativtexten skalas efter längd (t-s/t-m/t-l/t-xl) — långa förslag spränger inte längre sidan
- [x] Kompakt toppmeny på mobil (en rad i stället för två)
- [x] Lugnare destruktiva knappar i skapar-/adminvyn (quiet-danger)
- [x] Dela upp texten på inloggningssidan: inloggning först, sedan "Vad är Duellen?" och "Vad är Sambruk?"
- [x] Ny sida: Så fungerar Duellen (/sa-funkar-det) + serverrutt i backend/server.js
- [x] Länk till "Så funkar det" i toppmeny, sidfot, startsida och inloggningssida
- [x] Verifierat internt (curl 200 på alla rutter) och externt (https://app.sambruk.se/duellen/sa-funkar-det)
- [x] Visuellt granskat ljust/mörkt läge + mobil (Playwright-skärmdumpar)

## Uppföljning 2026-08-20 (samma dag)
- [x] Resultatbild: "Spara som bild" ritar resultatet på canvas (logga, fråga, datum, staplar, poäng) och laddar ner PNG
- [x] Utskrift: print-CSS för resultatsidan (ljus palett även i mörkt läge, meny/knappar bort, print-only logga, staplar trycks)
- [x] "Startförslag" → "Alternativ" med förklarande hjälptext bredvid etiketten (skapa + admin)
- [x] Samma förklaring i panelen "Lägg till alternativ" + placeholders med alternativ-exempel
- [x] Dämpade "Ta bort"-knappar på alternativ (quiet-danger)
- [x] Verifierat: PNG-export laddas ner utan JS-fel, utskriftsvyn granskad i ljust/mörkt läge
- [x] Hjälptexten om alternativ flyttad till tooltip (?-knapp vid etiketten, visas vid hover/fokus)
- [x] Inloggningssidan omordnad: Sambruk-rutan överst (marknadsföring), sedan Duellen, sist inloggningen
- [x] Supportlänk hjalp@sambruksupport.se — i sidfoten på alla sidor + eget kort på "Så funkar det" (mailto med ämnesrad "Duellen")
- [x] LinkedIn-lanseringstext: marknadsforing/linkedin-lansering.txt (inkl. alt-text och tips)


## Favicon 2026-08-23
- [x] Rita favicon ur Duellen-loggan (kugghjul, vitt på #3F7A11) — 12 tänder, 8 tänder i 16px-lagret
- [x] Skapa assets/favicon.svg, favicon.ico (16/32/48), favicon-16.png, favicon-32.png, apple-touch-icon.png
- [x] Länka ikonerna i alla sex sidor (index, results, admin, share, skapa, sa-funkar-det)
- [x] Rutt /favicon.ico i backend/server.js
- [x] Verifierat internt (curl) och externt (https://app.sambruk.se/duellen/)

## Lösenordsskydd per omröstning 2026-08-31
- [x] db: kolumn `questions.access_password` (hash) + migrering i db.js och schema.sql
- [x] auth.js: scrypt-hash/verify + poll-token (issuePoll/checkPoll)
- [x] server.js: `POST /api/questions/:id/access` (lösenord → 12h-token, egen rate limit 12/min)
- [x] server.js: grind `requirePollAccess` på metadata, par, röst, förslag och resultat
- [x] server.js: sätt/ta bort lösenord vid skapande + inställningar (user + admin), hashen läcker aldrig
- [x] server.js: GET /api/user/questions/:id och /api/admin/questions/:id (inställningsvyn)
- [x] frontend: låsvy på röstsidan och resultatsidan + token i localStorage (`pollToken:<id>`)
- [x] frontend: lösenordsfält i "Ny omröstning" och i Inställningar (skapa + admin) + 🔒-märke i listan
- [x] frontend: skaparen/admin kommer in på sin egen skyddade omröstning utan att skriva lösenordet
- [x] Dokumenterat: FAQ på /sa-funkar-det + README
- [x] Verifierat via API: 401 utan lösenord (metadata/par/röst/resultat), token bunden till EN omröstning,
      byte/borttagning av lösenord, öppna omröstningar opåverkade
- [x] Verifierat i webbläsare (Playwright): låsvy på röstsida + resultatsida, fel/rätt lösenord,
      resultat låst för ny besökare (titeln läcker inte), öppen omröstning opåverkad, inga JS-fel
- [x] Verifierat adminvyns inställningspanel i webbläsaren: sätta, ta bort och byta lösenord
- [x] Verifierat skaparflödet mot API: skapa med lösenord, egen upplåsning utan lösenord,
      annan inloggad användare nekas (401/404)
- [x] Testdata borttagen (frågorna 23 och 24 + testkonton)
- [x] Chromium för Playwright ominstallerat (cachen försvann vid container-recreate) + systembibliotek
- [x] `PUBLIC_URL` i docker-compose.yml ändrad /ideas → /duellen (2026-08-31) så inloggningslänkarna
      i mejlen pekar direkt rätt i stället för via 302-omskrivningen; verifierat i loggen

## Menyetikett 2026-08-31
- [x] Menyvalet "Skapa" heter nu "Skapa/Ändra" på alla sidor (index, results, skapa, sa-funkar-det)
- [x] Följdtexter som pekade dit uppdaterade ("Hantera i Skapa/Ändra →", tomma startsidan)
- [x] Mobilmenyn: snävare luft under 560px så den längre etiketten ryms på samma rad som övriga val
- [x] Verifierat i webbläsare: 1 rad på desktop, menyvalen på en rad på mobil (390px), ingen sidoscroll

## Statistik för super-admin + säkerhetsgenomgång 2026-09-02
- [x] `GET /api/admin/stats` — ENBART aggregerade siffror (inga titlar, e-postadresser eller resultat)
- [x] Statistikkort överst på /admin + veckoserie 12 veckor (nya konton, nya dueller, röster)
- [x] Adminlösenordet kan sättas via `ADMIN` i projektets .env (fallback: IDEAS_ADMIN_PASSWORD).
      Verifierat: ADMIN har företräde, och utan ADMIN funkar det gamla lösenordet
- [x] .env i .gitignore — redan gjort sedan tidigare, inga .env-filer spåras av git
- [x] Valfritt avsändarfält (`questions.creator_label`, max 80 tecken) i skapa- och adminformuläret
      + inställningar; visas för deltagarna på röst- och resultatsidan och i PNG-exporten
- [x] Säkerhetsgenomgång genomförd — se avsnittet nedan

### Säkerhetsgenomgång 2026-09-02 — åtgärdat
- [x] **Stängd omröstning gick att rösta i via API:t** — status kontrollerades inte i /pair och /vote.
      Nu: par returnerar `{closed:true}`, röst ger 403, och röstsidan säger att omröstningen är stängd
- [x] **"Utkast (dold)" var inte dold** — publik metadata gick att läsa. Nu 404 för alla utom ägare/admin
- [x] **Inloggningslänken loggades i klartext** i containerloggen tillsammans med e-postadressen
      (= giltig inloggning i 30 min för den som läser loggen). Nu loggas bara maskerad adress
- [x] Tak införda: rubrik 300 tecken, beskrivning 1000, max 200 alternativ per anrop
- [x] Kontrollerat utan anmärkning: alla admin-/user-rutter kräver token, ägarkontroll på samtliga
      user-rutter, parametriserad SQL överallt, lösenordshashen lämnar aldrig servern, XSS-test med
      skadlig kod i rubrik/avsändare/alternativ renderas som text (ingen kodkörning)

### Kvarstår att besluta
- [ ] Svårgissade dela-länkar: id:n är löpnummer, alla 8 omröstningar går att bläddra fram
      genom att räkna upp `?q=`. Förslag: slumpad slug per omröstning. Väntar på besked

## Svårgissade dela-länkar 2026-09-02
- [x] `questions.slug` — 10 tecken ur alfabetet `abcdefghjkmnpqrstuvwxyz23456789` (utan 0/1/i/l/o),
      unikt partiellt index. 31^10 ≈ 8·10^14 kombinationer
- [x] Migrering fyllde slug på alla 8 befintliga dueller vid start (idempotent, rör aldrig en satt slug)
- [x] `resolveQuestion`-middleware på de sex publika rutterna: tar både slug och gammalt löpnummer
- [x] Delningslänk, QR och alla länkar i skapar-/adminvyn använder slug
- [x] Frontend: QID är nu en sträng (slug eller id) i app.js och results.js
- [x] Verifierat: samma omröstning nås via slug och via id; påhittade slugar/skräp ger 404;
      nya omröstningar får slug automatiskt; lösenordsgrinden gäller båda vägarna och en token
      utfärdad via slug fungerar mot id:t; röst + förslag + resultat via slug; QR kodar slug-URL:en
- [x] Testdata borttagen

### Kvarstår (framtida beslut)
- [ ] Stänga av de numeriska länkarna när inga gamla QR-koder är i omlopp — då blir de åtta
      ursprungliga duellerna också obläddringsbara. Kräver en rad i `resolveQuestion`

## Adminlösenord + incident 2026-09-02
- [x] `ADMIN` aktiverat i projektets .env (container återskapad — `restart` räcker inte för ny miljö)
- [x] Verifierat: nya lösenordet ger 200, gamla IDEAS_ADMIN_PASSWORD ger 401
- [x] **Rensat riktigt lösenord ur `.env.example`** (git-spårad fil i publikt repo). Aldrig committat
      eller pushat — låg bara i arbetskopian. Ersatt med platshållaren `byt-mig`
- [x] Kontrollerat att lösenordet nu bara finns i `.env` och ingen annanstans på disk
- [x] Rate limit på `/api/admin/login`: 8 försök/min/IP, nollställs vid lyckad inloggning
      (saknades helt — obegränsad gissning mot ett 9 tecken långt lösenord)
