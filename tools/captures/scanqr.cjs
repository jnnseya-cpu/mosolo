const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const OUT = process.argv[2];
const PKT = fs.readFileSync('pkt.txt', 'utf8').trim();
fs.mkdirSync(OUT, { recursive: true });
(async () => {
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${process.cwd()}/cam.y4m`] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, serviceWorkers: 'block', permissions: ['camera'], timezoneId: 'Africa/Kinshasa', locale: 'fr-FR' });
  await ctx.addInitScript(() => { localStorage.setItem('mosolo.demoUser', 'u-contribuable'); localStorage.setItem('mosolo.theme', 'light'); });
  const page = await ctx.newPage();
  const native = await page.evaluate(() => 'BarcodeDetector' in window);
  await page.goto('http://localhost:4173/preuve', { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/16-bouton-scanner.png` });
  const t0 = Date.now();
  await page.getByRole('button', { name: 'Scanner un QR code' }).click();
  await page.waitForTimeout(1500);
  await page.locator('.qrs').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/17-camera-en-direct.png` });
  await page.waitForURL(`**/preuve/${PKT}`, { timeout: 20000 });
  const ms = Date.now() - t0;
  await page.waitForSelector('.pv-result');
  await page.waitForTimeout(600);
  await page.locator('.pv-result').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/18-resultat-apres-scan.png` });
  // Secours : photo du QR — on « imprime » la preuve A6 de ce ticket, puis on la photographie (inclinée, floue, sur fond).
  await page.goto(`http://localhost:4173/preuve/${PKT}/imprimer?format=a6`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.locator('.pv-sheet').screenshot({ path: 'a6-sheet.png' });
  require('child_process').execSync(`python3 -c "from PIL import Image, ImageFilter
s=Image.open('a6-sheet.png').convert('RGB')
bg=Image.new('RGB',(1600,1200),(110,95,80))
r=s.rotate(5,expand=True,fillcolor=(110,95,80))
bg.paste(r,(420,60)); bg.filter(ImageFilter.GaussianBlur(0.8)).save('photo-qr.jpg',quality=82)"`);
  await page.goto('http://localhost:4173/preuve', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Scanner un QR code' }).click();
  await page.waitForTimeout(500);
  await page.setInputFiles('input[aria-label="Photo du QR"]', 'photo-qr.jpg');
  await page.waitForURL(/\/preuve\/PKT/, { timeout: 20000 });
  const photoCode = page.url().split('/preuve/')[1];
  await page.waitForSelector('.pv-result');
  await page.screenshot({ path: `${OUT}/19-resultat-apres-photo.png` });
  await browser.close();
  console.log(JSON.stringify({ nativeDetector: native, liveScanToResultMs: ms, liveCode: PKT, photoCode }));
})();
