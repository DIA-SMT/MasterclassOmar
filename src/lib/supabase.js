import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configured = Boolean(url && key);
export const supabase = configured ? createClient(url, key) : null;

/** URL a la que lleva el QR (vista de participante). */
export function publicUrl() {
  const base = import.meta.env.VITE_PUBLIC_URL || location.origin;
  return base.replace(/\/+$/, '') + '/';
}

/** Texto corto para mostrar debajo del QR. */
export function prettyUrl() {
  return publicUrl().replace(/^https?:\/\//, '').replace(/\/$/, '');
}

let memoryDevice = null;
/** Id anónimo y persistente del celular (sirve para no contar dos veces la misma palabra). */
export function deviceId() {
  const K = 'nube.device';
  let id = memoryDevice;
  try { id = id || localStorage.getItem(K); } catch { /* modo privado */ }
  if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = globalThis.crypto?.randomUUID?.() ??
      'd-' + Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    try { localStorage.setItem(K, id); } catch { /* modo privado */ }
  }
  memoryDevice = id;
  return id;
}

/**
 * Escucha cambios del estado global (pregunta activa, QR grande, etc.).
 * Usa Realtime y, si no conecta (p. ej. por límite de conexiones), cae a polling.
 */
export function watchState(onChange, { fallbackMs = 5000, safetyMs = 20000 } = {}) {
  let live = false;
  let last = 0;
  const fire = () => { last = Date.now(); onChange(); };

  const channel = supabase
    .channel('app-state-' + Math.random().toString(36).slice(2, 8))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'app_state' }, fire)
    .subscribe((status) => {
      const wasLive = live;
      live = status === 'SUBSCRIBED';
      if (live && !wasLive) fire(); // re-sincroniza al (re)conectar
    });

  const timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - last >= (live ? safetyMs : fallbackMs)) fire();
  }, 1000);

  const onVisible = () => { if (document.visibilityState === 'visible') fire(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', fire);

  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', fire);
    supabase.removeChannel(channel);
  };
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
