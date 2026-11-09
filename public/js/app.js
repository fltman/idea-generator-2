// The app: boards, the canvas, panels, dialogs, live updates.

import { chatgptPanel } from './chatgpt.js';
import { api, follow } from './api.js';
import { $, h, clear, toast, debounce } from './dom.js';
import { t, getLang, setLang, applyI18n, errorText } from './i18n.js';
import { Graph, KIND_COLORS } from './graph.js';
import { loadSettings, saveSettings, pushSettings, ROLES, PROVIDER_IDS, providersInUse, DEFAULTS } from './settings.js';
import { medal, scoreSum, fitness, CRITERIA } from './score.js';
import { evolutionStats } from './evolve.js';
import { openDashboard } from './dashboard.js';
import { openReport } from './report.js';

const MEDAL_ICON = ['–', '🥉', '🥈', '🥇'];
const S = {
  boards: [], board: null, ideas: new Map(), edges: [], leads: [], spinoffs: [], judging: new Set(),
  autopilot: { state: 'manual' }, spentToday: 0, selected: null, templates: [], providers: null,
  settings: loadSettings(), stopFollow: null, createAt: null, leadsTab: 'x', refreshing: {}, exhibit: false,
};
const fail = (e) => toast(errorText(e), 'error', 8000);
/** Built-in template names are bilingual ("Uppfinnaren · Inventor"); show the half that matches the UI. */
const localName = (name) => {
  const m = /^(.+?) · (.+)$/.exec(name);
  return m ? (getLang() === 'en' ? m[2] : m[1]) : name;
};
const ideaList = () => [...S.ideas.values()];

// ================================================================ canvas

const graph = new Graph($('#canvas'), {
  select(id) {
    S.selected = id;
    graph.select(id);
    renderPanel();
  },
  hover(id, e) {
    const card = $('#hovercard');
    if (id == null || S.exhibit) return card.classList.remove('show');
    const idea = S.ideas.get(id);
    if (!idea) return;
    const sum = scoreSum(idea);
    clear(card, h('strong', {}, idea.title), idea.pitch ? h('p', {}, idea.pitch) : null,
      sum != null ? h('div', { class: 'muted' }, `${sum}/15 ${medal(idea) ? MEDAL_ICON[medal(idea)] : ''}`) : null);
    card.classList.add('show');
    if (e) moveCard(e);
  },
  combine: (a, b) => combine(a, b),
  expand: (id) => expand(id),
  create(x, y) {
    S.createAt = { x, y };
    $('#seed-input').focus();
  },
  moved: debounce(() => savePositions(), 1200),
  dropLead: (id, x, y) => seedLead(id, x, y),
});
// ?debug exposes the canvas for scripted demos and tests (node positions, camera).
if (new URLSearchParams(location.search).has('debug')) window.ideagen = { graph, state: () => S };

const moveCard = (e) => {
  const card = $('#hovercard');
  card.style.left = `${Math.min(e.clientX + 16, innerWidth - card.offsetWidth - 12)}px`;
  card.style.top = `${Math.min(e.clientY + 16, innerHeight - card.offsetHeight - 12)}px`;
};
$('#canvas').addEventListener('pointermove', (e) => $('#hovercard').classList.contains('show') && moveCard(e));

async function savePositions() {
  if (!S.board) return;
  try {
    await api('PUT', `/api/boards/${S.board.id}/positions`, { positions: graph.positions() });
  } catch (e) {
    console.warn('positions', e);
  }
}

// ================================================================ boards

async function loadBoards() {
  S.boards = (await api('GET', '/api/boards')).boards;
  renderBoardMenu();
}

async function openBoard(id) {
  S.stopFollow?.();
  const data = await api('GET', `/api/boards/${id}`);
  S.board = data.board;
  S.ideas = new Map(data.ideas.map((i) => [i.id, i]));
  S.edges = data.edges;
  S.leads = data.leads;
  S.spinoffs = data.spinoffs;
  S.judging = new Set(data.judging);
  S.autopilot = data.autopilot;
  S.spentToday = data.spentToday;
  S.selected = null;
  localStorage.setItem('ideagen.board', String(id));
  graph.setData(data.ideas, data.edges, data.judging);
  S.stopFollow = follow(id, onEvent);
  renderAll();
}

function onEvent(e) {
  switch (e.type) {
    case 'hello':
      S.autopilot = e.autopilot;
      renderAutopilot();
      // The server restarted and lost the settings it only keeps in memory: hand them over again.
      if (!e.settingsReceived) pushSettings(S.settings).then((p) => (S.providers = p)).catch(fail);
      break;
    case 'ideas':
      for (const idea of e.ideas) {
        const before = S.ideas.get(idea.id);
        S.ideas.set(idea.id, idea);
        graph.upsert(idea);
        if (medal(idea) === 3 && (!before || medal(before) !== 3)) {
          graph.burst(idea.id);
          toast(t('gold', { t: idea.title }), 'good');
        }
      }
      renderPanelSoon();
      break;
    case 'edges':
      for (const ed of e.edges) if (!S.edges.some((x) => x.from === ed.from && x.to === ed.to)) S.edges.push(ed);
      graph.addEdges(e.edges);
      break;
    case 'removed':
      for (const id of e.ids) {
        S.ideas.delete(id);
        S.edges = S.edges.filter((x) => x.from !== id && x.to !== id);
        graph.remove(id);
        if (S.selected === id) S.selected = null;
      }
      renderPanelSoon();
      break;
    case 'judging':
      for (const id of e.ids) e.on ? S.judging.add(id) : S.judging.delete(id);
      graph.setJudging(e.ids, e.on);
      if (e.ids.includes(S.selected)) renderPanelSoon();
      break;
    case 'board':
      S.board = e.board;
      renderHeader();
      renderPanelSoon();
      renderLeads();
      break;
    case 'leads':
      S.leads = [...S.leads.filter((l) => l.source !== e.source), ...e.leads];
      renderLeads();
      break;
    case 'autopilot':
      S.autopilot = e.status;
      if (e.status.spentToday != null) S.spentToday = e.status.spentToday;
      renderAutopilot();
      if (e.status.state === 'error' && e.status.code === 'no_key') toast(errorText(e.status), 'error', 8000);
      break;
    case 'project':
      toast(t('projectCreated', { p: e.path }), 'good', 9000);
      break;
    case 'spinoff':
      S.spinoffs.push({ ideaId: e.ideaId, boardId: e.boardId, title: e.title });
      renderPanelSoon();
      break;
    case 'error':
      fail(e);
      break;
  }
}

// ================================================================ actions

async function seedFromBar(ev) {
  ev.preventDefault();
  const input = $('#seed-input');
  const text = input.value.trim();
  if (!text || !S.board) return;
  const at = S.createAt ?? graph.viewCenter();
  S.createAt = null;
  input.disabled = true;
  const isLink = /^(https?:\/\/|www\.)\S+$/i.test(text);
  input.value = '';
  input.placeholder = isLink ? t('readingPage') : text.length > 160 ? t('thinking') : input.placeholder;
  const clearGhost = graph.addGhosts([at]);
  try {
    const { idea } = await api('POST', `/api/boards/${S.board.id}/seed`, { text, x: at.x, y: at.y });
    S.ideas.set(idea.id, idea);
    graph.upsert(idea);
  } catch (e) {
    input.value = text;
    fail(e);
  } finally {
    clearGhost();
    input.disabled = false;
    input.placeholder = t('seedPlaceholder');
    input.focus();
  }
}

async function expand(id) {
  graph.setBusy([id], true);
  const clearGhosts = graph.addGhosts(graph.ghostsAround(id));
  try {
    const r = await api('POST', `/api/ideas/${id}/expand`, {});
    for (const i of r.ideas) { S.ideas.set(i.id, i); graph.upsert(i); }
    graph.addEdges(r.edges);
  } catch (e) {
    fail(e);
  } finally {
    clearGhosts();
    graph.setBusy([id], false);
  }
}

async function combine(a, b) {
  const na = graph.nodes.get(a), nb = graph.nodes.get(b);
  graph.setBusy([a, b], true);
  const clearGhosts = na && nb ? graph.addGhosts([{ x: (na.x + nb.x) / 2, y: (na.y + nb.y) / 2 }]) : () => {};
  try {
    const r = await api('POST', `/api/boards/${S.board.id}/combine`, { a, b });
    S.ideas.set(r.idea.id, r.idea);
    graph.upsert(r.idea);
    graph.addEdges(r.edges);
  } catch (e) {
    fail(e);
  } finally {
    clearGhosts();
    graph.setBusy([a, b], false);
  }
}

async function seedLead(id, x, y) {
  try {
    const r = await api('POST', `/api/leads/${id}/seed`, x == null ? {} : { x, y });
    S.ideas.set(r.idea.id, r.idea);
    graph.upsert(r.idea);
    graph.focusOn(r.idea.id, null);
  } catch (e) {
    fail(e);
  }
}

async function refreshLeads(source) {
  S.refreshing[source] = Date.now();
  renderLeads();
  const tick = setInterval(renderLeads, 1000);
  try {
    const r = await api('POST', `/api/boards/${S.board.id}/leads/${source}`, {});
    S.leads = [...S.leads.filter((l) => l.source !== source), ...r.leads];
    if (r.empty) toast(t('leadsNone'));
    else if (r.dropped) toast(t('leadsDropped', { n: r.dropped }));
  } catch (e) {
    fail(e);
  } finally {
    clearInterval(tick);
    delete S.refreshing[source];
    renderLeads();
  }
}

async function patchBoard(patch) {
  try {
    const { board } = await api('PATCH', `/api/boards/${S.board.id}`, patch);
    S.board = board;
    S.boards = S.boards.map((b) => (b.id === board.id ? { ...b, ...board } : b));
    renderHeader();
    renderBoardMenu();
    return board;
  } catch (e) {
    fail(e);
  }
}

// ================================================================ header

function renderHeader() {
  const b = S.board;
  if (!b) return;
  $('#board-title').value = b.title;
  $('#board-goal').value = b.goal;
  $('#board-goal').title = b.goal || t('goal');
  $('#board-goal').placeholder = t('noGoal');
  $('#board-origin').replaceChildren(
    b.originBoardId
      ? h('button', { class: 'linkish', onclick: () => openBoard(b.originBoardId) }, `↳ ${b.originIdeaTitle} · ${b.originBoardTitle}`)
      : '',
  );
  const usesChatGPT = ROLES.some(r => (b.config.models?.[r] || S.settings.models[r]).startsWith('chatgpt:'));
  const usage = $('#chatgpt-usage');
  usage.hidden = !usesChatGPT;
  clear(usage, getLang() === 'en' ? 'Using ChatGPT plan · ' : 'Använder ChatGPT-plan · ', h('a', { href: 'https://chatgpt.com/settings/usage', target: '_blank', rel: 'noopener noreferrer' }, getLang() === 'en' ? 'Manage usage' : 'Hantera användning'));
  const auto = b.config.mode === 'auto';
  const btn = $('#mode-toggle');
  btn.textContent = auto ? t('auto') : t('manual');
  btn.classList.toggle('on', auto);
  btn.setAttribute('aria-pressed', String(auto));
  $('#ex-title').textContent = b.title;
  $('#ex-goal').textContent = b.goal;
  renderAutopilot();
}

function renderAutopilot() {
  const st = S.autopilot ?? { state: 'manual' };
  const chip = $('#ap-status');
  if (S.board?.config.mode !== 'auto') {
    chip.textContent = '';
    chip.className = 'ap-chip';
    return;
  }
  const secs = st.until ? Math.max(0, Math.ceil((st.until - Date.now()) / 1000)) : 0;
  const time = st.until ? new Date(st.until).toLocaleTimeString(getLang() === 'sv' ? 'sv-SE' : 'en-GB', { hour: '2-digit', minute: '2-digit' }) : '';
  const key = st.state === 'idle' ? (st.last === 'empty' ? 'ap_idle_empty' : st.last === 'nothing_to_do' ? 'ap_idle_nothing' : 'ap_idle') : `ap_${st.state}`;
  chip.textContent = t(key, { s: `${secs} s`, time, m: st.message ?? '' });
  chip.title = t('apMeta', { n: st.stepsLastHour ?? 0, usd: (st.spentToday ?? S.spentToday ?? 0).toFixed(3) });
  chip.className = `ap-chip ${['error', 'backoff', 'board_budget', 'global_budget', 'hourly'].includes(st.state) ? 'warn' : st.state === 'running' ? 'busy' : ''}`;
  $('#ex-status').textContent = chip.textContent;
}
setInterval(() => S.autopilot?.until && renderAutopilot(), 1000);

function renderBoardMenu() {
  const menu = $('#board-menu');
  clear(
    menu,
    S.boards.map((b) =>
      h('button', { class: `menu-item ${b.id === S.board?.id ? 'current' : ''}`, onclick: () => { menu.hidden = true; openBoard(b.id); } },
        h('span', { class: `dot ${b.config.mode === 'auto' ? 'auto' : ''}` }),
        h('span', { class: 'grow' }, b.title),
        h('span', { class: 'muted' }, String(b.ideaCount ?? '')),
      ),
    ),
    h('hr'),
    h('button', { class: 'menu-item', onclick: () => { menu.hidden = true; newBoardDialog(); } }, `＋ ${t('newBoard')}`),
  );
  $('#board-menu-btn').textContent = `${t('boards')} ▾`;
}

// ================================================================ right panel

let panelQueued = false;
function renderPanelSoon() {
  if (panelQueued) return;
  panelQueued = true;
  requestAnimationFrame(() => {
    panelQueued = false;
    renderPanel();
    if (S.exhibit) renderExhibit();
  });
}

function renderPanel() {
  const idea = S.selected != null ? S.ideas.get(S.selected) : null;
  if (idea) renderIdea(idea);
  else renderOverview();
}

function kindTag(idea) {
  return h('span', { class: 'kind' }, h('span', { class: 'swatch', style: { background: KIND_COLORS[idea.kind] } }), t(`kind_${idea.kind}`));
}

function scoreBlock(idea) {
  if (S.judging.has(idea.id)) return h('div', { class: 'judging' }, h('span', { class: 'spinner' }), t('judging'));
  const sum = scoreSum(idea);
  const m = medal(idea);
  if (sum == null && m == null) {
    return h('div', { class: 'muted row' }, t('notJudged'), h('button', { class: 'btn small', onclick: () => rejudge(idea.id) }, t('rejudge')));
  }
  return h('div', { class: 'score' },
    h('div', { class: 'score-head' },
      sum != null ? h('span', { class: 'big' }, `${sum}`, h('small', {}, '/15')) : null,
      m ? h('span', { class: `medal m${m}` }, MEDAL_ICON[m]) : null,
      idea.medalOverride != null ? h('span', { class: 'muted' }, `(${t('medal')}: ${MEDAL_ICON[idea.medalOverride]})`) : null,
    ),
    sum != null
      ? CRITERIA.map((c) =>
          h('div', { class: 'meter-row' },
            h('span', { class: 'meter-label' }, t(c)),
            h('span', { class: 'meter', role: 'img', 'aria-label': `${t(c)} ${idea[c]}/5` },
              [1, 2, 3, 4, 5].map((n) => h('span', { class: n <= idea[c] ? 'on' : '' }))),
            h('span', { class: 'meter-value' }, `${idea[c]}`),
          ),
        )
      : null,
    idea.reason ? h('p', { class: 'reason' }, idea.reason) : null,
  );
}

function renderIdea(idea) {
  const panel = $('#panel');
  const spun = S.spinoffs.filter((s) => s.ideaId === idea.id);
  const startCmd = idea.projectPath ? `cd "${idea.projectPath}" && claude` : '';
  const medalBtn = (value, label) =>
    h('button', {
      class: `seg ${idea.medalOverride === value ? 'on' : ''}`,
      onclick: async () => {
        try { await api('PATCH', `/api/ideas/${idea.id}`, { medalOverride: value }); } catch (e) { fail(e); }
      },
    }, label);

  clear(panel,
    h('div', { class: 'panel-top' },
      h('button', { class: 'icon-btn', title: t('close'), 'aria-label': t('close'), onclick: () => graph.h.select(null) }, '✕'),
      kindTag(idea),
      h('span', { class: 'muted' }, t('generation', { n: idea.generation })),
    ),
    idea.kind === 'guest' && idea.originBoardId
      ? h('button', { class: 'linkish', onclick: () => openBoard(idea.originBoardId) }, `↗ ${t('fromBoard', { b: idea.originBoardTitle ?? '?' })}`)
      : null,
    h('h2', {}, idea.title),
    idea.pitch ? h('p', { class: 'pitch' }, idea.pitch) : null,
    idea.sourceUrl ? h('a', { class: 'source', href: idea.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, `${t('source')} ↗`) : null,
    scoreBlock(idea),
    idea.keywords?.length
      ? h('div', { class: 'chips' }, idea.keywords.map((k) => h('button', { class: 'chip', onclick: () => openDashboard({ keyword: k, onOpenIdea }) }, k)))
      : null,
    h('div', { class: 'seg-row', role: 'group', 'aria-label': t('medal') },
      h('span', { class: 'muted' }, t('medal')),
      medalBtn(null, t('medalAuto')), medalBtn(0, '–'), medalBtn(1, '🥉'), medalBtn(2, '🥈'), medalBtn(3, '🥇'),
    ),
    h('div', { class: 'actions' },
      h('button', { class: 'btn primary', title: t('expandHint'), onclick: () => expand(idea.id) }, `＋ ${t('expand')}`),
      h('button', { class: 'btn', onclick: () => { graph.setPick(idea.id); toast(t('combinePick')); } }, `⚡ ${t('combineWith')}`),
      h('button', { class: 'btn', onclick: () => rejudge(idea.id) }, t('rejudge')),
      h('button', { class: 'btn', title: t('announceHint'), onclick: () => announceDialog(idea) }, `📣 ${t('announce')}`),
      h('button', { class: 'btn', title: t('spinoffHint'), onclick: () => spinoff(idea) }, `⤴ ${t('spinoff')}`),
    ),
    h('div', { class: 'project' },
      idea.projectPath
        ? [
            h('div', { class: 'path', title: idea.projectPath }, `📁 ${idea.projectPath}`),
            h('div', { class: 'row' },
              h('button', { class: 'btn small', onclick: () => api('POST', `/api/ideas/${idea.id}/reveal`, {}).catch(fail) }, t('revealProject')),
              h('button', { class: 'btn small', onclick: () => navigator.clipboard.writeText(startCmd).then(() => toast(t('copied'))) }, t('copyStart')),
            ),
          ]
        : h('button', { class: 'btn cc', title: t('projectHint'), onclick: (ev) => makeProject(idea, ev.currentTarget) }, `→ ${t('project')}`),
    ),
    spun.length
      ? h('div', { class: 'spinoffs' }, h('span', { class: 'muted' }, t('spinoffs')),
          spun.map((s) => h('button', { class: 'linkish', onclick: () => openBoard(s.boardId) }, `⤴ ${s.title}`)))
      : null,
    h('button', {
      class: 'btn danger small',
      onclick: async () => {
        if (!confirm(t('confirmDelete', { t: idea.title }))) return;
        try { await api('DELETE', `/api/ideas/${idea.id}`); } catch (e) { fail(e); }
      },
    }, t('deleteIdea')),
  );
}

async function rejudge(id) {
  try {
    await api('POST', `/api/ideas/${id}/judge`, {});
  } catch (e) {
    fail(e);
  }
}

async function makeProject(idea, btn) {
  btn.disabled = true;
  btn.textContent = t('projectMaking');
  try {
    const r = await api('POST', `/api/ideas/${idea.id}/project`, {});
    S.ideas.set(r.idea.id, r.idea);
    graph.upsert(r.idea);
    toast(t('projectCreated', { p: r.path }), 'good', 9000);
    renderPanel();
  } catch (e) {
    fail(e);
    btn.disabled = false;
    btn.textContent = `→ ${t('project')}`;
  }
}

async function spinoff(idea) {
  try {
    const r = await api('POST', `/api/ideas/${idea.id}/spinoff`, {});
    await loadBoards();
    await openBoard(r.board.id);
  } catch (e) {
    fail(e);
  }
}

function renderOverview() {
  const panel = $('#panel');
  const b = S.board;
  if (!b) return clear(panel);
  const ideas = ideaList();
  const stats = evolutionStats(ideas);
  const ranked = ideas.filter((i) => fitness(i) != null).sort((x, y) => fitness(y) - fitness(x)).slice(0, 12);
  const fmt = (v) => (v == null ? '–' : v.toFixed(1));
  const s = b.summary;
  clear(panel,
    h('div', { class: 'panel-top' }, h('h3', {}, t('overview'))),
    !ideas.length ? h('p', { class: 'muted' }, t('noIdeasYet')) : null,
    stats.count
      ? h('div', { class: 'evo' }, h('span', { class: 'muted' }, t('evolution')),
          h('div', {}, stats.latest != null
            ? t('evoLine', { g: stats.generation, first: fmt(stats.first), latest: fmt(stats.latest), best: stats.best })
            : t('evoShort', { g: stats.generation, best: stats.best })))
      : null,
    h('section', { class: 'summary' },
      h('div', { class: 'row space' }, h('h3', {}, t('summary')),
        ideas.length >= 2 ? h('button', { class: 'btn small', onclick: (ev) => summarize(ev.currentTarget) }, s ? t('resummarize') : t('summarize')) : null),
      s
        ? [
            s.ideaCount !== ideas.length ? h('p', { class: 'stale' }, t('summaryStale', { n: ideas.length - s.ideaCount })) : null,
            h('p', { class: 'headline' }, s.headline),
            s.themes.length ? h('h4', {}, t('themes')) : null,
            s.themes.map((th) => h('p', {}, h('strong', {}, `${th.name}. `), th.insight)),
            s.strongest.length ? h('h4', {}, t('strongest')) : null,
            h('ul', {}, s.strongest.map((x) => h('li', {}, h('strong', {}, x.title), ` – ${x.why}`))),
            s.gaps.length ? h('h4', {}, t('gaps')) : null,
            h('ul', {}, s.gaps.map((x) => h('li', {}, x))),
            s.nextSteps.length ? h('h4', {}, t('nextSteps')) : null,
            h('ul', {}, s.nextSteps.map((x) => h('li', {}, x))),
          ]
        : null,
    ),
    ranked.length ? h('h3', {}, t('topIdeas')) : null,
    h('ol', { class: 'ranking' },
      ranked.map((i) =>
        h('li', {},
          h('button', { class: 'rank-item', onclick: () => { graph.h.select(i.id); graph.focusOn(i.id, Math.max(graph.cam.k, 0.9)); } },
            h('span', { class: 'swatch', style: { background: KIND_COLORS[i.kind] } }),
            h('span', { class: 'grow' }, i.title),
            h('span', { class: 'rank-score' }, `${scoreSum(i) ?? ''} ${medal(i) ? MEDAL_ICON[medal(i)] : ''}`),
          ),
        ),
      ),
    ),
  );
}

async function summarize(btn) {
  btn.disabled = true;
  btn.textContent = t('thinking');
  try {
    const { board } = await api('POST', `/api/boards/${S.board.id}/summary`, {});
    S.board = board;
    renderPanel();
  } catch (e) {
    fail(e);
    btn.disabled = false;
  }
}

// ================================================================ leads panel

function renderLeads() {
  const root = $('#leads-panel');
  if (!S.board || root.hidden) return;
  const src = S.leadsTab;
  const cfg = S.board.config.researchers[src];
  const busy = S.refreshing[src];
  const list = S.leads.filter((l) => l.source === src);
  const tab = (id, label) => h('button', { class: `tab ${src === id ? 'on' : ''}`, role: 'tab', 'aria-selected': String(src === id), onclick: () => { S.leadsTab = id; renderLeads(); } }, label);
  clear(root,
    h('div', { class: 'tabs', role: 'tablist' }, tab('x', t('leadsX')), tab('research', t('leadsResearch'))),
    !cfg.enabled
      ? h('p', { class: 'muted' }, t('researcherOff'))
      : [
          h('div', { class: 'row space' },
            h('span', { class: 'muted small' }, S.board.goal ? `${t('goal')}: ${S.board.goal}${cfg.focus ? ` — ${cfg.focus}` : ''}` : t('noGoal')),
            h('button', { class: 'btn small', disabled: !!busy, onclick: () => refreshLeads(src) },
              busy ? `${t('refreshing')} ${Math.round((Date.now() - busy) / 1000)} s` : t('refresh')),
          ),
          !list.length ? h('p', { class: 'muted' }, t('leadsEmpty')) : h('p', { class: 'muted small' }, t('dragLead')),
          list.map((l) =>
            h('article', {
              class: `lead ${l.ideaId ? 'used' : ''}`, draggable: l.ideaId ? null : 'true',
              ondragstart: (e) => { e.dataTransfer.setData('text/x-lead', String(l.id)); e.dataTransfer.effectAllowed = 'copy'; },
            },
              h('h4', {}, l.title),
              l.summary ? h('p', {}, l.summary) : null,
              l.hook ? h('p', { class: 'hook' }, `→ ${l.hook}`) : null,
              h('div', { class: 'row space' },
                l.url ? h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', class: 'small' },
                  src === 'x' ? 'x.com ↗' : `${l.meta?.published ?? ''} ↗`) : h('span'),
                l.ideaId ? h('span', { class: 'muted small' }, `✓ ${t('onBoard')}`) : h('button', { class: 'btn small', onclick: () => seedLead(l.id) }, t('addAsSeed')),
              ),
            ),
          ),
        ],
  );
}

// ================================================================ dialogs

function dialog(id, title, body, buttons) {
  const dlg = $(`#${id}`);
  clear(dlg,
    h('form', { method: 'dialog', class: 'dlg' },
      h('header', {}, h('h2', {}, title), h('button', { class: 'icon-btn', value: 'cancel', 'aria-label': t('close') }, '✕')),
      h('div', { class: 'dlg-body' }, body),
      buttons ? h('footer', {}, buttons) : null,
    ),
  );
  dlg.showModal();
  return dlg;
}

function field(label, input, note) {
  return h('label', { class: 'field' }, h('span', {}, label), input, note ? h('small', { class: 'muted' }, note) : null);
}

async function newBoardDialog(first = false) {
  if (!S.templates.length) S.templates = (await api('GET', '/api/templates')).templates;
  const title = h('input', { required: true, placeholder: t('newBoard') });
  const goal = h('textarea', { rows: 3, placeholder: t('goalPlaceholder') });
  const tpl = h('select', {}, S.templates.map((x) => h('option', { value: x.id }, localName(x.name))));
  const dlg = dialog('dlg', t('newBoard'), [
    first ? h('p', {}, t('firstRun')) : null,
    field(t('title'), title), field(t('goal'), goal), field(t('template'), tpl),
  ], [
    h('button', { class: 'btn', value: 'cancel' }, t('cancel')),
    h('button', {
      class: 'btn primary',
      onclick: async (e) => {
        e.preventDefault();
        try {
          const { board } = await api('POST', '/api/boards', { title: title.value, goal: goal.value, templateId: Number(tpl.value), lang: getLang() });
          dlg.close();
          await loadBoards();
          await openBoard(board.id);
        } catch (err) { fail(err); }
      },
    }, t('create')),
  ]);
  title.focus();
}

async function boardSettingsDialog() {
  const b = S.board;
  if (!S.templates.length) S.templates = (await api('GET', '/api/templates')).templates;
  const c = structuredClone(b.config);
  const inp = (value, props = {}) => h('input', { value, ...props });
  const area = (value, rows = 3, props = {}) => h('textarea', { rows, ...props }, value);
  const title = inp(b.title), goal = area(b.goal, 2, { placeholder: t('goalPlaceholder') });
  const lang = h('select', {}, h('option', { value: 'sv', selected: c.lang === 'sv' }, 'Svenska'), h('option', { value: 'en', selected: c.lang === 'en' }, 'English'));
  const flowName = inp(c.flowName), sys = area(c.flow.system, 3), exp = area(c.flow.expand, 3), comb = area(c.flow.combine, 3);
  const tplSel = h('select', {}, S.templates.map((x) => h('option', { value: x.id }, localName(x.name))));
  const guidance = area(c.judgeGuidance, 2, { placeholder: t('judgeGuidancePh') });
  const autoProj = h('input', { type: 'checkbox', checked: c.autoProjectOnGold });
  const xOn = h('input', { type: 'checkbox', checked: c.researchers.x.enabled }), xFocus = inp(c.researchers.x.focus, { placeholder: t('focusPh') });
  const rOn = h('input', { type: 'checkbox', checked: c.researchers.research.enabled }), rFocus = inp(c.researchers.research.focus, { placeholder: t('focusPh') });
  const mode = h('select', {}, h('option', { value: 'manual', selected: c.mode === 'manual' }, t('manual')), h('option', { value: 'auto', selected: c.mode === 'auto' }, t('auto')));
  const pace = inp(c.autopilotSeconds, { type: 'number', min: 3, max: 3600 });
  const sph = inp(c.rate.stepsPerHour, { type: 'number', min: 1, max: 3600 });
  const usd = inp(c.rate.usdPerDay, { type: 'number', min: 0, step: 0.1 });
  const models = Object.fromEntries(ROLES.map((r) => [r, inp(c.models?.[r] ?? '', { placeholder: S.settings.models[r], list: 'model-list' })]));

  const dlg = dialog('dlg', t('boardSettings'), [
    h('fieldset', {}, h('legend', {}, t('general')), field(t('title'), title), field(t('goal'), goal), field(t('language'), lang)),
    h('fieldset', {}, h('legend', {}, t('flow')),
      h('div', { class: 'row' }, tplSel, h('button', {
        class: 'btn small', type: 'button',
        onclick: () => {
          const x = S.templates.find((y) => y.id === Number(tplSel.value));
          if (!x) return;
          flowName.value = x.name; sys.value = x.system; exp.value = x.expand; comb.value = x.combine;
        },
      }, t('applyTemplate'))),
      field(t('flowName'), flowName), field(t('systemPrompt'), sys), field(t('expandPrompt'), exp), field(t('combinePrompt'), comb),
      h('button', {
        class: 'btn small', type: 'button',
        onclick: async () => {
          try {
            await api('POST', '/api/templates', { name: flowName.value, system: sys.value, expand: exp.value, combine: comb.value });
            S.templates = (await api('GET', '/api/templates')).templates;
            toast(t('templateSaved'));
          } catch (e) { fail(e); }
        },
      }, t('saveAsTemplate')),
    ),
    h('fieldset', {}, h('legend', {}, t('jury')), field(t('judgeGuidance'), guidance),
      h('label', { class: 'check' }, autoProj, t('autoProject'))),
    h('fieldset', {}, h('legend', {}, t('researchers')),
      h('label', { class: 'check' }, xOn, t('xScout')), field(t('focus'), xFocus),
      h('label', { class: 'check' }, rOn, t('researchScout')), field(t('focus'), rFocus)),
    h('fieldset', {}, h('legend', {}, t('autopilot')),
      field(t('mode'), mode), h('div', { class: 'grid3' }, field(t('pace'), pace), field(t('stepsPerHour'), sph), field(t('usdPerDay'), usd)),
      h('small', { class: 'muted' }, t('rateNote'))),
    h('fieldset', {}, h('legend', {}, t('models')), h('small', { class: 'muted' }, t('modelsBoardNote')),
      h('div', { class: 'grid2' }, ROLES.map((r) => field(t(`role_${r}`), models[r])))),
    h('button', {
      class: 'btn danger small', type: 'button',
      onclick: async () => {
        if (!confirm(t('confirmDeleteBoard', { t: b.title }))) return;
        try {
          await api('DELETE', `/api/boards/${b.id}`);
          dlg.close();
          await loadBoards();
          if (S.boards.length) await openBoard(S.boards[0].id);
          else { S.board = null; await newBoardDialog(true); }
        } catch (e) { fail(e); }
      },
    }, t('deleteBoard')),
  ], [
    h('button', { class: 'btn', value: 'cancel' }, t('cancel')),
    h('button', {
      class: 'btn primary',
      onclick: async (e) => {
        e.preventDefault();
        const board = await patchBoard({
          title: title.value, goal: goal.value,
          config: {
            lang: lang.value, flowName: flowName.value, flow: { system: sys.value, expand: exp.value, combine: comb.value },
            judgeGuidance: guidance.value, autoProjectOnGold: autoProj.checked,
            researchers: { x: { enabled: xOn.checked, focus: xFocus.value }, research: { enabled: rOn.checked, focus: rFocus.value } },
            mode: mode.value, autopilotSeconds: Number(pace.value), rate: { stepsPerHour: Number(sph.value), usdPerDay: Number(usd.value) },
            models: Object.fromEntries(ROLES.map((r) => [r, models[r].value])),
          },
        });
        if (board) { dlg.close(); renderLeads(); renderPanel(); }
      },
    }, t('save')),
  ]);
}

const PROVIDER_LABELS = {
  chatgpt: 'ChatGPT plan', openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI',
  azure: 'Azure OpenAI / Microsoft Foundry (Copilot models)', ollama: 'Ollama', mlx: 'MLX (mlx_lm.server)', lmstudio: 'LM Studio', custom: 'OpenAI-compatible',
};
const HAS_URL = ['ollama', 'mlx', 'lmstudio', 'azure', 'custom'];
const HAS_KEY = ['openrouter', 'anthropic', 'openai', 'azure', 'custom'];
const modelCatalog = new Map();

function refreshModelList() {
  const dl = $('#model-list');
  clear(dl, [...modelCatalog.entries()].flatMap(([p, ids]) => ids.slice(0, 400).map((id) => h('option', { value: `${p}:${typeof id === 'string' ? id : id.slug}` }, typeof id === 'string' ? '' : id.displayName))));
}

function appSettingsDialog() {
  const s = structuredClone(S.settings);
  const status = new Map((S.providers?.providers ?? []).map((p) => [p.id, p]));
  const keys = {}, urls = {};
  const chatgpt = chatgptPanel(models => { modelCatalog.set('chatgpt', models); refreshModelList(); });
  const rows = PROVIDER_IDS.filter(p => p !== 'chatgpt').map((p) => {
    const st = status.get(p);
    const result = h('span', { class: 'small muted' });
    keys[p] = HAS_KEY.includes(p) ? h('input', { type: 'password', value: s.keys[p] ?? '', placeholder: t('apiKey'), autocomplete: 'off' }) : null;
    urls[p] = HAS_URL.includes(p) ? h('input', { value: s.baseUrls[p] ?? '', placeholder: t('baseUrl') }) : null;
    return h('div', { class: 'provider' },
      h('div', { class: 'row space' },
        h('strong', {}, PROVIDER_LABELS[p]),
        h('span', { class: `badge ${st?.keySource ? 'ok' : st?.local ? '' : 'warn'}` },
          st?.local ? t('local') : st?.keySource ? t(`keyFrom_${st.keySource}`) : t('keyMissing')),
      ),
      st?.note ? h('small', { class: 'muted' }, st.note) : null,
      h('div', { class: 'row' }, keys[p], urls[p],
        h('button', {
          class: 'btn small', type: 'button',
          onclick: async () => {
            result.textContent = '…';
            try {
              await saveFromForm(false);
              const { models } = await api('POST', `/api/providers/${p}/models`, {});
              modelCatalog.set(p, models);
              refreshModelList();
              result.textContent = t('testOk', { n: models.length });
            } catch (e) { result.textContent = errorText(e); }
          },
        }, t('test')), result),
    );
  });
  const models = Object.fromEntries(ROLES.map((r) => [r, h('input', { value: s.models[r], list: 'model-list', placeholder: DEFAULTS.models[r] })]));
  const root = h('input', { value: s.projectsRoot });
  const budget = h('input', { type: 'number', min: 0, step: 0.5, value: s.maxUsdPerDay });
  const spend = S.providers ? t('spend', { today: S.providers.spentToday.toFixed(3), total: S.providers.spentTotal.usd.toFixed(3) }) : '';

  async function saveFromForm(close = true) {
    for (const p of PROVIDER_IDS) {
      if (keys[p]) { if (keys[p].value.trim()) s.keys[p] = keys[p].value.trim(); else delete s.keys[p]; }
      if (urls[p]) s.baseUrls[p] = urls[p].value.trim();
    }
    for (const r of ROLES) s.models[r] = models[r].value.trim() || DEFAULTS.models[r];
    s.projectsRoot = root.value.trim() || DEFAULTS.projectsRoot;
    s.maxUsdPerDay = Number(budget.value);
    S.settings = s;
    S.providers = await saveSettings(s);
    renderHeader();
    if (close) { dlg.close(); toast(t('settingsSaved')); warnMissingKeys(); }
  }

  const dlg = dialog('dlg', t('appSettings'), [
    h('p', { class: 'small muted' }, t('settingsNote')),
    h('fieldset', {}, h('legend', {}, t('providers')), chatgpt.element, rows),
    h('fieldset', {}, h('legend', {}, t('models')), h('div', { class: 'grid2' }, ROLES.map((r) => field(t(`role_${r}`), models[r]))),
      h('small', { class: 'muted' }, t('calibrateNote'))),
    h('fieldset', {}, h('legend', {}, 'Claude Code'), field(t('projectsRoot'), root)),
    h('fieldset', {}, h('legend', {}, t('autopilot')), field(t('globalBudget'), budget, spend)),
  ], [
    h('button', { class: 'btn', value: 'cancel' }, t('cancel')),
    h('button', { class: 'btn primary', onclick: (e) => { e.preventDefault(); saveFromForm().catch(fail); } }, t('save')),
  ]);
  dlg.addEventListener('close', () => chatgpt.close(), { once: true });
}

function announceDialog(idea) {
  const others = S.boards.filter((b) => b.id !== S.board.id);
  const boxes = others.map((b) => ({ b, box: h('input', { type: 'checkbox' }) }));
  const all = h('input', { type: 'checkbox', onchange: (e) => boxes.forEach((x) => (x.box.checked = e.target.checked)) });
  const dlg = dialog('dlg', t('announceTitle', { t: idea.title }), [
    h('p', { class: 'small muted' }, t('announceHint')),
    others.length
      ? [h('label', { class: 'check' }, all, h('strong', {}, t('allBoards'))), boxes.map(({ b, box }) => h('label', { class: 'check' }, box, b.title, h('span', { class: 'muted small' }, b.goal ? ` · ${b.goal}` : '')))]
      : h('p', {}, t('noOtherBoards')),
  ], [
    h('button', { class: 'btn', value: 'cancel' }, t('cancel')),
    others.length
      ? h('button', {
          class: 'btn primary',
          onclick: async (e) => {
            e.preventDefault();
            const ids = boxes.filter((x) => x.box.checked).map((x) => x.b.id);
            if (!ids.length) return;
            try {
              const r = await api('POST', `/api/ideas/${idea.id}/announce`, { boardIds: ids });
              dlg.close();
              toast(r.guests.length ? t('announced', { n: r.guests.length }) : t('announceNone'), r.guests.length ? 'good' : 'info');
            } catch (err) { fail(err); }
          },
        }, t('announce'))
      : null,
  ]);
}

// ================================================================ exhibition

function renderExhibit() {
  const top = ideaList().filter((i) => fitness(i) != null).sort((a, b) => fitness(b) - fitness(a)).slice(0, 3);
  clear($('#ex-top'), top.map((i) => h('li', {}, h('span', {}, `${medal(i) ? MEDAL_ICON[medal(i)] : ''} ${scoreSum(i) ?? ''}`), ' ', i.title)));
}

async function enterExhibit() {
  S.exhibit = true;
  document.body.classList.add('exhibit');
  graph.followNewest = true;
  graph.insets = { top: 250, right: 40, bottom: 130, left: 40 };
  graph.select(null);
  S.selected = null;
  renderHeader();
  renderExhibit();
  try { await document.documentElement.requestFullscreen?.(); } catch { /* fullscreen is optional */ }
  setTimeout(() => graph.fit(), 300);
  toast(t('exhibitExit'));
}

function leaveExhibit() {
  if (!S.exhibit) return;
  S.exhibit = false;
  document.body.classList.remove('exhibit');
  graph.followNewest = false;
  graph.insets = { top: 30, right: 30, bottom: 100, left: 30 };
  if (document.fullscreenElement) document.exitFullscreen?.();
  renderPanel();
}
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) leaveExhibit(); });

// ================================================================ misc

function onOpenIdea(boardId, ideaId) {
  const go = boardId === S.board?.id ? Promise.resolve() : openBoard(boardId);
  go.then(() => {
    S.selected = ideaId;
    graph.select(ideaId);
    graph.focusOn(ideaId, 1);
    renderPanel();
  });
}

async function exportBoard() {
  try {
    const md = await api('GET', `/api/boards/${S.board.id}/export.md?lang=${getLang()}`);
    const a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), download: `${S.board.title.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase()}.md` });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    fail(e);
  }
}

function warnMissingKeys() {
  const status = new Map((S.providers?.providers ?? []).map((p) => [p.id, p]));
  for (const p of providersInUse(S.settings)) {
    const st = status.get(p);
    if (st && !st.local && st.needsKey && !st.keySource) toast(t('needKey', { p: st.label }), 'error', 10000);
  }
}

function renderAll() {
  applyI18n();
  renderHeader();
  renderBoardMenu();
  renderPanel();
  renderLeads();
  $('#lang-btn').textContent = getLang() === 'sv' ? 'EN' : 'SV';
}

function wire() {
  $('#seedbar').addEventListener('submit', seedFromBar);
  $('#board-menu-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#board-menu');
    const r = e.currentTarget.getBoundingClientRect();
    menu.style.left = `${Math.max(8, r.left)}px`;
    menu.style.top = `${r.bottom + 6}px`;
    menu.hidden = !menu.hidden;
  });
  document.addEventListener('click', (e) => { if (!$('#board-menu').contains(e.target)) $('#board-menu').hidden = true; });
  $('#board-title').addEventListener('change', (e) => e.target.value.trim() && patchBoard({ title: e.target.value }));
  $('#board-goal').addEventListener('change', (e) => patchBoard({ goal: e.target.value }));
  for (const id of ['#board-title', '#board-goal']) $(id).addEventListener('keydown', (e) => e.key === 'Enter' && e.target.blur());
  $('#mode-toggle').addEventListener('click', () => patchBoard({ config: { mode: S.board.config.mode === 'auto' ? 'manual' : 'auto' } }).then(renderAutopilot));
  $('#leads-btn').addEventListener('click', () => {
    const p = $('#leads-panel');
    p.hidden = !p.hidden;
    $('#leads-btn').setAttribute('aria-expanded', String(!p.hidden));
    renderLeads();
  });
  $('#dashboard-btn').addEventListener('click', () => openDashboard({ onOpenIdea }));
  $('#report-btn').addEventListener('click', () => openReport({ onOpenIdea, onOpenBoard: (id) => openBoard(id) }));
  $('#exhibit-btn').addEventListener('click', enterExhibit);
  $('#export-btn').addEventListener('click', exportBoard);
  $('#board-settings-btn').addEventListener('click', boardSettingsDialog);
  $('#app-settings-btn').addEventListener('click', appSettingsDialog);
  $('#lang-btn').addEventListener('click', () => { setLang(getLang() === 'sv' ? 'en' : 'sv'); renderAll(); });
  $('#zoom-in').addEventListener('click', () => graph.zoomBy(1.25));
  $('#zoom-out').addEventListener('click', () => graph.zoomBy(0.8));
  $('#fit-btn').addEventListener('click', () => graph.fit());
  document.addEventListener('keydown', (e) => {
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '');
    if (e.key === 'Escape') {
      if (graph.pick) graph.setPick(null);
      else if (S.exhibit) leaveExhibit();
      else if (!document.querySelector('dialog[open]')) graph.h.select(null);
    }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('#seed-input').focus(); }
    if (e.key === 'f') graph.fit();
  });
}

async function main() {
  wire();
  applyI18n();
  try {
    S.providers = await pushSettings(S.settings);
    warnMissingKeys();
  } catch (e) {
    fail(e);
  }
  await loadBoards();
  const last = Number(localStorage.getItem('ideagen.board'));
  const pick = S.boards.find((b) => b.id === last) ?? S.boards[0];
  if (pick) await openBoard(pick.id);
  else await newBoardDialog(true);
}

main().catch(fail);
