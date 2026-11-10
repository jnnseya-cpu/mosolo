import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { apprentissagePlugin, certificationValide } from '../src/plugins/apprentissage/plugin.js';
import type { ApprentissageService } from '../src/plugins/apprentissage/service.js';
import { CIRCUITS } from '../src/plugins/integrite/gouvernance/circuits.js';
import { ALL_PARAMETERS } from '../src/plugins/integrite/gouvernance/parametres.js';
import type { MosoloPlugin } from '../src/plugins/types.js';

async function setupA(plugins?: MosoloPlugin<unknown>[]) {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({
    clock, ...(plugins ? { plugins } : {}),
    secrets: { auditHmacKey: 'test-audit-key', providerSecrets: { 'mm-operator-a': 'test-secret-mm-operator-a' }, commsProviderKeys: {} },
  });
  await app.ready();
  const req = (method: string, url: string, user?: string, body?: unknown) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, req, svc: app.ctx.ext.apprentissage as ApprentissageService };
}

const day = (clock: ManualClock, n: number) => new Date(clock.now().getTime() + n * 86_400_000).toISOString().slice(0, 10);

describe('Apprentissage (§ 24) — micro-apprentissage contextuel et publication à deux personnes', () => {
  it('aide contextuelle publiée en lecture libre, lingala en brouillon, jamais un contenu non publié', async () => {
    const { req } = await setupA();
    const a = await req('GET', '/v1/apprentissage/aide/contribuable.payer');
    expect(a.statusCode).toBe(200);
    expect(a.json().corps).toMatch(/Aucun agent ne peut recevoir d’espèces/);
    expect(a.json().lingala.statut).toBe('BROUILLON');
    expect(a.json().lingalaNote).toMatch(/français fait foi/);
    expect((await req('GET', '/v1/apprentissage/aide/canaux.enrolement')).statusCode).toBe(404);
    expect((await req('GET', '/v1/apprentissage/aide/inconnue.cle')).json().code).toBe('AIDE_INTROUVABLE');
  });

  it('quatre yeux : l’auteur-proposant ne publie pas ; une autre personne publie (circuit de gouvernance)', async () => {
    const { req, svc } = await setupA();
    const c = svc.contenus.findOne((x) => x.cle === 'canaux.enrolement')!;
    const self = await req('POST', `/v1/apprentissage/contenus/${c.id}/publication/decision`, 'u-admin-entite', { approve: true, motif: 'Auto-publication' });
    expect(self.statusCode).toBe(403);
    expect(self.json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await req('POST', `/v1/apprentissage/contenus/${c.id}/publication/decision`, 'u-agent-terrain', { approve: true, motif: 'Sans habilitation' })).statusCode).toBe(403);
    const ok = await req('POST', `/v1/apprentissage/contenus/${c.id}/publication/decision`, 'u-dg-dgipk', { approve: true, motif: 'Relu, conforme' });
    expect(ok.statusCode).toBe(200);
    expect((await req('GET', '/v1/apprentissage/aide/canaux.enrolement')).statusCode).toBe(200);
    // Nouvelle version : brouillon puis proposition ; la version publiée reste en vigueur jusqu'à la décision.
    const v2 = await req('POST', `/v1/apprentissage/contenus/${c.id}/versions`, 'u-superviseur', { titre: 'Enrôler (v2)', corps: 'Texte révisé en français simple.' });
    expect(v2.json().versions).toHaveLength(2);
    await req('POST', `/v1/apprentissage/contenus/${c.id}/publication/propose`, 'u-superviseur');
    expect((await req('GET', '/v1/apprentissage/aide/canaux.enrolement')).json().version).toBe(1);
    await req('POST', `/v1/apprentissage/contenus/${c.id}/publication/decision`, 'u-dg-dgipk', { approve: true, motif: 'Relu, conforme' });
    const pub = svc.contenus.get(c.id)!;
    expect(pub.versions.map((v) => v.statut)).toEqual(['REMPLACEE', 'PUBLIEE']);
    expect(CIRCUITS.some((x) => x.code === 'APPRENTISSAGE_PUBLICATION')).toBe(true);
    // Un module sans épreuve est refusé.
    expect((await req('POST', '/v1/apprentissage/contenus', 'u-superviseur', { type: 'MODULE', cle: 'VIDE', publics: ['RECENSEUR'], titre: 'Module vide', corps: 'Sans épreuve.' })).json().code).toBe('EPREUVE_REQUISE');
  });

  it('espace par rôle : modules sans les bonnes réponses, certification en vigueur, confidentialité documentée', async () => {
    const { req } = await setupA();
    const e = (await req('GET', '/v1/apprentissage/espace', 'u-agent-terrain')).json();
    expect(e.profils.map((p: { profil: string }) => p.profil)).toEqual(['RECENSEUR']);
    expect(e.modules.length).toBeGreaterThan(0);
    expect(JSON.stringify(e.modules)).not.toContain('"bonne"');
    expect(e.certifications[0].valide).toBe(true);
    expect(e.confidentialite.jamais.join(' ')).toMatch(/temps d’écran/);
    const tp = (await req('GET', '/v1/apprentissage/espace', 'u-contribuable')).json();
    expect(tp.profils[0].profil).toBe('CONTRIBUABLE');
    expect(tp.certifications).toEqual([]);
    expect(tp.fiches.some((f: { cle: string }) => f.cle === 'contribuable.recours')).toBe(true);
  });
});

describe('Apprentissage (§ 24) — certification avant affectation', () => {
  it('agent sans certificat : habilitation refusée avec la liste de ce qui manque, puis parcours complet', async () => {
    const { req, svc, clock } = await setupA();
    const hab = { identityVerified: true, trainingCertificateRef: 'CERT-X', trainingValidUntil: day(clock, 200), ethicsSigned: true, module: 'FONCIER_LOCATIF', communes: ['Limete'], validUntil: day(clock, 60) };
    const refused = await req('POST', '/v1/terrain/agents/terrain-st-agent-2/habilitation', 'terrain-resp-module', hab);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe('CERTIFICATION_APPRENTISSAGE_MANQUANTE');
    expect(refused.json().manquants.join(' ')).toMatch(/Aucun certificat/);
    const etat = await req('GET', '/v1/apprentissage/certifications/terrain-st-agent-2?profil=RECENSEUR', 'u-superviseur');
    expect(etat.json().valide).toBe(false);

    const mod = svc.contenus.findOne((c) => c.cle === 'RECENSEMENT-BASE')!;
    const bad = await req('POST', `/v1/apprentissage/modules/${mod.id}/epreuve`, 'terrain-st-agent-2', { reponses: { q1: 0, q2: 1, q3: 0 } });
    expect(bad.json().epreuve.reussie).toBe(false);
    expect(bad.json().note).toMatch(/aucune sanction/);
    const good = await req('POST', `/v1/apprentissage/modules/${mod.id}/epreuve`, 'terrain-st-agent-2', { reponses: { q1: 1, q2: 0, q3: 1 } });
    expect(good.json().epreuve.scorePct).toBe(100);
    // Évaluation pratique encore absente : certification impossible, le manque est nommé.
    const early = await req('POST', '/v1/apprentissage/certificats', 'u-superviseur', { userId: 'terrain-st-agent-2', profil: 'RECENSEUR' });
    expect(early.json().code).toBe('CERTIFICATION_INCOMPLETE');
    expect(early.json().manquants.join(' ')).toMatch(/Vérification pratique/);
    // Nul ne s'évalue lui-même ; un rôle non évaluateur est refusé.
    expect((await req('POST', '/v1/apprentissage/evaluations', 'u-tresor', { userId: 'terrain-st-agent-2', profil: 'RECENSEUR', resultat: 'CONFORME', observations: 'Hors périmètre' })).json().code).toBe('EVALUATEUR_NON_HABILITE');
    expect((await req('POST', '/v1/apprentissage/evaluations', 'u-superviseur', { userId: 'u-superviseur', profil: 'RECENSEUR', resultat: 'CONFORME', observations: 'Soi-même' })).json().code).toBe('SEPARATION_OF_DUTIES');
    expect((await req('POST', '/v1/apprentissage/evaluations', 'u-superviseur', { userId: 'terrain-st-agent-2', profil: 'RECENSEUR', resultat: 'CONFORME', observations: 'Constat réel observé sur place' })).statusCode).toBe(201);
    const cert = await req('POST', '/v1/apprentissage/certificats', 'u-superviseur', { userId: 'terrain-st-agent-2', profil: 'RECENSEUR' });
    expect(cert.statusCode).toBe(201);
    expect(cert.json().valableJusquau).toBe(day(clock, 365));
    const ok = await req('POST', '/v1/terrain/agents/terrain-st-agent-2/habilitation', 'terrain-resp-module', hab);
    expect(ok.json().code).not.toBe('CERTIFICATION_APPRENTISSAGE_MANQUANTE');
    expect(ok.statusCode).toBe(200);
    const mine = (await req('GET', '/v1/apprentissage/mes-certificats', 'terrain-st-agent-2')).json();
    expect(mine[0].enVigueur).toBe(true);
    // Retrait motivé (décision humaine) : la garde retombe et dit pourquoi.
    await req('POST', `/v1/apprentissage/certificats/${cert.json().id}/retrait`, 'u-superviseur', { motif: 'Protocole non respecté, reprise de formation' });
    expect(svc.certificationValide('terrain-st-agent-2', 'RECENSEUR').manquants[0]).toMatch(/retiré/);
  });

  it('agents de démonstration déjà habilités : certificats [EXEMPLE] en vigueur ; certificat expiré signalé ; garde inactive sans le module', async () => {
    const { app, svc, clock } = await setupA();
    for (const id of ['u-agent-terrain', 'terrain-st-agent-1']) expect(certificationValide(app.ctx, id, 'RECENSEUR').valide).toBe(true);
    const c = svc.certificats.get('CERT-DEMO-RECENSEUR-u-agent-terrain')!;
    expect(c.fondement.note).toMatch(/\[EXEMPLE\]/);
    const exp = svc.certificationValide('u-analyste-rappro', 'FINANCES');
    expect(exp.valide).toBe(false);
    expect(exp.manquants[0]).toMatch(/expiré/);
    // Recertification annuelle du contrôleur : échéance puis expiration.
    expect(svc.certificationValide('u-controleur', 'CONTROLEUR').valide).toBe(true);
    clock.advance(30 * 86_400_000);
    expect(svc.certificationValide('u-controleur', 'CONTROLEUR').manquants[0]).toMatch(/recertification annuelle/);
    const bare = await setupA([]);
    expect(certificationValide(bare.app.ctx, 'x', 'RECENSEUR')).toMatchObject({ applicable: false, valide: true });
  });

  it('finances : échantillon d’actes professionnels et seuil de conformité ; cadres : résultats vérifiés cités', async () => {
    const { req } = await setupA();
    const s = await req('GET', '/v1/apprentissage/echantillon/u-analyste-rappro', 'u-tresor');
    expect(s.statusCode).toBe(200);
    expect(s.json().taille).toBe(10);
    const nc = await req('POST', '/v1/apprentissage/evaluations', 'u-tresor', { userId: 'u-analyste-rappro', profil: 'FINANCES', observations: 'Échantillon contrôlé', echantillon: { taille: 10, conformes: 8 } });
    expect(nc.json().resultat).toBe('NON_CONFORME');
    const cf = await req('POST', '/v1/apprentissage/evaluations', 'u-tresor', { userId: 'u-analyste-rappro', profil: 'FINANCES', observations: 'Échantillon contrôlé', echantillon: { taille: 10, conformes: 9 } });
    expect(cf.json().resultat).toBe('CONFORME');
    expect((await req('POST', '/v1/apprentissage/evaluations', 'u-dg-dgipk', { userId: 'u-superviseur', profil: 'CADRE', resultat: 'CONFORME', observations: 'Sans références' })).json().code).toBe('REFERENCES_REQUISES');
    const cadre = await req('POST', '/v1/apprentissage/evaluations', 'u-dg-dgipk', { userId: 'u-superviseur', profil: 'CADRE', resultat: 'CONFORME', observations: 'Résultats vérifiés', references: ['/pilotage/indicateurs'] });
    expect(cadre.statusCode).toBe(201);
    // Confidentialité : aucune mesure d'activité ne peut être transmise.
    const intrusive = await req('POST', '/v1/apprentissage/evaluations', 'u-dg-dgipk', { userId: 'u-superviseur', profil: 'CADRE', resultat: 'CONFORME', observations: 'Mesure', references: ['x'], tempsEcranMinutes: 400 });
    expect(intrusive.statusCode).toBe(400);
  });
});

describe('Apprentissage (§ 24) — compréhension des contribuables et paramètres', () => {
  it('taux de dossiers complets du premier coup ; « non mesuré » sans données ; indicateurs agrégés', async () => {
    const full = await setupA();
    const r = await full.req('GET', '/v1/apprentissage/indicateurs', 'u-dg-dgipk');
    expect(r.statusCode).toBe(200);
    expect(['MESURE', 'NON_MESURE']).toContain(r.json().comprehension.statut);
    expect(r.json().couverture.find((c: { profil: string }) => c.profil === 'RECENSEUR').enVigueur).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(r.json().couverture)).not.toContain('userId');
    expect((await full.req('GET', '/v1/apprentissage/indicateurs', 'u-agent-terrain')).statusCode).toBe(403);
    const seul = await setupA([apprentissagePlugin]);
    const c = seul.svc.comprehension();
    expect(c.statut).toBe('NON_MESURE');
    expect(c.libelle).toBe('non mesuré');
  });

  it('seuils inscrits au registre des seuils (PAR DÉFAUT — à confirmer)', () => {
    const ids = ALL_PARAMETERS.filter((p) => p.category.startsWith('Apprentissage')).map((p) => p.id);
    expect(ids).toContain('apprentissage.epreuve_seuil_pct');
    expect(ids).toContain('apprentissage.validite_certificat_j.controleur');
    expect(ids).toContain('apprentissage.echantillon_conformite_pct');
  });
});
