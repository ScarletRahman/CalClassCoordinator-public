# CalClassCoordinator

Alerts for open seats in Berkeley classes, plus a planner for majors, requirements and when to enroll.

| Part | Folder | Status |
|---|---|---|
| Seat alert watcher and Discord bot | `watcher/` | working |
| Enrollment history and predictions | `ml/`, `data/enrollment/`, `data/predictions/` | working |
| Majors and requirements | `data/requirements/`, `scripts/` | working |
| Planner web app | `web/` | working |
| Class insights (ratings, grades, professors, reviews) | `insights/`, `data/insights/` | working |

To run the whole thing as a hosted site, see [`docs/deploy.md`](docs/deploy.md).

## Seat alert watcher

Watches classes on [classes.berkeley.edu](https://classes.berkeley.edu) and alerts you when unreserved seats, reserved seats, or waitlist spots open.

### Setup

Needs Python 3.11 or newer.

```
pip install -e .
copy watcher.example.yaml watcher.yaml     (cp on macOS/Linux)
```

Edit `watcher.yaml`: list the classes under `watch:` and choose how to be alerted under `notifiers:`.

### Use

```
python -m watcher check "COMPSCI 61A"      show current seats once, no alerts
python -m watcher once                     one pass over watcher.yaml
python -m watcher run                      keep watching and alert on changes
python -m watcher serve                    same, plus a local API for the planner
```

Example output of `check`:

```
COMPSCI 61A    001 LEC  #28320  open  173  enrolled 332/600 wl 0/300  Kay Ousterhout
                        reserved Non-EECS Declared Engineering Majors: 48/50 (2 open)
                        reserved Students declared in the Computer Science BA major: 16/50 (34 open)
```

### Alerts

Channels: `console`, `desktop`, `ntfy` (free phone push), `discord`, `email`, `twilio` (SMS), `webhook`. See `watcher.example.yaml` for the settings of each. Passwords and webhook URLs are read from environment variables, never from the file.

**Discord with one channel per class.** Create a bot in the Discord developer portal, invite it to your server with View Channels, Manage Channels and Manage Webhooks, put its token in the `DISCORD_BOT_TOKEN` environment variable, then run:

```
python -m watcher discord-setup
```

It creates a "Seat Alerts" category, an `#all-alerts` channel, and one channel per course in `watcher.yaml`, each with its own webhook, and saves the webhook addresses to `discord_channels.json` (local only). Re-run it whenever you add classes. The bot is only needed for this step.

**A full public Discord server.** To run alerts for a whole community, give the bot's role these permissions as well: Manage Roles, Send Messages, Embed Links, Read Message History (required), and optionally Manage Messages, Mention Everyone, Kick Members, Ban Members, Moderate Members, Manage Nicknames, Manage Threads, View Audit Log, Manage Server, and the three thread permissions. `python -m watcher discord-server --check` lists what is missing and prints an invite link with everything ticked. Then:

```
pip install websocket-client
python -m watcher discord-server            # builds or updates the server; safe to re-run
python -m watcher discord-bot --watch       # keep this running: opt-in bot plus the seat watcher
```

`discord-server` creates welcome, rules, how-it-works, announcements and get-alerts channels, community channels, a public `#all-alerts` feed, a staff area, Admin and Moderator roles, and for every class a role and a private channel grouped by subject. Members pick classes with the buttons in `#get-alerts` or with `/watch`, `/unwatch`, `/alerts` and `/classes`; picking a class gives them its role, shows its channel, and alerts ping that role. Members can add classes that are not watched yet with **Request a class** or `/watch`: the bot checks the course against the catalog and the live schedule, then creates its role, channel and webhook on the spot and the watcher starts polling it, with no restart. One member can open 5 new classes a day and the server holds `--max-classes` (default 100); past either limit, or with `--require-approval`, requests wait for staff in `#class-requests`. Staff also have `/class-add` and `/class-remove`.

To start a server with classes people actually fight over, `python -m watcher discord-server --popular 25` adds the 25 largest classes that the enrollment predictor expects to fill this term, after checking each against the live schedule. The schedule site takes several seconds per page, so every watched class adds to the time one full pass takes: expect alerts to arrive within a few minutes at 25 classes and noticeably later at 100. The texts the bot posts live in `watcher/discord_content.py`.

Events: `seats_opened`, `seats_increased`, `reserved_opened`, `waitlist_opened`, `waitlist_moved`, `closed`, `new_section`, `error`. Pick which ones alert with `alert_on:`.

### API

`python -m watcher serve` listens on `http://127.0.0.1:8765`:

- `GET /seats` returns the latest numbers for every watched section (same content as `data/seats/latest.json`)
- `GET /seats/<classNumber>`
- `POST /subscriptions` with `{"email", "classNumber", "includeReserved"}` adds a class to the watch list and emails that address on changes (needs `subscription_email:` in the config)
- `DELETE /subscriptions`, `GET /subscriptions?email=`

- `GET /lookup?course=COMPSCI%2061A&term=2027%20Spring` returns the course's lectures, discussions and labs with meeting times and current seats, fetched on demand and cached for 5 minutes (shape in `docs/schedule.md`)

### Class times

`python -m watcher import-schedule --term "2027 Spring"` downloads every undergraduate class's lecture, discussion and lab times for a term from Berkeleytime into `data/schedule/2027-spring.json`, which the planner's weekly schedule view reads. It takes about an hour per term; add `--cache DIR` so an interrupted run can resume. `python -m watcher lookup "COMPSCI 61A"` prints one course's sections, times and seats.

### Tests

```
pip install -e .[dev]
python -m pytest
```

Please keep the polling interval at 30 seconds or more.

Alerts for open seats in Berkeley classes, plus an ML planner for when to enroll

## Enrollment predictor

Predicts, per class and professor, how popular a class will be and in which enrollment phase it fills, from Berkeleytime's daily enrollment history, classes.berkeley.edu and the registrar's phase calendar.

```
pip install -e ".[ml]"
python -m ml.predictor build --term "Spring 2027"     # writes data/predictions/predictions.json
python -m ml.predictor predict "COMPSCI 61A" "John DeNero"
```

Professors with no history get a warning and a prediction based on the course's history instead. Output format: `docs/predictions.md`.

## Class insights

For every class in the catalog that has been offered recently, `data/insights/` holds what students most want to know before enrolling:

- a **difficulty** rating and a **"should I take it"** rating, both 1 to 5, with a confidence level and the signals behind each number
- the grade distribution and average grade, overall and per professor
- the typical number of scheduled midterms, per professor where the registrar lists them
- student ratings and written reviews from Berkeleytime, RateMyProfessors ratings for each professor, and r/berkeley threads

The planner shows all of this when you open a class. The numbers and how they are computed are in [`data/insights/REPORT.md`](data/insights/REPORT.md).

To refresh the data (once a semester is enough):

```
python -m insights collect-berkeleytime      about 2 hours, can be stopped and resumed
python -m insights collect-rmp --reviews 400
python -m insights collect-reddit --top 300  needs REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET
python -m insights pack
python -m insights build
```

Ratings summarize other students' opinions and past grades. They are a starting point, not a promise about your experience.

## License and data

The code is under the MIT License (see `LICENSE`). The license covers the code only. Files under `data/` are collected from public sources (the UC Berkeley catalog, classes.berkeley.edu, Berkeleytime, RateMyProfessors) and belong to their owners; they are included for reference and are not relicensed here. CalClassCoordinator is an unofficial, student-run project and is not affiliated with UC Berkeley.
