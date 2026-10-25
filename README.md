# Little Focus

A private task list with steps, task notes and deadlines, a Pomodoro timer,
optional breaks, and focus history.

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
Client regressions execute the actual inline `index.html` script in Node's VM
with a small DOM/storage/network test harness. They cover shared-browser drafts,
backup merging, validation boundaries, concurrent timer completion, quote
rotation/preferences, and focus/break transitions. The
client/server validation contract is checked together; keep both validators
aligned when changing limits. The local page remains build-free.

## Local-only mode

Keep `index.html` and `support-content.js` in the same directory, then open
`index.html` directly. No server or dependencies are needed. Data stays in
that browser's localStorage. Use **Export JSON backup** before changing browsers
or moving to the cloud version.

## Appearance

The login page, task list, and motto settings automatically follow the system's
light/dark appearance, including changes while the page is open. Light mode uses
the original warm whites and soft green accents; dark mode uses charcoal surfaces, with limited accent
colors and distinct error/deadline warnings. Native form controls follow the same
color scheme; keyboard focus stays visible and reduced-motion preferences apply.

## Task views

Use **全部** (All), **未完成** (Active), or **已完成** (Completed) above the
task list to filter by the parent task's completion status. All is the default.
Completed tasks keep their steps and notes; expand them to review details or
uncheck them to move them back to Active. Completing individual steps does not
automatically complete their parent task.

The filter only changes the current page's display: it does not delete tasks,
change focus history, or trigger cloud saves. Reloading returns to All.
Adding a task from Completed switches to Active so the new task is visible.

## Deadlines

Expand a task to set its **截止日期** (Deadline) and edit its notes. Steps are
simple checklist items with completion, focus, and delete controls only; they
have no deadline or details fields. Dates are optional; use **清除** (Clear) to remove one. The list
shows each deadline, with **今天到期** (Due today) and **已逾期** (Overdue) based
on the current device's local calendar date. Status updates when the date changes,
without reloading. Completed tasks keep their dates without urgency warnings.

Deadlines are date-only (`dueDate: "YYYY-MM-DD"`, years 0001–9999), not moments
in a particular time zone. They do not schedule notifications, reorder tasks,
or change the timer. Dates are saved locally, synced in cloud mode, and included
in JSON backups. Old records without dates remain valid. When importing, existing
IDs keep their current dates; new tasks bring their backup dates. Legacy step
dates and notes are preserved in storage, sync, and backups but are not displayed.

## Quiet encouragement and optional breaks

Focus presets are **15 / 25 / 30 / 45 / 50 minutes**, with **25 minutes** selected
by default. Presets wrap on narrow screens and cannot change during an active or
paused timer. The existing pause/resume, history, backup, and cloud synchronization
rules apply to every preset. Optional breaks remain **5 minutes**.

Use **格言设置** (Motto settings) in the footer to add, edit, or delete ordinary
and rest mottos, then choose **保存句库**. **返回首页** returns to the timer.
The home quote area shows only the sentence and **换一句**; it has no hide,
disable, source links, or explanatory panel. Delete unwanted lines in settings.
Previous local hide/disable preferences are retired so they cannot conceal the
new library. User library content is never reset by this preference migration.

The library synchronizes with the sole account in cloud mode and saves in this
browser in local mode. It uses the existing full-document revisions, owner
authentication, CSRF checks, conflict handling, and recovery drafts, not a new
public administration endpoint. Limits are 200 entries with 1–200 characters per
entry and unique, stable IDs up to 128 characters. User text renders only as text.
Default lines retain their original attribution only when text and scenario
still match; changed lines are marked modified, and added lines custom in settings.

Changes remain in the editor until saved. Unsaved input is preserved in independent
`little-focus-v1-motto-editor-<UUID>` browser snapshots, including blank input
that needs correction. Returning home keeps the editor and warns that it is
unsaved; reload offers the saved editor drafts in settings. Recovered snapshots
are retained separately and can be explicitly discarded after saving/exporting.
Different tabs do not overwrite each other's input drafts. If the library
changed while editing, save refuses to overwrite it: export the input, load the
current library, and reapply the intended edits. Network failures use the regular
cloud draft recovery. Storage failures remain visible and allow exporting the
editor draft before closing. Only saved valid libraries sync.

`mottos` is an optional array of `{ id, pool: "focus" | "rest", text }` in the
state document. When absent, defaults are interpreted from **`support-content.js`**;
opening settings does not write or migrate the cloud document. Explicit empty
arrays stay empty, so deleting defaults does not revive them on refresh.
JSON backups include an explicit saved library. Importing a backup with a
library offers a separate confirmation to replace the library, including an
empty one; old backups without the field never reset customized content.
Timers and pending rest choices are not imported.

`support-content.js` remains the sole source of default encouragement, rest
suggestions, group labels, and source URLs. User edits do not modify this file.
It is
loaded as a classic script before the app, so `file://` needs neither fetch nor
ES modules. Keep the three groups of six lines, six rest lines, and three
suggestions in their current order: default entry IDs and legacy selection
migration use those original positions. Settings edits/deletions retain IDs and
do not shift another entry's selection.
Missing or malformed content stops initialization with a visible error before
task storage is read or changed; there is no empty-content fallback.

In cloud mode the server reads this same file at startup and embeds it only in
the authenticated HTML with that response's CSP nonce and `no-store` caching.
No static-file route or additional CSP source is enabled. The Dockerfile includes
the resource; deploy/restart the server after editing it. The resource is trusted
application JavaScript, so edit text/data only, not code copied from untrusted
sources.

The timer has a small Chinese encouragement area, initially containing 18 original
paraphrases grouped by Atomic Habits, CPT, and ACT, plus a separate six-line
rest pool. These are not quotations from the books or therapy manuals.
No AI, external content requests, scrolling, flashing, sounds, or notification
permissions are used.

Automatic selection changes at fixed 12-hour UTC windows (00:00 and 12:00 UTC).
Refreshes retain the selection. While a focus timer exists, including while
paused, automatic changes wait until it ends. Background library updates also
retain the current focus sentence until that timer ends; deliberate local
edits and **换一句** may apply immediately. An empty pool shows an invitation
to add content rather than silently restoring deleted lines.
Manual selection lasts for the current window and uses stable entry IDs.
Selection and rest-suggestion preferences remain browser-local in
`little-focus-v1-support`, shared by same-origin tabs but not account-synced or
exported in task backups. Rotation never writes the cloud task document.
Storage errors appear separately from data-save warnings.

After a focus timer finishes, choose **休息 5 分钟** or **稍后休息**.
Nothing automatically starts a break or the next focus. A break can be paused,
resumed, or ended early. It offers one optional suggestion (water, comfortable
movement/looking into the distance, or a one-minute grounding pause), with
**换个建议** and **跳过建议**. Grounding uses natural breathing and allows open
eyes; no breath holding, forced deep breathing, or clearing thoughts is required.
Suggestions have no completion checks, scores, or rewards.

When a break ends, the page says “休息时间到了。你可以继续，也可以再歇一会儿。”
Choose the next focus, another five minutes, or **今天先到这里**. Breaks never
enter focus history or its statistics. Early focus stops record the actual
elapsed time without failure labels. Completing a timer does not overwrite
storage/sync error messages with encouragement.

Focus/break timers and pending rest choices use the same revisioned cloud
document, recovery drafts, and absolute end times as the existing focus timer.
They survive refreshes and synchronize across devices. Returning after a long
absence completes only the current stage; it does not catch up missed cycles.
Identical simultaneous completions converge; different concurrent edits still
require recovery rather than silent merging.

Legacy timers without `kind` remain focus timers. New timers distinguish
`kind: "focus"` and `kind: "break"` (five minutes); an optional `breakPrompt`
records `offer` or `finished` only when no timer is active. JSON exports retain
these fields, but importing never activates timers or rest choices.
Reload old open pages after updating to understand the new state fields.

Default source references (not original quotations):
[Atomic Habits](https://jamesclear.com/atomic-habits),
[CPT](https://www.ptsd.va.gov/understand_tx/cognitive_processing.asp), and
[ACT](https://contextualscience.org/six_core_processes_act).
CPT is a specific cognitive-behavioral therapy, not another name for CBT.
These short lines are general support, not ADHD/PTSD treatment or trauma
processing exercises. The 12-hour rotation and five-minute break are product
defaults, not clinical prescriptions. There are no streak penalties, mood
scores, leaderboards, or AI coaching. Two-minute-start and current-step-only
features are not part of this phase.

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
IDs are not overwritten, and active timers are not imported. A task that already
exists still receives steps with new IDs; its existing title, notes, completion
status, and same-ID steps stay unchanged.

Edits save to the cloud. Pages refresh on returning to the tab and every five
seconds while visible. Only one timer exists in the shared document.

Writes use optimistic revisions and an idempotency key. A stale-device edit is
refused instead of overwriting another device. If two devices finish the same
timer, a conflict is acknowledged only when the **entire saved document** equals
the attempted write, not merely because the timer/history ID matches. Different
task, step, or note edits still produce a conflict. Reusing an idempotency key with
different content is also refused.

On a conflict or network failure, editing becomes read-only. Each unacknowledged
write has its own immutable localStorage draft under
`little-focus-v1-pending-<mutationId>`; an in-flight write and its queued successor
are retained separately. Another tab's successful save cannot clear these drafts.
Only an acknowledged, locally superseded, or explicitly discarded snapshot is
removed. Storage quota/permission failures are reported explicitly: in that case
export immediately and do not close the page.

Reopening the cloud page discovers remaining drafts, including the old
`little-focus-v1-pending` format. Use the draft selector to view or export each
snapshot. Retry the selected write, or export it before **Load cloud version**
discards only the currently viewed changes. Loading must succeed before those
drafts are removed; other snapshots remain available. Switching between drafts
does not discard them, and recovery controls wait for this tab's in-flight
request to finish. The separate **Discard selected draft** action can remove an
unselected or unreadable snapshot after confirmation; it does not cancel requests
already running in another tab. Draft exports include the write envelope and can
be imported like ordinary backups. For a real conflict, export each needed
snapshot, load the cloud version, then import the backups to recover new IDs;
merging does not overwrite same-ID text or notes.

### Data limits and rejected edits

Both local and cloud modes validate the final candidate before changing the
visible state, cache, or save queue, including after merging backups. Limits are
1000 tasks, 500 steps per task, 20000 history entries, 128-character IDs,
200-character task/step text and free-focus labels, 4000-character notes, and
405-character timer/history labels. IDs must be unique within their task, step,
or history collection; timer durations and nonnegative numeric fields must also
match the server contract.

The complete UTF-8 JSON request must fit in 2 MiB, not just the uploaded backup
file. Client edits reserve space for a UUID mutation key and the largest revision
number, so a near-limit queued write remains valid as its revision increases.
An invalid or oversized merge is rejected as a whole, leaving existing data
untouched. If the server still returns a validation/size rejection, editing stays
available so the data can be corrected rather than trapping the page read-only.

If recording a finished timer would exceed a limit, the timer and history stay
intact and an error is shown; no history is silently trimmed. Export a backup,
then use **Clear history** (with confirmation) to make room. The next timer tick
can finish recording after a successful correction. Browser storage has its own
quota, which can be smaller than the combined cache and recovery snapshots.

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
