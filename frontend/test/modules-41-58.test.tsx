import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import Commandement from '../src/modules/decision/Commandement';
import { RegieFiscale, RegieTaxes } from '../src/modules/decision/Regies';
import { PrevisionTresorerie, SalleControle, TableauMinistere } from '../src/modules/decision/Finances';
import AuditInvestigation from '../src/modules/decision/AuditInvestigation';
import { Administration, Partenaires, SupervisionSante } from '../src/modules/plateforme/Plateforme';
import Delegations from '../src/modules/acces/Delegations';
import Equipements from '../src/modules/terrain/Equipements';
import GrandsRedevables from '../src/modules/verticales/GrandsRedevables';
import Procedures from '../src/modules/apprentissage/Procedures';
import { RegistreExonerations } from '../src/modules/fiscal/RegistreExonerations';
import { PartsRepartition, SuiviTransparence } from '../src/modules/pilotage/TransparenceComplements';
import { EnveloppesBudget } from '../src/modules/pilotage/EnveloppesBudget';
import { MODULE_ROUTES } from '../src/modules/registry';

type Call = { url: string; method: string; body: unknown };
function mockBackend(user: { id: string; roles: string[]; entity?: string }, routes: Record<string, unknown>) {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined });
    const reply = (b: unknown) => Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } }));
    if (url.includes('/v1/demo/users')) return reply([{ id: user.id, name: `Utilisateur ${user.id} (démo)`, roles: user.roles, entity: user.entity ?? 'DGIPK' }]);
    if (method === 'POST') return reply({ ok: true });
    const hit = Object.entries(routes).sort((a, b) => b[0].length - a[0].length).find(([k]) => url.includes(k));
    if (hit) return reply(hit[1]);
    return Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
  return calls;
}
const renderPage = (ui: ReactElement) => render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
const CDF = (amount: string) => ({ amount, currency: 'CDF' });
const ind = (code: string, label: string, value: string | null, extra: Record<string, unknown> = {}) => ({ code, label, measured: value !== null, value, unit: '', ...(value === null ? { reason: 'Donnée source manquante (test).' } : {}), ...extra });

describe('Pilotage et décision — écrans des modules 41 à 47', () => {
  it('41 : carte de chaleur, alertes, indicateurs (écart non mesuré avec motif) et décision tracée', async () => {
    const calls = mockBackend({ id: 'u-gouverneur', roles: ['R01'] }, {
      '/v1/decision/commandement': {
        generatedAt: '2026-09-26T09:00:00Z', rule: 'Agrégats seulement.', financialEdit: false,
        ladder: { levels: [{ level: 'POTENTIEL', label: 'Potentiel estimé', count: 3, consolidatedCdf: CDF('10') }] },
        heatmap: { dimension: 'commune', metricNote: 'Intensité = rapproché / liquidé', situations: {}, rows: [{ key: 'Limete', obligations: 2, assessedCdf: CDF('100'), reconciledCdf: CDF('40'), overdueCdf: CDF('0'), recoveryPct: '40.0', overduePct: null, coveragePct: '50.0', situations: { PAYE: { count: 1 }, EXIGIBLE: { count: 1 } } }] },
        alerts: { items: [{ family: 'FRAUDE', severity: 'CRITIQUE', code: 'ALERTES_INTEGRITE', title: 'Alertes anti-fraude à examiner', detail: '1 alerte', count: 1, link: '/integrite/enquetes' }], critical: 1, byFamily: [{ family: 'ECARTS', count: 0 }, { family: 'FRAUDE', count: 1 }, { family: 'RETARDS', count: 0 }] },
        indicators: [ind('ECART_ASSIGNATION_RAPPROCHE', 'Écart assignation / rapproché', null), ind('ALERTES_CRITIQUES', 'Alertes critiques', '1')],
        decisions: { instructions: { total: 4 } },
      },
    });
    renderPage(<Commandement />);
    expect(await screen.findByText('Limete')).toBeTruthy();
    expect(screen.getByText('Potentiel estimé')).toBeTruthy();
    expect(screen.getByText('Alertes anti-fraude à examiner')).toBeTruthy();
    expect(screen.getAllByText('Non mesuré').length).toBeGreaterThan(0);
    expect(screen.getByText('Donnée source manquante (test).')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Objet'), { target: { value: 'Recouvrement faible' } });
    fireEvent.change(screen.getByLabelText('Texte'), { target: { value: 'Expliquer le recouvrement faible du trimestre.' } });
    fireEvent.change(screen.getByLabelText('Échéance'), { target: { value: '2026-10-15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Émettre' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/v1/decision/commandement/decisions'))).toBe(true));
  });

  it('42 et 43 : tableaux des régies (recette, commune, campagnes à valider, contentieux, taxes)', async () => {
    mockBackend({ id: 'u-dg-dgipk', roles: ['R06'] }, {
      '/v1/decision/regie-fiscale': {
        entity: 'DGIPK', rule: 'Périmètre de la régie.', indicators: [ind('TAUX_RECOUVREMENT', 'Taux de recouvrement', '50.0'), ind('DELAI_CONTENTIEUX', 'Délai de contentieux', null)],
        assessment: { byRevenue: [{ key: 'DEMO-IF-BATI', obligations: 1, assessed: [CDF('10')], paid: [], reconciled: [] }], byCommune: [{ key: 'Gombe', obligations: 1, assessed: [], paid: [], reconciled: [] }] },
        recovery: { arrears: [{ band: '0-30', count: 1, amounts: [CDF('10')] }], campaigns: [{ id: 'C1', code: 'CAMP-1', label: 'Campagne IF', status: 'LANCEMENT_PROPOSE', period: '2027', dueDate: '2027-02-28', validation: 'A_VALIDER' }], campaignsToValidate: 1, link: '/recouvrement/campagnes' },
        litigation: { open: 1, decided: 0, beyondDelay: 0, decisionDelayDays: 60, byDecision: [] },
        performance: { note: 'Résultats vérifiables.', zones: [{ commune: 'Limete', lots: 1, missions: 2, open: 1, overdue: 0, agents: 1 }], agents: [], teams: [{ team: 'DGIPK (équipe interne)', agents: 2, findings: 3, validated: 2 }], link: '/terrain/supervision' },
      },
      '/v1/decision/regie-taxes': { entity: 'DGTK', rule: 'Compétence DGTK.', indicators: [ind('RENOUVELLEMENTS_A_TEMPS', 'Renouvellements à temps', null)], byTax: [{ code: 'PUBLICITE', label: 'Publicité', obligations: 0, payments: 0, assessed: [], confirmed: [], reconciled: [] }], authorizations: { titres: { total: 1 }, publicite: { granted: 0 } }, controls: { titres: [], stationnement: [{ result: 'VERT', count: 2 }], publicite: [] } },
    });
    const a = renderPage(<RegieFiscale />);
    expect(await screen.findByText('DEMO-IF-BATI')).toBeTruthy();
    expect(screen.getByText('Campagnes (1 à valider)')).toBeTruthy();
    expect(screen.getByText('À valider')).toBeTruthy();
    expect(screen.getByText(/Affecter les zones et suivre les agents/)).toBeTruthy();
    a.unmount();
    renderPage(<RegieTaxes />);
    expect((await screen.findAllByText('Publicité')).length).toBeGreaterThan(0);
    expect(screen.getByText(/VERT 2/)).toBeTruthy();
  });

  it('44 : part de 10 % calculée, versée et reste ; constat proposé par le Trésor', async () => {
    const calls = mockBackend({ id: 'u-tresor', roles: ['R17'] }, {
      '/v1/decision/ministere': {
        entity: 'MIN-TRANSPORTS', entityName: 'Ministère des Transports', rule: 'Filtrage strict.', indicators: [ind('PART_VERSEE', 'Part versée', '1500.00 CDF')],
        modules: [{ moduleId: 'M1', code: 'STAT-DEMO', label: 'Stationnement', status: 'ACTIF', attachedSince: '2026-09-01T00:00:00Z', actReference: 'ARR-1', revenue: { assessed: [], reconciled: [CDF('20000')], payments: 1 }, performance: { obligations: 1, due: 1, paid: 1, paymentRatePct: '100.0', overdue: 0 }, tutelleShare: [CDF('2000')] }],
        share: { mode: 'SIMULATION', pct: '10', notice: 'Simulation — acte requis.', byCurrency: [{ currency: 'CDF', calculated: CDF('2000'), paid: CDF('1500'), remaining: CDF('500') }], versements: [] },
      },
    });
    renderPage(<TableauMinistere />);
    expect(await screen.findByText('STAT-DEMO — Stationnement')).toBeTruthy();
    expect(screen.getByText('Simulation (acte requis)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Période (AAAA-MM)'), { target: { value: '2026-08' } });
    fireEvent.change(screen.getByLabelText('Montant (CDF)'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Référence de l’ordre de paiement'), { target: { value: 'OP-1' } });
    fireEvent.change(screen.getByLabelText('Motif (10 caractères minimum)'), { target: { value: 'Versement du mois d’août' } });
    fireEvent.click(screen.getByRole('button', { name: 'Proposer le constat' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ entity: 'MIN-TRANSPORTS', amount: { amount: '500', currency: 'CDF' } }));
  });

  it('45, 46, 47 : salle de contrôle, audit (racine quotidienne), prévision (hypothèses et écart)', async () => {
    mockBackend({ id: 'u-auditeur', roles: ['R22'] }, {
      '/v1/decision/salle-controle': { rule: 'Aucune correction silencieuse.', indicators: [ind('EXCEPTIONS_OUVERTES', 'Exceptions ouvertes', '2')], settlements: { today: '2026-09-26', confirmed: { count: 1, amounts: [] }, settled: { count: 0, amounts: [] }, reconciled: { count: 0, amounts: [] }, suspense: { count: 1, over48h: 0 } }, exceptions: { open: 2, overdue: 1, slaHours: 48, byType: [] }, incidents: { open: [], closedWithProof: 0, closedWithoutProof: 0 }, sensitiveParameters: [{ code: 'SEUILS', label: 'Registre des seuils', total: 1, last30Days: 1, recent: [] }], escalations: [{ id: 'ESC-1', subjectKind: 'EXCEPTION', subjectId: 'EXC-1', label: 'Exception hors délai', dueAt: '2026-09-25T00:00:00Z', escalatedAt: '2026-09-26T00:00:00Z' }] },
      '/v1/decision/audit/missions': { items: [], populations: { PAIEMENTS: 'Ordres de paiement' }, indicators: [ind('MISSIONS_AUDIT', 'Missions d’audit', '0')], integrity: { ok: true, length: 42, headHash: 'x', note: 'Vérification intégrale.' }, dailyRoots: { available: true, roots: [{ day: '2026-09-25', partial: false, count: 40, merkleRoot: 'a'.repeat(64), timestamped: true, published: true }], lastCheck: { at: '2026-09-26T00:00:00Z', ok: true, findings: 0 }, link: '/integrite/scellement' } },
      '/v1/decision/previsions': { items: [{ id: 'PREV-1', createdAt: '2026-09-26T09:00:00Z', scenario: null, weeks: 6, firstWeek: '2026-09-21', lastWeek: '2026-11-01', sha256: 'b'.repeat(64), lineCount: 2, assignation: 'AUCUNE' }], indicator: ind('ECART_PREVISION_REALISE', 'Réalisé / prévu', null) },
    });
    const a = renderPage(<SalleControle />);
    expect(await screen.findByText('Exception hors délai (EXC-1)')).toBeTruthy();
    expect(screen.getByText('Registre des seuils')).toBeTruthy();
    a.unmount();
    const b = renderPage(<AuditInvestigation />);
    expect(await screen.findByText('Chaîne intègre (42 événements)')).toBeTruthy();
    expect(screen.getByText('2026-09-25')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Créer' })).toBeTruthy();
    b.unmount();
    renderPage(<PrevisionTresorerie />);
    expect(await screen.findByText(/PREV-1/)).toBeTruthy();
    expect(screen.getByText('Taux observés')).toBeTruthy();
  });
});

describe('Plateforme et accès — modules 51 à 55', () => {
  it('52 : registre des interfaces, approbation du protocole, journal des appels hors objet', async () => {
    const calls = mockBackend({ id: 'u-rssi', roles: ['R28'] }, {
      '/v1/plateforme/partenaires': {
        scopes: { 'quittances:verifier': 'Vérifier une quittance' }, kinds: { BANQUE: 'Banque' }, defaults: { tokenTtlSeconds: 3600, quota: { perMinute: 60, perDay: 10000 }, status: 'PAR_DEFAUT' }, delivery: 'JOURNAL',
        contracts: [{ id: 'ITF-1', code: 'ITF-DEMO', partnerName: 'Banque A', partnerKind: 'BANQUE', object: 'Statut des paiements', scopes: ['quittances:verifier'], protocol: { reference: 'PROTO-1', sha256: 'c'.repeat(64), signedAt: '2026-09-01' }, validFrom: '2026-09-01', validTo: '2027-09-01', status: 'PROPOSE', proposedBy: 'u-superadmin' }],
        clients: [], subscriptions: [], deliveries: [],
        calls: [{ id: 'APL-1', at: '2026-09-26T09:00:00Z', clientId: 'cli_1', method: 'GET', route: '/v1/partenaires/api/v1/paiements/:reference', scope: 'paiements:statut', status: 403, outcome: 'HORS_OBJET', latencyMs: 2 }],
        indicators: [ind('APPELS', 'Appels partenaires', '1'), ind('DISPONIBILITE_PARTENAIRES', 'Disponibilité des partenaires', null)],
      },
    });
    renderPage(<Partenaires />);
    expect(await screen.findByText('Proposé — approbation attendue')).toBeTruthy();
    expect(screen.getByText('403 Hors de l’objet contracté (HORS_OBJET)')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Motif \(approbation/), { target: { value: 'Protocole signé vérifié' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approuver' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/contrats/ITF-1/decision'))).toBe(true));
  });

  it('53 et 55 : comité de contrôle des changements ; supervision (RTO, astreinte, incidents)', async () => {
    const calls = mockBackend({ id: 'u-rssi', roles: ['R28'] }, {
      '/v1/plateforme/administration': { environments: [{ id: 'PRODUCTION', label: 'Production', version: '1.0.0', config: {}, history: [] }], changes: [{ id: 'CHG-1', kind: 'DEPLOIEMENT', environment: 'PRODUCTION', version: '1.1.0', motif: 'm', requestedBy: 'u-ing', approvals: [], status: 'DEMANDEE' }], params: { cabQuorum: 2, postDeployWindowHours: 72, status: 'PAR_DEFAUT' }, rule: 'Aucun pouvoir financier.', indicators: [ind('DEPLOIEMENTS_REUSSIS', 'Déploiements réussis', null)] },
      '/v1/plateforme/supervision': { targets: { availabilityPct: '99.9', rtoHours: { PILOTE: 4, MATURITE: 1 }, phase: 'PILOTE', source: 'Cahier § 28.6' }, thresholds: { latencyP95Ms: 2000, windowMinutes: 15, status: 'PAR_DEFAUT' }, window15: { requests: 10, errors5xx: 0, availabilityPct: '100.000', p95Ms: 12 }, routes: [], alerts: [], onCall: [], incidents: [{ id: 'INC-EXP-1', title: 'Paiements lents', service: 'API', severity: 'S2', status: 'DECLARE', detectedAt: '2026-09-26T09:00:00Z' }], procedure: ['1. Déclarer.'], logs: { note: 'Journaux sans secrets.', redacted: ['authorization'] }, metricsEndpoint: 'GET /v1/plateforme/metrics', indicators: [ind('DELAI_RETABLISSEMENT', 'Délai de rétablissement', null, { target: 4 })] },
    });
    const a = renderPage(<Administration />);
    expect(await screen.findByText(/CHG-1 — Déploiement PRODUCTION 1.1.0/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Avis favorable' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/changements/CHG-1/avis'))).toBe(true));
    a.unmount();
    renderPage(<SupervisionSante />);
    expect(await screen.findByText(/INC-EXP-1 — Paiements lents/)).toBeTruthy();
    expect(screen.getByText(/RTO 4 h/)).toBeTruthy();
    expect(screen.getByText(/Journaux sans secrets/)).toBeTruthy();
  });

  it('51 : délégations, détections et décision ABAC expliquée', async () => {
    mockBackend({ id: 'u-rssi', roles: ['R28'] }, {
      '/v1/acces/delegations': { params: { maxDays: 90, nonDelegable: ['R17'], status: 'PAR_DEFAUT' }, rule: 'RBAC + ABAC.', links: { justeATemps: '/acces/elevations', revues: '/integrite/revue-acces', invitations: '/acces/invitations' }, indicators: [ind('ACCES_REVUS', 'Accès revus', null), ind('PRIVILEGES_EXCESSIFS', 'Privilèges excessifs', '1')], delegations: [{ id: 'DEL-1', delegatorId: 'u-a', delegateId: 'u-b', roles: ['R11'], from: '2026-09-26', to: '2026-10-10', motif: 'Congé', status: 'PROPOSEE' }], detections: [{ kind: 'COMPTE_PARTAGE', userId: 'u-tresor', detail: 'Compte utilisé depuis 3 appareils', severity: 'ELEVEE' }] },
      '/v1/acces/abac/explication': { decision: 'REFUSE', checks: [{ attribute: 'TERRITOIRE', ok: false, detail: 'Gombe hors du périmètre.' }] },
    });
    renderPage(<Delegations />);
    expect(await screen.findByText(/DEL-1 — u-a → u-b/)).toBeTruthy();
    expect(screen.getByText('Compte partagé')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approuver' })).toBeTruthy();
  });
});

describe('Recettes spécifiques, terrain, apprentissage — modules 48 à 58', () => {
  it('58 : terminaux (quarantaine, liaison attestée), MDM à raccorder, incidents', async () => {
    mockBackend({ id: 'u-rssi', roles: ['R28'] }, {
      '/v1/equipements': { mdm: { adapter: 'MDM bac à sable (intégré)', external: false, label: 'Outil MDM du fournisseur [À RACCORDER — convention requise]' }, rule: 'Pas de surveillance intrusive.', indicators: [ind('TERMINAUX_ACTIFS', 'Terminaux actifs', '3')], policies: [{ id: 'P@1', code: 'TERRAIN-STANDARD', version: 1, label: 'Standard', screenLockMinutes: 5, minOsVersion: 10, offlineDataTtlDays: 7, status: 'PAR_DEFAUT' }], equipments: [{ id: 'dev-1', userId: 'u-agent', userName: 'Agent', policyCode: 'TERRAIN-STANDARD', policyVersion: 1, model: 'X', os: 'Y', state: 'QUARANTAINE', binding: { status: 'ATTESTEE', attestedAt: '2026-09-26T09:00:00Z' }, lastReport: { verdict: 'MODIFIE', reasons: ['Accès racine.'] }, commands: [] }], incidents: [{ id: 'INC-EQ-1', at: '2026-09-26T09:00:00Z', kind: 'APPAREIL_MODIFIE', detail: 'Accès racine.', deviceId: 'dev-1' }] },
    });
    renderPage(<Equipements />);
    expect(await screen.findByText('QUARANTAINE')).toBeTruthy();
    expect(screen.getByText(/À RACCORDER — convention requise/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Lever la quarantaine' })).toBeTruthy();
  });

  it('56 : portefeuille, rotation due, conventions ; 50 : procédures versionnées ; 57 : registre des exonérations', async () => {
    mockBackend({ id: 'vx-chef-service-dgtk', roles: ['R07'], entity: 'DGTK' }, {
      '/v1/grands-redevables': { portfolio: [{ taxpayerId: 'TP-1', name: 'Brasserie fictive', sectors: [{ code: '17', label: 'Brasseries, boissons, alcools et tabac' }], manager: { id: 'g1', name: 'Gestionnaire 1', since: '2024-01-01', rotation: { dueAt: '2026-01-01', due: true } }, managers: [], conventions: [], revenue: [CDF('10')], overdueObligations: 0, guarantees: [], journal: [] }], withoutManager: 0, rotationsDue: 1, rule: 'Gestionnaire dédié.', params: { managerMaxTenureMonths: 24, status: 'PAR_DEFAUT' }, indicators: [ind('DELAIS_PAIEMENT', 'Délais de paiement', null)] },
      '/v1/apprentissage/procedures': { items: [{ id: 'PROC-1', cle: 'procedure.constat-terrain', publics: ['RECENSEUR'], demo: true, publiee: { version: 2, titre: 'Procédure du constat', corps: 'Texte', publieeLe: '2026-09-26T09:00:00Z' }, historique: [{ version: 1, titre: 'v1', statut: 'REMPLACEE', auteur: 'a', creeLe: '2026-09-20T09:00:00Z' }, { version: 2, titre: 'v2', statut: 'PUBLIEE', auteur: 'a', creeLe: '2026-09-26T09:00:00Z' }] }] },
      '/v1/apprentissage/indicateurs': { indicators: [ind('AGENTS_CERTIFIES', 'Agents certifiés', '5')] },
      '/v1/fiscal/exemptions/registre': { indicators: [ind('EXONERATIONS_ACTIVES', 'Exonérations actives', '1'), ind('ANOMALIES', 'Anomalies', '0')], alerts: [], reminders: [{ id: 'RAP-1', exemptionId: 'EXO-1', kind: 'ECHEANCE_PROCHE', dueDate: '2026-10-15', at: '2026-09-26T09:00:00Z', notified: ['TP-1'] }], upcoming: [{ id: 'EXO-1', kind: 'EXONERATION', effectiveStatus: 'APPROUVEE', validTo: '2026-10-15', reviewDate: '2026-10-15' }], params: { reminderDays: 30, reviewMonths: 12, status: 'PAR_DEFAUT' } },
    });
    const a = renderPage(<GrandsRedevables />);
    expect(await screen.findByText('Brasserie fictive (TP-1)')).toBeTruthy();
    expect(screen.getByText('Rotation due')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Rotation du gestionnaire' })).toBeTruthy();
    a.unmount();
    const b = renderPage(<Procedures />);
    expect(await screen.findByText('Procédure du constat')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lire' }));
    expect(await screen.findByText('REMPLACEE')).toBeTruthy();
    b.unmount();
    renderPage(<RegistreExonerations />);
    expect(await screen.findByText('Échéance proche (2026-10-15)')).toBeTruthy();
  });

  it('54 et 48 : parts de répartition publiques ; suivi des publications ; enveloppes du budget voté', async () => {
    mockBackend({ id: 'u-ministre-finances', roles: ['R05'] }, {
      '/v1/public/transparence/repartition': { period: '2026-T3', mode: 'SIMULATION', notice: 'Simulation.', suppressed: false, threshold: 5, byCategory: [{ code: 'TUTELLE', label: 'Ministère de tutelle du module', pct: '10', amounts: [CDF('100')] }], method: 'Recettes rapprochées.' },
      '/v1/decision/transparence': { indicators: [ind('CONSULTATIONS', 'Consultations publiques', '3')], quarters: [{ period: '2026-T3', due: '2026-11-14', publishedAt: null, onTime: false }], params: { publicationDelayDays: 45, status: 'PAR_DEFAUT' } },
    });
    const a = renderPage(<><PartsRepartition /><SuiviTransparence /></>);
    expect(await screen.findByText('Ministère de tutelle du module')).toBeTruthy();
    expect(await screen.findByText('2026-11-14')).toBeTruthy();
    a.unmount();
    renderPage(<EnveloppesBudget envelopes={[{ id: 'ENV-1', period: '2026', amount: { amount: '100.00', currency: 'USD' }, actReference: 'Édit 2026', label: 'Investissements', status: 'IMPORTEE', importedBy: 'u-autre' }]} indicators={[ind('SCENARIOS_RETENUS', 'Scénarios retenus', '1')]} roles={['R05']} userId="u-ministre-finances" onDone={() => undefined} />);
    expect(await screen.findByRole('button', { name: 'Certifier' })).toBeTruthy();
    expect(screen.getByText('Scénarios retenus')).toBeTruthy();
  });

  it('registre des écrans : chaque module 41 à 58 a une entrée de menu en français', () => {
    const paths = ['/decision/commandement', '/decision/regie-fiscale', '/decision/regie-taxes', '/decision/ministere', '/decision/salle-controle', '/decision/audit', '/decision/previsions', '/acces/delegations', '/plateforme/partenaires', '/plateforme/administration', '/plateforme/supervision', '/grands-redevables', '/terrain/equipements', '/apprentissage/procedures'];
    for (const p of paths) expect(MODULE_ROUTES.find((r) => r.path === p)?.nav?.label, p).toBeTruthy();
    expect(MODULE_ROUTES.find((r) => r.path === '/decision/commandement')!.nav!.label).toBe('Centre de commandement (Command Centre)');
  });
});
