# Tryvera

📜 **Version history:** see [CHANGELOG.md](CHANGELOG.md) for all notable project changes (server, client, and the Tryvify extension), newest first.

### Guidance to use this app best to get highest quality resume, cv and answers

- template should look great.
- you'd better understand at least the high level flow if not entire code, to give the best prompt
- I suggest you tailoring your prompt to your resume. e.g. if your resume has only 1 company experience, when your resume is splitted into projects under companies, if your resume has many companies, your prompts should look different for each c
- 
- 
- ase to maximize relevance and ATS score
- keep the titles of the companies as "Software engineer, senior software engineer", so that you can apply to all different jobs :). tailoring engine dont touch the title, just change the very high level title engineer, scientist, ops,... and it tailors your resume to perfectly match the jd while keeping trustworthiness by sticking to the last project, so feel free to apply to any jobs.

Pre-apply document generator (profiles, job apply, generated resume/CV/answers). See `server/README.md` and `client/README.md` for details.

## Quick usage manual

1. **Profiles**
   - Create/select a profile and fill basic info, experience, skills, and education.
   - Save anytime with **Save profile** or keyboard shortcut **Ctrl+S / Cmd+S** on the Profiles page.
2. **Config**
   - Choose LLM provider/model.
   - Edit **résumé** and **CV** prompts only (variants, **Save draft**, **Set active**). Extraction and application-answer prompts are **not** editable here; they live in code (see below).
3. **Job Apply**
   - Paste JD + optional apply form text.
   - **Generate** toggles: résumé PDF, CV PDF, **Generate answers** (explicit questions from JD/apply form), **Generate fit answer** (constant “top choice / good fit” question when you need a fallback or want it appended). When any answering mode is on, the extraction step receives your **profile JSON** as context.
   - **Ignore duplicate check** skips both duplicate guards for that run (same normalized job link, same company+role). It defaults **off** each time and is **not** remembered in the browser.
4. **Result**
   - Review artifacts, role summary, requirements, extracted questions, and answers.
   - **Run options** shows the exact checkbox flags (`gen_resume`, `gen_cv`, `gen_answers`, `gen_fit_answer`, `ignore_duplicate_check`). **LLM config** shows `provider` and `model` as stored in `result.json`.
5. **Logs**
   - Open past runs quickly; with `ENPPLY_VERBOSE=1`, inspect detailed trace logs under `data/logs/verbose/`.

## Quick start

From the repo root:

```bash
npm install
```

Copy `.env.template` to `.env` and set the API key for the **LLM provider** you choose under **Config** (e.g. **`OPENROUTER_API_KEY`**, **`OPENAI_API_KEY`**, or **`DEEPSEEK_API_KEY`** — see [OpenRouter](https://openrouter.ai/keys), [OpenAI](https://platform.openai.com/account/api-keys), [DeepSeek](https://platform.deepseek.com/api_keys)). Invalid keys yield **401**; the app still builds PDFs using **placeholder** text until a key works.

```bash
npm run dev
```

This runs the API and the Vite client (see root `package.json` scripts).

### Dev URLs and ports

| What                                       | URL / port                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| **Web UI (use this in the browser)** | **http://localhost:5173** — Vite serves the React app and proxies `/api` to the server.   |
| **API only**                         | **http://localhost:3001** (or `PORT` in `.env`) — e.g. http://localhost:3001/api/health |

You normally open **5173**, not 3001.

---

## Extraction and answers (fixed prompts)

JD metadata and answers come from a **single extraction LLM** call. The system prompt is chosen from four fixed cases (`gen_answers` × `gen_fit_answer`):

| `gen_answers` | `gen_fit_answer` | Behavior                                                    |
| --------------- | ------------------ | ----------------------------------------------------------- |
| off             | off                | No `questions` / `answers`; metadata only.              |
| on              | off                | Explicit questions from JD/apply form + answers.            |
| off             | on                 | Only the constant fit question + answer.                    |
| on              | on                 | Explicit questions**plus** the constant fit question. |

Prompt text lives in `server/src/extractionAnswerPrompt.ts` (shared fragments plus four modes: no answers, explicit answers, fit-only, explicit + fit). No separate “answers” LLM step.

Résumé/CV tailoring still uses configurable prompts under **Config**, stored git-tracked in `server/prompt-defaults/resume/`, `server/prompt-defaults/coverLetter/`, etc.

---

## Duplicate detection

By default the app blocks:

1. **Duplicate job link** — same **resume profile** and same normalized job URL as another run (checked before generation runs).
2. **Duplicate company + role** — same normalized company + role + **resume profile** as another run (checked after extraction).

Check **Ignore duplicate check** on Job Apply to skip both for that run only.

---

**Do not use `http://localhost:3001/apply` for day‑to‑day development.** Port 3001 is the API server; if a `client/dist` folder exists from a previous `npm run build`, Express may serve that **old** static build. You will see an outdated UI. **Use 5173** for the live React app.

If **5173** says “connection refused,” the Vite client is not running. From the repo root run **`npm run dev`** (starts **both** `server` and `client`). If you only run `npm run dev -w server`, 5173 will not start. Check the terminal: you should see both `server` and `client` lines, and Vite should print `Local: http://localhost:5173/`.

---

## Where data is stored

| Location                   | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server (disk)**    | Under the repo by default:`data/profiles/*.json` (profiles), `data/application_logs.json` (generation log), `server/prompt-defaults/` (git-tracked résumé + cover-letter prompt variants and `active.json`; override with `PROMPTS_DIR`), `data/app_settings.json` (paths/themes/LLM). **Fixed extraction/answer prompts:** `server/src/extractionAnswerPrompt.ts`. **HTML PDF themes:** `server/templates/*.html` + `server/templates/registry.json` (see `server/templates/README.md`). Generated runs go under `default_output_path` as `MM_DD/<resume_profile_id>/<HHMMSS_company_role>/` (JST), with PDFs named `<profile_id>.pdf` / `<profile_id>_cv.pdf`. Each run’s `result.json` includes `generation_options`, `llm_config`, and artifacts. |
| **Client (browser)** | The Job Apply page stores last profile, theme, and generation checkboxes (not**Ignore duplicate check**) in `localStorage` for convenience.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

If generation shows **placeholder** documents, check the **server terminal** for `[enpply] LLM ERROR ▼` — it logs HTTP status, provider error fields (`code`, `param`, `type`), and stack traces (API keys are never printed). At generation start you should see `[enpply] LLM env:` with whether `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY` / `OPENAI_API_KEY` is set (length only). The provider in **Config** must match the key you put in `.env`.

---

## Windows: `npm.ps1 cannot be loaded` / execution policy

PowerShell may block the `npm` command because it runs `npm.ps1`, and your **execution policy** disallows scripts.

**Option A — Use the `.cmd` shim (no policy change):**

```powershell
npm.cmd run dev
```

Or from Command Prompt (`cmd.exe`) instead of PowerShell:

```bat
npm run dev
```

**Option B — Allow local scripts for your user (recommended if you use PowerShell often):**

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Then close and reopen the terminal; `npm run dev` should work.

**Option C — Bypass only for the current PowerShell session:**

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
npm run dev
```

For more detail: [about_Execution_Policies](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_execution_policies).

## Serving over HTTPS on a Windows VPS (Caddy)

The production deployment at `tealbridge.online` runs the Express server on `localhost:3001` and lets [Caddy](https://caddyserver.com/) terminate TLS in front of it. Caddy auto-provisions a Let's Encrypt cert on first start and redirects HTTP→HTTPS.

**Prerequisites**
- Public DNS A-record pointing your domain at the VPS IP (verify with `nslookup yourdomain.com 8.8.8.8`).
- `caddy.exe` on disk (this VPS keeps it at `C:\Caddy\caddy.exe`).
- `.env` has `PORT=3001` (NOT `80` — Caddy needs 80 for the ACME HTTP-01 challenge and the redirect).
- Inbound TCP **80** and **443** allowed in Windows Firewall:
  ```powershell
  New-NetFirewallRule -DisplayName 'Caddy HTTPS (443)' -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
  ```

**`C:\Caddy\Caddyfile`**
```
tealbridge.online {
    reverse_proxy localhost:3001
}
```
Replace `tealbridge.online` with your domain.

**Start order (matters — Caddy needs port 80 free at startup)**

1. Make sure nothing is on port 80:
   ```powershell
   netstat -ano | Select-String ':80 .*LISTENING'
   # If a node.exe is bound to 80, stop it: Stop-Process -Id <pid> -Force
   ```
2. Start Caddy (detached, runs in background):
   ```powershell
   cd C:\Caddy
   .\caddy.exe start --config Caddyfile
   ```
   First run takes ~20–30s while ACME issues the cert. Logs land in `%APPDATA%\Caddy`.
3. Start the Tryvera server on 3001:
   ```powershell
   cd C:\Users\Administrator\Music\Enpply-and-others\server
   Start-Process -FilePath node.exe -ArgumentList 'dist/index.js' -WindowStyle Hidden
   ```
   (Or `npm run start -w server` from the repo root in a cmd window you can leave open.)
4. Verify:
   ```powershell
   Invoke-WebRequest https://yourdomain.com/api/health -UseBasicParsing
   # Expect: StatusCode 200, body {"ok":true}
   ```

**Stopping / reloading**
```powershell
cd C:\Caddy
.\caddy.exe stop                          # stop
.\caddy.exe reload --config Caddyfile     # apply Caddyfile edits without dropping connections
```

**Reboot persistence (not yet configured).** Both Caddy and the node server are launched manually — they do NOT come back after a reboot. Either install Caddy as a Windows service (`caddy.exe service install`) and add a Task Scheduler entry to start node at logon, or use `nssm` / `pm2-windows-service` to wrap node.

## How to enable downloading on user side:

1. Open **Windows Security** → **Virus & threat protection** → **Manage settings** → **Add or remove exclusions** → **Add an exclusion → Folder** → pick whichever folder you just chose in Settings.

2. In chrome, 
chrome://flags/#unsafely-treat-insecure-origin-as-secure
and add domain

Then retry — `close()` will go through in tens of milliseconds instead of racing with Defender's `.pdf` scan.

FAQ: 
- When pdf template is not being applied, (this happends espeically wehn the server is running on vps)
The reason is because chromium app is not being launched. We should manually launch it at least once.

In powershell

$p = Start-Process "C:\Users\Administrator\.cache\puppeteer\chrome\win64-146.0.7680.153\chrome-win64\chrome.exe" -PassThru -Wait

And in commmand shell

"C:\Users\Administrator\.cache\puppeteer\chrome\win64-146.0.7680.153\chrome-win64\chrome.exe"
Check both of the commands run chromium app successfully.




Tryvify password rule: R123!@#qweQWE (R: the first character of the profiles first name)