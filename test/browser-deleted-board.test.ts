// The deleted-board flow in a real browser: two tabs of a headless Chrome on the same board,
// driven over the DevTools protocol. Tab A deletes the board; tab B must close its stream,
// say the board was deleted in another window and open another board, and neither tab may
// hear anything from the next board that gets the deleted board's id (the database reuses
// ids, see reused-ids.ts). Also: a DELETE that
// fails leaves A following the board, and deleting the last board opens the new-board dialog.
// Skips when no Chrome/Chromium is found (set CHROME_PATH to point at one) or Node is older than 25.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDbReusingIds } from './reused-ids.ts';
import { createEngine } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import { createHandler } from '../server/app.ts';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../server/providers.ts';

function findChrome(): string | null {
  if (process.env.CHROME_PATH) return existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null;
  const candidates =
    process.platform === 'win32'
      ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
          .filter((d): d is string => !!d)
          .map((d) => join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      : process.platform === 'darwin'
        ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  return candidates.find((p) => existsSync(p)) ?? null;
}

const chromePath = findChrome();
const nodeMajor = Number(process.versions.node.split('.')[0]);
const skip = !chromePath ? 'no Chrome or Chromium found (set CHROME_PATH)'
  : nodeMajor < 25 ? `needs Node 25 (this is Node ${process.versions.node})`
  : false;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Before any page script: English, the board to open, and a log of every EventSource and DELETE. */
const instrument = (port: number, boardId: number) => `(() => {
  if (location.port !== '${port}') return;
  localStorage.setItem('ideagen.lang', 'en');
  localStorage.setItem('ideagen.board', '${boardId}');
  const path = (u) => new URL(u, location.href).pathname;
  window.__es = []; window.__log = [];
  const Orig = window.EventSource;
  window.EventSource = class extends Orig {
    constructor(u, o) { super(u, o); window.__es.push(this); window.__log.push('open ' + path(u)); }
    close() { window.__log.push('close ' + path(this.url)); return super.close(); }
  };
  const fetch0 = window.fetch;
  window.fetch = (u, o) => { if (o?.method === 'DELETE') window.__log.push('DELETE ' + path(u)); return fetch0(u, o); };
})();`;

/** One tab, spoken to over its DevTools WebSocket. */
class Tab {
  n = 0;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  handlers: Record<string, ((p: any) => void)[]> = {};
  streams: string[] = []; // every request for an /events stream, in order
  dialogs: string[] = [];
  exceptions: string[] = [];
  name: string;
  ws: WebSocket;
  constructor(name: string, url: string) {
    this.name = name;
    this.ws = new WebSocket(url);
    this.ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data));
      if (msg.id) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(`${this.name}: ${JSON.stringify(msg.error)}`)) : p.resolve(msg.result);
      } else for (const f of this.handlers[msg.method] ?? []) f(msg.params);
    };
  }
  opened() { return new Promise<void>((r, j) => { this.ws.onopen = () => r(); this.ws.onerror = () => j(new Error(`${this.name}: no DevTools connection`)); }); }
  send(method: string, params: object = {}): Promise<any> {
    const id = ++this.n;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(event: string, f: (p: any) => void) { (this.handlers[event] ??= []).push(f); }
  async eval(expression: string): Promise<any> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`${this.name}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  // Generous: a headless Chrome on a busy machine takes several seconds for a step that is usually instant.
  async until(expression: string, what: string, ms = 20_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try { if (await this.eval(expression)) return; } catch { /* page still loading */ }
      await sleep(100);
    }
    throw new Error(`${this.name}: timed out waiting for ${what}; state: ${JSON.stringify(await this.state().catch(() => null))}`);
  }
  state(): Promise<{ board: string; log: string[]; open: string[]; toasts: string[]; dialog: string | null }> {
    return this.eval(`({
      board: document.querySelector('#board-title')?.value,
      log: window.__log,
      open: window.__es.filter((e) => e.readyState !== EventSource.CLOSED).map((e) => new URL(e.url).pathname),
      toasts: [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent),
      dialog: document.querySelector('dialog[open] h2')?.textContent ?? null,
    })`);
  }
  /** Board settings, "Delete board"; the confirm is answered OK (see openTab). */
  async deleteBoardInUi() {
    await this.eval(`document.querySelector('#board-settings-btn').click()`);
    await this.until(`document.querySelectorAll('dialog[open] button.danger').length === 1`, 'the board settings dialog');
    await this.eval(`document.querySelector('dialog[open] button.danger').click()`);
  }
}

test('deleting a board with two tabs open on it, in headless Chrome: a failed delete, the other tab, a reused id, the last board',
  { skip, timeout: 120_000 }, async () => {
  // The app in-process, as in api.test.ts. No model is ever called and the autopilot is not started.
  let settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
  let received = false;
  const runtime = { get: () => settings, set: (s: AppSettings) => { settings = s; received = true; }, received: () => received };
  const repo = openDbReusingIds();
  const engine = createEngine({ repo, settings: runtime.get, gitInit: false, chat: async () => { throw new Error('no model calls in this test'); } });
  const autopilot = createAutopilot({ repo, engine, settings: runtime.get });
  const server = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public') }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const app = `http://127.0.0.1:${port}`;
  const newBoard = async (title: string) => (await (await fetch(`${app}/api/boards`, {
    method: 'POST', headers: { Origin: app, 'Content-Type': 'application/json' }, body: JSON.stringify({ title, lang: 'en' }),
  })).json()).board;
  const keep = await newBoard('Blir kvar');
  const gone = await newBoard('Raderas'); // the newest board, so the next board created gets its id
  assert.equal(gone.id, keep.id + 1);
  const goneStream = `/api/boards/${gone.id}/events`, keepStream = `/api/boards/${keep.id}/events`;

  const profile = mkdtempSync(join(tmpdir(), 'ideagen-chrome-'));
  const chrome = spawn(chromePath!, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--window-size=1280,800', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise((r) => chrome.once('exit', r));
  const tabs: Tab[] = [];
  let dbg = '';
  try {
    // Chrome picks a free port and writes it to DevToolsActivePort in the profile.
    const portFile = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 150 && !dbg; i++) {
      const first = existsSync(portFile) ? readFileSync(portFile, 'utf8').split('\n')[0].trim() : '';
      if (/^\d+$/.test(first)) dbg = `http://127.0.0.1:${first}`;
      else await sleep(100);
    }
    assert.ok(dbg, 'Chrome started with a DevTools port');

    const openTab = async (name: string) => {
      const info = await (await fetch(`${dbg}/json/new?about:blank`, { method: 'PUT' })).json();
      const tab = new Tab(name, info.webSocketDebuggerUrl);
      tabs.push(tab);
      await tab.opened();
      for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) await tab.send(m);
      await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: instrument(port, gone.id) });
      tab.on('Network.requestWillBeSent', (e) => { const p = new URL(e.request.url).pathname; if (p.endsWith('/events')) tab.streams.push(p); });
      tab.on('Runtime.exceptionThrown', (e) => tab.exceptions.push(e.exceptionDetails.exception?.description ?? e.exceptionDetails.text));
      tab.on('Page.javascriptDialogOpening', (e) => { tab.dialogs.push(`${e.type}: ${e.message}`); tab.send('Page.handleJavaScriptDialog', { accept: true }); });
      await tab.send('Page.navigate', { url: app });
      await tab.until(`document.querySelector('#board-title')?.value === 'Raderas' && window.__es?.[0]?.readyState === EventSource.OPEN`,
        `${name} on "Raderas" with its stream open`);
      return tab;
    };
    const A = await openTab('A');
    const B = await openTab('B');
    /** The page's log entries after the first n. */
    const logSince = async (tab: Tab, n: number) => (await tab.state()).log.slice(n);

    // 1. The DELETE fails (Chrome answers it with a 500; the server never sees it): A follows the board again.
    let failed = 0;
    A.on('Fetch.requestPaused', (e) => {
      if (e.request.method !== 'DELETE') return A.send('Fetch.continueRequest', { requestId: e.requestId });
      failed++;
      A.send('Fetch.fulfillRequest', {
        requestId: e.requestId, responseCode: 500, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
        body: Buffer.from(JSON.stringify({ error: 'Disk full (test)', code: 'test_failure' })).toString('base64'),
      });
    });
    await A.send('Fetch.enable', { patterns: [{ urlPattern: `*/api/boards/${gone.id}`, requestStage: 'Request' }] });
    let a0 = (await A.state()).log.length, b0 = (await B.state()).log.length;
    await A.deleteBoardInUi();
    await A.until(`[...document.querySelectorAll('#toasts .toast')].some((t) => t.textContent.includes('Disk full (test)'))`, 'A to show the error');
    await A.until(`window.__es.at(-1).readyState === EventSource.OPEN`, 'A to follow the board again');
    await A.send('Fetch.disable');
    assert.equal(failed, 1, 'the DELETE was answered with a 500');
    assert.ok(repo.getBoard(gone.id), 'the board still exists');
    assert.deepEqual(await logSince(A, a0), [`close ${goneStream}`, `DELETE /api/boards/${gone.id}`, `open ${goneStream}`],
      'A stopped following, the DELETE failed, A follows the board again');
    assert.deepEqual((await A.state()).open, [goneStream]);
    assert.deepEqual(await logSince(B, b0), [], 'B noticed nothing');
    assert.deepEqual((await B.state()).open, [goneStream]);
    // Both streams still carry the board's events: a rename reaches both tabs.
    engine.updateBoard(gone.id, { title: 'Raderas nu' });
    for (const tab of [A, B]) await tab.until(`document.querySelector('#board-title')?.value === 'Raderas nu'`, `${tab.name} to hear the rename`);
    await A.eval(`document.querySelector('dialog[open] button[value="cancel"]').click()`); // the user closes board settings
    await A.until(`!document.querySelector('dialog[open]')`, 'board settings to close');

    // 2. The DELETE goes through: B closes its stream, says so, and both open the remaining board.
    a0 = (await A.state()).log.length; b0 = (await B.state()).log.length;
    await A.deleteBoardInUi();
    await B.until(`document.querySelector('#board-title')?.value === 'Blir kvar'`, 'B to open the remaining board');
    await A.until(`document.querySelector('#board-title')?.value === 'Blir kvar'`, 'A to open the remaining board');
    await sleep(200);
    let a = await A.state(), b = await B.state();
    assert.deepEqual(A.dialogs, ['Raderas', 'Raderas nu'].map((t) => `confirm: Delete the board "${t}" with all its ideas?`));
    assert.deepEqual(a.log.slice(a0), [`close ${goneStream}`, `DELETE /api/boards/${gone.id}`, `open ${keepStream}`],
      'A stops following before it deletes, then follows the remaining board');
    assert.deepEqual(b.log.slice(b0), [`close ${goneStream}`, `open ${keepStream}`],
      'B closes its stream on the deleted event and follows the remaining board');
    assert.ok(b.toasts.includes('The board "Raderas nu" was deleted in another window'), `B says so: ${JSON.stringify(b.toasts)}`);
    assert.ok(!a.toasts.some((t) => t.includes('deleted in another window')), 'A deleted it itself: no such message');
    assert.deepEqual([a.open, b.open], [[keepStream], [keepStream]]);

    // 3. The next board gets the deleted board's id. A change to it must reach neither tab:
    // a tab still on its stream would take its title from the 'board' event.
    const reused = await newBoard('Ny med samma id');
    assert.equal(reused.id, gone.id, 'the id is reused');
    engine.updateBoard(reused.id, { title: 'Inte din tavla' });
    await sleep(1500);
    for (const [tab, connects] of [[A, 2], [B, 1]] as const) { // A: on load and after the failed DELETE; B: on load
      const s = await tab.state();
      assert.equal(s.board, 'Blir kvar', `${tab.name} heard nothing from the new board`);
      assert.deepEqual(s.open, [keepStream], `${tab.name} has no stream open to the reused id`);
      assert.equal(tab.streams.filter((p) => p === goneStream).length, connects, `${tab.name} connected to ${goneStream} only before the delete`);
    }

    // 4. The last board: with the reused board gone too, A deletes "Blir kvar". Both tabs end on the new-board dialog.
    engine.deleteBoard(reused.id); // no tab follows it
    a0 = (await A.state()).log.length; b0 = (await B.state()).log.length;
    await A.deleteBoardInUi();
    const newBoardDialog = `document.querySelector('dialog[open]')?.textContent.includes('Welcome! Start with a board and a goal.')`;
    await A.until(newBoardDialog, 'A to open the new-board dialog');
    await B.until(newBoardDialog, 'B to open the new-board dialog');
    a = await A.state(); b = await B.state();
    assert.deepEqual(repo.listBoards(), [], 'no board left');
    assert.equal(A.dialogs.at(-1), 'confirm: Delete the board "Blir kvar" with all its ideas?');
    assert.deepEqual(a.log.slice(a0), [`close ${keepStream}`, `DELETE /api/boards/${keep.id}`], 'A follows nothing afterwards');
    assert.deepEqual(b.log.slice(b0), [`close ${keepStream}`], 'B follows nothing afterwards');
    assert.ok(b.toasts.includes('The board "Blir kvar" was deleted in another window'), `B says so: ${JSON.stringify(b.toasts)}`);
    assert.deepEqual([a.open, b.open, a.dialog, b.dialog], [[], [], 'New board', 'New board']);
    for (const tab of [A, B]) assert.deepEqual(tab.exceptions, [], `${tab.name} threw nothing`);
  } finally {
    for (const tab of tabs) tab.ws.close();
    // Close Chrome through DevTools so its child processes let go of the profile; kill it if that fails.
    if (dbg) {
      try {
        const { webSocketDebuggerUrl } = await (await fetch(`${dbg}/json/version`)).json();
        const browser = new WebSocket(webSocketDebuggerUrl);
        await new Promise((r, j) => { browser.onopen = r; browser.onerror = j; });
        browser.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
      } catch { /* killed below */ }
    }
    if (await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]) === false) {
      chrome.kill();
      await Promise.race([exited, sleep(5000)]);
    }
    server.closeAllConnections();
    server.close();
    // A profile Chrome still holds must not hide the test's own failure.
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); }
    catch (e) { console.warn(`could not remove ${profile}: ${e}`); }
  }
});
