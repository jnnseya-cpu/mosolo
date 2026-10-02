const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const OUT = process.argv[2];
const { execSync } = require('child_process');
const j = (u, who) => JSON.parse(execSync(`curl -s -H 'x-demo-user: ${who}' "http://localhost:8080${u}"`).toString());
const PL = {};
for (const o of j('/v1/fiscal/objects?commune=Limete', 'u-controleur')) if (o.plate && !PL[o.situation.color]) PL[o.situation.color] = o.plate.verifyPath;
const PUB = j('/v1/publicite/devices/mine', 'pb-annonceur').items.find((d) => d.status === 'AUTORISE').qrToken;
const V = [
 // [section, id, titre, route, user, action?]
 ['verification-publique','01-bien-vert','Plaque d’un bien — situation verte (régularisé)', PL.green, 'u-contribuable'],
 ['verification-publique','02-bien-orange','Plaque d’un bien — situation orange', PL.amber, 'u-contribuable'],
 ['verification-publique','03-bien-rouge','Plaque d’un bien — situation rouge (aucune mesure automatique)', PL.red, 'u-contribuable'],
 ['verification-publique','04-plaque-nfiu','Plaque NFIU d’une parcelle', '/verifier-plaque/KIN-LMT-000001-Y', 'u-contribuable'],
 ['verification-publique','05-plaque-etal','Plaque d’un étal de marché', '/verifier-plaque/MCH-GMB-000001-H', 'u-contribuable'],
 ['verification-publique','06-certificat-evenement','Certificat d’un événement', '/verifier-plaque/EVT-2026-00001-W', 'u-contribuable'],
 ['verification-publique','07-quittance','Quittance définitive', '/verifier/Q26KIN0000000303', 'u-contribuable'],
 ['verification-publique','08-badge-agent','Badge d’un agent de terrain', '/verifier-agent/AG-7K4M2Q-X', 'u-contribuable'],
 ['verification-publique','09-panneau-publicitaire','Plaque d’un panneau publicitaire', `/publicite/verifier?plaque=${PUB}`, 'u-contribuable', 'submit'],
 ['verticales-usagers','01-portail','Portail des services de la Ville', '/services', 'u-contribuable'],
 ['verticales-usagers','02-rakapay-pass-wewa','RakaPay — pass wewa du conducteur', '/services/rakapay', 'rk-conducteur'],
 ['verticales-usagers','03-rakapay-cooperative','RakaPay — espace coopérative', '/rakapay/cooperative', 'rk-coop-kalamu'],
 ['verticales-usagers','04-stationnement','Stationnement — automobiliste', '/stationnement', 'u-contribuable'],
 ['verticales-usagers','05-publicite','Publicité — annonceur', '/publicite', 'pb-annonceur'],
 ['verticales-usagers','06-propriete','Propriété', '/services/propriete', 'u-contribuable'],
 ['verticales-usagers','07-locatif','Locatif', '/services/locatif', 'u-contribuable'],
 ['verticales-usagers','08-entreprises','Entreprises', '/services/entreprises', 'u-contribuable'],
 ['verticales-usagers','09-mobilite','Mobilité', '/services/mobilite', 'u-contribuable'],
 ['verticales-usagers','10-marches','Marchés et domaine public', '/services/marches', 'u-contribuable'],
 ['verticales-usagers','11-environnement','Environnement', '/services/environnement', 'u-contribuable'],
 ['verticales-usagers','12-ports','Ports', '/services/ports', 'u-contribuable'],
 ['verticales-usagers','13-evenements','Événements', '/services/evenements', 'u-contribuable'],
 ['verticales-usagers','14-construction','Construction', '/services/construction', 'u-contribuable'],
 ['verticales-usagers','15-actifs','Actifs provinciaux', '/services/actifs', 'u-contribuable'],
 ['verticales-usagers','16-recouvrement','Recouvrement (service)', '/services/recouvrement', 'u-contribuable'],
 ['verticales-usagers','17-telecom','Télécom', '/services/telecom', 'u-contribuable'],
 ['verticales-usagers','18-avia','AVIA', '/services/avia', 'u-contribuable'],
 ['verticales-usagers','19-biens','Fiscal — mes biens et relations', '/fiscal/biens', 'u-contribuable'],
 ['verticales-usagers','20-declarations','Fiscal — déclarations pré-remplies', '/fiscal/declarations', 'u-contribuable'],
 ['verticales-usagers','21-quitus','Fiscal — quitus', '/fiscal/quitus', 'u-contribuable'],
 ['verticales-usagers','22-arrieres','Arriérés et échéancier', '/mes-arrieres', 'u-locataire'],
 ['verticales-usagers','23-ussd','USSD et SVI (sans Internet)', '/canaux/ussd', 'u-contribuable'],
 ['verticales-agents','01-controle-titres','RakaPay — contrôleur des titres', '/titres/controle', 'rk-controleur'],
 ['verticales-agents','02-pilotage-rakapay','RakaPay — pilotage', '/rakapay/pilotage', 'rk-responsable'],
 ['verticales-agents','03-controle-stationnement','Stationnement — contrôle par plaque', '/stationnement/controle', 'pk-controleur'],
 ['verticales-agents','04-regie-stationnement','Stationnement — régie des zones', '/stationnement/regie', 'pk-regie'],
 ['verticales-agents','05-tdb-stationnement','Stationnement — tableau de bord', '/stationnement/tableau-de-bord', 'u-gouverneur'],
 ['verticales-agents','06-inspection-publicite','Publicité — inspecteur accrédité', '/publicite/inspection', 'pb-inspecteur'],
 ['verticales-agents','07-regie-publicite','Publicité — autorisations', '/publicite/regie', 'pb-instructeur'],
 ['verticales-agents','08-tdb-publicite','Publicité — tableau de bord', '/publicite/tableau-de-bord', 'u-gouverneur'],
 ['verticales-agents','09-console-verticales','Console d’instruction des verticales', '/verticales/console', 'u-controleur'],
 ['verticales-agents','10-calcu','CALCU — contrôle de la dépense', '/controle/calcu', 'u-ministre-finances'],
 ['verticales-agents','11-carte-fiscale','Fiscal — carte à deux couches', '/fiscal/carte', 'u-controleur'],
 ['verticales-agents','12-exonerations','Fiscal — validation des exonérations', '/fiscal/exonerations', 'u-fiscal-chef-service'],
 ['verticales-agents','13-enrolement','Enrôlement assisté', '/canaux/enrolement', 'u-agent-terrain'],
 ['verticales-agents','14-point-agree','Point de paiement agréé', '/canaux/point-agree', 'canaux-op-gombe'],
 ['verticales-agents','15-terrain','Agent de terrain — missions', '/terrain', 'u-agent-terrain'],
 ['verticales-agents','16-supervision','Supervision du terrain', '/terrain/supervision', 'u-superviseur'],
 ['verticales-agents','17-recouvrement','Recouvrement gradué', '/recouvrement', 'u-contentieux'],
];
async function shoot(browser, dev, w, h, section, id, route, user, action) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dev === 'telephone' ? 2 : 1.5, serviceWorkers: 'block', colorScheme: 'light', timezoneId: 'Africa/Kinshasa', locale: 'fr-FR' });
  await ctx.addInitScript((u) => { localStorage.setItem('mosolo.demoUser', u); localStorage.setItem('mosolo.theme', 'light'); }, user);
  const page = await ctx.newPage();
  await page.goto('http://localhost:4173' + route, { waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForTimeout(900);
  if (action === 'submit') { await page.locator('main form button[type=submit]').first().click().catch(() => {}); await page.waitForTimeout(900); }
  const v = page.locator('.verdict, .result-card, .verify-out').first();
  if (section === 'verification-publique' && await v.count()) { await v.scrollIntoViewIfNeeded().catch(() => {}); await page.evaluate(() => window.scrollBy(0, -90)); }
  fs.mkdirSync(`${OUT}/${section}/${dev}`, { recursive: true });
  await page.screenshot({ path: `${OUT}/${section}/${dev}/${id}.png` });
  await ctx.close();
}
(async () => {
  const browser = await chromium.launch();
  for (const [section, id, , route, user, action] of V) {
    await shoot(browser, 'telephone', 390, 844, section, id, route, user, action);
    await shoot(browser, 'ordinateur', 1440, 900, section, id, route, user, action);
  }
  fs.writeFileSync(`${OUT}/liste.json`, JSON.stringify(V.map(([section, id, titre, route, user]) => ({ section, id, titre, route, user })), null, 1));
  await browser.close();
  console.log('ok', V.length);
})();
