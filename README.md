# Omröstning

En modern, lättviktig **pairwise wiki survey** — inspirerad av [All Our Ideas](https://allourideas.org/).
Deltagarna ser två alternativ i taget och väljer det de tycker är viktigast (A vs B), kan lägga till
egna förslag, och resultatet rankas i realtid. Byggd av [Sambruk](https://sambruk.se) för att
prioritera t.ex. hackaton-utmaningar, men fungerar för vilken prioriteringsfråga som helst.

## Så fungerar det

- **En fråga**, många svarsalternativ.
- Varje alternativ får en **Bayesiansk poäng 0–100** = den uppskattade sannolikheten att det slår ett
  slumpmässigt valt annat alternativ. Nya alternativ börjar på 50 och konvergerar mot sitt sanna
  värde i takt med att röster samlas in.
- **Aktivt parval** prioriterar alternativ som visats få gånger, så täckningen blir jämn och nya
  förslag snabbt får rättvisa matcher.

## Funktioner

- 📱 Modernt, mobilanpassat röst-UI med tangentbordsstöd (← / →), ljust/mörkt läge.
- ✍️ Deltagare kan skicka in egna förslag (**förmodereras** av admin innan de blir röstbara).
- 📊 Live-resultat med rankning och poäng.
- ⚙️ Admingränssnitt: skapa/redigera frågor, modereringskö, redigera alternativ (flerradigt),
  dashboard, **nollställ röster** (för testkörning), CSV/JSON-export.
- 📷 QR-kod och utskrivbar dela-sida som pekar på omröstningen.
- 🛡️ Anti-abuse: självhostad **SVG-CAPTCHA** före röstning, **rate-limit per IP**, och
  **en röst per par och deltagare**.

## Teknik

- Backend: Node.js + Express + PostgreSQL
- Frontend: vanilla HTML/CSS/JS (inga ramverk)
- Körs som en fristående `docker-compose`-stack

## Köra lokalt

```bash
cp .env.example .env      # fyll i egna värden
docker compose up -d
```

Appen serveras på den port som mappas i `docker-compose.yml` (internt 3000). Sätt upp en
reverse proxy framför vid behov. Publika sidor: `/` (rösta), `/results`, `/share`. Admin: `/admin`.

### Miljövariabler

| Variabel | Beskrivning |
| --- | --- |
| `DB_PASSWORD` | Postgres-lösenord |
| `TOKEN_SECRET` | HMAC-nyckel för admin- och human-tokens |
| `IDEAS_ADMIN_PASSWORD` | Lösenord till `/admin` |
| `RATE_LIMIT_PER_MIN` | Max röster per IP och minut (default 40) |

## API (urval)

| Metod & rutt | Beskrivning |
| --- | --- |
| `GET /api/questions` | Aktiva frågor |
| `GET /api/questions/:id/pair?voter=…` | Nästa par att rösta på (exkluderar redan sedda) |
| `POST /api/questions/:id/vote` | Rösta (kräver CAPTCHA-token, rate-limitad) |
| `POST /api/questions/:id/ideas` | Skicka in förslag (→ moderering) |
| `GET /api/questions/:id/results` | Rankade resultat |
| `GET /api/captcha` · `POST /api/captcha/verify` | CAPTCHA |
| `POST /api/admin/login` | Admin-inloggning |
| `POST /api/admin/questions/:id/reset` | Nollställ röster |

## Licens

Licensierad under **Apache License 2.0** — se [LICENSE](LICENSE).
