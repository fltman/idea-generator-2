// The Node version guard. The one that counts is the npm scripts running it first,
// as its own command: ESM loads and links every import of this file before running any of them,
// so an import an older Node cannot load (a missing builtin, TypeScript it cannot
// strip) fails before this line runs, and the message never shows. Imported here
// as well, first, for `node server/index.ts` run by hand: there it helps only when
// everything below still loads on that Node.
import './require-node-25.js';
import { createServer } from 'node:http';
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

const engine = createEngine({ repo, chat: makeChat(runtime.get), settings: runtime.get });
const autopilot = createAutopilot({ repo, engine, settings: runtime.get }).start();

createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(root, 'public'), host: process.env.HOST, allowedHostList: process.env.ALLOWED_HOSTS })).listen(PORT, HOST, () => {
  console.log(`Idégeneratorn: http://localhost:${PORT}`);
  const auto = repo.listBoards().filter((b) => b.config.mode === 'auto');
  if (auto.length) console.log(`Autopilot on for ${auto.length} board(s); they need keys from the browser or the environment.`);
});
