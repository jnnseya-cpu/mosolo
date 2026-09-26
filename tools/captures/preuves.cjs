const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const { execSync } = require('child_process');
const OUT = process.argv[2];
const j = (u, who) => JSON.parse(execSync(`curl -s ${who ? `-H 'x-demo-user: ${who}'` : ''} "http://localhost:8080${u}"`).toString());
const PKT = j('/v1/parking/sessions/mine', 'u-contribuable').items.find((s) => s.status === 'ACTIVE' && s.ticketCode).ticketCode;
const devs = j('/v1/publicite/devices/mine', 'pb-annonceur').items;
const RED = devs.find((d) => d.authorization?.validity?.band === 'ROUGE').qrToken;
const CERT = 'POV-2026-00001-H';
const sizes = { telephone: [390, 844, 2], ordinateur: [1440, 900, 1.5] };
const W = 'http://localhost:4173';
(async () => {
  const browser = await chromium.launch();
  const shots = [
    ['01-verifier-comment-lire', `${W}/preuve`, 'u-contribuable'],
    ['02-ticket-stationnement-vert', `${W}/preuve/${PKT}`, 'u-contribuable'],
    ['03-support-publicitaire-rouge', `${W}/preuve?c=${RED}`, 'u-contribuable'],
    ['04-certificat-pas-encore-actif', `${W}/preuve/EVT-2026-00001-W`, 'u-contribuable'],
    ['05-impression-a6', `${W}/preuve/${PKT}/imprimer?format=a6`, 'u-contribuable'],
    ['06-impression-ticket-80mm', `${W}/preuve/${PKT}/imprimer?format=ticket80`, 'u-contribuable'],
    ['07-impression-ticket-58mm', `${W}/preuve/${CERT}/imprimer?format=ticket58`, 'u-contribuable'],
    ['10-version-legere-accueil', `http://localhost:8080/l`, null],
    ['11-version-legere-resultat-rouge', `http://localhost:8080/l/v?c=${RED}`, null],
    ['12-version-legere-imprimable', `http://localhost:8080/l/imprimer?c=${PKT}`, null],
    ['13-stationnement-compte-a-rebours', `${W}/stationnement`, 'u-contribuable'],
    ['14-pass-wewa-compte-a-rebours', `${W}/services/rakapay`, 'rk-conducteur'],
    ['15-quitus-compte-a-rebours', `${W}/fiscal/quitus`, 'u-contribuable'],
  ];
  for (const dev of (process.argv[3] ? [process.argv[3]] : ['telephone', 'ordinateur'])) {
    fs.mkdirSync(`${OUT}/${dev}`, { recursive: true });
    const [w, h, dsf] = sizes[dev];
    for (const [id, url, user] of shots) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, serviceWorkers: 'block', colorScheme: 'light', timezoneId: 'Africa/Kinshasa', locale: 'fr-FR' });
      if (user) await ctx.addInitScript((u) => { localStorage.setItem('mosolo.demoUser', u); localStorage.setItem('mosolo.theme', 'light'); }, user);
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      if (id.startsWith('02') || id.startsWith('03') || id.startsWith('04')) await page.locator('.pv-result').scrollIntoViewIfNeeded().catch(() => {});
      if (id.startsWith('13')) await page.locator('.vc').first().scrollIntoViewIfNeeded().catch(() => {});
      if (id.startsWith('14')) await page.locator('.vc').first().scrollIntoViewIfNeeded().catch(() => {});
      if (id.startsWith('15')) await page.locator('.vc').first().scrollIntoViewIfNeeded().catch(() => {});
      await page.screenshot({ path: `${OUT}/${dev}/${id}.png` });
      if (dev === 'ordinateur' && (id.startsWith('05') || id.startsWith('06'))) {
        await page.emulateMedia({ media: 'print' });
        await page.pdf({ path: `${OUT}/${id}.pdf`, ...(id.startsWith('05') ? { width: '105mm', height: '160mm' } : { width: '80mm', height: '220mm' }), printBackground: true, margin: { top: '3mm', bottom: '3mm', left: '3mm', right: '3mm' } });
      }
      await ctx.close();
    }
    // WhatsApp + SMS
    const ctx = await browser.newContext({ viewport: { width: w, height: dev === 'telephone' ? 1400 : 1100 }, deviceScaleFactor: dsf, serviceWorkers: 'block', colorScheme: 'light', timezoneId: 'Africa/Kinshasa', locale: 'fr-FR' });
    await ctx.addInitScript(() => { localStorage.setItem('mosolo.demoUser', 'u-contribuable'); localStorage.setItem('mosolo.theme', 'light'); });
    const page = await ctx.newPage();
    await page.goto(`${W}/canaux/whatsapp-sms`, { waitUntil: 'networkidle' });
    await page.fill('.wa-num input', dev === 'telephone' ? '+243810000101' : '+243810000102');
    const say = async (t) => { await page.fill('.wa-input input', t); await page.click('.wa-input button'); await page.waitForTimeout(500); };
    await say('Bonjour');
    await page.screenshot({ path: `${OUT}/${dev}/08a-whatsapp-consentement.png` });
    await say('OUI'); await say('1'); await say(PKT);
    await page.locator('.wa-phone').screenshot({ path: `${OUT}/${dev}/08b-whatsapp-verification.png` });
    await say('3');
    await page.locator('.wa-phone').screenshot({ path: `${OUT}/${dev}/08c-whatsapp-comment-payer.png` });
    await page.fill('.sms-form input', `V ${PKT}`); await page.click('.sms-form button'); await page.waitForTimeout(500);
    await page.fill('.sms-form input', `V ${RED}`); await page.click('.sms-form button'); await page.waitForTimeout(500);
    await page.locator('.sms-phone').screenshot({ path: `${OUT}/${dev}/09-sms-telephone-basique.png` });
    await ctx.close();
  }
  await browser.close();
  console.log('ok', PKT, RED);
})();
