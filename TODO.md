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
- [ ] **E-postleverans**: lokal postfix avvisar externa mottagare (554). Måste kopplas till
      Postal (smtp.sambruk.se) eller annan autentiserad relä för att magic-mejl ska nå ut.

## Möjliga nästa steg (ej gjorda – be om dem vid behov)
- [ ] Flera samtidiga frågor / kategorier under hackatonet
- [ ] Cache-Control: no-cache på JS/CSS (slippa hård-omladdning vid uppdatering)
- [ ] "Kan inte välja"-statistik i admin-dashboarden
- [ ] Skydd mot upprepad röstning utöver anonym voter-id (t.ex. rate limit)
