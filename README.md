# Little Focus

A private task list with steps, notes, a Pomodoro timer, and focus history.

Source repository: [wei-yao/awesome-todos](https://github.com/wei-yao/awesome-todos).

The working copy is in `C:\code\little-focus`. Railway deploys uploaded source;
this application is not currently connected to GitHub autodeploys.

## Dependencies

| Component | Requirement |
| --- | --- |
| Node.js | 22 or newer, with npm; the production Dockerfile uses Node 22 |
| PostgreSQL | Required by the server; already provisioned on Railway |
| `pg` | Runtime PostgreSQL client, installed by npm |
| `openid-client` | Runtime Railway OAuth/OIDC client, installed by npm |
| `@electric-sql/pglite` | Development-only embedded PostgreSQL for tests |
| Railway CLI | Needed for deployment; commands below run it through `npm exec` |

Install the versions recorded in `package-lock.json` and run the tests:

```powershell
Set-Location C:\code\little-focus
npm ci
npm test
```

Tests run locally with an embedded database and a local test identity provider.
They do not require a running PostgreSQL server or real Railway credentials.
Docker Desktop is not required to deploy: Railway builds the Dockerfile remotely.

## Local-only mode

Open `index.html` directly. No server or dependencies are needed. Data stays in
that browser's localStorage. Use **Export JSON backup** before changing browsers
or moving to the cloud version.

## Cloud mode

The Node server serves the same HTML and enables authenticated cloud sync.
PostgreSQL stores one versioned document for the sole owner. There is no public
registration, and the database does not need public networking.

Required environment variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Private PostgreSQL connection string |
| `APP_ORIGIN` | Exact HTTPS origin, without a trailing slash |
| `OWNER_RAILWAY_ID` | Exact Railway user ID allowed to sign in |
| `RAILWAY_OAUTH_CLIENT_ID` | Railway Web OAuth app client ID |
| `RAILWAY_OAUTH_CLIENT_SECRET` | Railway Web OAuth app client secret |
| `PORT` | Listening port; defaults to `3000` |

Keep credentials in Railway Variables or a private local environment. Never
commit them or copy them into `index.html`. `.env.example` is a template, not
a working account. The server creates its table automatically at startup.

### Run the server locally

Install PostgreSQL locally and create a database named `little_focus`. Use that
database's credentials in `DATABASE_URL`; Railway's private database hostname
is not reachable from this machine.

Create a local environment file without overwriting an existing one:

```powershell
Set-Location C:\code\little-focus
if (-not (Test-Path -LiteralPath .env))
{
    Copy-Item -LiteralPath .env.example -Destination .env
}
```

Edit `.env` and fill in the required values. For local development, use
`APP_ORIGIN=http://localhost:3000`. The OAuth Web Application must allow the
exact redirect URI `http://localhost:3000/auth/callback`; a separate development
OAuth app can be used instead of changing the production app.

```powershell
node --env-file=.env server.mjs
```

Open `http://localhost:3000`. `npm start` also works when the required environment
variables are already supplied by your shell, but it does not load `.env`.

## Deploy to the existing Railway project

| Setting | Existing deployment |
| --- | --- |
| Website | <https://little-focus-web-production.up.railway.app/> |
| Project | `little-focus` |
| Project ID | `471e6083-3fd2-4f3c-92d9-1e515285ddd7` |
| Environment | `production` |
| Web service | `little-focus-web` |
| Database service | `Postgres` |

The production database, OAuth app, and environment variables are already
configured. Ordinary code updates do not require creating them again.

On this machine or a new machine, sign in to the Railway CLI and explicitly
link the working directory to the existing deployment:

```powershell
Set-Location C:\code\little-focus
npm exec --yes --package @railway/cli -- railway login
npm exec --yes --package @railway/cli -- railway link --project 471e6083-3fd2-4f3c-92d9-1e515285ddd7 --environment production --service little-focus-web
npm exec --yes --package @railway/cli -- railway status
```

Complete the CLI authorization in your browser, selecting only the intended
workspace. Confirm that `status` shows `little-focus`, `production`, and
`little-focus-web`. Do not use `railway init` or `railway up --new` for this
site: those create another project.

After installing dependencies with `npm ci`, deploy changes:

```powershell
npm test
npm exec --yes --package @railway/cli -- railway up --project 471e6083-3fd2-4f3c-92d9-1e515285ddd7 --environment production --service little-focus-web --ci
Invoke-RestMethod -Uri https://little-focus-web-production.up.railway.app/health
```

The health endpoint should return `ok: true`. Open the website and sign in with
Railway. Deploying restarts the web process, so existing app sessions may need
to sign in again. The database and its persistent volume are not replaced.

Editing files on disk alone does not update the website; run the upload command
after each change. `.gitignore` excludes `node_modules` and real `.env` files
from the normal source upload. Production secrets stay in Railway Variables.

## Railway service configuration

Use the Dockerfile for the `little-focus-web` service. Connect `DATABASE_URL` to
`${{Postgres.DATABASE_URL}}`. Set the health check to `/health`, timeout to 60
seconds, and restart policy to `ON_FAILURE` with 3 retries in service settings.
These are service settings, not the deprecated `railway.toml` format.

Keep the Postgres volume attached. Do not add a public TCP proxy for the
database. Railway currently restricts native volume backups and schedules to
Pro workspaces. This Hobby deployment was not upgraded and has no automatic
database backup. Use the app's JSON export regularly; persistent storage is not
a backup. A future Pro upgrade can enable daily backups.

## Railway sign-in

The hosted app uses Login with Railway. There is no password login or public
registration. Only the exact ID in `OWNER_RAILWAY_ID` can obtain an app session;
an email address or workspace membership does not grant access.

Create a **Web Application** in Railway workspace settings > Developer. Set its
redirect URI to `APP_ORIGIN` followed by `/auth/callback`, exactly. Store its
client ID and secret in the web service's Railway Variables. Obtain the owner's
ID from the already authenticated Railway account, not from the first person
who attempts to sign in.

The app requests only `openid`. It does not request workspace, project, SSH,
email, profile, or offline access. Authorization uses S256 PKCE, browser-bound
state, and a nonce. The server verifies the ID token's ES256 signature, issuer,
audience, expiry and nonce before checking the owner's `sub`.

Temporary login flows expire after 10 minutes and cannot be reused. Sessions
use HttpOnly, Secure, SameSite=Lax cookies so Railway can redirect back to the
app. State-changing API requests still require an exact matching Origin.
App sessions expire after 12 hours. Restarting the web service invalidates them;
sign in again. Logging out revokes the app session, not the Railway dashboard
session. Access and refresh tokens are not retained.

`OWNER_PASSWORD` and `OWNER_USERNAME` are obsolete and should be removed from
the service after the SSO deployment has been verified.

## Migration and sync

Export a JSON backup from the old local page. Sign in to the hosted page and
import that file. Tasks, steps, notes, and history are merged by ID. Existing
IDs are not overwritten, and active timers are not imported.

Edits save to the cloud. Pages refresh on returning to the tab and every five
seconds while visible. Only one timer exists in the shared document.

Writes use optimistic revisions and an idempotency key. A stale-device edit is
refused instead of overwriting another device. On a conflict or network failure,
editing becomes read-only and a recovery draft stays in localStorage. Retry
the save, or export a backup before explicitly loading the cloud version.

Local backups and recovery drafts contain private task data. Use trusted
machines, keep exported files private, and log out when finished.

## Cost control

The deployed workspace uses a $5 compute alert and a $10 compute hard limit,
Railway's minimum supported hard limit at deployment time. Hitting the hard
limit takes workspace workloads offline. This is not a promise of a $5 monthly
bill; persistent storage and backups may still incur charges while stopped.
The Agent usage limit is separate and does not cap app/database usage.

Check measured usage after a week. Promotional credits and discounts are not
permanent monthly allowances.
