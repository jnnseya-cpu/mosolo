// Captures KIN PUB CONTROL sur le terrain : Autour de moi (supports colorés, commerces à vérifier), paiement numérique
// assisté d'un chevalet impayé, constat pré-rempli d'une enseigne, publicité mobile contrôlée par plaque.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const W = 'http://localhost:4173';
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: -4.3036, longitude: 15.3070, accuracy: 6 }, timezoneId: 'Africa/Kinshasa', locale: 'fr-FR' });
  await ctx.addInitScript(() => { localStorage.setItem('mosolo.demoUser', 'pb-inspecteur'); localStorage.setItem('mosolo.theme', 'light'); });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
  const top = async (sel, off = 70) => { await page.locator(sel).first().evaluate((el, o) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o), off); await page.waitForTimeout(500); };
  await page.goto(`${W}/publicite/inspection`, { waitUntil: 'networkidle' });
  await page.getByRole('tab', { name: 'Autour de moi' }).click();
  await page.waitForSelector('.adm-counts', { timeout: 20000 });
  await page.waitForTimeout(3500);
  await top('.adm-counts');
  await page.screenshot({ path: `${OUT}/01-autour-de-moi-supports.png` });
  await top('.adm-list');
  await page.screenshot({ path: `${OUT}/02-supports-proches-liste.png` });
  // Chevalet devant un commerce : droits impayés → paiement numérique assisté.
  await page.locator('.adm-item', { hasText: 'Chevalet' }).locator('.adm-pay').click();
  await page.waitForSelector('.apay-channels', { timeout: 15000 });
  await page.waitForTimeout(1500);
  await top('.adm-item:has-text("Chevalet")', 80);
  await page.screenshot({ path: `${OUT}/03-chevalet-impaye-faire-payer.png` });
  // Commerces à vérifier.
  await top('text=Commerces à vérifier >> nth=1', 90);
  await page.screenshot({ path: `${OUT}/04-commerces-sans-enseigne.png` });
  await page.getByRole('button', { name: 'Constater une enseigne' }).first().click();
  await page.waitForTimeout(800);
  await top('text=Support non enregistré', 120);
  await page.screenshot({ path: `${OUT}/05-constat-enseigne-pre-rempli.png` });
  // Publicité mobile : contrôle par plaque.
  await page.getByRole('tab', { name: 'Véhicules' }).click();
  await page.fill('input[aria-label="Plaque du véhicule"]', 'KN-4521-BB');
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await page.waitForSelector('.adm-item', { timeout: 10000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/06-vehicule-declare.png` });
  await page.fill('input[aria-label="Plaque du véhicule"]', 'KN-7788-ZZ');
  await page.getByRole('button', { name: 'Vérifier' }).click();
  await page.waitForSelector('text=Constater « non déclaré »', { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/07-vehicule-non-declare.png` });
  await page.getByRole('button', { name: /Constater « non déclaré »/ }).click();
  await page.waitForTimeout(800);
  await top('text=Support non enregistré', 120);
  await page.screenshot({ path: `${OUT}/08-constat-vehicule-pre-rempli.png` });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
