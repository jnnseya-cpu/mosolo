/**
 * Moteur de paiement, de règlement et de répartition (spécifications du 29/09/2026, v1 et v1.0) — tests nommés selon les
 * sections de la spécification. Construit par-dessus la clé du § 37A (tests repartition*.test.ts inchangés).
 */
import { Money } from '@mosolo/shared';
import { describe, expect, it } from 'vitest';
import { CIRCUITS, reconstruct } from '../src/plugins/integrite/gouvernance/circuits.js';
import { allocateTransaction, checkVersionShape, defaultBeneficiaries, defaultPool, sumLines } from '../src/plugins/pilotage/repartition/moteur/model.js';
import { DEFAULT_SLICES, REPARTITION_PART_NSEYA_PCT } from '../src/plugins/pilotage/repartition/model.js';
import { activateKey, activateV1, B, money, payAndReconcile, refund, setupMoteur } from './moteur-helpers.js';

const ctxDirect = (agentId: string | null, agentType: 'DIRECT_DEPARTMENT' | 'SUBCONTRACTOR_AGENT' | null, subcontractorId: string | null = null) => ({
  entity: 'MINFIN', entityLabel: 'Ministère provincial des Finances', entityType: 'MINISTERE' as const, pool: { agentId, agentType, subcontractorId, module: 'V-propriete' },
});
const amounts = (ls: { beneficiary: string; amount: { amount: string } }[]) => Object.fromEntries(ls.map((l) => [l.beneficiary, l.amount.amount]));

describe('§ 3 et § 15 — matrice de répartition versionnée (KIN-DEFAULT)', () => {
  it('la V1 reprend les constantes du § 37A (non supprimées), proposée, ACTE_REQUIS, effet au 01/10/2026, pool par recette générée', async () => {
    const env = await setupMoteur();
    expect(DEFAULT_SLICES.map((s) => s.pct)).toEqual(['10', '10', '10', '70']);
    expect(REPARTITION_PART_NSEYA_PCT).toBe(10);
    const r = await env.req('GET', `${B}/regles`, 'u-ministre-finances');
    expect(r.statusCode).toBe(200);
    const v1 = r.json().items[0];
    expect(v1).toMatchObject({ id: 'KIN-DEFAULT-V1', status: 'ACTE_REQUIS', parDefaut: true, effectiveFrom: '2026-10-01', sum: '100.000', checks: [], pool: { mode: 'PAR_RECETTE_GENEREE', lecture: 'POINTS_DE_LA_TRANSACTION' } });
    expect(v1.beneficiaries.map((b: { code: string; pct: string; flow: string }) => [b.code, b.pct, b.flow])).toEqual([
      ['GROUPE_NSEYA', '10', 'FLUX_1'], ['TUTELLE', '10', 'FLUX_2'], ['AGENTS_SOUS_TRAITANTS', '10', 'FLUX_2'], ['GOUVERNEMENT_PROVINCIAL', '70', 'FLUX_2'],
    ]);
    expect(r.json().contradictions.map((c: { code: string }) => c.code)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
  });

  it('§ 3 — garde « somme = 100,000 % » : une version à 99,999 % est proposée mais refusée à la vérification', async () => {
    const env = await setupMoteur();
    const bs = defaultBeneficiaries().map((b) => (b.code === 'GOUVERNEMENT_PROVINCIAL' ? { ...b, pct: '69.999' } : b));
    const p = await env.req('POST', `${B}/regles`, 'u-validateur-financier', { label: 'Version fautive (test)', beneficiaries: bs, effectiveFrom: '2026-11-01', legalBasis: 'Test de la garde des 100 %', motif: 'Proposition volontairement fautive (test).' });
    expect(p.statusCode).toBe(201);
    expect(p.json().checks.map((c: { code: string }) => c.code)).toContain('SOMME_DIFFERENTE_DE_100');
    const v = await env.req('POST', `${B}/regles/${p.json().id}/verification`, 'u-juriste-verificateur', { approve: true, motif: 'Vérification de la version (test).' });
    expect(v.statusCode).toBe(422);
    expect(v.json().code).toBe('SOMME_DIFFERENTE_DE_100');
  });

  it('§ 18 — rédaction, vérification, approbation et activation par quatre personnes distinctes ; conditions du § 37A', async () => {
    const env = await setupMoteur();
    const bs = defaultBeneficiaries();
    const p = (await env.req('POST', `${B}/regles`, 'u-validateur-financier', { label: 'V2 de contrôle (test)', beneficiaries: bs, effectiveFrom: '2026-11-01', legalBasis: 'Test du circuit', motif: 'Proposition de contrôle (test).' })).json();
    const step = (s: string, u: string, approve = true) => env.req('POST', `${B}/regles/${p.id}/${s}`, u, { approve, motif: 'Décision motivée du circuit (test).' });
    // Le rédacteur ne vérifie pas ; un rôle non habilité non plus.
    expect((await step('verification', 'u-validateur-financier')).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await step('verification', 'u-tresor')).statusCode).toBe(403);
    expect((await step('verification', 'u-juriste-verificateur')).json().status).toBe('VERIFIEE');
    // L'approbateur est distinct du rédacteur et du vérificateur.
    expect((await step('approbation', 'u-ministre-finances')).json().status).toBe('APPROUVEE');
    // L'activation : quatrième personne ; refusée tant que la clé du § 37A n'est pas active (acte + conditions).
    expect((await step('activation', 'u-ministre-finances')).json().code).toBe('SEPARATION_OF_DUTIES');
    const refused = await step('activation', 'u-gouverneur');
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe('ACTE_REQUIS');
    expect(refused.json().missing.join(' ')).toMatch(/Acte juridique/);
    await activateKey(env);
    const ok = await step('activation', 'u-gouverneur');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'ACTIVE', createdBy: 'u-validateur-financier', reviewedBy: 'u-juriste-verificateur', approvedBy: 'u-ministre-finances', activatedBy: 'u-gouverneur' });
    // Circuits reconstitués depuis le journal d'audit (collusion, rotation).
    expect(CIRCUITS.filter((c) => c.code.startsWith('MOTEUR_REGLE_')).map((c) => c.code)).toEqual(['MOTEUR_REGLE_VERIFICATION', 'MOTEUR_REGLE_APPROBATION', 'MOTEUR_REGLE_ACTIVATION']);
    const { decisions } = reconstruct(env.app.ctx.audit.list({ limit: 1e6 }).items);
    expect(decisions.filter((d) => d.circuit.startsWith('MOTEUR_REGLE_')).map((d) => [d.circuit, d.proposerId, d.approverId])).toEqual([
      ['MOTEUR_REGLE_VERIFICATION', 'u-validateur-financier', 'u-juriste-verificateur'],
      ['MOTEUR_REGLE_APPROBATION', 'u-juriste-verificateur', 'u-ministre-finances'],
      ['MOTEUR_REGLE_ACTIVATION', 'u-ministre-finances', 'u-gouverneur'],
    ]);
  });

  it('§ 15 — versions : une transaction de décembre reste calculée en V1 après l’activation d’une V2 (8 %)', async () => {
    const env = await setupMoteur();
    await activateKey(env);
    await activateV1(env);
    env.clock.set('2026-12-15T10:00:00.000Z');
    const dec = await payAndReconcile(env);
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    const a1 = env.svc.allocations.get(`AL-${dec.id}`)!;
    expect(a1).toMatchObject({ versionId: 'KIN-DEFAULT-V1', mode: 'REEL' });
    expect(amounts(a1.lines)).toMatchObject({ GROUPE_NSEYA: '15.00', GOUVERNORAT: '105.00' });
    // V2 : Groupe Nseya 8 %, Gouvernorat 72 %, effet au 01/04/2027 ; règle certifiée portant les mêmes taux.
    env.clock.set('2027-03-01T10:00:00.000Z');
    const { publishCertifiedRule } = await import('./helpers.js');
    const { keyRule } = await import('./moteur-helpers.js');
    await publishCertifiedRule(env, keyRule({ part_groupe_nseya: '8', part_tutelle: '10', part_agents: '10', part_gouvernement: '72' }, '2027-04-01'));
    const bs = defaultBeneficiaries().map((b) => (b.code === 'GROUPE_NSEYA' ? { ...b, pct: '8' } : b.code === 'GOUVERNEMENT_PROVINCIAL' ? { ...b, pct: '72' } : b));
    const v2 = (await env.req('POST', `${B}/regles`, 'u-superadmin', { label: 'KIN-DEFAULT V2 — Groupe Nseya 8 % (test)', beneficiaries: bs, effectiveFrom: '2027-04-01', legalBasis: 'Avenant fictif (test)', approvalDocument: 'AVENANT-001 (fictif)', motif: 'Changement de taux proposé (test).' })).json();
    expect(v2.id).toBe('KIN-DEFAULT-V2');
    for (const [s, u] of [['verification', 'u-juriste-verificateur'], ['approbation', 'u-dircab'], ['activation', 'u-gouverneur']] as const) {
      const r = await env.req('POST', `${B}/regles/${v2.id}/${s}`, u, { approve: true, motif: 'Décision motivée du circuit (test).' });
      expect(r.statusCode, r.body).toBe(200);
    }
    const versions = (await env.req('GET', `${B}/regles`, 'u-auditeur')).json().items;
    expect(versions.map((v: { id: string; effectiveUntil: string | null; status: string }) => [v.id, v.status, v.effectiveUntil])).toEqual([['KIN-DEFAULT-V1', 'ACTIVE', '2027-03-31'], ['KIN-DEFAULT-V2', 'ACTIVE', null]]);
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    // Historique jamais réécrit : la transaction de décembre garde V1 et ses montants.
    expect(env.svc.allocations.get(`AL-${dec.id}`)).toEqual(a1);
    expect(env.svc.versionFor('2026-12-15', { module: 'V-propriete', revenueCategory: 'IMPOT_PROVINCIAL', methode: 'ELECTRONIQUE' })!.version.id).toBe('KIN-DEFAULT-V1');
    expect(env.svc.versionFor('2027-04-15', { module: 'V-propriete', revenueCategory: 'IMPOT_PROVINCIAL', methode: 'ELECTRONIQUE' })!.version.id).toBe('KIN-DEFAULT-V2');
    // Aucune V3 rétroactive : une date d'effet passée est refusée à l'activation.
    const v3 = (await env.req('POST', `${B}/regles`, 'u-superadmin', { label: 'V3 rétroactive (test)', beneficiaries: defaultBeneficiaries(), effectiveFrom: '2027-01-01', legalBasis: 'Test de rétroactivité', motif: 'Proposition rétroactive (test).' })).json();
    for (const [s, u] of [['verification', 'u-juriste-verificateur'], ['approbation', 'u-dircab']] as const) await env.req('POST', `${B}/regles/${v3.id}/${s}`, u, { approve: true, motif: 'Décision motivée du circuit (test).' });
    expect((await env.req('POST', `${B}/regles/${v3.id}/activation`, 'u-gouverneur', { approve: true, motif: 'Décision motivée du circuit (test).' })).json().code).toBe('EFFET_RETROACTIF');
  });
});

describe('§ 8 et § 18 — pool des opérations de terrain : 10 / 0 et 7 / 3 ; points × qualité conservé', () => {
  it('100 $ : agent direct 70 / 10 / 10 / 10 ; agent de sous-traitant 70 / 10 / 10 / 7 / 3 ; mode points × qualité : réserve du module', () => {
    const v = { beneficiaries: defaultBeneficiaries(), pool: defaultPool() };
    const base = Money.of('100.00', 'USD');
    const direct = allocateTransaction(base, v, ctxDirect('u-agent-terrain', 'DIRECT_DEPARTMENT'));
    expect(amounts(direct)).toEqual({ GROUPE_NSEYA: '10.00', 'ENTITE:MINFIN': '10.00', 'AGENT:u-agent-terrain': '10.00', GOUVERNORAT: '70.00' });
    const st = allocateTransaction(base, v, ctxDirect('u-agent-st', 'SUBCONTRACTOR_AGENT', 'ST-1'));
    expect(amounts(st)).toEqual({ GROUPE_NSEYA: '10.00', 'ENTITE:MINFIN': '10.00', 'AGENT:u-agent-st': '7.00', 'SOUS_TRAITANT:ST-1': '3.00', GOUVERNORAT: '70.00' });
    expect(sumLines(st, 'USD').equals(base)).toBe(true);
    const pts = allocateTransaction(base, { ...v, pool: { ...defaultPool(), mode: 'PAR_POINTS_QUALITE' } }, ctxDirect('u-agent-st', 'SUBCONTRACTOR_AGENT', 'ST-1'));
    expect(amounts(pts)).toEqual({ GROUPE_NSEYA: '10.00', 'ENTITE:MINFIN': '10.00', 'POOL:V-propriete': '10.00', GOUVERNORAT: '70.00' });
    // Lecture « 7 % du pool » (à arbitrer, configurable) : 0,70 / 0,30, le reste demeure en réserve.
    const ofPool = allocateTransaction(base, { ...v, pool: { ...defaultPool(), lecture: 'POURCENTAGE_DU_POOL', sousTraitance: { agentPct: '7', sousTraitantPct: '3' } } }, ctxDirect('u-agent-st', 'SUBCONTRACTOR_AGENT', 'ST-1'));
    expect(amounts(ofPool)).toMatchObject({ 'AGENT:u-agent-st': '0.70', 'SOUS_TRAITANT:ST-1': '0.30', 'POOL:V-propriete': '9.00' });
    // Sans agent attribué : la part reste en réserve du pool (jamais versée au collecteur).
    expect(amounts(allocateTransaction(base, v, ctxDirect(null, null)))).toMatchObject({ 'POOL:V-propriete': '10.00' });
    // Incohérence 7 + 4 ≠ 10 : refusée.
    expect(checkVersionShape({ ...v, couts: { mode: 'AUCUN', fraisGestionPct: null }, pool: { ...defaultPool(), sousTraitance: { agentPct: '7', sousTraitantPct: '4' } } }).map((c) => c.code)).toContain('POOL_INCOHERENT');
  });

  it('§ 18 — l’affectation de l’agent est celle de la date de la transaction ; un changement ultérieur ne réécrit rien', async () => {
    const env = await setupMoteur();
    await activateKey(env);
    await activateV1(env);
    env.app.ctx.users.add({ id: 'u-chef-service', name: 'Chef de service (test)', roles: ['R07'], entity: 'DGIPK' });
    const fiche = (await env.req('POST', `${B}/agents/affectations`, 'u-dg-dgipk', { agent_id: 'u-agent-terrain', agent_name: 'Agent Limete', agent_type: 'SUBCONTRACTOR_AGENT', parent_ministry_id: 'MINFIN', parent_department_id: 'DGIPK', subcontractor_id: 'ST-1', territory: ['Limete'], module_permissions: ['V-propriete'], effective_from: '2026-10-01', effective_to: null })).json();
    expect((await env.req('POST', `${B}/agents/affectations/${fiche.id}/confirmation`, 'u-dg-dgipk', { approve: true, motif: 'Confirmation par le proposant (test).' })).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await env.req('POST', `${B}/agents/affectations/${fiche.id}/confirmation`, 'u-chef-service', { approve: true, motif: 'Confirmation par une autre personne (test).' })).json().status).toBe('ACTIVE');
    const o = await payAndReconcile(env);
    env.app.ctx.ext.sanctions = { commissions: { lines: () => [{ source: 'PAIEMENT', state: 'ACQUISE', orderId: o.id, agentId: 'u-agent-terrain' }] } };
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    const a = env.svc.allocations.get(`AL-${o.id}`)!;
    expect(amounts(a.lines)).toEqual({ GROUPE_NSEYA: '15.00', 'ENTITE:DGIPK': '15.00', 'AGENT:u-agent-terrain': '10.50', 'SOUS_TRAITANT:ST-1': '4.50', GOUVERNORAT: '105.00' });
    // L'agent devient direct le 05/10 : la transaction du 02/10 reste 7 / 3.
    env.clock.set('2026-10-05T09:00:00.000Z');
    const f2 = (await env.req('POST', `${B}/agents/affectations`, 'u-dg-dgipk', { agent_id: 'u-agent-terrain', agent_name: 'Agent Limete', agent_type: 'DIRECT_DEPARTMENT', parent_ministry_id: 'MINFIN', parent_department_id: 'DGIPK', subcontractor_id: null, territory: ['Limete'], module_permissions: [], effective_from: '2026-10-05', effective_to: null })).json();
    await env.req('POST', `${B}/agents/affectations/${f2.id}/confirmation`, 'u-chef-service', { approve: true, motif: 'Changement de rattachement (test).' });
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    expect(env.svc.allocations.get(`AL-${o.id}`)).toEqual(a);
    expect(env.svc.agentProfile('u-agent-terrain', '2026-10-02')).toMatchObject({ type: 'SUBCONTRACTOR_AGENT', subcontractorId: 'ST-1' });
    expect(env.svc.agentProfile('u-agent-terrain', '2026-10-06')).toMatchObject({ type: 'DIRECT_DEPARTMENT', subcontractorId: null });
  });
});

describe('§ 7 et § 17 — attribution au ministère / département par la propriété officielle du module', () => {
  it('la part de 10 % suit le module (DEMO-IF-BATI → V-propriete → MINFIN), jamais le collecteur', async () => {
    const env = await setupMoteur();
    const reg = (await env.req('GET', `${B}/proprietes-modules`, 'u-auditeur')).json();
    // Fiche de module ACTIVE du domaine IMPOT_FONCIER : la DGIPK (département du ministère des Finances) est propriétaire.
    expect(reg.items.find((i: { ruleCode: string }) => i.ruleCode === 'DEMO-IF-BATI')).toMatchObject({ moduleId: 'V-propriete', responsibleMinistryId: 'MINFIN', responsibleDepartmentId: 'DGIPK', basis: 'FICHE_ACTIVE', allocationRuleId: 'KIN-DEFAULT' });
    const o = await payAndReconcile(env);
    // Collecteur rattaché à un AUTRE ministère : la part ministérielle ne le suit pas.
    env.app.ctx.users.add({ id: 'u-agent-transports', name: 'Agent des Transports (test)', roles: ['R10'], entity: 'MIN-TRANSPORTS' });
    env.app.ctx.ext.sanctions = { commissions: { lines: () => [{ source: 'PAIEMENT', state: 'ACQUISE', orderId: o.id, agentId: 'u-agent-transports' }] } };
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    const a = env.svc.allocations.get(`AL-${o.id}`)!;
    expect(a).toMatchObject({ module: 'V-propriete', entity: 'DGIPK', entityBasis: 'FICHE_ACTIVE', agentId: 'u-agent-transports', agentType: 'DIRECT_MINISTRY' });
    expect(a.lines.find((l) => l.kind === 'TUTELLE')).toMatchObject({ beneficiary: 'ENTITE:DGIPK', beneficiaryType: 'DEPARTEMENT' });
    // Sans module d'accès (aucune fiche active) : tutelle ministérielle PAR DÉFAUT (à confirmer).
    expect(env.svc.owner('XYZ-INCONNU')).toMatchObject({ entity: 'A_RATTACHER', basis: 'A_RATTACHER' });
  });
});

describe('§ 16 — remboursements et contrepassations : lignes négatives, solde recouvrable', () => {
  it('droit réglé par le Flux 1 puis paiement remboursé : contre-écriture −15 et solde recouvrable ; recouvré par la régularisation suivante', async () => {
    const env = await setupMoteur();
    await activateKey(env);
    await activateV1(env);
    const o = await payAndReconcile(env);
    env.clock.set('2026-11-02T09:00:00.000Z');
    const p = (await env.req('POST', '/v1/pilotage/repartition/propositions', 'u-analyste-rappro', { period: '2026-10', currency: 'USD', reason: 'Répartition d’octobre (test)' })).json();
    expect((await env.req('POST', `/v1/tresor/operations/${p.operations[0].id}/approve`, 'u-tresor', {})).json().status).toBe('EXECUTEE');
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    let droits = (await env.req('GET', `${B}/droits`, 'u-ministre-finances')).json().reel;
    expect(droits.find((d: { beneficiary: string }) => d.beneficiary === 'GROUPE_NSEYA')).toMatchObject({ constate: money('15.00'), regle: money('15.00'), solde: money('0.00') });
    refund(env, o.id);
    const s = (await env.req('POST', `${B}/synchroniser`, 'u-tresor', {})).json();
    expect(s.reversed).toBe(1);
    const cp = env.svc.contrepassations.get(`CP-${o.id}`)!;
    expect(cp.lines.map((l) => l.amount.amount).sort()).toEqual(['-105.00', '-15.00', '-15.00', '-15.00']);
    expect(cp.recoverable).toEqual(['GROUPE_NSEYA']);
    droits = (await env.req('GET', `${B}/droits`, 'u-ministre-finances')).json().reel;
    expect(droits.find((d: { beneficiary: string }) => d.beneficiary === 'GROUPE_NSEYA')).toMatchObject({ constate: money('0.00'), regle: money('15.00'), recouvrable: money('15.00') });
    // Les écritures d'origine restent visibles ; la chaîne du sous-grand-livre est intacte.
    expect(env.svc.ecritures.find((e) => e.orderId === o.id).map((e) => e.type)).toEqual(['CONSTAT', 'REGLEMENT', 'CONTREPASSATION']);
    expect(env.svc.verifyChain().valid).toBe(true);
  });
});

describe('§ 6 et § 13 — espèces : points agréés seulement ; droit de Groupe Nseya PAYABLE puis demande de règlement', () => {
  it('espèces rapprochées → droit PAYABLE (réglé 0) → brouillon → soumise → examen → approbation → paiement instruit (Flux 1) → payée → rapprochée → clôturée', async () => {
    const env = await setupMoteur();
    await activateKey(env);
    await activateV1(env);
    const o = await payAndReconcile(env, 'AGENT_POINT');
    await env.req('POST', `${B}/synchroniser`, 'u-tresor', {});
    const a = env.svc.allocations.get(`AL-${o.id}`)!;
    expect(a).toMatchObject({ methode: 'ESPECES', mode: 'REEL' });
    let ns = (await env.req('GET', `${B}/tableau/groupe-nseya`, 'u-superadmin')).json();
    expect(ns.positionCommerciale[0]).toMatchObject({ droit: money('15.00'), especes: money('15.00'), regle: money('0.00'), payable: money('15.00'), especesPayables: money('15.00') });
    // Jamais au-dessus du reste dû.
    const over = await env.req('POST', `${B}/demandes`, 'u-superadmin', { beneficiary: 'GROUPE_NSEYA', currency: 'USD', amount: '15.01', periodStart: '2026-10-01', periodEnd: '2026-10-31', motif: 'Demande de règlement des espèces d’octobre (test).' });
    expect(over.json().code).toBe('REGLEMENT_SUPERIEUR_AU_RESTANT');
    const d = (await env.req('POST', `${B}/demandes`, 'u-superadmin', { beneficiary: 'GROUPE_NSEYA', currency: 'USD', periodStart: '2026-10-01', periodEnd: '2026-10-31', motif: 'Demande de règlement des espèces d’octobre (test).' })).json();
    expect(d).toMatchObject({ status: 'BROUILLON', amount: money('15.00'), flow: 'FLUX_1' });
    // Groupe Nseya ne demande jamais pour un autre bénéficiaire.
    expect((await env.req('POST', `${B}/demandes`, 'u-superadmin', { beneficiary: 'GOUVERNORAT', currency: 'USD', motif: 'Demande hors périmètre (test).' })).json().code).toBe('HORS_PERIMETRE');
    const go = (path: string, user: string, body: Record<string, unknown>) => env.req('POST', `${B}/demandes/${d.id}/${path}`, user, body);
    expect((await go('soumission', 'u-superadmin', { motif: 'Soumission de la demande (test).' })).json().status).toBe('SOUMISE');
    expect((await go('examen', 'u-validateur-financier', { motif: 'Examen des droits espèces (test).' })).json().status).toBe('EN_EXAMEN');
    expect((await go('approbation', 'u-validateur-financier', { approve: true, motif: 'Auto-approbation interdite (test).' })).statusCode).toBe(403);
    expect((await go('approbation', 'u-ministre-finances', { approve: true, motif: 'Approbation du Gouvernement (test).' })).json().status).toBe('APPROUVEE');
    // Tant qu'aucun Flux 1 n'existe, aucun paiement n'est instruit (jamais un troisième flux).
    expect((await go('instruction', 'u-tresor', { operationId: 'OP-INEXISTANTE', motif: 'Instruction sans flux (test).' })).json().code).toBe('FLUX_NON_AUTORISE');
    env.clock.set('2026-11-02T09:00:00.000Z');
    const p = (await env.req('POST', '/v1/pilotage/repartition/propositions', 'u-analyste-rappro', { period: '2026-10', currency: 'USD', reason: 'Répartition d’octobre (test)' })).json();
    const [flux1, flux2] = p.operations;
    expect((await go('instruction', 'u-tresor', { operationId: flux2.id, motif: 'Instruction sur le mauvais flux (test).' })).json().code).toBe('FLUX_NON_AUTORISE');
    expect((await go('instruction', 'u-tresor', { operationId: flux1.id, motif: 'Instruction du règlement par le Flux 1 (test).' })).json().status).toBe('PAIEMENT_INSTRUIT');
    expect((await go('paiement', 'u-tresor', { reference: 'VIR-001 (test)' })).json().code).toBe('FLUX_NON_EXECUTE');
    expect((await env.req('POST', `/v1/tresor/operations/${flux1.id}/approve`, 'u-tresor', {})).json().status).toBe('EXECUTEE');
    expect((await go('paiement', 'u-tresor', { reference: 'VIR-001 (test)' })).json().status).toBe('PAYEE');
    // Tant que le règlement n'est pas rapproché, le droit n'est pas présenté comme réglé.
    ns = (await env.req('GET', `${B}/tableau/groupe-nseya`, 'u-superadmin')).json();
    expect(ns.positionCommerciale[0]).toMatchObject({ regle: money('0.00') });
    expect((await go('rapprochement', 'u-tresor', { reference: 'REL-BANQUE-001' })).statusCode).toBe(403);
    expect((await go('rapprochement', 'u-analyste-rappro', { reference: 'REL-BANQUE-001' })).json().status).toBe('RAPPROCHEE');
    expect((await go('cloture', 'u-tresor', { motif: 'Clôture de la demande (test).' })).json().status).toBe('CLOTUREE');
    ns = (await env.req('GET', `${B}/tableau/groupe-nseya`, 'u-superadmin')).json();
    expect(ns.positionCommerciale[0]).toMatchObject({ droit: money('15.00'), regle: money('15.00'), resteDu: money('0.00') });
    // Circuit des espèces tracé sur la transaction (jamais un agent de terrain).
    const t = (await env.req('GET', `${B}/transactions/${a.id}`, 'u-ministre-finances')).json();
    expect(t.circuitEspeces.map((s: { code: string; fait: boolean }) => [s.code, s.fait]).filter(([c]: [string]) => ['RAPPROCHEMENT', 'REPARTITION', 'PAYABLE_NSEYA', 'DEMANDE', 'APPROBATION', 'PAIEMENT', 'RAPPROCHEMENT_REGLEMENT'].includes(c))).toEqual([
      ['RAPPROCHEMENT', true], ['REPARTITION', true], ['PAYABLE_NSEYA', true], ['DEMANDE', true], ['APPROBATION', true], ['PAIEMENT', true], ['RAPPROCHEMENT_REGLEMENT', true],
    ]);
  });

  it('décision du 29/09/2026 — aucune espèce pour un agent de terrain : refus serveur explicite', async () => {
    const env = await setupMoteur();
    for (const user of ['u-agent-terrain', 'u-superviseur', 'u-guichet']) {
      const r = await env.req('POST', '/api/cash/collections', user, { pointId: 'PA-000001', reference: 'PR-ABCD-EFGH' });
      expect(r.statusCode, user).toBe(403);
      expect(r.json().code).toBe('ESPECES_INTERDITES_AGENT');
      const d = await env.req('POST', '/api/cash/declarations', user, { pointId: 'PA-000001', day: '2026-10-02', counted: [money('10.00')] });
      expect(d.json().code).toBe('ESPECES_INTERDITES_AGENT');
    }
    expect(env.app.ctx.audit.list({ action: 'moteur.especes.refusees_agent' }).items.length).toBeGreaterThanOrEqual(6);
  });
});

describe('§ 4 et § 12 de la spécification v1.0 — deux flux seulement ; fractionnement limité aux deux flux', () => {
  it('fractionnement en temps réel vers un ministère ou un agent : refusé (troisième flux) ; vers les deux flux : exige l’infrastructure approuvée', () => {
    const base = { pool: defaultPool(), couts: { mode: 'AUCUN' as const, fraisGestionPct: null } };
    const withMode = (code: string) => defaultBeneficiaries().map((b) => (b.code === code ? { ...b, modeReglement: 'TEMPS_REEL' as const } : b));
    expect(checkVersionShape({ ...base, beneficiaries: withMode('TUTELLE') }).map((c) => c.code)).toContain('FRACTIONNEMENT_TROISIEME_FLUX');
    expect(checkVersionShape({ ...base, beneficiaries: withMode('AGENTS_SOUS_TRAITANTS') }).map((c) => c.code)).toContain('FRACTIONNEMENT_TROISIEME_FLUX');
    expect(checkVersionShape({ ...base, beneficiaries: withMode('GROUPE_NSEYA') }).map((c) => c.code)).toEqual(['FRACTIONNEMENT_NON_APPROUVE']);
    expect(checkVersionShape({ ...base, beneficiaries: withMode('GROUPE_NSEYA'), fractionnement: { infrastructureApprouvee: 'INFRA-PAY-001 (fictif)' } })).toEqual([]);
    const flux3 = defaultBeneficiaries().map((b) => (b.code === 'TUTELLE' ? { ...b, flow: 'FLUX_1' as const } : b));
    expect(checkVersionShape({ ...base, beneficiaries: flux3 }).map((c) => c.code)).toContain('FLUX_NON_AUTORISE');
  });
});

describe('§ 18 — le super-administrateur ne modifie rien de financier', () => {
  it('saisie de pourcentages PROPOSÉS seulement ; ni vérification, approbation, activation, compte, demande, synchronisation ni tableau financier', async () => {
    const env = await setupMoteur();
    // Administrateur technique R26 seul (le compte de démonstration u-superadmin porte aussi R38 depuis le 29/09/2026).
    env.app.ctx.users.add({ id: 'test-admin-technique', name: 'Administrateur technique (test, R26 seul)', roles: ['R26'], entity: 'PLATEFORME' });
    const p = await env.req('POST', `${B}/regles`, 'test-admin-technique', { label: 'Groupe Nseya à 25 % (test)', beneficiaries: defaultBeneficiaries().map((b) => (b.code === 'GROUPE_NSEYA' ? { ...b, pct: '25' } : b.code === 'GOUVERNEMENT_PROVINCIAL' ? { ...b, pct: '55' } : b)), effectiveFrom: '2026-11-01', legalBasis: 'Aucune (test)', motif: 'Tentative de passer 10 % à 25 % (test).' });
    expect(p.statusCode).toBe(201);
    expect(p.json().status).toBe('PROPOSEE');
    const id = p.json().id;
    const denied = [
      ['POST', `${B}/regles/${id}/verification`, { approve: true, motif: 'Tentative du super-administrateur.' }],
      ['POST', `${B}/regles/${id}/approbation`, { approve: true, motif: 'Tentative du super-administrateur.' }],
      ['POST', `${B}/regles/${id}/activation`, { approve: true, motif: 'Tentative du super-administrateur.' }],
      ['POST', `${B}/comptes-reglement`, { alias: 'GVT-PROV-FLUX2-USD', effectiveFrom: '2026-10-01', motif: 'Tentative du super-administrateur.' }],
      ['POST', `${B}/demandes`, { beneficiary: 'GROUPE_NSEYA', currency: 'USD', motif: 'Tentative du super-administrateur.' }],
      ['POST', `${B}/synchroniser`, {}],
      ['POST', `${B}/couts`, { provider: 'Fournisseur IA (test)', category: 'IA', period: '2026-10', quantity: '1', unitCost: '10', currency: 'USD', fundedBy: 'GROUPE_NSEYA', motif: 'Tentative du super-administrateur.' }],
      ['GET', `${B}/tableau/executif`, undefined],
      ['GET', `${B}/transactions`, undefined],
    ] as const;
    for (const [m, url, body] of denied) expect((await env.req(m, url, 'test-admin-technique', body)).statusCode, `${m} ${url}`).toBe(403);
    const cfg = (await env.req('GET', `${B}/configuration`, 'test-admin-technique')).json();
    expect(cfg.mutationFinanciere).toBe('AUCUNE');
    expect(JSON.stringify(cfg)).not.toMatch(/"amount"/);
    expect(env.svc.versions.get(id)!.status).toBe('PROPOSEE');
    // Compte unique « Groupe Nseya — super-administrateur » (R26 + R38) : lecture complète et démarches pour son propre
    // droit, mais jamais vérifier, approuver ni activer une règle (circuit à quatre personnes distinctes).
    expect((await env.req('GET', `${B}/tableau/executif`, 'u-superadmin')).statusCode).toBe(200);
    expect((await env.req('POST', `${B}/regles/${id}/verification`, 'u-superadmin', { approve: true, motif: 'Tentative du compte Groupe Nseya.' })).statusCode).toBe(403);
    expect((await env.req('POST', `${B}/regles/${id}/activation`, 'u-superadmin', { approve: true, motif: 'Tentative du compte Groupe Nseya.' })).statusCode).toBe(403);
  });
});

describe('§ 2 — compte de règlement principal du Gouvernement', () => {
  it('proposé par le Trésor, vérifié par le coffre, autorisé par le Gouverneur ; le super-administrateur ne le remplace pas', async () => {
    const env = await setupMoteur();
    const seeded = (await env.req('GET', `${B}/comptes-reglement`, 'u-auditeur')).json();
    expect(seeded.items[0]).toMatchObject({ account_reference: 'GVT-PROV-FLUX2-USD', status: 'PROPOSE', demo: true, maskedNumber: '•••• 0840' });
    const id = seeded.items[0].id;
    expect((await env.req('POST', `${B}/comptes-reglement/${id}/autorisation`, 'u-gouverneur', { approve: true, motif: 'Autorisation avant vérification (test).', approvalReference: 'ARR-GOUV-001' })).json().code).toBe('ETAPE_INVALIDE');
    expect((await env.req('POST', `${B}/comptes-reglement/${id}/verification`, 'u-coffre-1', { approve: true, motif: 'Vérification hors bande effectuée (test).' })).json().status).toBe('VERIFIE');
    expect((await env.req('POST', `${B}/comptes-reglement/${id}/autorisation`, 'u-superadmin', { approve: true, motif: 'Tentative du super-administrateur.', approvalReference: 'X-001' })).statusCode).toBe(403);
    const ok = await env.req('POST', `${B}/comptes-reglement/${id}/autorisation`, 'u-gouverneur', { approve: true, motif: 'Désignation du compte principal (test).', approvalReference: 'ARR-GOUV-001 (fictif)' });
    expect(ok.json()).toMatchObject({ status: 'ACTIF', authorised_by: 'u-gouverneur', created_by: 'u-tresor', verified_by: 'u-coffre-1', approval_reference: 'ARR-GOUV-001 (fictif)' });
    expect(env.app.ctx.audit.list({ action: 'moteur.compte_reglement.autorise' }).items).toHaveLength(1);
  });
});
