import QRCode from 'qrcode';

// Generador pseudoaleatorio con semilla (misma red cada vez que se carga)
function rng(seed) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** Red de nodos y líneas como la del banner. corner: 'bl' | 'br' | 'tr' | 'tl' */
export function networkSVG({ w = 520, h = 420, n = 16, seed = 7, corner = 'bl' } = {}) {
  const r = rng(seed);
  const pts = [];
  for (let i = 0; i < n; i++) {
    let x = Math.pow(r(), 1.5) * w;
    let y = Math.pow(r(), 1.5) * h;
    if (corner.includes('r')) x = w - x;
    if (corner.includes('b')) y = h - y;
    pts.push([x, y, 1.6 + r() * 2.8]);
  }
  const edges = new Set();
  pts.forEach((p, i) => {
    pts
      .map((q, j) => [j, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2])
      .filter(([j]) => j !== i)
      .sort((a, b) => a[1] - b[1])
      .slice(0, 2 + (i % 2))
      .forEach(([j]) => edges.add(i < j ? `${i}-${j}` : `${j}-${i}`));
  });
  const lines = [...edges].map((e) => {
    const [a, b] = e.split('-').map(Number);
    return `<line x1="${pts[a][0].toFixed(1)}" y1="${pts[a][1].toFixed(1)}" x2="${pts[b][0].toFixed(1)}" y2="${pts[b][1].toFixed(1)}"/>`;
  }).join('');
  const dots = pts.map(([x, y, rad]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${rad.toFixed(1)}"/>`).join('');
  return `<svg class="net" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <g class="net-lines">${lines}</g><g class="net-dots">${dots}</g></svg>`;
}

/** Trazo tipo circuito con nodo hueco y barras inclinadas (motivo del banner). */
export function circuitSVG() {
  return `<svg class="circuit" viewBox="0 0 360 100" aria-hidden="true">
    <polyline points="22,80 88,14 230,14 268,52 360,52" fill="none" stroke="currentColor" stroke-width="1.6"/>
    <g fill="currentColor"><path d="M150 10h10l6 8h-10z"/><path d="M165 10h10l6 8h-10z"/><path d="M180 10h10l6 8h-10z"/></g>
    <circle cx="16" cy="86" r="11" fill="none" stroke="currentColor" stroke-width="3.2"/>
    <circle cx="16" cy="86" r="5.5" fill="currentColor"/>
  </svg>`;
}

/** QR en SVG (negro sobre blanco: lo más confiable para escanear desde lejos). */
export async function qrSVG(text) {
  return QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 0,
    color: { dark: '#000000', light: '#ffffff' },
  });
}

export function logo(l, cls = '') {
  return `<img class="logo ${cls}" src="${l.src}" alt="${l.alt}" decoding="async">`;
}
