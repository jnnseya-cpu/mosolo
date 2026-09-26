#!/usr/bin/env node
/**
 * Dossier de présentation des écrans (téléphone puis ordinateur) au format 16:9.
 * Entrée : captures PNG « telephone-<id>.png » et « ordinateur-<id>.png ».
 * Sortie : une image PNG par diapositive et un PDF unique.
 *
 * Usage : node tools/presentation/build-deck.mjs <dossier-captures> <dossier-sortie>
 * Prérequis : puppeteer (ou puppeteer-core) résolu via NODE_PATH, Chromium (CHROME_PATH).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const [capDir, outDir] = process.argv.slice(2).map((p) => resolve(p));
if (!capDir || !outDir) {
  console.error('Usage : build-deck.mjs <captures> <sortie>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const ecrans = JSON.parse(readFileSync(join(HERE, 'ecrans.json'), 'utf8'));
const url = (p) => pathToFileURL(p).href;
const font = (f) => url(join(ROOT, 'node_modules/@fontsource', f));
const COVER = url(join(ROOT, 'docs/assets/couverture-ville-de-kinshasa.png'));
const LOGO = url(join(ROOT, 'docs/assets/logo-ville-de-kinshasa.png'));
const shot = (dev, id) => {
  const p = join(capDir, `${dev}-${id}.png`);
  if (!existsSync(p)) throw new Error(`Capture manquante : ${p}`);
  return url(p);
};
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

const CSS = `
@font-face { font-family: Fraunces; font-weight: 400; src: url(${font('fraunces/files/fraunces-latin-400-normal.woff2')}); }
@font-face { font-family: Fraunces; font-weight: 600; src: url(${font('fraunces/files/fraunces-latin-600-normal.woff2')}); }
@font-face { font-family: Inter; font-weight: 400; src: url(${font('inter/files/inter-latin-400-normal.woff2')}); }
@font-face { font-family: Inter; font-weight: 500; src: url(${font('inter/files/inter-latin-500-normal.woff2')}); }
@font-face { font-family: Inter; font-weight: 600; src: url(${font('inter/files/inter-latin-600-normal.woff2')}); }
@font-face { font-family: Inter; font-weight: 700; src: url(${font('inter/files/inter-latin-700-normal.woff2')}); }
:root { --navy:#232C6B; --navy-deep:#0E1433; --blue:#1E9BD7; --yellow:#F7D618; --red:#D7141A; --ink:#111111; --ink2:#4A4F5C; --line:#E3E6EE; --surface:#F5F7FB; }
* { box-sizing: border-box; margin: 0; padding: 0; }
@page { size: 1920px 1080px; margin: 0; }
body { font-family: Inter, sans-serif; color: var(--ink); }
.slide { width: 1920px; height: 1080px; position: relative; overflow: hidden; background: #fff; page-break-after: always; }
.tri { position: absolute; left: 0; right: 0; top: 0; height: 8px; display: flex; }
.tri i { flex: 1; } .tri i:nth-child(1){background:var(--blue)} .tri i:nth-child(2){background:var(--yellow)} .tri i:nth-child(3){background:var(--red)}
.foot { position: absolute; left: 96px; right: 96px; bottom: 36px; display: flex; align-items: center; gap: 20px; font-size: 17px; color: var(--ink2); }
.foot img { height: 44px; }
.foot .sep { flex: 1; }
.foot .demo { color: #9A3412; }
.eyebrow { font-size: 18px; letter-spacing: .18em; text-transform: uppercase; color: var(--ink2); font-weight: 600; }
h1 { font-family: Fraunces, serif; font-weight: 600; letter-spacing: -.01em; }
h2 { font-family: Fraunces, serif; font-weight: 600; font-size: 54px; line-height: 1.08; letter-spacing: -.01em; }
.num { font-family: Fraunces, serif; color: var(--navy); }
/* Couverture */
.cover { background: #fff; }
.cover img.visual { position: absolute; right: 60px; top: 170px; width: 1060px; height: 707px; object-fit: contain; }
.cover .text { position: absolute; left: 96px; top: 190px; width: 620px; }
.cover .text h1 { font-size: 76px; line-height: 1.02; margin: 22px 0 30px; color: var(--navy); }
.cover .text p { font-size: 25px; line-height: 1.45; color: var(--ink2); }
.cover .text .date { margin-top: 40px; font-size: 20px; color: var(--ink); font-weight: 600; }
/* Intercalaire */
.divider { background: var(--navy-deep); color: #fff; }
.divider .inner { position: absolute; left: 96px; top: 150px; width: 820px; }
.divider h1 { font-size: 104px; line-height: .98; margin: 22px 0 28px; }
.divider p { font-size: 27px; line-height: 1.45; color: #C9CEE6; }
.divider .eyebrow { color: #9FB2E8; }
.divider .foot { color: #9FB2E8; }
/* Téléphones */
.phone { width: 300px; border-radius: 46px; background: #0b0d14; padding: 11px; box-shadow: 0 30px 60px -20px rgba(14,20,51,.45), 0 0 0 1px rgba(0,0,0,.2); position: relative; }
.phone img { display: block; width: 100%; border-radius: 36px; }
.phone.sm { width: 214px; border-radius: 34px; padding: 8px; } .phone.sm img { border-radius: 27px; }
.divider .phones { position: absolute; right: 70px; top: 92px; width: 900px; display: grid; grid-template-columns: repeat(4, 214px); gap: 22px 16px; }
.divider .phones .phone.sm:nth-child(n+9) { display: none; }
.trio { position: absolute; left: 96px; right: 96px; top: 170px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 60px; }
.trio .col { display: grid; grid-template-columns: 300px 1fr; gap: 30px; align-items: start; }
.trio .txt .num { font-size: 64px; line-height: 1; }
.trio .txt h3 { font-family: Fraunces, serif; font-size: 30px; font-weight: 600; margin: 14px 0 8px; line-height: 1.1; }
.trio .txt .aud { font-size: 15px; text-transform: uppercase; letter-spacing: .12em; color: var(--ink2); font-weight: 600; margin-bottom: 14px; }
.trio .txt p { font-size: 19px; line-height: 1.45; color: var(--ink); }
.head { position: absolute; left: 96px; top: 70px; right: 96px; display: flex; align-items: baseline; gap: 24px; }
.head h2 { font-size: 46px; }
/* Ordinateur */
.browser { position: absolute; left: 96px; top: 150px; width: 1220px; border-radius: 14px; overflow: hidden; background: #fff; box-shadow: 0 40px 80px -30px rgba(14,20,51,.45), 0 0 0 1px var(--line); }
.browser .bar { height: 40px; background: #EEF1F7; display: flex; align-items: center; gap: 8px; padding: 0 16px; border-bottom: 1px solid var(--line); }
.browser .bar i { width: 12px; height: 12px; border-radius: 50%; background: #CBD1DE; }
.browser .bar span { margin-left: 18px; font-size: 14px; color: var(--ink2); background: #fff; border: 1px solid var(--line); border-radius: 8px; padding: 4px 14px; }
.browser img { display: block; width: 100%; }
.side { position: absolute; left: 1380px; right: 96px; top: 150px; }
.side .num { font-size: 88px; line-height: 1; }
.side h2 { font-size: 46px; margin: 18px 0 12px; }
.side .aud { font-size: 15px; text-transform: uppercase; letter-spacing: .12em; color: var(--ink2); font-weight: 600; margin-bottom: 26px; }
.side .msg { font-size: 22px; line-height: 1.45; margin-bottom: 30px; padding-left: 18px; border-left: 3px solid var(--navy); }
.side ul { list-style: none; }
.side li { font-size: 18px; line-height: 1.45; color: var(--ink2); padding: 14px 0; border-top: 1px solid var(--line); }
/* Conclusion */
.close .cols { position: absolute; left: 96px; right: 96px; top: 250px; display: grid; grid-template-columns: 1fr 1fr; gap: 80px; }
.close h3 { font-family: Fraunces, serif; font-size: 34px; font-weight: 600; margin-bottom: 20px; }
.close li { font-size: 21px; line-height: 1.5; padding: 12px 0; border-top: 1px solid var(--line); list-style: none; color: var(--ink2); }
.close .ask { position: absolute; left: 96px; right: 96px; bottom: 120px; background: var(--surface); border-left: 4px solid var(--navy); padding: 26px 32px; font-size: 24px; line-height: 1.4; }
`;

const foot = (n, total, dark = false) => `
  <div class="foot">${dark ? '' : `<img src="${LOGO}" alt="Ville de Kinshasa">`}
    <span>KINSHASA MOSOLO · Dossier de présentation au Gouvernement provincial</span>
    <span class="sep"></span>
    <span class="demo">Données de démonstration — non opposables</span>
    <span>${n} / ${total}</span>
  </div>`;

const slides = [];
slides.push((n, t) => `
<section class="slide cover"><div class="tri"><i></i><i></i><i></i></div>
  <img class="visual" src="${COVER}" alt="Ville de Kinshasa">
  <div class="text">
    <div class="eyebrow">Ville Province de Kinshasa · Recettes provinciales</div>
    <h1>KINSHASA MOSOLO<br>Les écrans de la plateforme</h1>
    <p>Parcours sur téléphone, puis sur ordinateur : ce que voient le contribuable, l'agent de terrain, le Trésor, l'auditeur et le Gouverneur.</p>
    <div class="date">Dossier de présentation au Gouvernement provincial · septembre 2026</div>
  </div>
  ${foot(n, t)}
</section>`);

slides.push((n, t) => `
<section class="slide divider"><div class="tri"><i></i><i></i><i></i></div>
  <div class="inner">
    <div class="eyebrow">Partie 1</div>
    <h1>Sur téléphone</h1>
    <p>La majorité des Kinois accède aux services par téléphone. Chaque écran est conçu d'abord pour un écran de 390 pixels, fonctionne hors connexion quand c'est nécessaire et s'installe comme une application.</p>
  </div>
  <div class="phones">${ecrans.slice(0, 8).map((e) => `<div class="phone sm"><img src="${shot('telephone', e.id)}"></div>`).join('')}</div>
  ${foot(n, t, true)}
</section>`);

for (let i = 0; i < ecrans.length; i += 3) {
  const group = ecrans.slice(i, i + 3);
  slides.push((n, t) => `
<section class="slide"><div class="tri"><i></i><i></i><i></i></div>
  <div class="head"><span class="eyebrow">Sur téléphone</span><h2>${group.map((e) => esc(e.titre)).join(' · ')}</h2></div>
  <div class="trio">${group.map((e) => `
    <div class="col">
      <div class="phone"><img src="${shot('telephone', e.id)}"></div>
      <div class="txt"><div class="num">${e.id.slice(0, 2)}</div><h3>${esc(e.titre)}</h3><div class="aud">${esc(e.public)}</div><p>${esc(e.message)}</p></div>
    </div>`).join('')}
  </div>
  ${foot(n, t)}
</section>`);
}

slides.push((n, t) => `
<section class="slide divider"><div class="tri"><i></i><i></i><i></i></div>
  <div class="inner" style="width:1300px">
    <div class="eyebrow">Partie 2</div>
    <h1>Sur ordinateur</h1>
    <p>Les postes de travail des régies, du Trésor, de l'audit et du cabinet du Gouverneur : une console sobre, où chaque chiffre est sourcé, chaque action tracée et chaque décision réservée à une personne habilitée.</p>
  </div>
  ${foot(n, t, true)}
</section>`);

for (const e of ecrans) {
  const route = { '01-accueil': '/', '02-inscription': '/inscription', '03-espace-contribuable': '/espace', '04-verification-quittance': '/verifier', '05-centre-de-commandement': '/gouverneur', '06-communications': '/communications', '07-registre-juridique': '/registre', '08-tresor-rapprochement': '/tresor', '09-terrain': '/terrain', '10-audit': '/audit', '11-recommandations-ia': '/ia' }[e.id];
  slides.push((n, t) => `
<section class="slide"><div class="tri"><i></i><i></i><i></i></div>
  <div class="head"><span class="eyebrow">Sur ordinateur</span></div>
  <div class="browser"><div class="bar"><i></i><i></i><i></i><span>KINSHASA MOSOLO · ${route}</span></div><img src="${shot('ordinateur', e.id)}"></div>
  <div class="side">
    <div class="num">${e.id.slice(0, 2)}</div>
    <h2>${esc(e.titre)}</h2>
    <div class="aud">${esc(e.public)}</div>
    <div class="msg">${esc(e.message)}</div>
    <ul>${e.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
  </div>
  ${foot(n, t)}
</section>`);
}

slides.push((n, t) => `
<section class="slide close"><div class="tri"><i></i><i></i><i></i></div>
  <div class="head"><span class="eyebrow">Ce que montrent ces écrans</span></div>
  <div class="head" style="top:110px"><h2>Ce qui fonctionne déjà, et ce qui reste à décider</h2></div>
  <div class="cols">
    <div><h3>Démontré dans le socle</h3><ul>
      <li>Quatre visas distincts avant qu'une règle n'agisse ; taux non certifiés bloqués</li>
      <li>Paiement par référence, confirmation signée, quittance vérifiable par tous</li>
      <li>Rapprochement automatique et grand livre sans suppression possible</li>
      <li>Comptes bénéficiaires protégés : deux validations et 72 heures</li>
      <li>Journal d'audit dont toute altération est détectée</li>
      <li>Analyse qui propose ; décision réservée à une personne habilitée</li>
    </ul></div>
    <div><h3>Relève encore de la démonstration</h3><ul>
      <li>Connexion de démonstration à remplacer par l'identification sécurisée</li>
      <li>Données en mémoire : base PostgreSQL prête, à brancher</li>
      <li>Chiffres du tableau de bord illustratifs, marqués « EXEMPLE »</li>
      <li>Canaux SMS, USSD et courriel en bac à sable jusqu'aux conventions</li>
      <li>Taux et barèmes à certifier par les services juridiques</li>
      <li>Application Android native des agents à réaliser</li>
    </ul></div>
  </div>
  <div class="ask"><strong>Décision attendue :</strong> mandater le programme, ordonner le relevé juridique certifié et la mesure de la base de référence, et autoriser le pilote de 180 jours à Gombe, Limete, Kalamu et Ngaliema.</div>
  ${foot(n, t)}
</section>`);

const total = slides.length;
const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>${CSS}</style></head><body>${slides.map((s, i) => s(i + 1, total)).join('\n')}</body></html>`;
const htmlPath = join(outDir, 'presentation-ecrans.html');
writeFileSync(htmlPath, html);

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, args: ['--no-sandbox', '--allow-file-access-from-files'] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
await page.goto(url(htmlPath), { waitUntil: 'networkidle0' });
await page.evaluate(() => document.fonts.ready);
const handles = await page.$$('section.slide');
for (let i = 0; i < handles.length; i++) {
  await handles[i].screenshot({ path: join(outDir, `diapo-${String(i + 1).padStart(2, '0')}.png`) });
}
await page.pdf({ path: join(outDir, 'KINSHASA_MOSOLO_Ecrans_Presentation_Gouvernement.pdf'), width: '1920px', height: '1080px', printBackground: true });
await browser.close();
console.log(`${handles.length} diapositives → ${outDir}`);
