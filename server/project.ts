// Turn an idea into a folder that Claude Code can start from: a CLAUDE.md
// brief, a README with the start command, an idea.json, an Obsidian vault for
// notes (gitignored) and an empty git repo. Never overwrites: a taken name
// gets -2, -3 and so on.

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ChatFn, Lang } from './llm.ts';
import { medal, scoreSum } from '../public/js/score.js';

export type Brief = {
  name: string;
  slug: string;
  oneLiner: string;
  problem: string;
  audience: string;
  mvp: string[];
  outOfScope: string[];
  stack: string;
  firstSteps: string[];
  openQuestions: string[];
  risks: string[];
};
type IdeaLike = {
  id: number;
  title: string;
  pitch: string;
  kind: string;
  sourceUrl: string | null;
  originality: number | null;
  feasibility: number | null;
  impact: number | null;
  reason: string | null;
  medalOverride: number | null;
  boardId?: number;
  originBoardTitle?: string | null;
};

const list = (description: string) => ({ type: 'array', description, items: { type: 'string' } });
const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Project name, 1–4 words.' },
    slug: { type: 'string', description: 'Folder name: lowercase ASCII kebab-case, at most 40 characters.' },
    oneLiner: { type: 'string', description: 'One sentence: what it is and for whom.' },
    problem: { type: 'string', description: 'The problem or opportunity, 2–3 sentences.' },
    audience: { type: 'string', description: 'Who it is for, concretely.' },
    mvp: list('3–6 features of the smallest version that tests the core mechanism.'),
    outOfScope: list('2–5 things deliberately left out of the first version.'),
    stack: { type: 'string', description: 'A simple suggested stack and why, 1–3 sentences.' },
    firstSteps: list('3–6 concrete first steps for a coding agent, in order.'),
    openQuestions: list('2–5 questions a human must answer.'),
    risks: list('2–4 main risks.'),
  },
  required: ['name', 'slug', 'oneLiner', 'problem', 'audience', 'mvp', 'outOfScope', 'stack', 'firstSteps', 'openQuestions', 'risks'],
  additionalProperties: false,
};

const LANG_NAME: Record<Lang, string> = { sv: 'Swedish', en: 'English' };
const fmt = (i: { title: string; pitch: string }) => (i.pitch ? `${i.title}: ${i.pitch}` : i.title);

export function slugify(s: string) {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/, '') || 'idea'
  );
}

/** ~ and ~/x are under the home folder; on Windows ~\x is too. */
export function expandHome(p: string, platform: NodeJS.Platform = process.platform) {
  const t = p.trim();
  const home = t === '~' || t.startsWith('~/') || (platform === 'win32' && t.startsWith('~\\'));
  return home ? join(homedir(), t.slice(1)) : t;
}

export async function writeBrief(a: {
  chat: ChatFn; model: string; idea: IdeaLike; goal: string; lineage: IdeaLike[]; lang: Lang;
}) {
  const sum = scoreSum(a.idea);
  const user = [
    'Turn this idea into a kickoff brief for a coding agent (Claude Code) that will build it from an empty folder.',
    `The idea:\n${fmt(a.idea)}`,
    a.goal.trim() ? `The goal of the board it came from: ${a.goal.trim()}` : '',
    sum != null ? `Jury verdict: originality ${a.idea.originality}, feasibility ${a.idea.feasibility}, impact ${a.idea.impact} (of 5). ${a.idea.reason ?? ''}` : '',
    a.lineage.length ? `It grew out of these ideas:\n${a.lineage.map((i) => `- ${fmt(i)}`).join('\n')}` : '',
    `Write in the language of the idea; if that is unclear, in ${LANG_NAME[a.lang]}. If Swedish, write idiomatic Swedish. The slug is always ASCII.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const r = await a.chat({
    model: a.model,
    system:
      'You are a senior product engineer who turns raw ideas into crisp kickoff briefs. You favour the smallest build that tests the core mechanism, and you name the hard parts honestly.',
    user,
    schemaName: 'brief',
    schema: BRIEF_SCHEMA,
    temperature: 0.5,
    maxTokens: 2500,
  });
  const v = r.value ?? {};
  const arr = (x: unknown) => (Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean).slice(0, 8) : []);
  const brief: Brief = {
    name: String(v.name ?? a.idea.title).trim() || a.idea.title,
    slug: slugify(String(v.slug || v.name || a.idea.title)),
    oneLiner: String(v.oneLiner ?? '').trim(),
    problem: String(v.problem ?? '').trim(),
    audience: String(v.audience ?? '').trim(),
    mvp: arr(v.mvp),
    outOfScope: arr(v.outOfScope),
    stack: String(v.stack ?? '').trim(),
    firstSteps: arr(v.firstSteps),
    openQuestions: arr(v.openQuestions),
    risks: arr(v.risks),
  };
  return { brief, costUsd: r.costUsd };
}

const L = {
  sv: {
    born: 'Projektet föddes på en idétavla i Idégeneratorn', brief: 'Den här filen är briefen: läs den innan du börjar och håll den aktuell när beslut fattas.',
    idea: 'Idén', goal: 'Tavlans mål', verdict: 'Juryns bedömning', o: 'Originalitet', f: 'Genomförbarhet', i: 'Effekt', handset: 'Medalj satt för hand',
    problem: 'Problem', audience: 'Vem det är för', mvp: 'MVP: minsta bygget som prövar kärnan', out: 'Utanför första versionen', stack: 'Föreslagen stack',
    steps: 'Första stegen', questions: 'Öppna frågor', risks: 'Risker', origin: 'Var idén kom ifrån', source: 'källa',
    kinds: { seed: 'Frö', expand: 'Förgrening', combine: 'Korsning', guest: 'Gäst' } as Record<string, string>, fromBoard: 'från tavlan',
    agreements: 'Arbetsregler',
    rules: [
      'Bygg först den minsta versionen som prövar kärnmekanismen; lägg till komplexitet först när den fungerar.',
      'Verifiera varje steg genom att köra det, inte bara genom att läsa koden.',
      'Fråga innan något kostar pengar (betalda API:er) eller publiceras.',
      'Anteckningar och idéer hör hemma i `vault/` (Obsidian), som aldrig checkas in.',
    ],
    start: 'Kom igång', then: 'Säg sedan: "Läs CLAUDE.md och föreslå en plan för första steget."',
    vaultIntro: 'Arbetsanteckningar för projektet. Mappen är gitignorerad.',
  },
  en: {
    born: 'This project was born on an idea board in Idea Generator', brief: 'This file is the brief: read it before you start, and keep it up to date as decisions are made.',
    idea: 'The idea', goal: 'Board goal', verdict: 'Jury verdict', o: 'Originality', f: 'Feasibility', i: 'Impact', handset: 'Medal set by hand',
    problem: 'Problem', audience: 'Who it is for', mvp: 'MVP: the smallest build that tests the core', out: 'Out of scope for now', stack: 'Suggested stack',
    steps: 'First steps', questions: 'Open questions', risks: 'Risks', origin: 'Where the idea came from', source: 'source',
    kinds: { seed: 'Seed', expand: 'Branch', combine: 'Cross', guest: 'Guest' } as Record<string, string>, fromBoard: 'from board',
    agreements: 'Working agreements',
    rules: [
      'Build the smallest version that tests the core mechanism first; add complexity only once that works.',
      'Verify each step by running it, not just by reading the code.',
      'Ask before anything that costs money (paid APIs) or publishes anything.',
      'Notes and ideas belong in `vault/` (Obsidian), which is never committed.',
    ],
    start: 'Getting started', then: 'Then say: "Read CLAUDE.md and propose a plan for the first step."',
    vaultIntro: 'Working notes for the project. This folder is gitignored.',
  },
};
const MEDAL = ['', ' 🥉', ' 🥈', ' 🥇'];

export function renderClaudeMd(a: { brief: Brief; idea: IdeaLike; goal: string; lineage: IdeaLike[]; lang: Lang; date: string }) {
  const t = L[a.lang];
  const b = a.brief;
  const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n');
  const sum = scoreSum(a.idea);
  const m = medal(a.idea);
  const out = [`# ${b.name}`, '', `> ${b.oneLiner}`, '', `${t.born} (${a.date}). ${t.brief}`, '', `## ${t.idea}`, '', `**${a.idea.title}.** ${a.idea.pitch}`.trim(), ''];
  if (a.goal.trim()) out.push(`## ${t.goal}`, '', a.goal.trim(), '');
  if (sum != null || a.idea.medalOverride != null) {
    out.push(`## ${t.verdict}`, '');
    if (sum != null) out.push(`${t.o} ${a.idea.originality} · ${t.f} ${a.idea.feasibility} · ${t.i} ${a.idea.impact} = ${sum}/15${m ? MEDAL[m] : ''}`, '', a.idea.reason ?? '', '');
    if (a.idea.medalOverride != null) out.push(`*${t.handset}:${MEDAL[a.idea.medalOverride] || ' –'}*`, '');
  }
  out.push(
    `## ${t.problem}`, '', b.problem, '',
    `## ${t.audience}`, '', b.audience, '',
    `## ${t.mvp}`, '', bullets(b.mvp), '',
    `## ${t.out}`, '', bullets(b.outOfScope), '',
    `## ${t.stack}`, '', b.stack, '',
    `## ${t.steps}`, '', b.firstSteps.map((s, n) => `${n + 1}. ${s}`).join('\n'), '',
    `## ${t.questions}`, '', bullets(b.openQuestions), '',
    `## ${t.risks}`, '', bullets(b.risks), '',
  );
  if (a.lineage.length) {
    out.push(`## ${t.origin}`, '');
    for (const i of a.lineage) {
      const where = i.kind === 'guest' && i.originBoardTitle ? ` (${t.fromBoard} ${i.originBoardTitle})` : '';
      out.push(`- ${t.kinds[i.kind] ?? i.kind}${where}: **${i.title}**${i.pitch ? ` ${i.pitch}` : ''}${i.sourceUrl ? ` (${t.source}: ${i.sourceUrl})` : ''}`);
    }
    out.push('');
  }
  out.push(`## ${t.agreements}`, '', bullets(t.rules), '');
  return out.join('\n');
}

/** Create a fresh, uniquely named folder under root. Returns its absolute path. */
async function uniqueDir(root: string, slug: string) {
  await mkdir(root, { recursive: true });
  for (let n = 1; n < 100; n++) {
    const dir = join(root, n === 1 ? slug : `${slug}-${n}`);
    try {
      await mkdir(dir); // not recursive: fails if it exists, so we never write into someone else's folder
      return dir;
    } catch (e: any) {
      if (e?.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`No free folder name for ${slug}`);
}

export async function writeProject(a: {
  root: string; brief: Brief; idea: IdeaLike; goal: string; lineage: IdeaLike[]; lang: Lang; gitInit?: boolean;
}) {
  const root = resolve(expandHome(a.root));
  if (!isAbsolute(expandHome(a.root))) throw new Error(`The projects folder must be an absolute path or start with ~ (got "${a.root}")`);
  const dir = await uniqueDir(root, slugify(a.brief.slug));
  const t = L[a.lang];
  const date = new Date().toISOString().slice(0, 10);

  await writeFile(join(dir, 'CLAUDE.md'), renderClaudeMd({ ...a, date }));
  await writeFile(
    join(dir, 'README.md'),
    [`# ${a.brief.name}`, '', a.brief.oneLiner, '', `## ${t.start}`, '', '```bash', `cd "${dir}"`, 'claude', '```', '', t.then, ''].join('\n'),
  );
  await writeFile(
    join(dir, 'idea.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), goal: a.goal, idea: a.idea, lineage: a.lineage, brief: a.brief }, null, 2) + '\n',
  );
  await writeFile(join(dir, '.gitignore'), ['node_modules/', '.env', '.DS_Store', '# Obsidian-vault: arbetsanteckningar, aldrig i repot', 'vault/', '.obsidian/', ''].join('\n'));
  await mkdir(join(dir, 'vault'));
  await writeFile(
    join(dir, 'vault', 'Home.md'),
    [`# ${a.brief.name}`, '', t.vaultIntro, '', `## ${t.idea}`, '', fmt(a.idea), '', `## ${t.questions}`, '', ...a.brief.openQuestions.map((q) => `- [ ] ${q}`), ''].join('\n'),
  );
  if (a.gitInit !== false) {
    await new Promise<void>((done) => execFile('git', ['init', '-q', '-b', 'main'], { cwd: dir }, () => done()));
  }
  return dir;
}
