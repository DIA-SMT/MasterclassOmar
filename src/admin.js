import './styles/base.css';
import './styles/admin.css';
import { supabase, configured, publicUrl, prettyUrl, watchState, escapeHtml as esc } from './lib/supabase.js';
import { qrSVG } from './lib/decor.js';

const $ = (id) => document.getElementById(id);

let questions = [];
let state = null;      // fila de app_state
let stats = {};        // { [question_id]: { answers, people } }
let terms = [];        // admin_terms() de la pregunta activa
let blocked = [];
let filter = 'all';
let editing = null;    // id de la pregunta en edición
let started = false;

// ---------- Utilidades ----------
let toastTimer;
function toast(msg, kind = 'ok') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'a-toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'err' ? 4500 : 2000);
}

/** Ejecuta una operación de Supabase y muestra el error si falla. */
async function run(promise, okMsg) {
  const { data, error } = await promise;
  if (error) { toast('Error: ' + error.message, 'err'); return null; }
  if (okMsg) toast(okMsg);
  return data ?? true;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const activeId = () => state?.active_question_id ?? null;
const activeQ = () => questions.find((q) => q.id === activeId()) ?? null;

function view(name) {
  for (const v of ['login', 'denied', 'app']) $(v).hidden = v !== name;
}

// ---------- Sesión ----------
async function boot() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return view('login');
  const { error } = await supabase.rpc('admin_stats');
  if (error) {
    $('denied-email').textContent = session.user.email;
    $('denied-sql').textContent = `insert into public.admins (email) values ('${session.user.email}') on conflict do nothing;`;
    return view('denied');
  }
  view('app');
  start();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-btn').disabled = true;
  $('login-error').hidden = true;
  const { error } = await supabase.auth.signInWithPassword({ email: $('email').value.trim(), password: $('password').value });
  $('login-btn').disabled = false;
  if (error) {
    $('login-error').textContent = error.message.includes('Invalid') ? 'Email o contraseña incorrectos.' : error.message;
    $('login-error').hidden = false;
    return;
  }
  boot();
});
const logout = async () => { await supabase.auth.signOut(); location.reload(); };
$('logout').addEventListener('click', logout);
$('denied-logout').addEventListener('click', logout);

// ---------- Carga de datos ----------
async function loadQuestions() {
  const { data, error } = await supabase.from('questions').select('*').order('position').order('created_at');
  if (!error) questions = data;
}
async function loadState() {
  const { data, error } = await supabase.from('app_state').select('*').eq('id', 1).single();
  $('conn').classList.toggle('off', !!error);
  if (error) return;
  const changed = data.active_question_id !== state?.active_question_id;
  state = data;
  if (changed) { terms = []; loadTerms(); }
  await loadQuestions(); // el estado de abierta/cerrada vive en la pregunta
  renderAll();
}
async function loadStats() {
  const { data, error } = await supabase.rpc('admin_stats');
  $('conn').classList.toggle('off', !!error);
  if (error) return;
  stats = data ?? {};
  renderQuestions();
  renderLive();
}
let loadingTerms = false;
async function loadTerms() {
  const qid = activeId();
  if (!qid) { terms = []; renderTerms(); return; }
  if (loadingTerms) return;
  loadingTerms = true;
  try {
    const { data, error } = await supabase.rpc('admin_terms', { p_question: qid });
    if (!error && qid === activeId()) { terms = data ?? []; renderTerms(); }
  } finally { loadingTerms = false; }
}
async function loadBlocked() {
  const { data, error } = await supabase.from('blocked_words').select('word').order('word');
  if (!error) { blocked = data.map((r) => r.word); renderBlocked(); }
}

function start() {
  if (started) return;
  started = true;
  const url = publicUrl();
  $('public-url').href = url;
  $('public-url').textContent = prettyUrl();
  qrSVG(url).then((svg) => { $('qr-mini').innerHTML = svg; });

  Promise.all([loadQuestions(), loadStats(), loadBlocked()]).then(loadState);
  watchState(loadState, { fallbackMs: 3000, safetyMs: 10000 });
  setInterval(() => { if (document.visibilityState === 'visible') loadTerms(); }, 2000);
  setInterval(() => { if (document.visibilityState === 'visible') loadStats(); }, 4000);
}

// ---------- Render ----------
function renderAll() { renderLive(); renderQuestions(); renderTerms(); }

function renderLive() {
  const q = activeQ();
  $('live-none').hidden = !!q;
  $('live-q').hidden = !q;
  $('mod').hidden = !q;
  $('project-first').disabled = questions.length === 0;
  $('project-first').textContent = questions.length ? 'Proyectar la primera pregunta' : 'Primero agregá una pregunta →';

  $('toggle-qr').textContent = state?.show_qr ? 'Ocultar QR grande' : 'Mostrar QR grande';
  $('toggle-qr').classList.toggle('on', !!state?.show_qr);
  $('toggle-open').hidden = !q;
  $('unproject').hidden = !q;
  const idx = q ? questions.findIndex((x) => x.id === q.id) : -1;
  $('next').hidden = !q;
  $('next').disabled = idx < 0 || idx >= questions.length - 1;

  if (!q) return;
  $('live-status').textContent = q.is_open ? 'Recibiendo respuestas' : 'Respuestas cerradas';
  $('live-status').className = 'a-live-status' + (q.is_open ? '' : ' off');
  $('live-text').textContent = q.text;
  const s = stats[q.id] ?? { answers: 0, people: 0 };
  $('live-stats').innerHTML = `<b>${s.answers}</b> respuestas · <b>${s.people}</b> participantes`;
  $('toggle-open').textContent = q.is_open ? 'Cerrar respuestas' : 'Abrir respuestas';
}

function renderQuestions() {
  $('q-count').textContent = questions.length ? plural(questions.length, 'pregunta', 'preguntas') : '';
  if (!questions.length) {
    $('qlist').innerHTML = '<li class="a-empty">Todavía no hay preguntas. Agregá la primera arriba.</li>';
    return;
  }
  $('qlist').innerHTML = questions.map((q, i) => {
    const active = q.id === activeId();
    const s = stats[q.id] ?? { answers: 0, people: 0 };
    if (editing === q.id) {
      return `<li class="a-q${active ? ' active' : ''}"><div class="a-q-num">${i + 1}</div>
        <div class="a-q-edit"><textarea class="input" rows="3" maxlength="200" data-edit="${q.id}">${esc(q.text)}</textarea>
        <div class="a-row"><button class="btn sm primary" data-act="save" data-id="${q.id}" type="button">Guardar</button>
        <button class="btn sm ghost" data-act="cancel" type="button">Cancelar</button></div></div></li>`;
    }
    return `<li class="a-q${active ? ' active' : ''}">
      <div class="a-q-num">${i + 1}</div>
      <div>
        <div class="a-q-text">${esc(q.text)}</div>
        <div class="a-q-meta">${plural(s.answers, 'respuesta', 'respuestas')} · ${plural(s.people, 'persona', 'personas')}${q.is_open ? '' : ' · cerrada'}</div>
      </div>
      <div class="a-q-actions">
        ${active ? '<span class="a-tag live">En pantalla</span>' : `<button class="btn sm primary" data-act="project" data-id="${q.id}" type="button">Proyectar</button>`}
        <button class="btn sm ghost" data-act="up" data-id="${q.id}" type="button" title="Subir" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn sm ghost" data-act="down" data-id="${q.id}" type="button" title="Bajar" ${i === questions.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn sm ghost" data-act="edit" data-id="${q.id}" type="button">Editar</button>
        <button class="btn sm danger" data-act="delete" data-id="${q.id}" type="button">Borrar</button>
      </div>
    </li>`;
  }).join('');
}

function renderTerms() {
  const flaggedN = terms.filter((t) => t.flagged > 0).length;
  const hiddenN = terms.filter((t) => t.hidden).length;
  const counters = $('tabs').querySelectorAll('span');
  counters[0].textContent = terms.length || '';
  counters[1].textContent = flaggedN || '';
  counters[2].textContent = hiddenN || '';

  const qs = $('search').value.trim().toLowerCase();
  const list = terms.filter((t) =>
    (filter === 'all' || (filter === 'flagged' && t.flagged > 0) || (filter === 'hidden' && t.hidden)) &&
    (!qs || t.text.toLowerCase().includes(qs) || t.norm.includes(qs)));

  if (!list.length) {
    $('terms').innerHTML = `<div class="a-empty">${terms.length ? 'Nada para mostrar con este filtro.' : 'Todavía no hay respuestas.'}</div>`;
    return;
  }
  $('terms').innerHTML = list.map((t) => {
    const n = esc(t.norm);
    const actions = [];
    if (t.flagged > 0) actions.push(`<button class="btn sm" data-term="allow" data-norm="${n}" type="button">Permitir</button>`);
    actions.push(t.hidden
      ? `<button class="btn sm" data-term="show" data-norm="${n}" type="button">Mostrar</button>`
      : `<button class="btn sm danger" data-term="hide" data-norm="${n}" type="button">Ocultar</button>`);
    return `<div class="a-term${t.hidden ? ' is-hidden' : ''}${t.flagged > 0 ? ' is-flagged' : ''}">
      <span class="a-term-text" title="${esc(t.text)}">${esc(t.text)}</span>
      ${t.flagged > 0 ? '<span class="a-tag warn">Filtrada</span>' : ''}
      ${t.hidden ? '<span class="a-tag">Oculta</span>' : ''}
      <span class="a-term-count">${t.count}</span>
      ${actions.join('')}
    </div>`;
  }).join('');
}

function renderBlocked() {
  $('block-n').textContent = blocked.length;
  $('blocked').innerHTML = blocked.map((w) =>
    `<span class="a-chip">${esc(w)}<button data-unblock="${esc(w)}" type="button" title="Quitar">×</button></span>`).join('');
}

// ---------- Acciones: pantalla ----------
async function project(id) {
  if (await run(supabase.from('app_state').update({ active_question_id: id, show_qr: false }).eq('id', 1))) loadState();
}
$('project-first').addEventListener('click', () => questions[0] && project(questions[0].id));
$('next').addEventListener('click', () => {
  const idx = questions.findIndex((q) => q.id === activeId());
  if (idx >= 0 && questions[idx + 1]) project(questions[idx + 1].id);
});
$('unproject').addEventListener('click', async () => {
  if (await run(supabase.from('app_state').update({ active_question_id: null, show_qr: false }).eq('id', 1))) loadState();
});
$('toggle-qr').addEventListener('click', async () => {
  if (await run(supabase.from('app_state').update({ show_qr: !state?.show_qr }).eq('id', 1))) loadState();
});
$('toggle-open').addEventListener('click', async () => {
  const q = activeQ();
  if (!q) return;
  if (await run(supabase.from('questions').update({ is_open: !q.is_open }).eq('id', q.id),
    q.is_open ? 'Respuestas cerradas' : 'Respuestas abiertas')) loadState();
});
$('clear').addEventListener('click', async () => {
  const q = activeQ();
  if (!q) return;
  const n = stats[q.id]?.answers ?? 0;
  if (!confirm(`¿Borrar las ${n} respuestas de "${q.text}"?\n\nNo se puede deshacer.`)) return;
  await run(supabase.from('hidden_terms').delete().eq('question_id', q.id));
  if (await run(supabase.from('answers').delete().eq('question_id', q.id), 'Respuestas borradas')) {
    loadTerms();
    loadStats();
  }
});

// ---------- Acciones: moderación ----------
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filter]');
  if (!b) return;
  filter = b.dataset.filter;
  $('tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  renderTerms();
});
$('search').addEventListener('input', renderTerms);
$('terms').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-term]');
  const qid = activeId();
  if (!b || !qid) return;
  const norm = b.dataset.norm;
  b.disabled = true;
  const t = terms.find((x) => x.norm === norm);
  if (b.dataset.term === 'hide') {
    await run(supabase.from('hidden_terms').upsert({ question_id: qid, norm }), `"${t?.text ?? norm}" oculta`);
  } else if (b.dataset.term === 'show') {
    await run(supabase.from('hidden_terms').delete().eq('question_id', qid).eq('norm', norm), `"${t?.text ?? norm}" visible`);
  } else if (b.dataset.term === 'allow') {
    await run(supabase.from('answers').update({ flagged: false }).eq('question_id', qid).eq('norm', norm), `"${t?.text ?? norm}" permitida`);
  }
  loadTerms();
});

// ---------- Acciones: preguntas ----------
$('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('add-text').value.replace(/\s+/g, ' ').trim();
  if (!text) return;
  const position = questions.reduce((m, q) => Math.max(m, q.position), 0) + 1;
  if (await run(supabase.from('questions').insert({ text, position }), 'Pregunta agregada')) {
    $('add-text').value = '';
    await loadQuestions();
    renderAll();
  }
});
$('add-text').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('add-form').requestSubmit(); }
});

async function move(id, dir) {
  const order = questions.map((q) => q.id);
  const i = order.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  const updates = order
    .map((qid, pos) => ({ qid, pos: pos + 1 }))
    .filter(({ qid, pos }) => questions.find((q) => q.id === qid).position !== pos)
    .map(({ qid, pos }) => supabase.from('questions').update({ position: pos }).eq('id', qid));
  const results = await Promise.all(updates);
  const err = results.find((r) => r.error);
  if (err) toast('Error: ' + err.error.message, 'err');
  await loadQuestions();
  renderAll();
}

$('qlist').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const q = questions.find((x) => x.id === id);
  switch (b.dataset.act) {
    case 'project': return project(id);
    case 'up': return move(id, -1);
    case 'down': return move(id, 1);
    case 'edit': editing = id; renderQuestions(); $('qlist').querySelector('textarea')?.focus(); return;
    case 'cancel': editing = null; return renderQuestions();
    case 'save': {
      const text = $('qlist').querySelector(`[data-edit="${id}"]`).value.replace(/\s+/g, ' ').trim();
      if (!text) return toast('La pregunta no puede quedar vacía', 'err');
      if (await run(supabase.from('questions').update({ text }).eq('id', id), 'Pregunta actualizada')) {
        editing = null;
        await loadQuestions();
        renderAll();
      }
      return;
    }
    case 'delete': {
      const n = stats[id]?.answers ?? 0;
      if (!confirm(`¿Borrar la pregunta "${q?.text}"${n ? ` y sus ${n} respuestas` : ''}?\n\nNo se puede deshacer.`)) return;
      if (await run(supabase.from('questions').delete().eq('id', id), 'Pregunta borrada')) loadState();
    }
  }
});

// ---------- Herramientas ----------
$('copy-url').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(publicUrl()); toast('Link copiado'); } catch { toast(publicUrl()); }
});

$('block-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const word = $('block-word').value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!word) return;
  if (await run(supabase.from('blocked_words').upsert({ word }), `"${word}" bloqueada para respuestas nuevas`)) {
    $('block-word').value = '';
    loadBlocked();
  }
});
$('blocked').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-unblock]');
  if (!b) return;
  if (await run(supabase.from('blocked_words').delete().eq('word', b.dataset.unblock))) loadBlocked();
});

$('export').addEventListener('click', async () => {
  const btn = $('export');
  btn.disabled = true;
  btn.textContent = 'Exportando…';
  try {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('answers')
        .select('question_id,text,norm,flagged,device_id,created_at').order('id').range(from, from + 999);
      if (error) throw error;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    const { data: hidden, error: hErr } = await supabase.from('hidden_terms').select('question_id,norm');
    if (hErr) throw hErr;
    const hiddenSet = new Set(hidden.map((h) => h.question_id + '|' + h.norm));
    const qinfo = new Map(questions.map((q, i) => [q.id, { n: i + 1, text: q.text }]));
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [['N°', 'Pregunta', 'Respuesta', 'Agrupada como', 'Estado', 'Participante', 'Fecha y hora'].map(cell).join(';')];
    for (const r of rows) {
      const qi = qinfo.get(r.question_id) ?? { n: '', text: '' };
      const estado = r.flagged ? 'Filtrada' : hiddenSet.has(r.question_id + '|' + r.norm) ? 'Oculta' : 'Visible';
      lines.push([qi.n, qi.text, r.text, r.norm, estado, r.device_id.slice(0, 8),
        new Date(r.created_at).toLocaleString('es-AR')].map(cell).join(';'));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    a.href = URL.createObjectURL(blob);
    a.download = `nube-masterclass-${stamp}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`${rows.length} respuestas exportadas`);
  } catch (err) {
    toast('Error al exportar: ' + err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Exportar respuestas (CSV)';
  }
});

// ---------- Arranque ----------
if (!configured) {
  view('login');
  $('login-btn').disabled = true;
  document.body.insertAdjacentHTML('beforeend',
    '<div class="config-error">Falta configurar Supabase: <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code> (ver README).</div>');
} else {
  boot();
}
