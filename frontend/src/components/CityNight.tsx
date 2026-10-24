import { useEffect, useRef } from 'react';

/**
 * Vue aérienne nocturne procédurale (aucune photo simulée) : milliers de points lumineux chauds
 * le long de trames de rues, courbe du fleuve évoquant le Pool Malebo, parallaxe légère,
 * grain filmique (CSS) et vignettage. prefers-reduced-motion → image fixe.
 */

type Light = { x: number; y: number; r: number; a: number; c: string };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/** Rive du fleuve : y(x) normalisé, grande boucle au nord-est (Pool Malebo). */
function riverY(x: number): number {
  return 0.2 + 0.06 * Math.sin(x * 3.1 + 0.6) - 0.1 * Math.exp(-((x - 0.72) ** 2) / 0.02);
}
function riverHalfWidth(x: number): number {
  return 0.035 + 0.07 * Math.exp(-((x - 0.72) ** 2) / 0.018);
}

const WARM = ['#ffb35c', '#ffb35c', '#ffa94a', '#ffc27a', '#ffd6a0'];
const COOL = ['#dfe9ff', '#f4f7ff'];
/** Centre (Gombe, au bord du fleuve) : la densité décroît avec la distance. */
const CENTRE = { x: 0.64, y: 0.42 };

function buildLights(seed: number): { far: Light[]; near: Light[]; avenues: [number, number, number, number][] } {
  const r = rng(seed);
  const far: Light[] = []; const near: Light[] = [];
  // Quartiers : trames orthogonales d'orientation propre, plus denses près du centre
  const districts = Array.from({ length: 16 }, () => {
    const cx = 0.2 + r() * 0.85, cy = 0.36 + r() * 0.66;
    const d = Math.hypot(cx - CENTRE.x, (cy - CENTRE.y) * 1.3);
    return { cx, cy, rad: 0.08 + r() * 0.14, ang: (r() - 0.5) * 0.8, step: 0.012 + r() * 0.008, dens: Math.max(0.3, 1 - d * 0.85) };
  });
  districts.push({ cx: CENTRE.x, cy: CENTRE.y + 0.02, rad: 0.15, ang: 0.1, step: 0.0085, dens: 0.8 });
  for (const d of districts) {
    const cos = Math.cos(d.ang), sin = Math.sin(d.ang);
    const n = Math.ceil(d.rad / d.step);
    for (let i = -n; i <= n; i++) for (let j = -n * 2; j <= n * 2; j++) {
      // points uniquement le long des rues (lignes i entières, colonnes j paires = rues transversales)
      const onStreet = j % 2 === 0 || i % 2 === 0;
      if (!onStreet) continue;
      const u = i * d.step, v = (j / 2) * d.step;
      const x = d.cx + u * cos - v * sin + (r() - 0.5) * 0.0015;
      const y = d.cy + u * sin + v * cos + (r() - 0.5) * 0.0015;
      const dist = Math.hypot((x - d.cx) / d.rad, (y - d.cy) / d.rad);
      if (dist > 1 || r() > d.dens * (1 - dist * 0.55)) continue;
      if (y < riverY(x) + riverHalfWidth(x) + 0.008) continue;
      if (x < -0.02 || x > 1.02 || y > 1.04) continue;
      const b = r();
      const cool = b > 0.975;
      const light: Light = {
        x, y, r: b > 0.96 ? 1.7 : b > 0.75 ? 1.2 : 0.85, a: 0.5 + b * 0.5,
        c: cool ? COOL[Math.floor(r() * COOL.length)]! : WARM[Math.floor(r() * WARM.length)]!,
      };
      (b > 0.7 ? near : far).push(light);
    }
  }
  // Rive nord (Brazzaville) : lumières rares et lointaines
  for (let k = 0; k < 260; k++) {
    const x = r(); const y = riverY(x) - riverHalfWidth(x) - 0.012 - r() * 0.1;
    if (y < 0.03) continue;
    far.push({ x, y, r: 0.5, a: 0.15 + r() * 0.25, c: WARM[Math.floor(r() * WARM.length)]! });
  }
  const avenues: [number, number, number, number][] = [
    [0.02, 0.42, 0.98, 0.35], [0.3, 0.38, 0.5, 0.99], [0.4, 0.37, 0.96, 0.74], [0.1, 0.46, 0.33, 0.97],
  ];
  return { far, near, avenues };
}

function renderLayer(w: number, h: number, lights: Light[], scale: number, glow: HTMLCanvasElement | null, river: boolean, avenues?: [number, number, number, number][]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  if (!g) return c;
  if (river) {
    g.beginPath();
    const steps = 80;
    for (let i = 0; i <= steps; i++) { const x = i / steps; g.lineTo(x * w, (riverY(x) - riverHalfWidth(x)) * h); }
    for (let i = steps; i >= 0; i--) { const x = i / steps; g.lineTo(x * w, (riverY(x) + riverHalfWidth(x)) * h); }
    g.closePath();
    const grad = g.createLinearGradient(0, 0, 0, h * 0.45);
    grad.addColorStop(0, 'rgba(6,9,26,0.85)'); grad.addColorStop(1, 'rgba(10,15,40,0.8)');
    g.fillStyle = grad; g.fill();
    g.strokeStyle = 'rgba(255,179,92,0.08)'; g.lineWidth = 1 * scale; g.stroke();
    // Reflets : courtes traînées verticales sous la rive sud
    const rr = rng(7);
    for (let k = 0; k < 40; k++) {
      const x = rr(); const top = riverY(x) + riverHalfWidth(x);
      const len = (0.006 + rr() * 0.018) * h;
      const lg = g.createLinearGradient(0, top * h - len, 0, top * h);
      lg.addColorStop(0, 'rgba(255,179,92,0)'); lg.addColorStop(1, `rgba(255,179,92,${0.03 + rr() * 0.06})`);
      g.fillStyle = lg; g.fillRect(x * w, top * h - len, 0.8 * scale, len);
    }
  }
  if (avenues) {
    g.lineCap = 'round';
    for (const [x1, y1, x2, y2] of avenues) {
      const lg = g.createLinearGradient(x1 * w, y1 * h, x2 * w, y2 * h);
      lg.addColorStop(0, 'rgba(255,190,110,0.0)'); lg.addColorStop(0.3, 'rgba(255,190,110,0.22)'); lg.addColorStop(1, 'rgba(255,190,110,0.04)');
      g.strokeStyle = lg; g.lineWidth = 1.2 * scale;
      g.beginPath(); g.moveTo(x1 * w, y1 * h); g.lineTo(x2 * w, y2 * h); g.stroke();
    }
  }
  for (const l of lights) {
    // Profondeur de champ : net au centre, bokeh doux et plus large vers les bords
    const edge = Math.min(1, Math.hypot((l.x - CENTRE.x) * 1.1, (l.y - CENTRE.y) * 1.4) / 0.75);
    const blur = edge * edge;
    if (glow && (blur > 0.35 || l.r > 1.1)) {
      const s2 = (6 + blur * 14) * scale * (l.r > 1.1 ? 1.3 : 1);
      g.globalAlpha = l.a * (0.35 + 0.4 * blur);
      g.drawImage(glow, l.x * w - s2 / 2, l.y * h - s2 / 2, s2, s2);
    }
    g.globalAlpha = l.a * (1 - blur * 0.4);
    g.fillStyle = l.c;
    g.beginPath(); g.arc(l.x * w, l.y * h, l.r * scale * (0.8 + blur * 0.6), 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  return c;
}

export function CityNight({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const data = buildLights(20260926);
    let far: HTMLCanvasElement | null = null, near: HTMLCanvasElement | null = null;
    let W = 0, H = 0, dpr = 1, raf = 0, visible = true;
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const M = 0.06; // marge de parallaxe

    const glow = document.createElement('canvas');
    glow.width = glow.height = 32;
    const gg = glow.getContext('2d');
    if (gg) {
      const rg = gg.createRadialGradient(16, 16, 0, 16, 16, 16);
      rg.addColorStop(0, 'rgba(255,179,92,0.5)'); rg.addColorStop(0.5, 'rgba(255,179,92,0.18)'); rg.addColorStop(1, 'rgba(255,179,92,0)');
      gg.fillStyle = rg; gg.fillRect(0, 0, 32, 32);
    }

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = Math.max(1, Math.round(rect.width * dpr)); H = Math.max(1, Math.round(rect.height * dpr));
      canvas!.width = W; canvas!.height = H;
      const lw = Math.round(W * (1 + M * 2)), lh = Math.round(H * (1 + M * 2));
      const s = dpr * Math.max(0.8, Math.min(1.4, rect.width / 1100));
      far = renderLayer(lw, lh, data.far, s, null, true, data.avenues);
      near = renderLayer(lw, lh, data.near, s, glow, false);
      draw(0);
    }

    function draw(t: number) {
      if (!ctx || !far || !near) return;
      pointer.x += (pointer.tx - pointer.x) * 0.04; pointer.y += (pointer.ty - pointer.y) * 0.04;
      const drift = reduce ? 0 : Math.sin(t / 60000) * 0.01;
      const sy = reduce ? 0 : Math.min(window.scrollY / Math.max(H / dpr, 1), 1) * 0.04;
      ctx.clearRect(0, 0, W, H);
      const ox = -W * M, oy = -H * M;
      ctx.drawImage(far, ox + (pointer.x * 0.3 + drift) * W * 0.3, oy + (pointer.y * 0.3 - sy * 0.5) * H * 0.3);
      ctx.drawImage(near, ox + (pointer.x + drift * 1.6) * W * 0.3, oy + (pointer.y - sy) * H * 0.3);
    }

    function loop(t: number) {
      if (visible && !document.hidden) draw(t);
      raf = requestAnimationFrame(loop);
    }

    const onMove = (e: PointerEvent) => {
      pointer.tx = (e.clientX / window.innerWidth - 0.5) * 0.06;
      pointer.ty = (e.clientY / window.innerHeight - 0.5) * 0.04;
    };
    resize();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
    ro?.observe(canvas);
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; }) : null;
    io?.observe(canvas);
    if (!reduce) {
      window.addEventListener('pointermove', onMove, { passive: true });
      raf = requestAnimationFrame(loop);
    }
    return () => { cancelAnimationFrame(raf); ro?.disconnect(); io?.disconnect(); window.removeEventListener('pointermove', onMove); };
  }, []);
  return (
    <div className={`city-night ${className ?? ''}`} aria-hidden="true">
      <canvas ref={ref} />
      <div className="grain" />
      <div className="vignette" />
    </div>
  );
}
