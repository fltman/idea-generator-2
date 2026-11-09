import { h, clear } from './dom.js';
import { api } from './api.js';
import { getLang } from './i18n.js';
import { signInFlow } from './chatgpt-flow.js';

export function chatgptPanel(onModels) {
  const en = getLang() === 'en';
  const label = (english, swedish) => en ? english : swedish;
  const root = h('div', { class: 'provider' });
  const account = h('select', { 'aria-label': label('ChatGPT account', 'ChatGPT-konto') });
  const message = h('p', { class: 'small', role: 'status' });
  const controls = h('div', { class: 'row' });
  const welcome = h('div', { role: 'status' });
  let state = { accounts: [], pending: false }, closed = false, timer, running = false, statusSignature = '';
  const flow = signInFlow(api, () => window.open('about:blank', '_blank'), () => render());
  const report = e => { if (!closed) message.textContent = e.message; };
  const action = (text, fn, disabled = false, independent = false) => h('button', { type: 'button', class: 'btn small', disabled,
    onclick: async () => { if (running && !independent) return; if (!independent) running = true; render(); try { await fn(); await refresh(); } catch (e) { try { await refresh(); } catch {} report(e); } finally { if (!independent) running = false; render(); } } }, text);
  function render() {
    if (closed) return;
    const selected = state.accounts.find(a => a.id === account.value);
    clear(controls,
      action('Continue with ChatGPT', () => flow.start(account.value || undefined), running || flow.busy || state.pending),
      action(label('Cancel sign-in', 'Avbryt inloggning'), () => flow.cancel(state.pendingId), !state.pending && !flow.busy, true),
      selected?.connected && action(label('Use this account', 'Använd kontot'), async () => { await api('POST', '/api/chatgpt/select', { accountId: selected.id }); onModels([]); }, running || state.pending),
      selected && action(label('Sign out', 'Logga ut'), async () => { await api('POST', '/api/chatgpt/signout', { accountId: selected.id }); onModels([]); }, running || state.pending),
      selected?.connected && !selected.planEnabled && action(label('Enable plan usage', 'Aktivera plananvändning'), () => flow.start(selected.id, true), running || state.pending),
      action(label('Load models', 'Hämta modeller'), async () => { const data = await api('POST', '/api/chatgpt/models', {}); onModels(data.models); }, running || !state.active || state.pending),
      state.accounts.some(a => a.id === state.active && a.paused) && action(label('Resume after reviewing usage', 'Återuppta efter kontroll av användning'), () => api('POST', '/api/chatgpt/resume', {}), running),
    );
    clear(welcome, state.welcome ? [h('strong', {}, label("You're using your ChatGPT plan", 'Du använder din ChatGPT-plan')),
      h('p', {}, label('Eligible requests use your plan or credits. Manage usage in ChatGPT Settings.', 'Berättigade förfrågningar använder din plan eller krediter. Hantera användningen i ChatGPT-inställningar.')),
      action(label('Got it', 'Jag förstår'), () => api('POST', '/api/chatgpt/welcome', {}))] : []);
  }
  async function refresh() {
    const next = await api('GET', '/api/chatgpt/status');
    if (closed) return;
    const signature = JSON.stringify(next);
    if (signature !== statusSignature) {
      statusSignature = signature;
      if (next.active !== state.active) onModels([]);
      const previous = account.value;
      state = next;
      clear(account, h('option', { value: '' }, label('Add another account / workspace', 'Lägg till konto / arbetsyta')),
        state.accounts.map(a => h('option', { value: a.id }, `${a.label}${a.id === state.active ? label(' (active)', ' (aktivt)') : ''}${a.connected ? '' : label(' (signed out)', ' (utloggat)')}`)));
      account.value = state.accounts.some(a => a.id === previous) ? previous : (state.active ?? '');
      message.textContent = state.pending ? label('Finish sign-in in the other tab, or cancel here.', 'Slutför inloggningen i den andra fliken eller avbryt här.') : state.message;
      render();
    }
    clearTimeout(timer);
    if (state.pending) timer = setTimeout(async () => {
      try { if (flow.popupClosed()) await flow.cancel(state.pendingId); await refresh(); } catch (e) { report(e); }
    }, 1000);
  }
  account.addEventListener('change', render);
  clear(root, h('strong', {}, 'ChatGPT plan'), h('p', { class: 'small muted' }, label(
    'Use an eligible Plus or Pro plan in this local app. Tokens stay on this computer. Plan usage is not measured by the app’s dollar budget; existing models stay unchanged.',
    'Använd en berättigad Plus- eller Pro-plan lokalt. Token stannar på datorn. Appens dollarbudget mäter inte plananvändningen; befintliga modeller ändras inte.')),
    location.hostname !== '127.0.0.1' ? h('a', { href: `http://127.0.0.1:${location.port}` }, label('Open loopback address to sign in', 'Öppna loopback-adressen för inloggning')) : null,
    account, controls, message, welcome,
    h('a', { href: 'https://chatgpt.com/settings/usage', target: '_blank', rel: 'noopener noreferrer' }, label('Manage usage', 'Hantera användning')));
  refresh().catch(report);
  return { element: root, close() { closed = true; clearTimeout(timer); if (state.pending || flow.busy) flow.cancel(state.pendingId).catch(() => {}); } };
}
