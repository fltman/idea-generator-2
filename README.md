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
npm install          # one dependency: @anthropic-ai/sdk
npm start            # http://localhost:8300
npm test             # 58 tests, fake LLM, no network
npm run calibrate    # real judge vs. reference ideas (~$0.07); -- --model ollama:qwen3:8b for others
```

All app settings live in the browser (localStorage), including API keys, models per role, provider addresses, the projects folder and the global budget. The browser pushes them to the local server, which keeps them in memory only and never writes keys to disk. Environment variables (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AZURE_OPENAI_API_KEY`) work as a fallback.

The server listens on 127.0.0.1 only. There is no login, and keys pass through it, so **do not expose it** as is.

## License

MIT
