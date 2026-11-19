import './styles/base.css';
import './styles/pantalla.css';
import { supabase, configured, publicUrl, prettyUrl, watchState } from './lib/supabase.js';
import { networkSVG, circuitSVG, qrSVG, logo } from './lib/decor.js';
import { WordCloud } from './lib/cloud.js';
import { LOGOS } from './config.js';

const $ = (id) => document.getElementById(id);
const body = document.body;

// ---------- Decoración y QR ----------
document.querySelectorAll('[data-logos]').forEach((el) => {
  el.innerHTML = logo(LOGOS.utn40) + logo(LOGOS.isi) + logo(LOGOS.masterclass, 'round');
});
document.querySelectorAll('[data-circuit]').forEach((el) => { el.outerHTML = circuitSVG(); });
$('net-bl').innerHTML = networkSVG({ w: 520, h: 360, n: 18, seed: 5, corner: 'bl' });
$('net-r').innerHTML = networkSVG({ w: 200, h: 600, n: 13, seed: 23, corner: 'tr' });

qrSVG(publicUrl()).then((svg) => {
  document.querySelectorAll('[data-qr]').forEach((el) => { el.innerHTML = svg; });
});
document.querySelectorAll('[data-url]').forEach((el) => { el.textContent = prettyUrl(); });

// ---------- Estado ----------
const cloud = new WordCloud($('cloud'));
let qid = null;

function sizeClass(text) {
  return text.length > 120 ? 'xlong' : text.length > 70 ? 'long' : '';
}

function apply(data) {
  const q = data?.question ?? null;
  $('qr-overlay').hidden = !data?.show_qr;
  $('ov-q').textContent = q?.text ?? 'Escaneá y participá';

  if (!q) {
    body.dataset.scene = 'welcome';
    if (qid) { qid = null; cloud.clear(); }
    return;
  }
  body.dataset.scene = 'live';
  $('q-text').textContent = q.text;
  $('q-text').className = 's-qtext ' + sizeClass(q.text);
  document.querySelector('.s-qcard').classList.toggle('closed', !q.is_open);
  $('q-label').textContent = q.is_open ? 'Pregunta en vivo' : 'Respuestas cerradas';

  if (q.id !== qid) {
    qid = q.id;
    cloud.clear();
    $('empty').hidden = false;
    $('st-people').textContent = '0';
    $('st-total').textContent = '0';
    refreshCloud();
  }
}

let busyState = false;
async function refreshState() {
  if (busyState) return;
  busyState = true;
  try {
    const { data, error } = await supabase.rpc('get_current');
    if (!error) apply(data);
  } finally { busyState = false; }
}

let busyCloud = false;
async function refreshCloud() {
  if (!qid || busyCloud) return;
  busyCloud = true;
  const asked = qid;
  try {
    const { data, error } = await supabase.rpc('get_cloud', { p_question: asked });
    if (error || asked !== qid || !data) return;
    cloud.set(data.terms ?? []);
    $('empty').hidden = (data.terms ?? []).length > 0;
    $('st-people').textContent = data.participants ?? 0;
    $('st-total').textContent = data.total ?? 0;
  } finally { busyCloud = false; }
}

// ---------- Pantalla completa y cursor ----------
async function toggleFs() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch { /* navegador sin permiso */ }
}
$('fs').addEventListener('click', toggleFs);
document.addEventListener('keydown', (e) => { if (e.key === 'f' || e.key === 'F') toggleFs(); });
document.addEventListener('fullscreenchange', () => body.classList.toggle('is-fs', !!document.fullscreenElement));
let idleTimer;
const wake = () => {
  body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => body.classList.add('idle'), 2500);
};
document.addEventListener('mousemove', wake);
wake();

// ---------- Arranque ----------
if (!configured) {
  body.dataset.scene = 'welcome';
  body.insertAdjacentHTML('beforeend',
    '<div class="config-error">Falta configurar Supabase: <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_ANON_KEY</code>.</div>');
} else {
  // esperamos la tipografía para medir bien las palabras
  Promise.race([document.fonts.load('800 100px "Montserrat Variable"'), new Promise((r) => setTimeout(r, 2500))])
    .finally(() => {
      refreshState();
      watchState(refreshState, { fallbackMs: 4000, safetyMs: 15000 });
      setInterval(() => { if (document.visibilityState === 'visible') refreshCloud(); }, 1500);
    });
}
