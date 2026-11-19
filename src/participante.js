import './styles/base.css';
import './styles/participante.css';
import { supabase, configured, deviceId, watchState } from './lib/supabase.js';
import { networkSVG, logo } from './lib/decor.js';
import { LOGOS, MAX_CHARS } from './config.js';

const $ = (id) => document.getElementById(id);
const els = {
  loading: $('s-loading'), waiting: $('s-waiting'), question: $('s-question'),
  qText: $('q-text'), qBadge: $('q-badge'), form: $('form'), input: $('answer'), send: $('send'),
  count: $('count'), closed: $('closed'), mineWrap: $('mine-wrap'), mine: $('mine'), mineN: $('mine-n'), toast: $('toast'),
};

$('logos').innerHTML = logo(LOGOS.utn40) + logo(LOGOS.isi) + logo(LOGOS.masterclass, 'round');
$('net').innerHTML = networkSVG({ w: 400, h: 300, n: 14, seed: 11, corner: 'br' });

let current = null; // { id, text, is_open }
let sending = false;

// ---------- Respuestas propias (solo en este celular) ----------
const mineKey = (qid) => `nube.mine.${qid}`;
function loadMine(qid) {
  try { return JSON.parse(localStorage.getItem(mineKey(qid)) || '[]'); } catch { return []; }
}
function saveMine(qid, list) {
  try { localStorage.setItem(mineKey(qid), JSON.stringify(list.slice(-60))); } catch { /* sin storage */ }
}
function renderMine() {
  const list = current ? loadMine(current.id) : [];
  els.mineWrap.hidden = list.length === 0;
  els.mineN.textContent = list.length ? `(${list.filter((m) => !m.flagged).length})` : '';
  els.mine.replaceChildren(...list.slice().reverse().map((m) => {
    const c = document.createElement('span');
    c.className = 'chip' + (m.flagged ? ' flagged' : '');
    c.textContent = m.text;
    if (m.flagged) c.title = 'No pasó el filtro de moderación';
    return c;
  }));
}

// ---------- Estados ----------
function show(state) {
  els.loading.hidden = state !== 'loading';
  els.waiting.hidden = state !== 'waiting';
  els.question.hidden = state !== 'question';
}

function apply(data) {
  const q = data?.question ?? null;
  if (!q) {
    current = null;
    show('waiting');
    return;
  }
  const changed = !current || current.id !== q.id;
  current = q;
  show('question');
  els.qText.textContent = q.text;
  els.qBadge.textContent = q.is_open ? 'En vivo' : 'Cerrada';
  els.qBadge.className = 'p-badge ' + (q.is_open ? 'live' : 'off');
  els.form.hidden = !q.is_open;
  els.closed.hidden = q.is_open;
  if (changed) {
    els.input.value = '';
    updateCount();
    renderMine();
  }
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const { data, error } = await supabase.rpc('get_current');
    if (!error) apply(data);
    else if (!current) toast('Sin conexión. Reintentando…', 'err');
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// ---------- Envío ----------
function updateCount() {
  const n = els.input.value.length;
  els.count.textContent = `${n}/${MAX_CHARS}`;
  els.count.classList.toggle('near', n >= MAX_CHARS - 3);
}
els.input.addEventListener('input', updateCount);

const MESSAGES = {
  ok: ['¡Enviada! Podés mandar otra.', 'ok'],
  flagged: ['Esa respuesta no pasó el filtro de moderación.', 'warn'],
  duplicate: ['Ya enviaste esa respuesta.', 'warn'],
  too_fast: ['Más despacio 🙂 Probá de nuevo en un segundo.', 'warn'],
  empty: ['Escribí al menos una palabra (letras o números).', 'warn'],
  too_long: [`Máximo ${MAX_CHARS} caracteres.`, 'warn'],
  closed: ['Las respuestas para esta pregunta ya se cerraron.', 'warn'],
  not_active: ['La pregunta cambió. Mirá la nueva 👆', 'warn'],
  bad_device: ['No pudimos identificar tu dispositivo. Recargá la página.', 'err'],
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (sending || !current) return;
  const text = els.input.value.replace(/\s+/g, ' ').trim();
  if (!text) { toast(MESSAGES.empty[0], 'warn'); els.input.focus(); return; }

  sending = true;
  els.send.disabled = true;
  els.send.textContent = 'Enviando…';
  const qid = current.id;
  try {
    let res = await supabase.rpc('submit_answer', { p_question: qid, p_text: text, p_device: deviceId() });
    if (res.data === 'too_fast') { await sleep(900); res = await supabase.rpc('submit_answer', { p_question: qid, p_text: text, p_device: deviceId() }); }
    if (res.error) throw res.error;
    const code = res.data;
    const [msg, kind] = MESSAGES[code] ?? ['Algo salió mal, probá de nuevo.', 'err'];
    toast(msg, kind);
    if (code === 'ok' || code === 'flagged') {
      saveMine(qid, [...loadMine(qid), { text, flagged: code === 'flagged' }]);
      els.input.value = '';
      updateCount();
      renderMine();
    }
    if (code === 'closed' || code === 'not_active') await refresh();
  } catch {
    toast('Sin conexión. Revisá tu internet y probá de nuevo.', 'err');
  } finally {
    sending = false;
    els.send.disabled = false;
    els.send.textContent = 'Enviar';
    if (!els.form.hidden) els.input.focus({ preventScroll: true });
  }
});

// ---------- Toast ----------
let toastTimer;
function toast(msg, kind = 'ok') {
  els.toast.textContent = msg;
  els.toast.className = 'p-toast ' + kind;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, kind === 'ok' ? 1800 : 3200);
}

// ---------- Arranque ----------
if (!configured) {
  show('waiting');
  document.body.insertAdjacentHTML('beforeend',
    '<div class="config-error">Falta configurar Supabase: <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code>.</div>');
} else {
  show('loading');
  refresh();
  watchState(refresh, { fallbackMs: 5000 });
}
