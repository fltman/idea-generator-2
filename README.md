# Idégeneratorn · Idea Generator

[![Support me on Patreon](https://img.shields.io/badge/Patreon-Support%20my%20work-FF424D?style=flat&logo=patreon&logoColor=white)](https://www.patreon.com/AndersBjarby)

An idea board where language models branch, cross and judge ideas, and an evolution autopilot breeds the best ones.

Each board has a **goal** that every step works toward. Seed it with a thought, a link or a lead from the scouts. Then branch ideas, drag one idea onto another to cross them, and let a calibrated jury score each one on originality, feasibility and impact, with a reason. Gold ideas turn into **Claude Code project folders** by themselves.

## What it does

- **Boards with their own goal and setup.** Each board has its own creation flow (prompts), jury guidance, scouts, models, autopilot and limits. Templates only seed a new board.
- **Canvas.** Infinite pan and zoom with a force layout, so families cluster. Drag an idea onto another to cross them. Hovering lights up an idea's whole lineage, and a ball grows with its score.
- **Explainable jury.** Originality, feasibility and impact are scored 1–5 each, with a one-sentence reason and 2–4 keywords. The medal is computed in code: bronze from 9/15, silver from 11, gold from 13. It is calibrated against reference ideas (`npm run calibrate`), and gold is rare on purpose.
- **Evolution autopilot (server-side).** Boards set to *automatic* breed parents by tournament selection on the jury score, and now and then expand a strong idea instead. The autopilot keeps running with no browser open, within its limits:
  - steps per hour
  - USD per day per board
  - a global USD per day
  - error backoff
- **Scouts.**
  - *X trends*: Grok with live X search via OpenRouter. A lead is kept only if its post is among the search engine's own citations.
  - *AI research*: Hugging Face daily and semantic paper search, aimed at the goal.
  - Drag a lead onto the board to seed it.
- **Across boards.**
  - *Announce* an idea to other boards. It arrives as a guest, is judged against the new board's goal, and cross-breeds there.
  - Spin an idea off into a *new board* where it is the goal.
- **Claude Code projects.** One click, or the jury on gold, writes a folder containing `CLAUDE.md` (brief, MVP, first steps, open questions, lineage, verdict), `README.md`, `idea.json`, a gitignored `vault/`, and runs `git init`.
- **Board summary, keyword trend dashboard, report.**
  - *Summary*: themes, strongest ideas, gaps and next steps for one board.
  - *Dashboard*: keyword trends across boards, with sparklines and drill-down.
  - *Report*: totals, cross-board conclusions, every project with its start command, and one card per board. Exports to Markdown.
- **Exhibition mode.** Fullscreen, the camera follows new ideas, and visitors type seeds. It runs together with automatic mode.
- **Providers per role.** Every role has its own model, written `provider:model`. The roles are distill, branch, cross, judge, summary, research scout, X scout and project brief.
  - **Hosted:** OpenRouter, Anthropic (official SDK) and OpenAI.
  - **Copilot models:** neither GitHub Copilot nor Microsoft Copilot has a completion API for apps, and GitHub Models was retired on 30 July 2026. GitHub points to Microsoft Foundry, so the models behind both Copilots are reached through the Azure OpenAI / Microsoft Foundry provider.
  - **Local:** Ollama, MLX (`mlx_lm.server`), LM Studio, or any OpenAI-compatible URL.
- **Swedish and English** interface. Generated text follows the language of its seed.

## Run

Needs Node 25 or newer, which runs TypeScript directly. There is no build step.

```bash
npm install          # provider SDK and jose for OAuth identity validation
npm start            # http://localhost:8300
npm test             # fake LLM and mocked OAuth, no live providers
npm run calibrate    # real judge vs. reference ideas (~$0.07); -- --model ollama:qwen3:8b for others
```

API-key provider settings live in the browser (localStorage), including API keys, models per role, provider addresses, the projects folder and the global budget. The browser pushes them to the local server, which keeps them in memory only and never writes keys to disk. Environment variables (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`) work as a fallback.

The server listens on 127.0.0.1 only. There is no login, and keys pass through it, so **do not expose it** as is.

## ChatGPT plan (local OAuth)

Open **http://127.0.0.1:8300**, then Settings → ChatGPT plan → **Continue with ChatGPT**.
The browser asks you to register Idea Generator 2 and authorize eligible requests to use your ChatGPT plan.
Eligible Plus and Pro accounts can use this open-source flow; account, workspace, region and usage policies still apply.
No API key, client secret, partner key, or borrowed Codex client ID is needed. Remotely hosted/paid integrations require a different approval path; this app supports a single OS user on loopback only.

After sign-in, choose **Load models**, then select a `chatgpt:<model slug>` for each role you want to change.
The picker uses the active account’s catalog and display names. Existing role defaults and all API-key/local providers are preserved.
The X scout still requires OpenRouter. ChatGPT judge models have **not** been calibrated: changing a judge requires the separate, paid calibration run.

- Add or reauthorize accounts/workspaces individually in the account selector. Registrations stay separate even when emails match.
- Cancel sign-in in Settings, close its popup, or close Settings to abandon a pending attempt. It also expires after ten minutes.
- If plan permission was declined, select **Enable plan usage** or choose another provider. Inference never silently changes billing providers.
- **Manage usage** opens [ChatGPT usage settings](https://chatgpt.com/settings/usage). These requests consume plan allowance or credits; a recorded cost of $0 means **unmetered by this app**, not free. The app’s USD budget does not cap ChatGPT usage. On a reported usage-limit error, new ChatGPT inference pauses until you explicitly resume in Settings.
- Sign out attempts remote session revocation, clears local tokens and retains the account/client registration for later sign-in. If revocation cannot be confirmed, disconnect the app in ChatGPT Settings.

OAuth credentials are separate from settings: `~/.config/idea-generator-2/chatgpt/credentials.json`, in an owner-only directory (0700), atomically written with mode 0600. Access, refresh and retained ID tokens never enter browser storage, the board database, URLs, or logs. Protect this directory like a password; it is not encrypted at rest. An optional server-side `IDEAGEN_CHATGPT_DIR` selects another private directory, useful for isolated testing. Do not commit it or share it between OS users. A stable, opaque host ID survives restarts/sign-outs.

Only one process can open a credential directory. Normal shutdown releases its lock. After a crash, first verify the PID in its `lock` file is no longer running, then remove that stale lock. Do not delete the credential file or host ID to unlock it.

OAuth is disabled unless `HOST=127.0.0.1`. HTTP routes reject non-loopback peers, unexpected Host/Origin values and cross-site writes. This is not multi-user authentication: any local process able to reach the port can use the app. Use only on a trusted, single-user machine. Do not expose it through a tunnel or reverse proxy. Existing API-key providers retain their prior browser-storage behavior.

### Implementation and validation

The direct Responses adapter uses fixed OpenAI endpoints, `store:false`, `stream:true`, array input and `instructions`. It omits unsupported sampling/token-limit fields, and only accepts output after `response.completed`. State, browser callback binding, PKCE and OIDC nonce are fresh per attempt; JWT verification uses OpenAI’s JWKS, issuer, issued client ID and expiry. Refresh is serialized, with rotating credentials saved together. Switching/signing out aborts current ChatGPT requests.

`npm test` includes mocked OAuth/token/catalog/Responses coverage and signed test JWTs. For browser QA, run `node test/fixtures/chatgpt-ui.ts` and open its printed loopback URL; `MOCK_START_DELAY_MS=20000` adds latency for cancellation testing. This fixture uses an in-memory database and fake tokens only. It never signs into ChatGPT or makes a paid model call.

Live validation on 2026-11-09 confirmed browser consent, token exchange and model catalog loading for one account. After the compatibility fix, one explicitly approved synthetic request through the normal `makeChat`/ChatGPT provider returned exactly `{"connected":true}` with `response.completed` and status `completed`. It used `gpt-6-luna`, unchanged strict JSON-schema `text.format`, `store:false`, `stream:true`, instructions and array input. No token refresh or new grant was needed. Four small live requests were made in total; no user board data or existing role settings were used.

Earlier attempts exposed a live SSE response without `Content-Type`. The provider now permits an absent header through the same incremental SSE parser, completed-status check and JSON parsing. Explicit non-SSE MIME types remain rejected; MIME matching is case-insensitive. Mocked tests cover malformed/non-event bodies, incomplete/error streams and bounded cancellation. The missing header's origin remains unresolved, but the post-fix structured-output smoke test passed despite that absent header. HTTP 200 alone is not treated as success. This small test does not validate every model, full idea-generation workload, live refresh/revocation or judge calibration. Further live validation requires explicit user approval; model availability and plan eligibility are confirmed only by the service.

Design sources:
- [OSS overview](https://developers.openai.com/siwc/token-sharing-open-source), [registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions), [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference), [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery), [UI guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)

The [Codex app-server route](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) was reviewed. It still needs this app’s OAuth authorization and token refresh. Direct Responses fits the existing provider interface without adding a subprocess or tool-execution surface.

## License

MIT
