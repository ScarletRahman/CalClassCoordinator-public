# Deploying CalClassCoordinator

The whole app ships as one Docker image (`Dockerfile`): the planner website, the seat watcher, and
the Discord bot. It needs one persistent folder, mounted at `/data`, which holds the accounts
database, the watcher's seat history, and the Discord server state.

Two supported ways to host it:

- **Option A, Fly.io** (recommended): about $3 to $4 a month, deploys itself from GitHub.
- **Option B, your own server** with `docker compose`: free on an Oracle Cloud "Always Free" VM,
  or about $4 a month on Hetzner. More setup, more control.

Why these and not Vercel, Render and so on is written up in `OWNER_NOTES.md`.

## What you need first

| Thing | Why | Cost |
| --- | --- | --- |
| An SMTP mailbox | Verification emails, password resets, seat alert emails | Free with a Gmail app password |
| A Discord bot token | Only if you run the Discord bot | Free |
| A domain name | Optional. Fly gives you `https://<app>.fly.dev` for free | About $10 a year |

Secrets are never committed and never pasted into chat. They go into `fly secrets` (Option A) or
a `.env` file on the server (Option B). The full list with comments is in `deploy/.env.example`.

| Name | Required | What it is |
| --- | --- | --- |
| `APP_URL` | yes | Public address of the site, used in email links |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | yes for email | Outgoing mail |
| `PLAN_ENCRYPTION_KEY` | recommended | Encrypts saved plans and transcript class lists at rest |
| `DISCORD_BOT_TOKEN` | only for the bot | Discord bot login |
| `WATCHER_API_TOKEN` | no | Web app to watcher secret; generated at boot if unset |

Without SMTP the site still runs and people can make accounts and save plans, but nobody can
verify their email, reset a password, or get email seat alerts.

## Option A: Fly.io

One-time setup, about 15 minutes. Run these on your own computer.

1. Install the Fly command line tool and make an account (needs a payment card):
   <https://fly.io/docs/flyctl/install/>, then `fly auth signup`.
2. From the repo folder, create the app and its disk. Pick your own app name; it becomes the
   address `https://<name>.fly.dev`.

   ```
   fly apps create <name>
   fly volumes create ccc_data --app <name> --region sjc --size 1
   ```

3. Edit `fly.toml`: set `app = "<name>"` and `APP_URL = "https://<name>.fly.dev"`. Commit that.
4. Set the secrets. Each value is typed by you into your own terminal:

   ```
   fly secrets set --app <name> \
     SMTP_HOST=smtp.gmail.com SMTP_PORT=587 \
     SMTP_USER=you@gmail.com SMTP_PASSWORD=<gmail app password> \
     MAIL_FROM="CalClassCoordinator <you@gmail.com>" \
     PLAN_ENCRYPTION_KEY=<32 random bytes, base64> \
     DISCORD_BOT_TOKEN=<bot token>
   ```

   Make the encryption key with
   `python -c "import os,base64; print(base64.b64encode(os.urandom(32)).decode())"` and keep a
   copy in your password manager. If it is lost, saved plans cannot be read.
5. Deploy: `fly deploy`. Then open `https://<name>.fly.dev`.
6. Check that the server can read Berkeley's schedule from Fly's network:

   ```
   fly ssh console --app <name> -C "python -m watcher check 'COMPSCI 61A'"
   ```

   If that prints seats, the watcher works. If it is blocked, see "If Berkeley blocks the server".
7. Turn on automatic deploys: `fly tokens create deploy --app <name>`, then add the output as a
   GitHub secret named `FLY_API_TOKEN` (repo Settings, Secrets and variables, Actions). From then
   on every merge to `main` that passes CI is deployed.

### Moving the Discord bot off your PC

The bot keeps everything it knows about your server (roles, channels, which classes exist) in
`discord_channels.json`. Copy that file to the server once, so the bot there carries on where the
PC left off.

1. Stop the bot on the PC (close its window). Two copies with the same token would both answer.
2. Copy the file up:

   ```
   fly ssh sftp shell --app <name>
   put discord_channels.json /data/watcher/discord_channels.json
   ```

3. Restart the app so it picks the file up: `fly apps restart <name>`.
4. In Discord, press one of the opt-in buttons. It should answer within a second or two.

After this the PC can be off. Do not start the bot on the PC again unless you stop the server's.

### Day to day

| Task | Command |
| --- | --- |
| Logs | `fly logs --app <name>` |
| Shell on the server | `fly ssh console --app <name>` |
| Download a database backup | `fly ssh sftp get /data/web/planner.db --app <name>` |
| Restore a disk snapshot | `fly volumes snapshots list <volume id>` (Fly keeps daily snapshots for 5 days) |
| Change a secret | `fly secrets set NAME=value --app <name>` (restarts the app) |

## Option B: your own server

Any Linux machine with Docker and ports 80 and 443 open.

```
git clone https://github.com/ScarletRahman/CalClassCoordinator-public.git
cd CalClassCoordinator
cp deploy/.env.example .env      # fill it in; SITE_ADDRESS is your domain
docker compose up -d --build
```

Point your domain's A record at the server first; Caddy then fetches the HTTPS certificate on its
own. To update: `git pull && docker compose up -d --build`. The data lives in the `ccc_data`
Docker volume; back it up with
`docker run --rm -v calclasscoordinator_ccc_data:/data -v "$PWD":/out busybox tar czf /out/backup.tgz /data`.

Copy `discord_channels.json` in with
`docker compose cp discord_channels.json app:/data/watcher/discord_channels.json`, then
`docker compose restart app`.

## Berkeley blocks cloud servers

`classes.berkeley.edu` answers HTTP 403 to requests from Fly's network (checked 20 November 2026).
Berkeleytime works from there, so the production watcher config (`deploy/watcher.prod.yaml`) lists
Berkeleytime first and keeps `classes.berkeley.edu` as a fallback. Berkeleytime refreshes on its own
schedule, so an opening can be noticed a little later than on Berkeley's own site.

The proper long-term source is Berkeley's official API Central (api-central.berkeley.edu), which
needs a key requested with a CalNet login. The planner itself does not depend on the watcher; without
it the site just shows no live seat numbers.

## Scheduled jobs

| Job | Where | When |
| --- | --- | --- |
| Tests on every pull request | `.github/workflows/ci.yml` | Each push |
| Deploy | `.github/workflows/deploy.yml` | After CI passes on `main` |
| Re-scrape the catalog and open a PR | `.github/workflows/refresh-catalog.yml` | 15 June, 15 November, or on demand |

The catalog refresh opens a pull request instead of committing straight to `main`, so a broken
scrape can never reach the live site. For it to open that PR, turn on "Allow GitHub Actions to
create and approve pull requests" in repo Settings, Actions, General.
