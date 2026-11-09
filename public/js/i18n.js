// Swedish and English. The interface language is per browser; generated text
// follows the language of its seed (the board's language is only a fallback).

const DICT = {
  sv: {
    appName: 'Idégeneratorn',
    seedPlaceholder: 'Skriv en idé eller klistra in en länk … (Enter)',
    readingPage: 'Läser sidan …',
    thinking: 'Tänker …',
    boards: 'Tavlor',
    newBoard: 'Ny tavla',
    goal: 'Mål',
    goalPlaceholder: 't.ex. innovativ audiovisuell produkt för interaktion i offentliga miljöer',
    noGoal: 'Inget mål ännu – klicka för att sätta riktningen',
    title: 'Namn',
    template: 'Flödesmall',
    create: 'Skapa',
    cancel: 'Avbryt',
    save: 'Spara',
    close: 'Stäng',
    delete: 'Radera',
    manual: 'Manuell',
    auto: 'Automatisk',
    leads: 'Spaning',
    dashboard: 'Trender',
    exhibit: 'Utställning',
    export: 'Exportera',
    boardSettings: 'Tavlans inställningar',
    appSettings: 'Inställningar',
    fit: 'Visa allt',
    // kinds
    kind_seed: 'Frö', kind_expand: 'Förgrening', kind_combine: 'Korsning', kind_guest: 'Gäst',
    generation: 'generation {n}',
    fromBoard: 'från tavlan {b}',
    // detail
    notJudged: 'Inte bedömd ännu',
    judging: 'Juryn läser …',
    originality: 'Originalitet', feasibility: 'Genomförbarhet', impact: 'Effekt',
    expand: 'Förgrena', expandHint: 'Tre nya idéer som växer ur den här',
    combineWith: 'Korsa med …', combinePick: 'Klicka på idén att korsa med (Esc avbryter). Du kan också dra en idé på en annan.',
    rejudge: 'Bedöm igen',
    medal: 'Medalj', medalAuto: 'Juryn',
    announce: 'Annonsera', announceHint: 'Skicka idén som gäst till andra tavlor, där den kan korsas med deras idéer',
    spinoff: 'Ny tavla av idén', spinoffHint: 'Förfina idén i en egen tavla med den som mål',
    project: 'Claude Code-projekt', projectHint: 'Skapa en projektmapp med CLAUDE.md som Claude Code kan börja från',
    projectMaking: 'Skriver brief …',
    revealProject: 'Visa i Finder', copyStart: 'Kopiera startkommando', copied: 'Kopierat',
    source: 'Källa', spinoffs: 'Egna tavlor', keywords: 'Nyckelord',
    deleteIdea: 'Radera idén', confirmDelete: 'Radera "{t}"?',
    // overview
    overview: 'Översikt', topIdeas: 'Topplista', noIdeasYet: 'Tavlan är tom. Skriv ett frö nedan, eller hämta spaning från vänsterpanelen.',
    evolution: 'Evolution', evoLine: 'Generation {g} · snitt {first} → {latest} · bäst {best}', evoShort: 'Generation {g} · bäst {best}',
    summary: 'Sammanfattning', summarize: 'Sammanfatta tavlan', resummarize: 'Uppdatera', summaryStale: '{n} nya idéer sedan sammanfattningen',
    themes: 'Teman', strongest: 'Starkast', gaps: 'Luckor', nextSteps: 'Nästa steg',
    // leads
    leadsX: 'X-trender', leadsResearch: 'AI-forskning', refresh: 'Hämta', refreshing: 'Spanar …',
    leadsEmpty: 'Inget hämtat ännu. Spanarna letar utifrån tavlans mål.', addAsSeed: '+ Frö', onBoard: 'på tavlan',
    leadsDropped: '{n} spår utan verifierad källa sorterades bort', leadsNone: 'Inga verifierade spår hittades den här gången',
    researcherOff: 'Den här spanaren är avstängd i tavlans inställningar.',
    dragLead: 'Dra in på tavlan eller klicka + Frö',
    // autopilot
    ap_manual: 'Manuell', ap_running: 'Arbetar …', ap_pace: 'Nästa steg om {s}', ap_hourly: 'Timgräns nådd · fortsätter {time}',
    ap_board_budget: 'Dagsbudgeten är slut · fortsätter i morgon', ap_global_budget: 'Global dagsbudget slut · fortsätter i morgon',
    ap_backoff: 'Fel · försöker igen om {s}', ap_error: 'Fel: {m}', ap_idle: 'Väntar', ap_idle_empty: 'Väntar på ett frö',
    ap_idle_nothing: 'Inget mer att göra just nu',
    apMeta: '{n} steg senaste timmen · ${usd} i dag',
    // board settings
    general: 'Allmänt', language: 'Språk (reserv för genererad text)', flow: 'Skapandeflöde', flowName: 'Flödets namn',
    systemPrompt: 'Roll (systemprompt)', expandPrompt: 'Förgrening', combinePrompt: 'Korsning', applyTemplate: 'Använd mall',
    saveAsTemplate: 'Spara som mall', templateSaved: 'Mallen sparades',
    jury: 'Jury', judgeGuidance: 'Extra riktlinjer till juryn', judgeGuidancePh: 't.ex. Belöna lösningar som fungerar utomhus året runt.',
    autoProject: 'Juryn gör guldidéer till Claude Code-projekt',
    researchers: 'Spanare', xScout: 'X-trender (Grok via OpenRouter)', researchScout: 'AI-forskning (Hugging Face)', focus: 'Extra fokus',
    focusPh: 'utöver målet, t.ex. "ljudinstallationer"',
    autopilot: 'Autopilot', mode: 'Läge', pace: 'Sekunder mellan steg', stepsPerHour: 'Max steg per timme', usdPerDay: 'Max USD per dag',
    rateNote: 'Dollargränser räknar bara leverantörer som rapporterar kostnad (OpenRouter, Anthropic). 0 = bara gratis (lokala) modeller.',
    models: 'Modeller', modelsBoardNote: 'Tomt fält = appens inställning.',
    role_distill: 'Destillera frö', role_expand: 'Förgrena', role_combine: 'Korsa', role_judge: 'Jury', role_summary: 'Sammanfatta',
    role_research: 'Forskningsspanare', role_x: 'X-spanare', role_brief: 'Projektbrief',
    deleteBoard: 'Radera tavlan', confirmDeleteBoard: 'Radera tavlan "{t}" med alla idéer?',
    // app settings
    providers: 'Leverantörer', apiKey: 'API-nyckel', baseUrl: 'Adress', test: 'Testa', testOk: '{n} modeller', keyFrom_browser: 'nyckel här',
    keyFrom_env: 'nyckel från miljön', keyMissing: 'ingen nyckel', local: 'lokal',
    projectsRoot: 'Mapp för Claude Code-projekt', globalBudget: 'Global gräns, USD per dag', spend: 'Förbrukat: ${today} i dag · ${total} totalt',
    settingsNote: 'Inställningar för API-nycklar sparas i webbläsaren. ChatGPT-token sparas separat i en skyddad fil på datorn.',
    settingsSaved: 'Inställningarna sparades',
    needKey: 'Lägg in en API-nyckel för {p} under Inställningar.',
    calibrateNote: 'Byter du juryns modell: kör npm run calibrate -- --model <modell> för att se att den skiljer svagt från starkt.',
    // announce
    announceTitle: 'Annonsera "{t}"', allBoards: 'Alla tavlor', announced: 'Gäst på {n} tavlor', announceNone: 'Redan gäst där',
    noOtherBoards: 'Det finns inga andra tavlor ännu.',
    // dashboard
    dashTitle: 'Trender över alla tavlor', days: '{n} dagar', statIdeas: 'Idéer', statBoards: 'Tavlor', statKeywords: 'Nyckelord',
    statRecent: 'Nya idéer, {n} dagar', keyword: 'Nyckelord', trend: 'Per dag', count: 'Idéer', change: 'Mot förra perioden',
    onBoards: 'Tavlor', meanJury: 'Snitt jury', boardKeywords: 'Tavlornas nyckelord', ideasWith: 'Idéer om "{k}"',
    dashEmpty: 'Inga nyckelord ännu. De kommer när juryn bedömer idéer.', tableNote: 'Hovra över en kurva för dagens värde.',
    // report
    report: 'Rapport', reportNew: '{n} nya', reportMedals: 'Medaljer', reportProjects: 'Claude Code-projekt',
    reportSpent: 'Förbrukat, {n} dagar', conclusions: 'Slutsatser', writeConclusions: 'Skriv slutsatser',
    rewriteConclusions: 'Skriv om', conclusionsHint: 'Låt AI:n läsa alla tavlor och skriva rapportens slutsatser: insikter, de idéer som är mest värda att driva vidare, möjligheter och nästa steg.',
    conclusionsFrom: 'Skrivna {date} · gällde {n} dagar', insights: 'Insikter', standouts: 'Mest värt att driva vidare', opportunities: 'Möjligheter',
    noProjects: 'Inga projekt ännu. Guldidéer blir projekt av sig själva, eller klicka → Claude Code-projekt på en idé.',
    ideasWord: 'idéer', summaryOld: 'äldre än tavlan', noBoardSummary: 'Ingen sammanfattning ännu.',
    // misc
    gold: '🥇 Guld: {t}', projectCreated: 'Claude Code-projekt skapat: {p}', exhibitExit: 'Esc lämnar utställningsläget',
    err_no_key: 'Ingen API-nyckel: {m}', err_bad_key: 'Nyckeln godtogs inte: {m}', err_unreachable: 'Når inte tjänsten: {m}',
    err_no_search: '{m}', err_url_unreadable: 'Kunde inte läsa länken: {m}', err_url_no_text: 'Sidan har för lite läsbar text.',
    err_too_few: 'Sammanfattningen behöver minst två idéer.', err_generic: 'Något gick fel: {m}',
    firstRun: 'Välkommen! Börja med en tavla och ett mål.',
  },
  en: {
    appName: 'Idea Generator',
    seedPlaceholder: 'Write an idea or paste a link … (Enter)',
    readingPage: 'Reading the page …',
    thinking: 'Thinking …',
    boards: 'Boards',
    newBoard: 'New board',
    goal: 'Goal',
    goalPlaceholder: 'e.g. innovative audio-visual product for interaction in public spaces',
    noGoal: 'No goal yet – click to set the direction',
    title: 'Name',
    template: 'Flow template',
    create: 'Create',
    cancel: 'Cancel',
    save: 'Save',
    close: 'Close',
    delete: 'Delete',
    manual: 'Manual',
    auto: 'Automatic',
    leads: 'Scouting',
    dashboard: 'Trends',
    exhibit: 'Exhibition',
    export: 'Export',
    boardSettings: 'Board settings',
    appSettings: 'Settings',
    fit: 'Show all',
    kind_seed: 'Seed', kind_expand: 'Branch', kind_combine: 'Cross', kind_guest: 'Guest',
    generation: 'generation {n}',
    fromBoard: 'from board {b}',
    notJudged: 'Not judged yet',
    judging: 'The jury is reading …',
    originality: 'Originality', feasibility: 'Feasibility', impact: 'Impact',
    expand: 'Branch out', expandHint: 'Three new ideas growing out of this one',
    combineWith: 'Cross with …', combinePick: 'Click the idea to cross with (Esc cancels). You can also drag one idea onto another.',
    rejudge: 'Judge again',
    medal: 'Medal', medalAuto: 'Jury',
    announce: 'Announce', announceHint: 'Send the idea as a guest to other boards, where it can cross with their ideas',
    spinoff: 'New board from idea', spinoffHint: 'Refine the idea on a board of its own, with the idea as the goal',
    project: 'Claude Code project', projectHint: 'Create a project folder with a CLAUDE.md that Claude Code can start from',
    projectMaking: 'Writing the brief …',
    revealProject: 'Show in Finder', copyStart: 'Copy start command', copied: 'Copied',
    source: 'Source', spinoffs: 'Own boards', keywords: 'Keywords',
    deleteIdea: 'Delete idea', confirmDelete: 'Delete "{t}"?',
    overview: 'Overview', topIdeas: 'Top ideas', noIdeasYet: 'The board is empty. Write a seed below, or pull leads from the left panel.',
    evolution: 'Evolution', evoLine: 'Generation {g} · mean {first} → {latest} · best {best}', evoShort: 'Generation {g} · best {best}',
    summary: 'Summary', summarize: 'Summarize the board', resummarize: 'Refresh', summaryStale: '{n} new ideas since the summary',
    themes: 'Themes', strongest: 'Strongest', gaps: 'Gaps', nextSteps: 'Next steps',
    leadsX: 'X trends', leadsResearch: 'AI research', refresh: 'Fetch', refreshing: 'Scouting …',
    leadsEmpty: 'Nothing fetched yet. The scouts search from the board\'s goal.', addAsSeed: '+ Seed', onBoard: 'on the board',
    leadsDropped: '{n} leads without a verified source were dropped', leadsNone: 'No verified leads found this time',
    researcherOff: 'This scout is switched off in the board settings.',
    dragLead: 'Drag onto the board or click + Seed',
    ap_manual: 'Manual', ap_running: 'Working …', ap_pace: 'Next step in {s}', ap_hourly: 'Hourly limit reached · resumes {time}',
    ap_board_budget: 'Daily budget spent · resumes tomorrow', ap_global_budget: 'Global daily budget spent · resumes tomorrow',
    ap_backoff: 'Error · retrying in {s}', ap_error: 'Error: {m}', ap_idle: 'Waiting', ap_idle_empty: 'Waiting for a seed',
    ap_idle_nothing: 'Nothing more to do right now',
    apMeta: '{n} steps in the last hour · ${usd} today',
    general: 'General', language: 'Language (fallback for generated text)', flow: 'Creation flow', flowName: 'Flow name',
    systemPrompt: 'Role (system prompt)', expandPrompt: 'Branching', combinePrompt: 'Crossing', applyTemplate: 'Use template',
    saveAsTemplate: 'Save as template', templateSaved: 'Template saved',
    jury: 'Jury', judgeGuidance: 'Extra guidance for the jury', judgeGuidancePh: 'e.g. Reward solutions that work outdoors all year.',
    autoProject: 'The jury turns gold ideas into Claude Code projects',
    researchers: 'Scouts', xScout: 'X trends (Grok via OpenRouter)', researchScout: 'AI research (Hugging Face)', focus: 'Extra focus',
    focusPh: 'besides the goal, e.g. "sound installations"',
    autopilot: 'Autopilot', mode: 'Mode', pace: 'Seconds between steps', stepsPerHour: 'Max steps per hour', usdPerDay: 'Max USD per day',
    rateNote: 'Dollar limits only count providers that report cost (OpenRouter, Anthropic). 0 = free (local) models only.',
    models: 'Models', modelsBoardNote: 'Empty field = the app setting.',
    role_distill: 'Distill seed', role_expand: 'Branch', role_combine: 'Cross', role_judge: 'Jury', role_summary: 'Summarize',
    role_research: 'Research scout', role_x: 'X scout', role_brief: 'Project brief',
    deleteBoard: 'Delete board', confirmDeleteBoard: 'Delete the board "{t}" with all its ideas?',
    providers: 'Providers', apiKey: 'API key', baseUrl: 'Address', test: 'Test', testOk: '{n} models', keyFrom_browser: 'key here',
    keyFrom_env: 'key from environment', keyMissing: 'no key', local: 'local',
    projectsRoot: 'Folder for Claude Code projects', globalBudget: 'Global limit, USD per day', spend: 'Spent: ${today} today · ${total} in total',
    settingsNote: 'API-key provider settings are stored in this browser. ChatGPT OAuth tokens are stored separately in a protected file on this computer.',
    settingsSaved: 'Settings saved',
    needKey: 'Add an API key for {p} under Settings.',
    calibrateNote: 'Changing the jury model? Run npm run calibrate -- --model <model> to check it still tells weak from strong.',
    announceTitle: 'Announce "{t}"', allBoards: 'All boards', announced: 'Guest on {n} boards', announceNone: 'Already a guest there',
    noOtherBoards: 'There are no other boards yet.',
    dashTitle: 'Trends across all boards', days: '{n} days', statIdeas: 'Ideas', statBoards: 'Boards', statKeywords: 'Keywords',
    statRecent: 'New ideas, {n} days', keyword: 'Keyword', trend: 'Per day', count: 'Ideas', change: 'Vs previous period',
    onBoards: 'Boards', meanJury: 'Mean jury', boardKeywords: 'Keywords per board', ideasWith: 'Ideas about "{k}"',
    dashEmpty: 'No keywords yet. They arrive as the jury judges ideas.', tableNote: 'Hover a line for the value of the day.',
    report: 'Report', reportNew: '{n} new', reportMedals: 'Medals', reportProjects: 'Claude Code projects',
    reportSpent: 'Spent, {n} days', conclusions: 'Conclusions', writeConclusions: 'Write conclusions',
    rewriteConclusions: 'Rewrite', conclusionsHint: 'Let the AI read every board and write the conclusions: insights, the ideas most worth pursuing, opportunities and next steps.',
    conclusionsFrom: 'Written {date} · covered {n} days', insights: 'Insights', standouts: 'Most worth pursuing', opportunities: 'Opportunities',
    noProjects: 'No projects yet. Gold ideas become projects by themselves, or click → Claude Code project on an idea.',
    ideasWord: 'ideas', summaryOld: 'older than the board', noBoardSummary: 'No summary yet.',
    gold: '🥇 Gold: {t}', projectCreated: 'Claude Code project created: {p}', exhibitExit: 'Esc leaves exhibition mode',
    err_no_key: 'No API key: {m}', err_bad_key: 'The key was not accepted: {m}', err_unreachable: 'Cannot reach the service: {m}',
    err_no_search: '{m}', err_url_unreadable: 'Could not read the link: {m}', err_url_no_text: 'The page has too little readable text.',
    err_too_few: 'The summary needs at least two ideas.', err_generic: 'Something went wrong: {m}',
    firstRun: 'Welcome! Start with a board and a goal.',
  },
};

let lang = localStorage.getItem('ideagen.lang') || (navigator.language?.startsWith('sv') ? 'sv' : 'en');

export const getLang = () => lang;
export function setLang(l) {
  lang = l === 'en' ? 'en' : 'sv';
  localStorage.setItem('ideagen.lang', lang);
  document.documentElement.lang = lang;
}

export function t(key, vars = {}) {
  let s = DICT[lang][key] ?? DICT.sv[key] ?? key;
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
  return s;
}

/** Fill [data-i18n] text, [data-i18n-ph] placeholders and [data-i18n-title] tooltips. */
export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh);
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  }
}

/** A friendly message for an API error code. */
export function errorText(e) {
  const key = `err_${e?.code}`;
  return DICT[lang][key] ? t(key, { m: e.message }) : t('err_generic', { m: e?.message ?? String(e) });
}
