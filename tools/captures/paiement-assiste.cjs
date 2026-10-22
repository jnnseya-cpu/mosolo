// Captures : paiement NUMÉRIQUE assisté par l'agent (jamais d'espèces) depuis « Autour de moi », puis confirmation.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const W = 'http://localhost:4173'; const API = 'http://localhost:8080';
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { latitude: -4.38405, longitude: 15.33425, accuracy: 6 }, timezoneId: 'Africa/Kinshasa', locale: 'fr-FR' });
  await ctx.addInitScript(() => { localStorage.setItem('mosolo.demoUser', 'u-agent-terrain'); localStorage.setItem('mosolo.theme', 'light'); });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
  await page.goto(`${W}/autour-de-moi`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.adm-counts', { timeout: 20000 });
  await page.locator('.adm-count.adm-red').click();
  await page.waitForTimeout(800);
  await page.locator('.adm-pay').first().click();
  await page.waitForSelector('.apay-channels', { timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.locator('.apay').scrollIntoViewIfNeeded();
  await page.locator('.apay').screenshot({ path: `${OUT}/01-faire-payer-canaux-numeriques.png` });
  await page.getByRole('radio', { name: /QR à scanner/ }).click();
  await page.waitForFunction(() => !document.querySelector('.apay .btn-primary')?.hasAttribute('disabled'), null, { timeout: 30000 });
  await page.getByRole('button', { name: 'Émettre la référence de paiement' }).click();
  await page.waitForSelector('.apay-issued', { timeout: 15000 });
  await page.waitForTimeout(800);
  await page.locator('.apay').screenshot({ path: `${OUT}/02-reference-et-qr-pour-l-usager.png` });
  const ref = (await page.locator('.apay-ref').textContent()).trim();
  // L'usager paie depuis son téléphone : confirmation simulée du prestataire (bac à sable, Trésor).
  const r = await fetch(`${API}/v1/providers/bitripay/sandbox-simulate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-demo-user': 'u-tresor' }, body: JSON.stringify({ paymentReference: ref, event: 'succeeded' }) });
  console.log('simulation', r.status, ref);
  await page.waitForSelector('.apay-paid', { timeout: 20000 });
  await page.locator('.apay').screenshot({ path: `${OUT}/03-paiement-confirme-quittance.png` });
  // Titres : pénalité d'un autre module, bouton « Faire payer (numérique) ».
  await ctx.close();
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
