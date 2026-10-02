// Captures : bandeau des pénalités (règle module / 30 jours), surveillance des constats, cartes OSM, position précise.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const VIDEO = process.argv[3];
const W = 'http://localhost:4173';
const log = (...a) => console.log(...a);
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(VIDEO ? [`--use-file-for-fake-video-capture=${VIDEO}`] : [])] });
  const mk = async (user, w = 390, h = 844) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', permissions: ['camera', 'geolocation'], geolocation: { latitude: -4.30512, longitude: 15.31077, accuracy: 6 }, timezoneId: 'Africa/Kinshasa', locale: 'fr-FR' });
    await ctx.addInitScript((u) => { if (u) localStorage.setItem('mosolo.demoUser', u); localStorage.setItem('mosolo.theme', 'light'); }, user);
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') log('console:', m.text().slice(0, 200)); });
    return { ctx, page };
  };
  // 1. Contrôle des titres d'une plaque avec une pénalité de stationnement impayée depuis 35 jours (autre module).
  let { ctx, page } = await mk('u-agent-gombe');
  await page.goto(`${W}/titres/controle`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Plaque' }).click();
  await page.getByRole('button', { name: 'Joindre la position' }).click();
  await page.waitForTimeout(2500);
  await page.fill('.tt-plate-input', 'KN-0001-DM');
  await page.getByRole('button', { name: /^Vérifier/ }).click();
  await page.waitForSelector('.overdue-pen', { timeout: 15000 });
  await page.locator('.overdue-pen').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/01-titres-penalite-autre-module-30-jours.png` });
  await ctx.close();
  // 2. Surveillance des constats (bureau).
  ({ ctx, page } = await mk('pk-superviseur', 1366, 900));
  await page.goto(`${W}/agents/surveillance`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.mon-table', { timeout: 15000 });
  const first = page.locator('.mon-table tbody tr th button').first();
  await first.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/02-surveillance-des-constats.png`, fullPage: true });
  await ctx.close();
  // 3. Carte OSM des points de paiement (public).
  ({ ctx, page } = await mk(null, 1280, 900));
  await page.goto(`${W}/points-de-paiement`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.geomap canvas, .cx-map', { timeout: 20000 });
  await page.waitForTimeout(2500);
  log('carte points :', await page.locator('.geomap canvas').count() ? 'MapLibre' : 'plan schématique');
  await page.locator('.geomap, .cx-map').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/03-carte-osm-points-de-paiement.png` });
  await ctx.close();
  // 4. Carte des zones de stationnement (régie).
  ({ ctx, page } = await mk('pk-regie', 1280, 900));
  await page.goto(`${W}/stationnement/regie`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  if (await page.locator('.geomap').count()) { await page.locator('.geomap').first().scrollIntoViewIfNeeded(); await page.screenshot({ path: `${OUT}/04-carte-osm-zones-stationnement.png` }); }
  await ctx.close();
  // 5. Caméra de preuve avec position précise (plaque rouge).
  ({ ctx, page } = await mk('pk-controleur'));
  await page.goto(`${W}/stationnement/controle`, { waitUntil: 'networkidle' });
  await page.fill('.pk-plate-input', 'KN-0777-DM');
  await page.getByRole('button', { name: 'Contrôler' }).click();
  await page.waitForSelector('.evc .ploc', { timeout: 15000 });
  await page.waitForTimeout(4000);
  await page.locator('.evc .ploc').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/05-camera-preuve-position-precise.png` });
  await page.getByRole('button', { name: 'Ajuster sur la carte' }).click();
  await page.waitForTimeout(500);
  const box = await page.locator('.evc .geomap-canvas').boundingBox();
  if (box) await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await page.waitForTimeout(1500);
  await page.locator('.evc .ploc').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/06-position-ajustee-a-la-main.png` });
  await ctx.close();
  // 6. Enrôlement assisté : relevé précis et carte de vérification.
  ({ ctx, page } = await mk('u-agent-gombe'));
  await page.goto(`${W}/canaux/enrolement`, { waitUntil: 'networkidle' });
  const rel = page.getByRole('button', { name: 'Relever la position' });
  if (await rel.count()) {
    await rel.click(); await page.waitForTimeout(3000);
    await page.getByRole('button', { name: 'Voir sur la carte' }).first().click(); await page.waitForTimeout(2500);
    await page.locator('.cx-gps').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${OUT}/07-enrolement-position-precise.png` });
  } else log('enrôlement : bouton absent');
  await ctx.close();
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
