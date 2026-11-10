// Captures « Autour de moi » : agent de Limete sur place (vert, ambre, rouge), puis hors de son secteur (Gombe).
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const OUT = process.argv[2]; fs.mkdirSync(OUT, { recursive: true });
const W = 'http://localhost:4173';
(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const shot = async (name, pos, w = 390, h = 844) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, serviceWorkers: 'block', permissions: ['geolocation'], geolocation: { ...pos, accuracy: 7 }, timezoneId: 'Africa/Kinshasa', locale: 'fr-FR' });
    await ctx.addInitScript(() => { localStorage.setItem('mosolo.demoUser', 'u-agent-terrain'); localStorage.setItem('mosolo.theme', 'light'); });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text().slice(0, 200)); });
    await page.goto(`${W}/autour-de-moi`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.adm-counts, .callout-warn', { timeout: 20000 });
    if (await page.locator('.adm-radius button', { hasText: '1 km' }).count()) await page.locator('.adm-radius button', { hasText: '1 km' }).click();
    await page.waitForTimeout(3500);
    if (await page.locator('.adm-counts').count()) {
      await page.locator('.adm-counts').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70));
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${OUT}/${name}.png` });
      await page.locator('.adm-list').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 120));
      await page.screenshot({ path: `${OUT}/${name}-liste.png` });
      await page.locator('.adm-count.adm-red').click(); await page.waitForTimeout(1500);
      await page.locator('.adm-counts').evaluate((el) => window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70));
      await page.screenshot({ path: `${OUT}/${name}-filtre-rouge.png` });
    } else await page.screenshot({ path: `${OUT}/${name}.png` });
    await ctx.close();
  };
  await shot('01-autour-de-moi-limete', { latitude: -4.3775, longitude: 15.339 });
  await shot('02-hors-secteur-gombe', { latitude: -4.305, longitude: 15.3 });
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
