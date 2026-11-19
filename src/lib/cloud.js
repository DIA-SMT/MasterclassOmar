// Nube de palabras: layout en espiral elíptica con colisión por rectángulos
// (determinístico → las palabras no "saltan" sin motivo) + render en DOM con transiciones.

const FONT = '"Montserrat Variable", Montserrat, system-ui, sans-serif';
const MIN_FONT = 15;

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const widthCache = new Map();
let mctx = null;
function unitWidth(text, weight) {
  const k = weight + '|' + text;
  let w = widthCache.get(k);
  if (w === undefined) {
    mctx ??= document.createElement('canvas').getContext('2d');
    mctx.font = `${weight} 100px ${FONT}`;
    w = mctx.measureText(text).width / 100;
    widthCache.set(k, w);
  }
  return w;
}
// si la tipografía termina de cargar después, re-medimos
document.fonts?.addEventListener?.('loadingdone', () => widthCache.clear());

function prepare(terms) {
  const counts = terms.map((t) => t.count);
  const cmax = Math.max(...counts);
  const cmin = Math.min(...counts);
  return terms.map((t, rank) => {
    const r = cmax === cmin ? 1 : (t.count - cmin) / (cmax - cmin);
    const rel = 0.26 + 0.74 * Math.pow(r, 0.7); // tamaño relativo a la palabra más grande
    const weight = rel > 0.62 ? 800 : rel > 0.4 ? 700 : 600;
    return { ...t, rank, rel, weight, wu: unitWidth(t.text, weight) };
  });
}

function place(items, base, W, H, abortOnFail) {
  const CELL = 48;
  const grid = new Map();
  const placed = [];
  const ex = Math.max(1, W / H); // elipse con la forma del contenedor
  const cx = W / 2;
  const cy = H / 2;

  const cells = (x0, y0, x1, y1, fn) => {
    for (let gx = Math.floor(x0 / CELL); gx <= Math.floor(x1 / CELL); gx++)
      for (let gy = Math.floor(y0 / CELL); gy <= Math.floor(y1 / CELL); gy++) if (fn(gx * 8192 + gy)) return true;
    return false;
  };
  const hits = (x0, y0, x1, y1) => cells(x0, y0, x1, y1, (k) => {
    const list = grid.get(k);
    if (!list) return false;
    for (const b of list) if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) return true;
    return false;
  });
  const add = (box) => cells(box[0], box[1], box[2], box[3], (k) => {
    (grid.get(k) ?? grid.set(k, []).get(k)).push(box);
    return false;
  });

  for (const it of items) {
    const size = Math.max(MIN_FONT, base * it.rel);
    const w = it.wu * size + size * 0.26 + 6;
    const h = size * 1.06 + 4;
    const hw = w / 2;
    const hh = h / 2;
    let pos = null;

    if (w <= W && h <= H) {
      const a0 = it.rank === 0 ? 0 : (hash(it.norm) % 6283) / 1000;
      let r = 0;
      let th = 0;
      for (let guard = 0; guard < 60000; guard++) {
        const x = cx + r * ex * Math.cos(th + a0);
        const y = cy + r * Math.sin(th + a0);
        if (x - hw >= 0 && x + hw <= W && y - hh >= 0 && y + hh <= H && !hits(x - hw, y - hh, x + hw, y + hh)) {
          pos = { x, y };
          break;
        }
        if (r > H / 2 + hh && r * ex > W / 2 + hw) break; // ya salió del contenedor
        const dth = Math.min(0.6, 7 / Math.max(1, r * ex));
        th += dth;
        r += (9 * dth) / (2 * Math.PI); // ~9 px por vuelta
      }
    }

    if (!pos) {
      if (abortOnFail) return null;
      continue;
    }
    const box = [pos.x - hw, pos.y - hh, pos.x + hw, pos.y + hh];
    add(box);
    placed.push({ ...it, size, x: pos.x, y: pos.y });
  }
  return placed;
}

export function layoutCloud(terms, W, H) {
  if (!terms.length || W < 60 || H < 60) return [];
  const items = prepare(terms);
  // estimación inicial: que las palabras ocupen ~45 % del área
  const unitArea = items.reduce((a, it) => a + (it.wu * it.rel + 0.26 * it.rel) * 1.06 * it.rel, 0);
  const cap = Math.min(H * 0.34, W * 0.2);
  let base = Math.min(cap, Math.sqrt((W * H * 0.45) / unitArea));
  let best = null;
  // achicar hasta que entre todo…
  for (let i = 0; i < 22 && base > MIN_FONT; i++) {
    best = place(items, base, W, H, true);
    if (best) break;
    base *= 0.9;
  }
  if (!best) return place(items, Math.max(base, MIN_FONT), W, H, false); // lo que entre
  // …y agrandar mientras siga entrando, para llenar el espacio
  for (let i = 0; i < 10 && base * 1.07 <= cap; i++) {
    const bigger = place(items, base * 1.07, W, H, true);
    if (!bigger) break;
    best = bigger;
    base *= 1.07;
  }
  return best;
}

function colorFor(p) {
  if (p.rank === 0) return 'var(--lime)';
  const h = hash(p.norm) % 10;
  if (p.rel > 0.62) return h < 4 ? 'var(--lime)' : 'var(--white)';
  return ['var(--white)', 'var(--white)', 'var(--white)', 'var(--lime)', 'var(--lime)',
    'var(--lime-soft)', 'var(--lime-soft)', 'var(--silver)', 'var(--white)', 'var(--silver)'][h];
}

export class WordCloud {
  constructor(el) {
    this.el = el;
    this.nodes = new Map();
    this.counts = new Map();
    this.terms = [];
    this.key = '';
    this.size = '';
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(el);
  }

  set(terms) {
    const key = terms.map((t) => t.norm + ':' + t.count + ':' + t.text).join('|');
    if (key === this.key) return; // sin cambios → no re-layout
    this.key = key;
    this.terms = terms;
    this.schedule();
  }

  clear() {
    for (const node of this.nodes.values()) node.remove();
    this.nodes.clear();
    this.counts.clear();
    this.terms = [];
    this.key = '';
  }

  schedule() {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(() => this.render());
  }

  render() {
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    const placed = layoutCloud(this.terms, W, H);
    const seen = new Set();

    for (const p of placed) {
      seen.add(p.norm);
      let node = this.nodes.get(p.norm);
      const at = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -50%)`;
      if (!node) {
        node = document.createElement('span');
        node.className = 'w';
        node.style.fontSize = p.size + 'px';
        node.style.transform = at + ' scale(0.2)';
        node.style.opacity = '0';
        this.el.appendChild(node);
        this.nodes.set(p.norm, node);
        node.getBoundingClientRect(); // fuerza el estado inicial para animar la entrada
      }
      if (node.textContent !== p.text) node.textContent = p.text;
      node.style.fontSize = p.size.toFixed(1) + 'px';
      node.style.fontWeight = p.weight;
      node.style.color = colorFor(p);
      node.style.transform = at;
      node.style.opacity = '1';
      node.style.zIndex = String(1000 - p.rank);

      const prev = this.counts.get(p.norm);
      if (prev !== undefined && p.count > prev) {
        node.classList.remove('bump');
        void node.offsetWidth;
        node.classList.add('bump');
      }
      this.counts.set(p.norm, p.count);
    }

    for (const [norm, node] of this.nodes) {
      if (seen.has(norm)) continue;
      node.style.opacity = '0';
      node.style.transform += ' scale(0.3)';
      setTimeout(() => node.remove(), 700);
      this.nodes.delete(norm);
      this.counts.delete(norm);
    }
  }
}
