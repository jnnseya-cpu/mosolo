/**
 * Modules sectoriels « acte requis » (§ 11) — chemin vers l'acte (29/09/2026) : liste de contrôle lue dans les registres
 * existants (points juridiques, règles, fiche du module, titres), actions réservées aux rôles habilités, sortie
 * automatique de « acte requis » quand la règle retenue devient ACTIVE, exemples [EXEMPLE] semés en démonstration
 * seulement ; et « qui doit agir / où » pour chaque maillon en attente de la chaîne opératoire.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ManualClock } from '../src/core/clock.js';
import { PROCHAINE_ACTION } from '../src/plugins/chaine/model.js';
import { DEFAULT_PLUGINS } from '../src/plugins/index.js';
import { etapePointJuridique, etapeRegle, pointsCites } from '../src/plugins/verticales/secteurs-acte.js';
import { SECTEURS_DEMO, VX_DEMO } from '../src/plugins/verticales/seed.js';
import type { RuleRecord } from '../src/modules/rules/service.js';
import { DEMO, publishCertifiedRule, type TestEnv } from './helpers.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

async function env(seed: boolean): Promise<TestEnv> {
  const clock = new ManualClock('2026-09-26T09:00:00.000Z');
  const app = buildApp({ clock, seed, demoExamples: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
  await app.ready();
  const req: TestEnv['req'] = (method, url, user, body, headers = {}) => app.inject({
    method: method as 'GET', url,
    headers: { ...(user ? { 'x-demo-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { app, clock, req };
}

interface Etape { code: string; kind: string; statut: string; action: { label: string; path: string; roles: string[] } | null; automatique?: boolean }
interface Item { module: string; etat: string; counts: { declarations: number; observations: number; references: number }; activite: { label: string; value: number }[]; cheminActe: { etat: string; etapes: Etape[]; prochaine: Etape | null; faites: number; total: number } }
const catalogue = async (e: TestEnv) => (await e.req('GET', '/v1/verticales/secteurs')).json().items as Item[];
const mod = (items: Item[], m: string) => items.find((i) => i.module === m)!;
const etape = (i: Item, code: string) => i.cheminActe.etapes.find((x) => x.code === code)!;

describe('Chemin vers l’acte : correspondance des statuts', () => {
  it('prérequis → points juridiques cités (J1, J3 ; J30), sans doublon', () => {
    expect(pointsCites('J1, J3 — base légale et barème')).toEqual(['J1', 'J3']);
    expect(pointsCites('J30 — cadrage sectoriel et base légale')).toEqual(['J30']);
    expect(pointsCites('Protocole avec le pouvoir central (immatriculations)')).toEqual([]);
  });

  it('point juridique : ouvert → « Enregistrer l’acte » (juristes) ; proposé → « Trancher » (autorité distincte) ; tranché → fait', () => {
    const open = etapePointJuridique('J30', 'J30 — cadrage', undefined, 'Question');
    expect(open).toMatchObject({ statut: 'A_FAIRE', action: { label: 'Enregistrer l’acte', roles: ['R13', 'R14'], path: '/juridique/points?point=J30' } });
    const proposed = etapePointJuridique('J30', 'J30', { statut: 'OUVERT', proposition: { acte: { reference: 'ARR-1' } } }, 'Q');
    expect(proposed).toMatchObject({ statut: 'EN_COURS', action: { label: 'Trancher le point', roles: ['R16', 'R05', 'R01'] } });
    expect(etapePointJuridique('J30', 'J30', { statut: 'TRANCHE', decision: { acte: { reference: 'ARR-1' } } }, 'Q')).toMatchObject({ statut: 'FAIT', action: null });
  });

  it('règle : absente → « Rédiger la règle » (R13) ; visas → prochain visa et son rôle ; publiée → automatique ; ACTIVE → fait', () => {
    expect(etapeRegle(null, null, '2026-09-26')).toMatchObject({ statut: 'A_FAIRE', action: { label: 'Rédiger la règle', roles: ['R13'] } });
    const rule = (status: string, roles: string[]) => ({ code: 'X', version: 1, status, approvals: roles.map((role, i) => ({ role, userId: `u${i}` })), effectiveFrom: '2026-01-01' }) as unknown as RuleRecord;
    expect(etapeRegle('X', rule('REVUE_JURIDIQUE', ['REDACTEUR']), '2026-09-26')).toMatchObject({ statut: 'EN_COURS', action: { roles: ['R14'], path: '/registre?code=X' } });
    expect(etapeRegle('X', rule('REVUE_FINANCIERE', ['REDACTEUR', 'VERIFICATEUR_JURIDIQUE']), '2026-09-26').action?.roles).toEqual(['R15']);
    expect(etapeRegle('X', rule('PUBLIEE', ['REDACTEUR', 'VERIFICATEUR_JURIDIQUE', 'VALIDATEUR_FINANCIER', 'AUTORITE_PUBLICATION']), '2026-09-26')).toMatchObject({ statut: 'EN_COURS', automatique: true, action: null });
    expect(etapeRegle('X', rule('ACTIVE', ['REDACTEUR', 'VERIFICATEUR_JURIDIQUE', 'VALIDATEUR_FINANCIER', 'AUTORITE_PUBLICATION']), '2026-09-26')).toMatchObject({ statut: 'FAIT' });
    expect(etapeRegle('X', rule('SUSPENDUE', []), '2026-09-26')).toMatchObject({ statut: 'BLOQUE', action: { roles: ['R13'] } });
  });
});

describe('Catalogue des modules sectoriels : chemin vers l’acte lu dans les registres', () => {
  it('chaque module « acte requis » porte sa liste de contrôle et sa prochaine étape ; aucun montant', async () => {
    const e = await env(true);
    const items = await catalogue(e);
    expect(items.map((i) => i.module)).toEqual(['11', '13', '16', '17', '21', '22', '23', '24', '25', '56']);
    for (const i of items) {
      expect(i.etat).toBe('ACTE_REQUIS');
      expect(i.cheminActe.etapes.length).toBeGreaterThan(0);
      expect(i.cheminActe.prochaine).not.toBeNull();
      expect(JSON.stringify(i.cheminActe)).not.toMatch(/"amount"/);
    }
    const m13 = mod(items, '13');
    expect(etape(m13, 'J30')).toMatchObject({ kind: 'POINT_JURIDIQUE', statut: 'A_FAIRE', action: { path: '/juridique/points?point=J30' } });
    expect(etape(m13, 'REGLE')).toMatchObject({ statut: 'A_FAIRE', action: { label: 'Rédiger la règle' } });
    expect(etape(m13, 'CONFIGURATION')).toMatchObject({ statut: 'A_FAIRE', action: { label: 'Activer après acte', roles: ['R06'], path: '/verticales/fiches?onglet=configuration&module=13' } });
    // Prérequis sans point juridique rattaché : signalé, jamais inventé.
    expect(mod(items, '11').cheminActe.etapes.some((x) => x.kind === 'PREREQUIS' && x.statut === 'A_QUALIFIER')).toBe(true);
    // Antennes : clé du registre de la verticale (jamais une règle fictive d'une autre verticale).
    expect(etape(mod(items, '16'), 'REGLE').action?.path).toBe('/registre?nouvelle=VX-TEL-SITES');
    // Grands redevables : pas de règle propre (aucun montant) ; conventions J13.
    expect(mod(items, '56').cheminActe.etapes.map((x) => x.code)).toEqual(['J13']);
  });

  it('point tranché par deux personnes, règle publiée par quatre visas, fiche configurée : le module quitte « acte requis » automatiquement', async () => {
    const e = await env(true);
    const acte = { reference: 'ARR-TEST-22', titre: 'Arrêté de test (carrières)', sha256: sha('arr22') };
    expect((await e.req('POST', '/v1/juridique/points/J1/propositions', 'u-juriste-redacteur', { acte, motif: 'Acte publié (test du chemin vers l’acte).' })).statusCode).toBe(201);
    let m22 = mod(await catalogue(e), '22');
    expect(etape(m22, 'J1')).toMatchObject({ statut: 'EN_COURS', action: { label: 'Trancher le point' } });
    expect((await e.req('POST', '/v1/juridique/points/J1/decision', 'u-autorite-publication', { approve: true, motif: 'Acte vérifié (test du chemin vers l’acte).' })).statusCode).toBe(200);
    m22 = mod(await catalogue(e), '22');
    expect(etape(m22, 'J1').statut).toBe('FAIT');

    // Règle rédigée, deux visas : l'étape règle n'est visible qu'une fois retenue par la fiche.
    const { id } = await publishCertifiedRule(e, { code: 'TEST-SEC-CARRIERES', administeringEntity: 'DGTK', beneficiaryAccountAlias: 'KIN-DGTK-RECETTES-01' }, 2);
    const cfg = (ruleCode: string) => e.req('POST', '/v1/verticales/fiches/22/configuration', VX_DEMO.users.director, { ruleCode, actReference: 'ARR-TEST-22', motif: 'Configuration après acte (test).' });
    expect((await e.req('POST', '/v1/verticales/fiches/22/configuration', 'u-contribuable', { ruleCode: 'TEST-SEC-CARRIERES', actReference: 'ARR', motif: 'Tentative non habilitée.' })).statusCode).toBe(403);
    expect((await cfg('TEST-SEC-CARRIERES')).statusCode).toBe(200);
    m22 = mod(await catalogue(e), '22');
    expect(etape(m22, 'REGLE')).toMatchObject({ statut: 'EN_COURS', action: { roles: ['R15'] } });
    expect(etape(m22, 'CONFIGURATION')).toMatchObject({ statut: 'EN_COURS', automatique: true });
    expect(m22.etat).toBe('ACTE_REQUIS');

    // Deux derniers visas : règle ACTIVE (date d'effet passée) → le module quitte « acte requis ».
    for (const [user, role] of [['u-validateur-financier', 'VALIDATEUR_FINANCIER'], ['u-autorite-publication', 'AUTORITE_PUBLICATION']] as const) {
      expect((await e.req('POST', `/v1/legal-rules/${id}/approve`, user, { role })).statusCode).toBe(200);
    }
    m22 = mod(await catalogue(e), '22');
    expect(etape(m22, 'REGLE').statut).toBe('FAIT');
    expect(etape(m22, 'CONFIGURATION').statut).toBe('FAIT');
    expect(m22.etat).toBe('ACTE_EN_VIGUEUR');
    // Les autres modules restent en « acte requis ».
    expect(mod(await catalogue(e), '17').etat).toBe('ACTE_REQUIS');
  });
});

describe('Exemples sectoriels : démonstration seulement', () => {
  it('avec --demo : déclarations, relevés, données tierces et rapprochements [EXEMPLE] ; décisions laissées à une autre personne', async () => {
    const e = await env(true);
    const items = await catalogue(e);
    for (const m of ['17', '22', '23']) expect(mod(items, m).counts.declarations).toBeGreaterThan(0);
    for (const m of ['13', '22', '23', '24', '25']) expect(mod(items, m).counts.observations).toBeGreaterThan(0);
    expect(mod(items, '22').activite[0]!.value).toBeGreaterThan(0);
    const decls = (await e.req('GET', '/v1/verticales/secteurs/declarations', VX_DEMO.users.chief)).json().items as { module: string; status: string; taxpayerId: string; decision?: unknown }[];
    expect(decls.every((d) => d.taxpayerId === SECTEURS_DEMO.taxpayerId && !d.decision)).toBe(true);
    expect(decls.find((d) => d.module === '22')?.status).toBe('ECART_A_INSTRUIRE');
    expect(decls.find((d) => d.module === '17')?.status).toBe('RAPPROCHEE');
    expect(decls.find((d) => d.module === '23')?.status).toBe('DEPOSEE');
    // Le contribuable démo n'est pas touché : il ne voit aucune de ces déclarations.
    expect((await e.req('GET', '/v1/verticales/secteurs/declarations', 'u-contribuable')).json().items).toHaveLength(0);
    expect(e.app.ctx.assessment.obligations.find((o) => o.taxpayerId === SECTEURS_DEMO.taxpayerId)).toHaveLength(0);
    // La décision reste possible pour la cheffe de service (personne distincte du contrôleur qui a rapproché).
    const d22 = e.app.ctx.ext.verticales as { secteurs: { declarations: { find(p: (d: { module: string }) => boolean): { id: string }[] } } };
    const id22 = d22.secteurs.declarations.find((d) => d.module === '22')[0]!.id;
    expect((await e.req('POST', `/v1/verticales/secteurs/declarations/${id22}/decision`, VX_DEMO.users.instructor, { decision: 'OUVRIR_CONTRADICTOIRE', motif: 'Même personne que le rapprochement' })).statusCode).toBe(403);
    expect((await e.req('POST', `/v1/verticales/secteurs/declarations/${id22}/decision`, VX_DEMO.users.chief, { decision: 'OUVRIR_CONTRADICTOIRE', motif: 'Écart défavorable : contradictoire [EXEMPLE]' })).json().status).toBe('EN_CONTRADICTOIRE');
  });

  it('données de démonstration sans demande explicite du point d’entrée : exemples complémentaires non semés', async () => {
    const clock = new ManualClock('2026-09-26T09:00:00.000Z');
    const app = buildApp({ clock, seed: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
    await app.ready();
    expect(app.ctx.demoExamples).toBe(false);
    expect(app.ctx.taxpayers.taxpayers.get(SECTEURS_DEMO.taxpayerId)).toBeUndefined();
    // Sans données de démonstration, la demande est ignorée.
    const prod = buildApp({ clock, seed: false, demoExamples: true, plugins: DEFAULT_PLUGINS, secrets: { auditHmacKey: 'k', providerSecrets: { 'mm-operator-a': 's' }, commsProviderKeys: {} } });
    await prod.ready();
    expect(prod.ctx.demoExamples).toBe(false);
  });

  it('sans --demo (production) : aucun exemple chargé', async () => {
    const e = await env(false);
    const items = await catalogue(e);
    for (const i of items) expect([i.counts.declarations, i.counts.observations, i.counts.references]).toEqual([0, 0, 0]);
    expect(e.app.ctx.taxpayers.taxpayers.get(SECTEURS_DEMO.taxpayerId)).toBeUndefined();
    expect(items.every((i) => i.etat === 'ACTE_REQUIS')).toBe(true);
  });
});

describe('Chaîne opératoire : qui doit agir, où, pour chaque maillon en attente', () => {
  it('chaque maillon a une correspondance « qui / où » ; le maillon n’est jamais accompli depuis la chaîne', () => {
    for (const [code, a] of Object.entries(PROCHAINE_ACTION)) {
      expect(a.qui.length, code).toBeGreaterThan(3);
      expect(a.ou.every((l) => l.path.startsWith('/') && !l.path.startsWith('/chaine')), code).toBe(true);
      expect(a.automatique || a.roles.length > 0, code).toBe(true);
    }
    expect(PROCHAINE_ACTION.PAYER.roles).toEqual(['R30', 'R31']);
    expect(PROCHAINE_ACTION.PAYER.note).toMatch(/jamais.*agent/);
  });

  it('les maillons en attente d’un objet sans obligation portent « à agir » ; les maillons faits n’en portent pas', async () => {
    const e = await env(true);
    const r = await e.req('GET', `/v1/objects/${DEMO.parcelId}/sept-questions`, 'u-contribuable');
    expect(r.statusCode).toBe(200);
    const ms = r.json().chaine.maillons as { code: string; status: string; aAgir?: { qui: string; roles: string[]; ou: { path: string }[] } }[];
    for (const m of ms) {
      if (m.status === 'FAIT' || m.status === 'SANS_OBJET') expect(m.aAgir, m.code).toBeUndefined();
      else expect(m.aAgir?.qui, m.code).toBeTruthy();
    }
    expect(ms.some((m) => m.aAgir)).toBe(true);
  });
});
