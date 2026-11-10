/* Audit d'accessibilité (deuxième passe adverse, 27/09/2026) : parcours au clavier seul, focus visible, libellés,
 * repères (landmarks), zoom 200 %, mouvement réduit, contraste. Chromium Playwright (/opt/pw-browsers). */
// Playwright : module global (PLAYWRIGHT_MODULE, défaut /opt/node22/lib/node_modules/playwright) ; navigateurs dans PLAYWRIGHT_BROWSERS_PATH.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright');
const BASE = process.env.BASE || 'http://localhost:18743';
const out = { parcours: [], pages: [] };
const log = (...a) => console.log(...a);

async function newPage(browser, user, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 }, reducedMotion: opts.reducedMotion ?? 'no-preference' });
  await ctx.addInitScript((u) => { try { localStorage.setItem('mosolo.demoUser', u); } catch {} }, user);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log('ERREUR JS', e.message));
  return { ctx, page };
}

const focusInfo = (page) => page.evaluate(() => {
  const e = document.activeElement;
  if (!e || e === document.body) return { tag: 'body', name: '', visible: false };
  const cs = getComputedStyle(e);
  const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
  const shadow = cs.boxShadow && cs.boxShadow !== 'none';
  const lab = e.labels && e.labels[0] ? e.labels[0].textContent : '';
  const name = (e.getAttribute('aria-label') || lab || e.textContent || e.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return { tag: e.tagName.toLowerCase(), name, visible: outline || shadow, inDialog: !!e.closest('[role="dialog"], dialog') };
});

/** Tabule jusqu'à l'élément dont le nom correspond (max n) ; relève les éléments sans focus visible. */
async function tabTo(page, re, max = 80, invisible = []) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const f = await focusInfo(page);
    if (f.tag !== 'body' && !f.visible) invisible.push(`${f.tag} « ${f.name} »`);
    if (re.test(f.name)) return f;
  }
  return null;
}

async function pageChecks(page, label) {
  const r = await page.evaluate(() => {
    const vis = (e) => { const s = getComputedStyle(e); const b = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0; };
    const nameOf = (e) => {
      if (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby') || e.getAttribute('title')) return true;
      if (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) return true;
      if (e.closest('label')) return true;
      if (['button', 'a', 'summary'].includes(e.tagName.toLowerCase()) && e.textContent.trim()) return true;
      if (e.tagName === 'IMG' && e.hasAttribute('alt')) return true;
      return false;
    };
    const unlabeled = [...document.querySelectorAll('input:not([type=hidden]), select, textarea, button, a[href], [role=button]')].filter((e) => vis(e) && !nameOf(e))
      .map((e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className ? '.' + String(e.className).split(' ')[0] : ''}`);
    const imgs = [...document.querySelectorAll('img')].filter((e) => vis(e) && !e.hasAttribute('alt')).map((e) => e.src.slice(-40));
    const landmarks = { main: document.querySelectorAll('main, [role=main]').length, nav: document.querySelectorAll('nav, [role=navigation]').length, header: document.querySelectorAll('header, [role=banner]').length, h1: document.querySelectorAll('h1').length };
    // Contraste : textes visibles (nœuds feuilles), couleur du texte / premier fond opaque ascendant.
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
    const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const bgOf = (e) => { for (let x = e; x; x = x.parentElement) { const c = parse(getComputedStyle(x).backgroundColor); if (c && c.a > 0.9 && !getComputedStyle(x).backgroundImage.includes('gradient')) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
    const low = [];
    const seen = new Set();
    for (const e of document.querySelectorAll('body *')) {
      if (!vis(e) || !e.childNodes.length) continue;
      const own = [...e.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ');
      if (!own) continue;
      const cs = getComputedStyle(e);
      const fg = parse(cs.color); if (!fg || fg.a < 0.5) continue;
      const bg = bgOf(e);
      const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
      const size = parseFloat(cs.fontSize); const bold = parseInt(cs.fontWeight, 10) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      if (ratio < need) { const k = `${cs.color}|${bg.r},${bg.g},${bg.b}`; if (!seen.has(k)) { seen.add(k); low.push(`${ratio.toFixed(2)} < ${need} « ${own.slice(0, 40)} » (${cs.color} sur rgb(${bg.r},${bg.g},${bg.b}))`); } }
    }
    const hscroll = document.documentElement.scrollWidth > window.innerWidth + 1;
    return { unlabeled: unlabeled.slice(0, 15), unlabeledCount: unlabeled.length, imgs, landmarks, low: low.slice(0, 12), lowCount: low.length, hscroll, lang: document.documentElement.lang };
  });
  out.pages.push({ label, ...r });
  log(`\n[${label}] repères=${JSON.stringify(r.landmarks)} lang=${r.lang} sans-libellé=${r.unlabeledCount} img-sans-alt=${r.imgs.length} contraste-bas=${r.lowCount} défilement-horizontal=${r.hscroll}`);
  if (r.unlabeled.length) log('  sans libellé :', r.unlabeled.join(', '));
  if (r.low.length) log('  contraste :', r.low.join('\n    '));
  return r;
}

(async () => {
  const browser = await chromium.launch();
  // ---------------------------------------------------------------- Parcours 1 : paiement du contribuable
  {
    const { ctx, page } = await newPage(browser, 'u-contribuable');
    await page.goto(BASE + '/espace', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const invisible = [];
    await page.keyboard.press('Tab');
    const skip = await focusInfo(page);
    await page.keyboard.press('Enter');
    const pay = await tabTo(page, /^Payer/, 60, invisible);
    let ok = false; let detail = '';
    if (pay) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      const inDialog = (await focusInfo(page)).inDialog;
      const choice = await tabTo(page, /Mobile|mobile/, 25, invisible);
      const trapped = [];
      for (let i = 0; i < 12; i++) { await page.keyboard.press('Tab'); trapped.push((await focusInfo(page)).inDialog); }
      out.piege = trapped.every(Boolean);
      log('  piège de focus (12 tabulations dans le panneau) :', out.piege);
      const submit = await tabTo(page, /Obtenir ma référence/i, 25, invisible);
      if (submit) { await page.keyboard.press('Enter'); await page.waitForTimeout(1200); }
      const ref = await page.evaluate(() => /PR-[A-Z0-9-]+|MOS-[A-Z0-9-]+|[A-Z]{2,4}-\d{4}-[A-Z0-9-]+/.exec(document.querySelector('[role="dialog"], dialog')?.textContent ?? document.body.textContent)?.[0] ?? null);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      const back = await focusInfo(page);
      ok = !!ref;
      detail = `saut=${skip.name} ; focus dans le panneau=${inDialog} ; choix=${choice?.name ?? '—'} ; validation=${submit?.name ?? '—'} ; référence=${ref} ; retour du focus=${back.tag} « ${back.name} »`;
    }
    out.parcours.push({ parcours: 'Paiement contribuable (/espace)', ok, detail, focusInvisible: [...new Set(invisible)] });
    log('\n[Parcours paiement]', ok ? 'RÉUSSI' : 'ÉCHEC', detail, '\n  focus non visible :', [...new Set(invisible)].join(', ') || 'aucun');
    await pageChecks(page, 'Espace contribuable');
    await ctx.close();
  }
  // ---------------------------------------------------------------- Parcours 2 : fiche de décision du Gouverneur
  {
    const { ctx, page } = await newPage(browser, 'u-gouverneur');
    await page.goto(BASE + '/poste-de-decision/decisions', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const invisible = [];
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    const approve = await tabTo(page, /^Approuver/, 40, invisible);
    let ok = false; let detail = '';
    if (approve) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      const f = await focusInfo(page);
      // Motif : champ de saisie atteint au clavier
      let field = f.tag === 'textarea' || f.tag === 'input' ? f : await tabTo(page, /motif|Motif|raison|justif/i, 15, invisible);
      if (!field) { const f2 = await focusInfo(page); field = f2; }
      await page.keyboard.type('Suspension pour contrôle sur place, décision au clavier (audit).');
      const confirm = await tabTo(page, /Confirmer|Valider|Approuver/i, 15, invisible);
      if (confirm) { await page.keyboard.press('Enter'); await page.waitForTimeout(1500); }
      const status = await page.evaluate(() => [...document.querySelectorAll('[role="status"], [role="alert"], .callout, .toast, .notice')].map((e) => e.textContent.trim()).filter(Boolean).join(' | ').slice(0, 300));
      const after = await focusInfo(page);
      ok = !!confirm && (/enregistr|décid|approuv|exécution|par délégation|Décision|transmis/i.test(status));
      detail += ` ; focus après décision=${after.tag} « ${after.name} »`;
      detail = `bouton=${approve.name} ; saisie=${field?.tag} ; confirmation=${confirm?.name ?? '—'} ; annonce=« ${status} »` + detail;
    }
    out.parcours.push({ parcours: 'Fiche de décision du Gouverneur (/poste-de-decision)', ok, detail, focusInvisible: [...new Set(invisible)] });
    log('\n[Parcours Gouverneur]', ok ? 'RÉUSSI' : 'ÉCHEC', detail, '\n  focus non visible :', [...new Set(invisible)].join(', ') || 'aucun');
    await pageChecks(page, 'Poste de décision du Gouverneur');
    await ctx.close();
  }
  // ---------------------------------------------------------------- Parcours 3 : contrôle de plaque
  {
    const { ctx, page } = await newPage(browser, 'u-controleur');
    await page.goto(BASE + '/vehicules/scan', { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const invisible = [];
    await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    const input = await tabTo(page, /KN-0000-AB|plaque|Plaque/i, 10, invisible);
    let ok = false; let detail = '';
    if (input) {
      await page.keyboard.type('KN-1234-AB');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1500);
      const res = await page.evaluate(() => [...document.querySelectorAll('[role="status"], [role="alert"], [aria-live]')].map((e) => e.textContent.trim()).filter(Boolean).join(' | ').slice(0, 300));
      ok = /KN-1234-AB|inconnu|aucun|situation|vignette|statut/i.test(res);
      detail = `champ=${input.name} ; résultat annoncé=« ${res.slice(0, 160)} »`;
    }
    out.parcours.push({ parcours: 'Contrôle de plaque (/vehicules/scan)', ok, detail, focusInvisible: [...new Set(invisible)] });
    log('\n[Parcours plaque]', ok ? 'RÉUSSI' : 'ÉCHEC', detail, '\n  focus non visible :', [...new Set(invisible)].join(', ') || 'aucun');
    await pageChecks(page, 'Contrôle de plaque');
    await ctx.close();
  }
  // ---------------------------------------------------------------- Zoom 200 % (fenêtre CSS 640 × 400) et mouvement réduit
  for (const [user, path] of [['u-contribuable', '/espace'], ['u-gouverneur', '/poste-de-decision/decisions'], ['u-controleur', '/vehicules/scan'], [null, '/'], [null, '/verifier']]) {
    const { ctx, page } = await newPage(browser, user ?? '', { viewport: { width: 640, height: 400 }, reducedMotion: 'reduce' });
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    const z = await page.evaluate(() => {
      const over = document.documentElement.scrollWidth - window.innerWidth;
      const clipped = [...document.querySelectorAll('button, a, input, select, textarea')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > window.innerWidth + 1); }).length;
      const anim = [...document.querySelectorAll('*')].filter((e) => { const s = getComputedStyle(e); return (parseFloat(s.animationDuration) > 0.01 && s.animationName !== 'none' && s.animationIterationCount !== '0') || parseFloat(s.transitionDuration) > 0.01; }).length;
      return { over, clipped, anim };
    });
    log(`\n[Zoom 200 % + mouvement réduit] ${path} : débordement horizontal=${z.over}px, contrôles hors écran=${z.clipped}, éléments animés malgré « réduire les animations »=${z.anim}`);
    out.pages.push({ label: `zoom200 ${path}`, ...z });
    if (path === '/' || path === '/verifier') await pageChecks(page, `Page publique ${path} (640 px)`);
    await ctx.close();
  }
  if (process.env.A11Y_OUT) require('fs').writeFileSync(process.env.A11Y_OUT, JSON.stringify(out, null, 1));
  await browser.close();
})();
