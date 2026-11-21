# Planner web app

The student-facing site: choose a major and year, import a transcript, plan future semesters,
and watch major, college, university and breadth requirements check off as classes are added.
Shows enrollment predictions and live seats (including reserved seats) where available.

## Run it

```bash
cd web
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests
```

## Data

The app reads the repo-level `data/` folder (shapes in [`docs/data-contracts.md`](../docs/data-contracts.md)).
Any file that is missing falls back to sample data in `web/stub-data/`, and the UI says so.

Configuration is read in `src/lib/server/env.ts`; every variable is documented in [`.env.example`](.env.example).

| Env var | Purpose | Default |
| --- | --- | --- |
| `APP_URL` | Public base URL, used in email links and accepted as a trusted `Origin` | `http://localhost:3000` |
| `DATABASE_PATH` | SQLite file for accounts, plans, email tokens and seat alerts (use a persistent volume) | `web/.data/planner.db` |
| `CCC_DATA_DIR` | Where the real data lives | `../data` |
| `WATCHER_URL` | Seat watcher HTTP server, for live seats and forwarding alert sign-ups | unset (reads `data/seats/latest.json`; alerts stay in the DB) |
| `WATCHER_API_TOKEN` | Sent as `Authorization: Bearer …` on every watcher call | unset |
| `SMTP_HOST` | SMTP server for verification and reset emails. Unset: links are logged in dev, a warning in production | unset |
| `SMTP_PORT` | 587 (STARTTLS required), 465 (TLS), other (STARTTLS if offered) | `587` |
| `SMTP_USER`, `SMTP_PASSWORD` | SMTP login | unset |
| `MAIL_FROM` | From address | `SMTP_USER` |
| `PLAN_ENCRYPTION_KEY` | Optional 32-byte key (base64 or 64 hex) to encrypt saved plans at rest (AES-256-GCM) | unset (plaintext) |

## Production

`npm run build` makes a standalone server (`output: "standalone"`, traced from the repo root):

```bash
npm ci && npm run build
cp -r .next/static .next/standalone/web/.next/static
cp -r stub-data .next/standalone/web/stub-data   # normally traced in already; harmless
# cp -r public .next/standalone/web/public        # only if a public/ folder is added
cd .next/standalone/web && PORT=3000 HOSTNAME=0.0.0.0 node server.js
```

Run it as one long-lived process (rate limits are in memory) behind an HTTPS proxy that sets
`X-Forwarded-For` or `Fly-Client-IP`. `GET /api/health` returns `{ok:true}` once the database answers.
Security headers and the Content-Security-Policy are set in `next.config.ts`.

## Accounts and privacy

- Transcript PDFs are parsed in the browser (`src/lib/transcript/pdf.ts`, pdf.js worker served from
  `/_next/static`) and never uploaded. Only the resulting class list and plan are saved, and only for
  signed-in users. The public `/privacy` page states what is stored.
- Passwords: scrypt, at least 10 characters. Sessions: random token in an httpOnly SameSite=Lax cookie,
  SHA-256 hash in the DB. Verification (24h) and reset (1h) links are single-use random tokens; only their
  hashes are stored. A reset signs the account out everywhere and also verifies the email.
- Unverified accounts can save plans but not create seat alerts. Alerts always go to the account's own
  email, at most 25 per account, stored in `alert_subscriptions` and forwarded to the watcher.
- Every POST/PUT/DELETE API route calls `checkOrigin` (`src/lib/server/origin.ts`); a test enforces it.
  Rate limits live in `src/lib/server/rateLimit.ts`.
- Users can download their data (`GET /api/account/export`) or delete the account from the account menu.
- Schema changes are additive and applied on startup by `migrate()` in `src/lib/server/db.ts`.

## Layout

- `src/lib/requirements.ts` rule engine that checks classes against requirement rules
- `src/lib/transcript/` transcript text parser and in-browser PDF text extraction
- `src/lib/store.tsx` plan state (localStorage, plus account sync when signed in)
- `src/lib/catalog.ts` loads `data/` with stub fallback
- `src/app/api/` accounts, saved plan, seat alerts, data export, health check
- `src/lib/server/` database, auth, email, rate limits, origin check, env
- `src/components/` UI
