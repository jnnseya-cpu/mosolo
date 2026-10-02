const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const OUT = process.argv[2];
const sizes = { ordinateur: [1440, 900, 1.5, { bitripay: 3, koda: 5 }], telephone: [390, 844, 2, { bitripay: 6, koda: 4 }] };
async function ctxFor(browser, dev, user) {
  const [w, h, dsf] = sizes[dev];
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, serviceWorkers: 'block', colorScheme: 'light', timezoneId: 'Africa/Kinshasa', locale: 'fr-FR' });
  await ctx.addInitScript((u) => { localStorage.setItem('mosolo.demoUser', u); localStorage.setItem('mosolo.theme', 'light'); }, user);
  return ctx;
}
(async () => {
  const browser = await chromium.launch();
  fs.mkdirSync(`${OUT}/telephone`, { recursive: true }); fs.mkdirSync(`${OUT}/ordinateur`, { recursive: true });
  for (const dev of (process.argv[3] ? [process.argv[3]] : ['ordinateur', 'telephone'])) {
    for (const prov of ['bitripay', 'koda']) {
      const ctx = await ctxFor(browser, dev, 'u-contribuable');
      const page = await ctx.newPage();
      await page.goto('http://localhost:4173/espace', { waitUntil: 'networkidle' });
      await page.waitForTimeout(800);
      const row = page.locator('tr, .rtable-card, .rtable-row, li').filter({ hasText: prov === 'bitripay' ? 'vignette automobile' : 'impôt foncier' }).filter({ has: page.getByRole('button', { name: 'Payer', exact: true }) }).last();
      await row.getByRole('button', { name: 'Payer', exact: true }).first().click();
      await page.waitForTimeout(500);
      await page.locator(`input[name=provider][value=${prov}]`).check({ force: true });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${OUT}/${dev}/0${prov === 'bitripay' ? 1 : 3}-choix-${prov}.png` });
      await page.getByRole('button', { name: 'Obtenir ma référence de paiement' }).click();
      await page.waitForTimeout(1200);
      await page.locator('.provider-box').scrollIntoViewIfNeeded().catch(() => {});
      await page.screenshot({ path: `${OUT}/${dev}/0${prov === 'bitripay' ? 2 : 4}-reference-${prov}.png` });
      await ctx.close();
    }
    const ctx = await ctxFor(browser, dev, 'u-tresor');
    const page = await ctx.newPage();
    await page.goto('http://localhost:4173/tresor/prestataires', { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${OUT}/${dev}/05-console-prestataires.png` });
    await page.screenshot({ path: `${OUT}/${dev}/05-console-prestataires-page.png`, fullPage: true });
    const b = page.getByRole('button', { name: 'Simuler la confirmation signée' }).first();
    if (await b.count()) { await b.click(); await page.waitForTimeout(1200); }
    const s = page.getByRole('button', { name: 'Annonce de règlement' }).first();
    if (await s.count()) { await s.click(); await page.waitForTimeout(1200); }
    const k = page.getByRole('button', { name: 'Simuler la confirmation signée' }).first();
    if (await k.count()) { await k.click(); await page.waitForTimeout(1200); }
    await page.locator('#pr-orders').scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, -90));
    await page.screenshot({ path: `${OUT}/${dev}/06-confirmation-signee.png` });
    await page.locator('#pr-events').scrollIntoViewIfNeeded(); await page.evaluate(() => window.scrollBy(0, -90));
    await page.screenshot({ path: `${OUT}/${dev}/07-journal-webhooks.png` });
    await ctx.close();
  }
  await browser.close();
  console.log('ok');
})();
