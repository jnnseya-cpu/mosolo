import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { drawSample } from '../src/plugins/decision/audit-missions.js';
import { taxFamilyOf } from '../src/plugins/decision/regie-taxes.js';
import { DEMO } from '../src/seed.js';
import { callbackHeaders, postStatement } from './helpers.js';

/** Application complète (tous les modules d'extension, données de démonstration semées). */
async function full() {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown, headers: Record<string, string> = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  return { app, clock, req, ctx: app.ctx };
}

describe('Module 41 — centre de commandement exécutif', () => {
  it('carte de chaleur par commune, quartier, catégorie et situation ; agrégats sans donnée individuelle', async () => {
    const { req } = await full();
    const r = await req('GET', '/v1/decision/commandement', 'u-gouverneur');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.aggregatesOnly).toBe(true);
    expect(b.financialEdit).toBe(false);
    expect(b.heatmap.dimension).toBe('commune');
    expect(b.heatmap.rows.length).toBeGreaterThan(0);
    const row = b.heatmap.rows[0];
    expect(Object.keys(row.situations)).toEqual(['PAYE', 'EXIGIBLE', 'EN_RETARD', 'CONTESTE']);
    expect(r.body).not.toContain(DEMO.taxpayerId);
    for (const d of ['quartier', 'categorie']) {
      const x = await req('GET', `/v1/decision/commandement?dimension=${d}`, 'u-dircab');
      expect(x.statusCode, d).toBe(200);
      expect(x.json().heatmap.dimension).toBe(d);
    }
    // Indicateurs : écart assignation non mesuré sans assignation certifiée (motif = donnée source manquante).
    const gap = b.indicators.find((i: { code: string }) => i.code === 'ECART_ASSIGNATION_RAPPROCHE');
    expect(gap.measured).toBe(false);
    expect(gap.reason).toMatch(/assignation/);
    expect(b.indicators.map((i: { code: string }) => i.code)).toEqual(['ECART_ASSIGNATION_RAPPROCHE', 'COUVERTURE', 'ALERTES_CRITIQUES']);
    expect(['ECARTS', 'FRAUDE', 'RETARDS']).toEqual(b.alerts.byFamily.map((f: { family: string }) => f.family));
    // Échelle des onze états, servie par le pilotage.
    expect(b.ladder.levels.length).toBe(11);
  });

  it('réservé au Gouverneur, au Cabinet et au Secrétariat ; aucune capacité d’édition financière', async () => {
    const { req } = await full();
    expect((await req('GET', '/v1/decision/commandement', 'u-agent-terrain')).statusCode).toBe(403);
    expect((await req('GET', '/v1/decision/commandement', 'u-contribuable')).statusCode).toBe(403);
    // Le Gouverneur ne passe aucune écriture : la contre-écriture reste réservée au Trésor à quatre yeux.
    const entry = (await req('GET', '/v1/decision/commandement', 'u-gouverneur')).json();
    expect(entry.rule).toMatch(/aucun acte financier/);
    expect((await req('POST', '/v1/ledger/entries/ENT-1/reversals', 'u-gouverneur', { reason: 'Essai de correction par le Gouverneur' })).statusCode).toBe(403);
  });

  it('rapport signé vérifiable ; décision tracée (demande d’explication) par le circuit des instructions', async () => {
    const { req } = await full();
    const rep = (await req('GET', '/v1/decision/commandement/rapport', 'u-gouverneur')).json();
    expect(rep.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    const v = (await req('POST', '/v1/pilotage/exports/verify', undefined, { payload: rep.payload, sha256: rep.manifest.sha256, signature: rep.manifest.signature })).json();
    expect(v).toMatchObject({ integrity: true, authentic: true });
    const d = await req('POST', '/v1/decision/commandement/decisions', 'u-gouverneur', {
      kind: 'EXPLICATION', subject: 'Recouvrement faible à Limete', body: 'Expliquer le faible taux de rapproché sur liquidé à Limete ce trimestre.',
      context: { commune: 'Limete' }, assignee: { entity: 'DGIPK', role: 'R06' }, deadline: '2026-10-15',
    });
    expect(d.statusCode).toBe(201);
    expect(d.json().financialEffect).toBe('AUCUN');
    expect(d.json().instruction.subject).toMatch(/^Demande d’explication/);
    const list = (await req('GET', '/v1/pilotage/instructions', 'u-gouverneur')).json();
    expect(list.items.some((i: { id: string }) => i.id === d.json().instruction.id)).toBe(true);
    const cmd = (await req('GET', '/v1/decision/commandement', 'u-gouverneur')).json();
    expect(cmd.decisions.instructions.total).toBeGreaterThan(0);
  });
});

describe('Module 42 — tableau de bord de la régie fiscale', () => {
  it('assiette et liquidation par recette et commune, recouvrement, campagnes, contentieux, performance ; périmètre strict', async () => {
    const { req } = await full();
    const r = await req('GET', '/v1/decision/regie-fiscale', 'u-dg-dgipk');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.entity).toBe('DGIPK');
    expect(b.financialEdit).toBe(false);
    expect(b.assessment.byRevenue.length).toBeGreaterThan(0);
    expect(b.assessment.byCommune.length).toBeGreaterThan(0);
    expect(b.recovery.arrears.map((a: { band: string }) => a.band)).toEqual(['0-30', '31-90', '91-365', '365+']);
    expect(b.recovery.campaigns.length).toBeGreaterThan(0);
    expect(b.recovery.campaigns[0]).toHaveProperty('validation');
    expect(b.litigation).toHaveProperty('decisionDelayDays', 60);
    expect(b.performance.zones.length).toBeGreaterThan(0);
    expect(b.performance.teams.length).toBeGreaterThan(0);
    expect(b.indicators.map((i: { code: string }) => i.code)).toEqual(['TAUX_RECOUVREMENT', 'DELAI_CONTENTIEUX']);
    expect(r.body).not.toContain(DEMO.taxpayerId);
    // Périmètre strict : la DGIPK ne lit pas une autre régie ; la DGTK n'accède pas au tableau de la régie fiscale.
    expect((await req('GET', '/v1/decision/regie-fiscale?entity=DGTK', 'u-dg-dgipk')).statusCode).toBe(403);
    expect((await req('GET', '/v1/decision/regie-fiscale', 'vx-chef-service-dgtk')).json().code).toBe('OUT_OF_COMPETENCE');
    expect((await req('GET', '/v1/decision/regie-fiscale', 'u-tresor')).statusCode).toBe(403);
    // Autorités provinciales : choix de la régie, seulement une régie fiscale.
    expect((await req('GET', '/v1/decision/regie-fiscale', 'u-gouverneur')).json().entity).toBe('DGIPK');
    expect((await req('GET', '/v1/decision/regie-fiscale?entity=DGTK', 'u-gouverneur')).statusCode).toBe(400);
  });
});

describe('Module 43 — régie des taxes', () => {
  it('recettes par taxe, autorisations, contrôles ; périmètre limité à la DGTK', async () => {
    const { req } = await full();
    expect(taxFamilyOf('DEMO-PARK-HORAIRE')).toBe('STATIONNEMENT');
    expect(taxFamilyOf('DEMO-PUB-SURFACE')).toBe('PUBLICITE');
    expect(taxFamilyOf('R72-PATENTE')).toBe('PATENTE');
    expect(taxFamilyOf('R73-DOMAINE-PUBLIC')).toBe('DOMAINE_PUBLIC');
    const r = await req('GET', '/v1/decision/regie-taxes', 'pk-autorite');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.entity).toBe('DGTK');
    expect(b.byTax.map((t: { code: string }) => t.code)).toEqual(['PATENTE', 'PUBLICITE', 'STATIONNEMENT', 'DOMAINE_PUBLIC', 'AUTRES']);
    expect(b.authorizations.titres).toBeDefined();
    expect(b.authorizations.publicite).toBeDefined();
    expect(b.controls).toHaveProperty('stationnement');
    expect(b.indicators.map((i: { code: string }) => i.code)).toEqual(['RECETTES_PAR_TAXE', 'RENOUVELLEMENTS_A_TEMPS']);
    // Hors compétence : la direction de la DGIPK ne lit pas le tableau de la régie des taxes.
    expect((await req('GET', '/v1/decision/regie-taxes', 'u-dg-dgipk')).statusCode).toBe(403);
    expect((await req('GET', '/v1/decision/regie-taxes', 'u-gouverneur')).statusCode).toBe(200);
  });
});

describe('Module 44 — tableaux ministériels', () => {
  it('filtrage strict sur le ministère ; modules rattachés ; part de 10 % calculée, rapprochée, versée (quatre yeux)', async () => {
    const { req } = await full();
    const r = await req('GET', '/v1/decision/ministere', 'u-ministre-transports');
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.entity).toBe('MIN-TRANSPORTS');
    expect(b.modules.some((m: { code: string }) => m.code === 'STAT-DEMO')).toBe(true);
    expect(b.share.mode).toBe('SIMULATION');
    expect(b.share.pct).toBe('10');
    expect((await req('GET', '/v1/decision/ministere?entity=MINFIN', 'u-ministre-transports')).statusCode).toBe(403);
    expect((await req('GET', '/v1/decision/ministere', 'u-gouverneur')).statusCode).toBe(400);
    expect((await req('GET', '/v1/decision/ministere?entity=MIN-TRANSPORTS', 'u-gouverneur')).statusCode).toBe(200);
    expect((await req('GET', '/v1/decision/ministeres', 'u-ministre-transports')).json().items.map((e: { id: string }) => e.id)).toEqual(['MIN-TRANSPORTS']);
    // Versement constaté : saisi par le Trésor, validé par une seconde personne.
    const p = await req('POST', '/v1/decision/ministere/versements', 'u-tresor', { entity: 'MIN-TRANSPORTS', period: '2026-08', amount: { amount: '1500.00', currency: 'CDF' }, reference: 'OP-BUDG-2026-0815', motif: 'Versement de la part de tutelle d’août 2026' });
    expect(p.statusCode).toBe(201);
    expect((await req('POST', `/v1/decision/ministere/versements/${p.json().id}/decision`, 'u-tresor', { approve: true, motif: 'Validation par le même agent (refusée)' })).statusCode).toBe(403);
    const d = await req('POST', `/v1/decision/ministere/versements/${p.json().id}/decision`, 'u-analyste-rappro', { approve: true, motif: 'Ordre de paiement budgétaire vérifié' });
    expect(d.json().status).toBe('CONSTATE');
    const after = (await req('GET', '/v1/decision/ministere', 'u-ministre-transports')).json();
    expect(after.share.byCurrency.find((c: { currency: string }) => c.currency === 'CDF').paid.amount).toBe('1500.00');
    expect(after.indicators.find((i: { code: string }) => i.code === 'PART_VERSEE').measured).toBe(true);
    expect(after.indicators.find((i: { code: string }) => i.code === 'RECETTES_PAR_MODULE').byModule.length).toBe(after.modules.length);
    // Aucun autre ministère n'est visible du ministre des Transports (périmètre strict).
    expect(JSON.stringify(after)).not.toContain('MINFIN');
    expect((await req('POST', '/v1/decision/ministere/versements', 'u-ministre-transports', { entity: 'MIN-TRANSPORTS', period: '2026-08', amount: { amount: '1.00', currency: 'CDF' }, reference: 'X-1', motif: 'Tentative du ministre lui-même' })).statusCode).toBe(403);
  });
});

describe('Module 45 — salle de contrôle finances et trésorerie', () => {
  it('temps réel, incidents, paramètres sensibles ; escalade de toute exception hors délai, sans correction silencieuse', async () => {
    const { req, ctx, clock } = await full();
    const v = await req('GET', '/v1/decision/salle-controle', 'u-tresor');
    expect(v.statusCode).toBe(200);
    const b = v.json();
    expect(b.silentCorrection).toBe(false);
    expect(b.sensitiveParameters.map((f: { code: string }) => f.code)).toContain('SEUILS');
    expect(b.indicators.map((i: { code: string }) => i.code)).toEqual(['EXCEPTIONS_OUVERTES', 'DELAI_CLOTURE']);
    ctx.treasury.exceptions.insert({ id: 'EXC-TEST-1', type: 'ORPHAN_CREDIT', detail: 'Crédit orphelin (test)', status: 'OUVERTE', openedAt: clock.now().toISOString() });
    const before = JSON.stringify(ctx.treasury.exceptions.get('EXC-TEST-1'));
    clock.advanceHours(49);
    const after = (await req('GET', '/v1/decision/salle-controle', 'u-tresor')).json();
    const esc = after.escalations.find((e: { subjectId: string }) => e.subjectId === 'EXC-TEST-1');
    expect(esc).toBeDefined();
    expect(esc.notified.length).toBeGreaterThan(0);
    // Idempotente ; aucune modification de l'exception (lecture et escalade seulement).
    expect((await req('POST', '/v1/decision/salle-controle/escalades', 'u-tresor')).json().created).toHaveLength(0);
    expect(JSON.stringify(ctx.treasury.exceptions.get('EXC-TEST-1'))).toBe(before);
    const ack = await req('POST', `/v1/decision/salle-controle/escalades/${esc.id}/prise-en-charge`, 'u-ministre-finances', { motif: 'Prise en charge par le comité finances' });
    expect(ack.json().acknowledgement.by).toBe('u-ministre-finances');
    expect((await req('GET', '/v1/decision/salle-controle', 'u-agent-terrain')).statusCode).toBe(403);
  });
});

describe('Module 46 — audit et investigation', () => {
  it('tirage d’échantillon reproductible (même graine, même population ⇒ même échantillon)', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `ID-${i}`);
    expect(drawSample(ids, 'graine-1', 5)).toEqual(drawSample([...ids].reverse(), 'graine-1', 5));
    expect(drawSample(ids, 'graine-1', 5)).not.toEqual(drawSample(ids, 'graine-2', 5));
  });

  it('mission, échantillon, constat, recommandation suivie ; export scellé avec chaîne de possession ; corrections', async () => {
    const { req, ctx } = await full();
    const m = (await req('POST', '/v1/decision/audit/missions', 'u-auditeur', { title: 'Revue des paiements de septembre', objective: 'Vérifier la chaîne paiement → quittance → écriture sur un échantillon.', scope: 'Paiements 2026' })).json();
    const s1 = await req('POST', `/v1/decision/audit/missions/${m.id}/echantillons`, 'u-auditeur', { population: 'EVENEMENTS_AUDIT', size: 5, seed: 'graine-audit' });
    expect(s1.statusCode).toBe(201);
    expect(s1.json().sample.items).toHaveLength(5);
    expect(s1.json().sample.populationSha256).toMatch(/^[0-9a-f]{64}$/);
    const f = (await req('POST', `/v1/decision/audit/missions/${m.id}/constats`, 'u-auditeur', { title: 'Quittances tardives', description: 'Délai supérieur à la cible pour deux paiements échantillonnés.', severity: 'MOYENNE', evidence: s1.json().sample.items.slice(0, 2) })).json();
    const findingId = f.findings[0].id;
    const withReco = (await req('POST', `/v1/decision/audit/missions/${m.id}/constats/${findingId}/recommandations`, 'u-auditeur', { text: 'Suivre le délai de quittance chaque semaine.', ownerEntity: 'DGIPK', deadline: '2026-11-30' })).json();
    const recoId = withReco.findings[0].recommendations[0].id;
    expect((await req('POST', `/v1/decision/audit/recommandations/${recoId}/suivi`, 'u-tresor', { status: 'MISE_EN_OEUVRE_DECLAREE', note: 'Hors service destinataire', evidenceSha256: 'a'.repeat(64) })).statusCode).toBe(403);
    expect((await req('POST', `/v1/decision/audit/recommandations/${recoId}/suivi`, 'u-dg-dgipk', { status: 'MISE_EN_OEUVRE_DECLAREE', note: 'Tableau hebdomadaire mis en place', evidenceSha256: 'b'.repeat(64) })).statusCode).toBe(200);
    // L'auteur du constat ne vérifie pas lui-même le suivi.
    expect((await req('POST', `/v1/decision/audit/recommandations/${recoId}/suivi`, 'u-auditeur', { status: 'MISE_EN_OEUVRE_VERIFIEE', note: 'Vérifié' })).statusCode).toBe(403);
    expect((await req('POST', `/v1/decision/audit/recommandations/${recoId}/suivi`, 'pilotage-u-auditeur-externe', { status: 'MISE_EN_OEUVRE_VERIFIEE', note: 'Vérifié sur pièces' })).statusCode).toBe(200);
    const list = (await req('GET', '/v1/decision/audit/missions', 'u-auditeur')).json();
    expect(list.integrity.ok).toBe(true);
    // Racine quotidienne : vérification d'intégrité par le module de scellement (lecture seule).
    expect(list.dailyRoots.available).toBe(true);
    expect(list.dailyRoots.link).toBe('/integrite/scellement');
    expect(list.indicators.find((i: { code: string }) => i.code === 'RECOMMANDATIONS_SUIVIES').value).toBe('100.0');
    // Export scellé : vérifiable ; remise tracée (empreinte recalculée).
    const sealed = (await req('POST', `/v1/decision/audit/missions/${m.id}/scelle`, 'u-auditeur', { motif: 'Remise du dossier à l’inspection générale' })).json();
    expect(sealed.verification).toEqual({ integrity: true, authentic: true });
    const v = (await req('POST', '/v1/pilotage/exports/verify', undefined, { payload: sealed.payload, sha256: sealed.sha256, signature: sealed.signature })).json();
    expect(v.integrity && v.authentic).toBe(true);
    const handed = (await req('POST', `/v1/decision/audit/scelles/${sealed.id}/remise`, 'u-auditeur', { to: 'Inspection générale des finances', motif: 'Transmission officielle du dossier' })).json();
    expect(handed.custody.map((c: { step: string }) => c.step)).toEqual(['SCELLE', 'REMISE']);
    expect(handed.custody[1].sha256Verified).toBe(sealed.sha256);
    // Reconstitution d'une correction (obligation) ; référence inconnue : 404.
    const ob = ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!;
    const c = (await req('GET', `/v1/decision/audit/corrections/${ob.id}`, 'u-auditeur')).json();
    expect(c.kind).toBe('OBLIGATION');
    expect(c.events.length).toBeGreaterThan(0);
    expect((await req('GET', '/v1/decision/audit/corrections/INCONNU-1', 'u-auditeur')).statusCode).toBe(404);
    // Aucune modification possible par l'audit : ni contre-écriture, ni création de mission par un non-auditeur.
    expect((await req('POST', '/v1/ledger/entries/ENT-1/reversals', 'u-auditeur', { reason: 'Tentative de correction par l’audit' })).statusCode).toBe(403);
    expect((await req('POST', '/v1/decision/audit/missions', 'u-tresor', { title: 'Mission', objective: 'Objectif de la mission', scope: 'Tout' })).statusCode).toBe(403);
  });
});

describe('Module 47 — prévision de trésorerie hebdomadaire', () => {
  it('par catégorie et par commune, hypothèses jointes, empreinte ; aucune assignation fixée ; écart prévision / réalisé', async () => {
    const { req, ctx, clock } = await full();
    const targetsBefore = (ctx.ext.planification as { targets: { count(): number } }).targets.count();
    const r = await req('POST', '/v1/decision/previsions', 'u-ministre-finances', { weeks: 6 });
    expect(r.statusCode).toBe(201);
    const f = r.json();
    expect(f.assignation).toBe('AUCUNE');
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(f.rates.length).toBeGreaterThan(0);
    expect(f.rates.every((x: { source: string }) => ['OBSERVE_365_JOURS', 'HYPOTHESE'].includes(x.source))).toBe(true);
    for (const l of f.lines) expect(l).toHaveProperty('commune');
    expect((ctx.ext.planification as { targets: { count(): number } }).targets.count()).toBe(targetsBefore);
    // Hypothèse du registre : le scénario la joint à la prévision.
    const h = await req('POST', '/v1/pilotage/scenarios/hypotheses', 'u-ministre-finances', { scenario: 'PRUDENT', variable: 'TAUX_CONFORMITE_CIBLE', revenue: '*', value: '40', source: 'Note de cadrage budgétaire (test)', sourceDate: '2026-09-01' });
    expect(h.statusCode).toBeLessThan(300);
    const withH = (await req('POST', '/v1/decision/previsions', 'u-ministre-finances', { weeks: 4, scenario: 'PRUDENT' })).json();
    expect(withH.hypotheses.length).toBe(1);
    expect(withH.rates.every((x: { source: string }) => x.source === 'HYPOTHESE')).toBe(true);
    // Semaines écoulées (échéances de démonstration fin octobre) : l'écart prévision / réalisé devient mesurable.
    clock.advance(45 * 86_400_000);
    const g = (await req('GET', `/v1/decision/previsions/${f.id}/ecart`, 'u-ministre-finances')).json();
    expect(f.lines.length).toBeGreaterThan(0);
    expect(g.rows.every((x: { elapsed: boolean }) => x.elapsed)).toBe(true);
    expect(g.rows[0].actual).not.toBeNull();
    expect(g.totals.expectedCdf.currency).toBe('CDF');
    const list = (await req('GET', '/v1/decision/previsions', 'u-ministre-finances')).json();
    expect(list.indicator.code).toBe('ECART_PREVISION_REALISE');
    expect((await req('POST', '/v1/decision/previsions', 'u-agent-terrain', {})).statusCode).toBe(403);
  });
});

describe('Module 54 — transparence publique (compléments)', () => {
  it('parts de répartition publiques par catégorie de bénéficiaire (agrégats, simulation sans acte) ; consultations et publications à temps', async () => {
    const { req, clock, ctx } = await full();
    const sh = await req('GET', '/v1/public/transparence/repartition/2026-T3');
    expect(sh.statusCode).toBe(200);
    expect(sh.json().mode).toBe('SIMULATION');
    expect(sh.json().threshold).toBe(5);
    expect(sh.body).not.toContain(DEMO.taxpayerId);
    if (!sh.json().suppressed) expect(sh.json().byCategory.map((c: { code: string }) => c.code)).toContain('TUTELLE');
    expect((await req('GET', '/v1/public/transparence/repartition/2026-09')).statusCode).toBe(400);
    await req('GET', '/v1/public/transparency');
    const ind = (await req('GET', '/v1/decision/transparence', 'u-ministre-finances')).json();
    expect(ind.indicators.find((i: { code: string }) => i.code === 'CONSULTATIONS').value).toBe('2');
    expect(ind.indicators.map((i: { code: string }) => i.code)).toEqual(['CONSULTATIONS', 'PUBLICATIONS_A_TEMPS']);
    expect(ind.indicators.find((i: { code: string }) => i.code === 'PUBLICATIONS_A_TEMPS').measured).toBe(false);
    // Un paiement rapproché au 3e trimestre, jamais publié : après l'échéance de publication, le trimestre est en retard.
    const obligationId = ctx.assessment.byTaxpayer(DEMO.taxpayerId)[0]!.id;
    const order = (await req('POST', `/v1/obligations/${obligationId}/payment-orders`, 'u-guichet', { channel: 'MOBILE_MONEY' }, { 'idempotency-key': 'cle-transparence-0001' })).json();
    const raw = JSON.stringify({ providerTxnId: 'TXN-TRANSP-1', paymentReference: order.paymentReference, amount: order.amount, status: 'SUCCESS', completedAt: clock.now().toISOString() });
    expect((await req('POST', '/v1/providers/mm-operator-a/callbacks', undefined, raw, callbackHeaders('s', raw, clock.now()))).json().status).toBe('CONFIRME');
    expect((await postStatement({ req }, 'u-tresor', { statementId: 'REL-TRANSP-1', lines: [{ accountAlias: DEMO.dgipkAlias, amount: order.amount, valueDate: clock.now().toISOString().slice(0, 10), paymentReference: order.paymentReference }] })).statusCode).toBe(201);
    clock.advance(120 * 86_400_000);
    const late = (await req('GET', '/v1/decision/transparence', 'u-ministre-finances')).json();
    expect(late.quarters[0]).toMatchObject({ period: '2026-T3', due: '2026-11-14', publishedAt: null, onTime: false });
    expect(late.indicators.find((i: { code: string }) => i.code === 'PUBLICATIONS_A_TEMPS').value).toBe('0.0');
    expect((await req('GET', '/v1/decision/transparence', 'u-contribuable')).statusCode).toBe(403);
  });
});
