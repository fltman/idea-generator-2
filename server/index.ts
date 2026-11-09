import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { ChatGPT } from './chatgpt.ts';
import { fileStore } from './chatgpt-store.ts';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { DEFAULT_APP_SETTINGS, makeChat, type AppSettings } from './providers.ts';
import { createEngine } from './engine.ts';
import { createAutopilot } from './autopilot.ts';
import { createHandler, type Runtime } from './app.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8300);
// Local first: loopback only. There is no login, and API keys pass through here.
const HOST = process.env.HOST ?? '127.0.0.1';

mkdirSync(join(root, 'data'), { recursive: true });
const repo = openDb(process.env.DB_FILE ?? join(root, 'data', 'ideas.db'));

// App settings belong to the browser (localStorage). It pushes them here on
// load and on every change; they are kept in memory only, never on disk.
let settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
let received = false;
const runtime: Runtime = {
  get: () => settings,
  set: (s) => {
    settings = s;
    received = true;
  },
  received: () => received,
};

// This is a single-OS-user local app, never a remotely hosted OAuth service.
const chatgpt = HOST === '127.0.0.1' ? new ChatGPT(fileStore(process.env.IDEAGEN_CHATGPT_DIR ?? join(homedir(), '.config', 'idea-generator-2', 'chatgpt'))) : undefined;
process.on('exit', () => chatgpt?.close());
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => process.exit(0));
const engine = createEngine({ repo, chat: makeChat(runtime.get, chatgpt), settings: runtime.get });
const autopilot = createAutopilot({ repo, engine, settings: runtime.get }).start();

createServer(createHandler({ repo, engine, autopilot, runtime, chatgpt, publicDir: join(root, 'public') })).listen(PORT, HOST, () => {
  console.log(`Idégeneratorn: http://localhost:${PORT}`);
  const auto = repo.listBoards().filter((b) => b.config.mode === 'auto');
  if (auto.length) console.log(`Autopilot on for ${auto.length} board(s); they need keys from the browser or the environment.`);
});
