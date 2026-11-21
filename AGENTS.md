# AGENTS.md — setup guide for AI coding agents

You are helping a person install **Call Transcripts MCP**: Cube ACR call recordings on Android → Google Drive → Google Apps Script → Cloudflare Worker (KV + D1) → OpenAI transcription → an MCP connector in Claude. Read [README.md](README.md) for the architecture.

Work through the steps in order. Each step says who does it:

- **🤖 AGENT** — run it yourself and check the result.
- **👤 HUMAN** — stop, tell the person exactly what to do (copy the instructions below), and wait until they confirm. Never guess values the person has to provide.

## Ground rules

- **Secrets.** Never write `OPENAI_API_KEY` or `MCP_TOKEN` into any file in this repo, never commit them, and never paste them into logs, issues or PRs. Set them only with `wrangler secret put` (which reads from the terminal) and in Apps Script properties. When the person gives you their OpenAI key, prefer that they paste it into the `wrangler secret put` prompt themselves.
- **Don't commit personal ids.** `wrangler.jsonc` will contain the person's KV and D1 ids after step 3. That's fine locally. If the person later wants to push their copy to a public fork, revert those ids to the placeholders first.
- **Ask before spending money** or changing anything outside this setup (for example an existing Worker with the same name).
- Commands below assume the repo root as working directory and Node.js 18+.

---

## Step 0 — Check prerequisites · 🤖 AGENT

```bash
node --version        # must be >= 18
npm --version
```

Then ask the person, in one message, to confirm they have:

1. An **Android** phone (Cube ACR does not record calls on iPhone).
2. A **Google account** for Drive and Apps Script.
3. A **Cloudflare** account (free) — or they can create one during `wrangler login`.
4. An **OpenAI API key** with credit (https://platform.openai.com/api-keys, billing at https://platform.openai.com/settings/organization/billing/overview).
5. A **Claude** plan that supports custom connectors.
6. Which **language** their calls are in (default `he`; for English use `en`).

Mention that call-recording laws vary by country and some require consent from everyone on the call.

## Step 1 — Cube ACR on the phone · 👤 HUMAN

Tell the person to do this on their phone (see the illustrated walkthrough in README section "1. Cube ACR on your phone"):

1. Install **Cube ACR** from Google Play and open it.
2. Allow microphone, phone and contacts. Turn on **Cube ACR App Connector** in Android *Settings → Accessibility* (needed for WhatsApp/VoIP calls). Exclude the app from battery optimisation.
3. In Cube ACR settings, enable automatic recording for phone calls (and WhatsApp if wanted). Keep the default file-name format.
4. In Cube ACR *Settings → Cloud backup*, choose **Google Drive**, sign in with the same Google account as in step 0, turn on automatic upload. (Cloud backup is a Premium feature.)
5. Make a short test call, wait a few minutes, open the **Cube ACR** folder in Google Drive, and send you the **folder id** — the part after `/folders/` in the URL.

Wait for the folder id. Save it for step 5 as `DRIVE_FOLDER_ID`. It's not a secret, but don't commit it.

## Step 2 — Install and sign in to Cloudflare · 🤖 AGENT + 👤 HUMAN

```bash
npm install
npx wrangler login     # 👤 the person approves in the browser window that opens
npx wrangler whoami    # 🤖 confirm the login worked
```

If `wrangler login` can't open a browser (remote machine), ask the person to create an API token at https://dash.cloudflare.com/profile/api-tokens with the *Edit Cloudflare Workers* template plus D1 edit permission, and export it as `CLOUDFLARE_API_TOKEN` in their own shell.

## Step 3 — Create KV and D1, fill in wrangler.jsonc · 🤖 AGENT

```bash
npx wrangler kv namespace create call-transcripts-audio
npx wrangler d1 create call-transcripts
```

From the output, copy the KV `id` and the D1 `database_id` into `wrangler.jsonc`, replacing `<YOUR_KV_NAMESPACE_ID>` and `<YOUR_D1_DATABASE_ID>`. If the namespace or database already exists, list them (`npx wrangler kv namespace list`, `npx wrangler d1 list`) and ask the person whether to reuse them.

Set `vars.TRANSCRIBE_LANGUAGE` to the language from step 0. Leave `DRIVE_FOLDER_ID` empty (it's only for the optional service-account mode).

## Step 4 — Secrets and deploy · 🤖 AGENT + 👤 HUMAN

```bash
npm run token                          # 🤖 generates MCP_TOKEN; show it to the person once and tell them to save it in a password manager
npx wrangler secret put MCP_TOKEN      # 🤖 paste the generated token
npx wrangler secret put OPENAI_API_KEY # 👤 the person pastes their OpenAI key at the prompt
npx wrangler deploy
```

Note the deployed URL (`https://call-transcripts-mcp.<subdomain>.workers.dev`) as `WORKER_URL`.

Verify:

```bash
curl -s "$WORKER_URL/"                              # → "Phone Calls MCP is running."
curl -s "$WORKER_URL/ingest/$MCP_TOKEN/health"      # → {"alert":null,"pending":0,...}
```

Run the second command without echoing the token into shared logs where possible (e.g. read it from an environment variable).

## Step 5 — Google Apps Script · 👤 HUMAN (or 🤖 AGENT with clasp)

**Option A — by hand (simplest).** Tell the person:

1. Open https://script.google.com with the **same Google account** that Cube ACR uploads to → **New project** → name it *Cube ACR Transcripts Sync*.
2. Replace `Code.gs` with the contents of `apps-script/Code.gs` from this repo.
3. *Project Settings* (gear) → tick **Show "appsscript.json" manifest file in editor** → replace it with `apps-script/appsscript.json` (optionally change `timeZone`).
4. *Project Settings → Script Properties* → add `WORKER_URL`, `MCP_TOKEN`, `DRIVE_FOLDER_ID`, and optionally `ALERT_EMAIL` (address for "OpenAI out of credit" emails). Give them the exact values from steps 1 and 4.
5. In the editor, select the function **`setup`** → **Run** → approve Google's permission prompts.

**Option B — agent pushes the code with clasp.**

```bash
# 👤 first: enable "Google Apps Script API" at https://script.google.com/home/usersettings
npx @google/clasp login                 # 👤 approves in the browser
npx @google/clasp create --type standalone --title "Cube ACR Transcripts Sync" --rootDir apps-script
npx @google/clasp push -f
npx @google/clasp open-script           # prints/opens the editor URL (older clasp: `clasp open`)
```

`clasp create` writes `.clasp.json` (git-ignored). The person still has to do items 4 and 5 of option A (Script Properties and running `setup`), because those need their approval in Google's UI.

## Step 6 — Confirm the pipeline · 🤖 AGENT

Wait 5–10 minutes after `setup` ran, then:

```bash
curl -s "$WORKER_URL/ingest/$MCP_TOKEN/health"
```

- `pending` should rise when recordings arrive, then fall as they're transcribed.
- `alert` not null → OpenAI rejected the key or has no credit. Tell the person to fix billing; nothing is lost.
- If nothing arrives, ask the person to open the Apps Script **Executions** page and paste you the error. Common causes: wrong `DRIVE_FOLDER_ID`, `WORKER_URL` with a typo, `MCP_TOKEN` mismatch (the Worker requires at least 24 characters).

Worker logs: `npx wrangler tail` (live) or Cloudflare dashboard → Worker → Observability.

## Step 7 — Connect Claude · 👤 HUMAN

Tell the person: in Claude open **Settings → Connectors → Add custom connector**, name it *Phone Calls*, URL:

```
<WORKER_URL>/mcp/<MCP_TOKEN>
```

Remind them the URL is a secret: anyone with it can read every transcript.

Then suggest a first prompt: *"Run sync_status on Phone Calls"*, then *"List my calls from today"*.

## Done

Summarise for the person:

- Where things live: Worker URL (without the token), Apps Script project name, Drive folders *Cube ACR* and *Cube ACR Transcripts*.
- Costs: ~$0.006 per minute of calls on OpenAI; Cloudflare and Google stay in free tiers for normal use.
- How to change settings: `RETENTION_DAYS`, `TRANSCRIBE_MODEL`, `TRANSCRIBE_LANGUAGE`, `BATCH_SIZE` in `wrangler.jsonc`, then `npx wrangler deploy`.
- How to rotate the token if it leaks: new `npm run token` → `wrangler secret put MCP_TOKEN` → update the Apps Script property → update the connector URL.

## Reference

| Endpoint | Used by | Purpose |
|---|---|---|
| `POST /mcp/<token>` | Claude | MCP (Streamable HTTP, stateless). Also accepts `Authorization: Bearer <token>`. |
| `POST /ingest/<token>/check` | Apps Script | Which Drive file ids the Worker hasn't seen |
| `POST /ingest/<token>?id=&name=...` | Apps Script | Upload one recording (body = audio bytes) |
| `GET /ingest/<token>/done` · `POST /ingest/<token>/ack` | Apps Script | Fetch finished transcripts, confirm they were saved to Drive |
| `GET /ingest/<token>/health` | Apps Script, you | OpenAI alert + pending count |
| `POST /upload/<token>` | you | Transcribe a single file right away |

MCP tools: `search_calls`, `list_calls`, `get_transcript`, `sync_status`, `sync_now`.
