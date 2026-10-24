const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const { execSync } = require('child_process');
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const W = 'http://localhost:4173';
const log = (...a) => console.log(...a);
(async () => {
  const browserA = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${process.cwd()}/plate.y4m`] });
  const browserB = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${process.cwd()}/street.y4m`] });
  let browser = browserA;
  const mk = async (user, w = 390, h = 844) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', permissions: ['camera', 'geolocation'], geolocation: { latitude: -4.30512, longitude: 15.31077, accuracy: 7 }, timezoneId: 'Africa/Kinshasa', locale: 'fr-FR' });
    await ctx.addInitScript((u) => { localStorage.setItem('mosolo.demoUser', u); localStorage.setItem('mosolo.theme', 'light'); }, user);
    return ctx;
  };
  // 1. Agent : lecture de la plaque à la caméra (OCR), contrôle ROUGE, caméra de preuve, 5 photos, constat.
  let ctx = await mk('pk-controleur');
  let page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log('console:', m.text().slice(0, 200)); });
  await page.goto(`${W}/stationnement/controle`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Scanner la plaque (caméra)' }).click();
  await page.waitForTimeout(2500);
  await page.locator('.plq').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/01-lecture-plaque-camera.png` });
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Lire la plaque' }).click();
  await page.waitForSelector('.plq-confirm input', { timeout: 120000 });
  const read = await page.inputValue('.plq-confirm input');
  log('OCR lu :', JSON.stringify(read), 'en', Date.now() - t0, 'ms');
  await page.locator('.plq-confirm').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/02-plaque-lue-a-confirmer.png` });
  if (read !== 'KN-0777-DM') await page.fill('.plq-confirm input', 'KN-0777-DM');
  await ctx.close();
  // Caméra de preuve : les ABORDS du véhicule (scène de rue), pas la plaque.
  browser = browserB;
  ctx = await mk('pk-controleur');
  page = await ctx.newPage();
  await page.goto(`${W}/stationnement/controle`, { waitUntil: 'networkidle' });
  await page.fill('.pk-plate-input', 'KN-0777-DM');
  await page.getByRole('button', { name: 'Contrôler' }).click();
  await page.waitForSelector('.evc', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await page.locator('.pk-light').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/03-plaque-rouge-camera-ouverte.png` });
  await page.fill('.evc input[placeholder^="ex. Bd"]', 'Bd du 30 Juin, face à la poste centrale');
  await page.waitForTimeout(800);
  await page.locator('.evc').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/04-camera-de-preuve.png` });
  for (let i = 0; i < 5; i++) {
    const btn = page.locator('.evc-actions button', { hasText: 'Photographier' });
    await page.waitForTimeout(1600); // la vue se déplace le long de la rue
    await btn.click();
    await page.waitForFunction((n) => document.querySelectorAll('.evc-slot.is-done').length >= n, i + 1, { timeout: 20000 });
  }
  await page.locator('.evc-slots').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/05-cinq-photos-prises.png` });
  await page.getByRole('button', { name: /Terminer \(5\/5\)/ }).click();
  await page.selectOption('form[aria-label="Constat"] select', 'NON_PAIEMENT');
  await page.fill('form[aria-label="Constat"] textarea', 'Véhicule sans titre, photographié sous cinq angles.');
  await page.getByRole('button', { name: 'Enregistrer le constat' }).click();
  await page.waitForSelector('.ev-thumb img', { timeout: 20000 });
  await page.waitForTimeout(1200);
  await page.locator('.result-card').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/06-constat-enregistre-photos.png` });
  // Une photo horodatée, en taille réelle, telle que conservée par le serveur.
  const items = JSON.parse(execSync(`curl -s -H 'x-demo-user: pk-superviseur' http://localhost:8080/v1/parking/violations`).toString()).items;
  const v = items.find((x) => x.plate === 'KN-0777-DM' && x.photos && x.photos.length === 5);
  for (const p of v.photos) execSync(`curl -s -H 'x-demo-user: pk-superviseur' -o ${OUT}/photo-${p.slot}.jpg http://localhost:8080${p.url}`);
  log('constat', v.reference, 'photos', v.photos.map((p) => p.slot).join(','));
  // Pénalités de l'usager au contrôle (plaque avec pénalité impayée) — agent du module.
  await page.goto(`${W}/stationnement/controle`, { waitUntil: 'networkidle' });
  await page.fill('.pk-plate-input', 'KN-0001-DM');
  await page.getByRole('button', { name: 'Contrôler' }).click();
  await page.waitForSelector('.pk-pen, .pk-light', { timeout: 10000 });
  await page.waitForTimeout(800);
  await page.locator('.pk-pen').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/07-penalites-usager-au-controle.png` });
  // Mes gains (10 %).
  await page.goto(`${W}/mes-gains`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/08-mes-gains-10-pourcent.png` });
  await page.screenshot({ path: `${OUT}/08b-mes-gains-page.png`, fullPage: true });
  await ctx.close();
  // 2. Superviseur : vérification avec les photos.
  ctx = await mk('pk-superviseur', 1440, 900); page = await ctx.newPage();
  await page.goto(`${W}/stationnement/controle`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.ev-thumb img', { timeout: 15000 }); await page.waitForTimeout(800);
  await page.locator('.ev-photos').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/09-verification-avec-photos.png` });
  await ctx.close();
  // 3. Régie : commissions des agents.
  ctx = await mk('pk-regie', 1440, 900); page = await ctx.newPage();
  await page.goto(`${W}/stationnement/regie`, { waitUntil: 'networkidle' });
  const tab = page.getByRole('button', { name: /Commissions/ }).or(page.getByRole('tab', { name: /Commissions/ }));
  if (await tab.count()) { await tab.first().click(); await page.waitForTimeout(1000); }
  await page.screenshot({ path: `${OUT}/10-regie-commissions-agents.png` });
  await ctx.close();
  // 3 bis. Agent d'un autre module (verticales) : ses gains de 10 %.
  ctx = await mk('u-agent-gombe'); page = await ctx.newPage();
  await page.goto(`${W}/mes-gains`, { waitUntil: 'networkidle' }); await page.waitForTimeout(1000);
  await page.screenshot({ path: `${OUT}/12-mes-gains-agent-verticales.png`, fullPage: true });
  await ctx.close();
  // 3 ter. Trésor : commissions de tous les agents, tous modules.
  ctx = await mk('u-tresor', 1440, 900); page = await ctx.newPage();
  await page.goto(`${W}/stationnement/tableau-de-bord`, { waitUntil: 'networkidle' }); await page.waitForTimeout(800);
  await ctx.close();
  // 4. Autre module : contrôle d'un titre (moto-taxi, ticket) — pénalité impayée depuis plus de 30 jours.
  ctx = await mk('rk-controleur'); page = await ctx.newPage();
  await page.goto(`${W}/titres/controle`, { waitUntil: 'networkidle' });
  await page.locator('button[aria-pressed]', { hasText: 'Plaque' }).click();
  await page.fill('#tt-val', 'KN-0001-DM');
  const lieu = page.locator('#tt-lieu'); if (await lieu.count()) await lieu.fill('Rond-point Victoire');
  await page.locator('form button[type=submit]').first().click();
  await page.waitForSelector('.overdue-pen', { timeout: 15000 });
  await page.locator('.overdue-pen').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/11-autre-module-penalite-30-jours.png` });
  await ctx.close();
  await browserA.close(); await browserB.close();
})();
