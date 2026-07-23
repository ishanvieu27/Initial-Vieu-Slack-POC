# Vieu Slack POC — net-new warm intro journey

Slack POC of the warm-intro journey: nudge → understand / shortlist / park / ask → sent → reply → completed. All state lives in Slack threads. One AE, one Slack workspace, seeded from a CSV that carries every Vieu field per connection.

## What you get

- **`/vieu-fire [account]`** — DMs the AE a "N new connections found" alert plus one message per top-3 connection (ranked by Vieu Score), each with `Request introduction / 📌 Shortlist / 💬 Understand connection / Not now` buttons. No arg → top 3 across all accounts.
- **Shortlist** and **Not now** update the card in place with the new status.
- **💬 Understand connection** opens a thread. Any reply you type in that thread is answered by GPT-4o-mini using the connection's full CSV row (all 37 columns) as grounding data — no MCP, no external API, just your CSV.
- **Request introduction** opens a modal with an LLM-drafted, editable ask; submit → status becomes `In progress` and a confirmation lands in the thread.
- **`@vieu <query>`** in any channel, or just DM the bot free-form — runs a deterministic local search over the CSV and posts result cards. The Understand button on those cards opens the same threaded LLM chat.
- **`/vieu-reply <connection_id> yes|no`** — simulates the introducer's response. `yes` marks Completed with the follow-through messages; `no` posts the "try a different path" nudge.

## Layout

```
src/
  app.js         Local dev entrypoint — Socket Mode (no public URL needed)
  handlers.js    Every Bolt listener (commands, buttons, modals, events) —
                 shared verbatim between src/app.js and api/slack/events.js
  store.js       CSV loader (37 cols) + state (Redis-backed), PID extraction
  vieu.js        Local search + LLM (OpenAI) for Understand-connection and drafts
  blocks.js      Block Kit builders for cards, modals, and search results
  intros.js      Introduction lifecycle orchestration (approval, channels, reminders)
  activity.js    Append-only action log (Redis-backed) — backs /vieu-reset
  dedupe.js      Redis-backed event dedupe (Slack retries, double-fired events)
  kv.js          Shared Redis client (Upstash, via Vercel's Redis integration)
api/
  slack/events.js   Vercel entrypoint — HTTP mode, one endpoint for
                    Events/Interactivity/Slash Commands
data/
  connections.csv   canonical data — 37 columns per row (bundled in the deploy)
vercel.json      declares connections.csv as a required deploy asset
```

State (`state.json`/`activity.json`-equivalent) and per-thread LLM conversation
memory live in **Redis** (Upstash, via Vercel), not local files — Vercel's
filesystem is read-only and isn't shared across invocations. Locally, Socket
Mode talks to the *same* Redis instance (see step 4 below), so local testing
and the deployed instance share live state.

## Setup

Two ways to run this: **locally** (Socket Mode, your laptop, no public URL —
good for solo dev) or **on Vercel** (HTTP mode, live 24/7, shareable with a
team). Both need the same Slack app and the same Redis store; you can do one
or both.

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Create the Slack app

At https://api.slack.com/apps → **Create New App → From scratch**.

**Bot Token Scopes**:
- `chat:write`
- `im:write`
- `im:history`
- `app_mentions:read`
- `commands`
- `users:read`
- `users:read.email` — resolve the introducer by email
- `groups:write` — create/manage the private intro channels + invite members
- `groups:read` — check/reuse existing intro channels

**Slash commands**: `/vieu-fire`, `/vieu-reply`, `/vieu-reset` — each needs a
**Request URL** only if you're running HTTP mode (Vercel); Socket Mode ignores it.

**Event Subscriptions**: on. Bot events: `message.im`, `app_mention`. Same
Request URL note as above.

**App Home → Messages tab**: enable *"Allow users to send Slash commands and messages from the messages tab"*.

Install to your workspace and paste `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` into `.env`.

### 3. Provision Redis (required for both modes)

Vercel dashboard → your project → **Storage** tab → add a **Redis** store
(Upstash) → **Connect** it to this project. Vercel injects
`KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`,
depending on the flow) automatically for the deployed function.

For local dev against that same store:
```bash
vercel link      # once, links this folder to the Vercel project
vercel env pull .env
```
This appends the Redis vars (and anything else set in Vercel) to your local `.env`.

### 4a. Run locally (Socket Mode)

Add an app-level token (**Basic Information → App-Level Tokens**, scope
`connections:write`) as `SLACK_APP_TOKEN` in `.env`, then also enable
**Socket Mode** in the Slack app settings, and turn on **Interactivity**.

```bash
npm start
```

Then in Slack: `/vieu-fire` or `/vieu-fire Microsoft`, or DM the bot: `find connections at Salesforce`.

### 4b. Deploy to Vercel (HTTP mode, shared demo env)

1. Push this repo to GitHub, then Vercel → **New Project → Deploy from GitHub repo**.
2. Set env vars in the Vercel dashboard: `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`,
   `SLACK_SIGNING_SECRET`, `VIEU_APP_URL`, `INTRO_REMINDER_SECS`. **Do not set**
   `SLACK_APP_TOKEN` or `AE_SLACK_ID` here — HTTP mode doesn't use the app
   token, and leaving `AE_SLACK_ID` unset is what makes every caller their own AE.
3. Redis vars come from step 3 above (already linked).
4. Deploy. Copy the resulting URL, e.g. `https://<project>.vercel.app`.
5. Back in the Slack app config, set the **Request URL** for **Event
   Subscriptions**, **Interactivity & Shortcuts**, and each **Slash Command**
   to: `https://<project>.vercel.app/api/slack/events`. Slack will send a
   verification challenge — Bolt's receiver answers it automatically.
6. Reinstall the app if prompted. Invite teammates to the workspace — each
   person's `/vieu-fire` DMs go to themselves.

## Demo script

1. `/vieu-fire Microsoft` → header + top 3 cards, each with hyperlinked target and introducer names.
2. Click **💬 Understand connection**. In the thread, ask *"how close are they really?"* — GPT-4o-mini answers grounded in every CSV field for that connection.
3. Ask a follow-up in the same thread — memory is preserved.
4. On another card, click **📌 Shortlist**. Card collapses to the shortlisted state.
5. Click **Request introduction** → edit the LLM-drafted ask → **Send**. Card flips to 🟡 In progress.
6. `/vieu-reply <connection_id> yes` → thread lights up with completion messages; card flips to ✅ Completed.
7. In any channel or DM: `@vieu find connections at Salesforce` (or just `find connections at Salesforce` in DM) → result cards with real Vieu URLs and an interactive Understand button.

## Introduction workflow (via the introducer on Slack)

When a requester clicks **Request introduction** on any card:

1. **Resolve the introducer on Slack** — by `Introducer Email` (`users.lookupByEmail`), falling back to name search. Multiple name matches → the requester picks one.
2. **Not on Slack** (not found, or a guest/deactivated) → the bot DMs the requester an email draft + the Connection Vieu URL to send it from Vieu.
3. **On Slack** → a compose modal opens with an editable note. On send, the bot DMs the introducer an approval request with **Yes / No** only, and confirms to the requester (*"contacted … for approval"*), with a **Cancel request** button. Status → **in progress**.
4. **Introducer says No** → optional reason modal; status → **parked**; requester notified (with the note) and offered a direct/email path.
5. **Introducer says Yes** → the bot creates (or reuses) a **private** channel `vieu-intro-<first>-network-connections`, adds the introducer + requester + bot (never the target), and posts a per-target thread *"Intro to <Target>"* with a **✅ Mark as introduced** button. Status stays **in progress** (internal: approved).
6. **Mark as introduced** (requester or introducer) → status → **completed**.

**Reminders:** two nudges at `INTRO_REMINDER_SECS` and 2× that (default 2 days / 4 days) for both the approval wait and the post-approval completion wait, cancelled automatically on response. **One shared channel per introducer, one thread per target.** Edge cases handled: duplicate requests (first-come-first-serve), answer locked after first click, cancellation, channel-permission failures (retry → manual), and introducer no longer active (intros parked).

## Demo cleanup — `/vieu-reset [minutes]`

Wipes everything the bot did on Slack within the last N minutes (default 60), so you can re-run a demo from a clean slate.

```
/vieu-reset          → cleans up the last 60 minutes
/vieu-reset 15       → cleans up just the last 15 minutes
```

What it does:
- **Deletes** every message the bot posted in that window (cards, DMs, thread replies, confirmations).
- **Archives** every private intro channel it created in that window.
- **Cancels** any pending approval/completion reminders scheduled in that window.
- **Resets** local state for any connection touched in that window back to *Not started* — re-rendering its card in place if it survived, or just dropping the stale reference if that card itself was deleted.

**Slack's hard limits** (surfaced in the command's reply, not hidden):
- A bot can only delete **its own** messages — a human's reply in a thread is left untouched; Slack's API won't allow anything else.
- A bot can only **archive** a channel, never permanently delete it (true deletion needs an Enterprise Grid admin). Archived channels vanish from your sidebar; that's as clean as this command can make it.

Under the hood: every `postMessage` / `scheduleMessage` / `conversations.create` call is logged to `data/activity.json` (gitignored, auto-prunes anything older than 24h) via the same client patch that suppresses link previews. `/vieu-reset` replays that log backwards.

## Seed data

`data/connections.csv` — 37 columns per row. Key fields:

| column | notes |
|---|---|
| `Account`, `Account Target`, `Target Title`, `Introducer Name` | who + where |
| `Introducer Vieu URL`, `Target Vieu URL`, `Connection Vieu URL` | canonical links; PID is extracted from the connection URL and used as the stable ID |
| `Summary`, `Connection to Introducer/Intermediary/Target/Account` | narrative; Summary shown on card, all four passed to the LLM |
| `Vieu Score` | drives sort order for `/vieu-fire` |
| `Priority`, `Status` | Vieu's own workflow state — CSV `Status` seeds Slack state on first alert |
| `Buyer Alignment`, `Conn Strength: *` | signals passed to the LLM |

## Known POC limits

- Multi-tester by default — each caller of `/vieu-fire` is their own AE. Set
  `AE_SLACK_ID` to lock the DM handler to a single user for solo local testing.
- Firing `/vieu-fire` twice re-posts messages; old ones become orphans. Use
  `/vieu-reset` between clean-slate demos.
- Introducer's reply is simulated via `/vieu-reply`; no real outbound email/DM.
- On Vercel (HTTP mode), a slow LLM call inside a modal flow (e.g. drafting
  the forwardable blurb) can occasionally make Slack show a modal spinner a
  bit longer than on Socket Mode, since `processBeforeResponse` holds the
  HTTP ack until the whole listener finishes. The final result always lands
  correctly — this is a minor UX difference, not a correctness bug.
