import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppProvider } from '../src/context';
import Collusion, { type CollusionReport } from '../src/modules/integrite/Collusion';
import RegistreSeuils, { type ThresholdRegister } from '../src/modules/integrite/RegistreSeuils';
import SanteCles, { type KeyHealth } from '../src/modules/integrite/SanteCles';

const json = (v: unknown) => Promise.resolve(new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } }));

function mockApi(user: { id: string; roles: string[] }, routes: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url: String(url), ...(init ? { init } : {}) });
    if (String(url).includes('/v1/demo/users')) return json([{ ...user, name: `${user.id} (démo)`, entity: 'AUDIT' }]);
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    if (!hit) return Promise.reject(new TypeError('Failed to fetch'));
    return json(hit[1]);
  }) as unknown as typeof fetch;
  localStorage.removeItem('mosolo.demoUser');
  return calls;
}

const renderApp = (el: JSX.Element) => render(<AppProvider initialLang="fr">{el}</AppProvider>);

const report: CollusionReport = {
  generatedAt: '2026-10-05T09:00:00.000Z',
  params: {
    windowDays: 90, pairShareMinPct: 60, pairDecisionsMin: 5, fastSeconds: 120, fastMinCount: 3, workStartHour: 7, workEndHour: 18,
    offHoursMinCount: 3, neverRefuseMin: 10, rotationEnforced: false, rotationMaxPerPair: 5, rotationWindowDays: 30,
    statut: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage', rotationStatut: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage',
  },
  circuits: [{ code: 'TRESOR_OPERATION', label: 'Opérations financières du Trésor', guarded: true, decisions: 10 }],
  totals: { decisions: 10, approvals: 9, refusals: 1, pairs: 2 },
  pairs: [{ proposerId: 'u-a', approverId: 'u-b', approvals: 9, refusals: 0, sharePct: 90, fast: 4, offHours: 0, inRotationWindow: 9, circuits: ['TRESOR_OPERATION'] }],
  approvers: [{ approverId: 'u-b', decisions: 9, approvals: 9, refusals: 0, fast: 4, offHours: 0, medianDelaySeconds: 900, proposers: 1 }],
  findings: [{
    code: 'PAIRE_CONCENTREE', label: 'Paire proposant → valideur concentrée', severity: 'HIGH', subjects: ['u-a', 'u-b'],
    explanation: 'u-b a pris 9 des 10 décisions sur les propositions de u-a (90 %) en 90 jours.', variables: [{ name: 'Part', value: '90 % (seuil 60 %)' }],
    evidence: ['AUD-00000002'], fingerprint: 'COL:PAIRE:u-a>u-b:2026-10-05',
  }],
  masked: 1,
  rotation: { enforced: false, maxPerPair: 5, windowDays: 30, atLimit: [{ proposerId: 'u-a', approverId: 'u-b', count: 9 }] },
  automaticEffect: 'AUCUN',
  note: 'Signaux à examiner par un humain : ils ne valent ni preuve ni soupçon établi. Aucune sanction automatique.',
};

const register: ThresholdRegister = {
  entries: [
    {
      id: 'canaux.assist_sur_place_m', label: 'Paiement assisté : distance maximale agent ↔ objet fixe', category: 'Géolocalisation', value: 300, defaultValue: 300, unit: 'm',
      owner: 'CODE', source: { file: 'backend/src/plugins/canaux/assisted.ts', constant: 'ASSIST_ON_SITE_M', exported: true },
      status: 'PAR_DEFAUT', statusLabel: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage', pendingRequest: null,
    },
    {
      id: 'sanctions.contre_verification_pct', label: 'Contre-vérification aléatoire des constats retenus', category: 'Contrôles et preuves', value: 5, defaultValue: 5, unit: '%',
      owner: 'CODE', source: { file: 'backend/src/plugins/sanctions/counterchecks.ts', constant: 'COUNTER_CHECK_RATE_PER_10K', exported: true },
      status: 'CONFIRME', statusLabel: 'CONFIRME (acte Arrêté n° 001/2026)', pendingRequest: null,
    },
  ],
  summary: { total: 2, parDefaut: 1, confirmes: 1, modifiesAConfirmer: 0 },
  requests: [{
    id: 'SEUIL-0001', parameterId: 'rotation.blocage_actif', kind: 'MODIFICATION', currentValue: false, proposedValue: true, motif: 'Activation proposée (test).',
    status: 'PROPOSEE', proposedBy: 'u-rssi', proposedAt: '2026-10-05T09:00:00.000Z',
  }],
  note: 'Registre en lecture seule.',
};

const keys: KeyHealth = {
  generatedAt: '2026-10-05T09:00:00.000Z', mode: 'EXPLOITATION',
  keys: [
    { id: 'audit-hmac', purpose: 'Signature HMAC du journal d’audit chaîné et de son ancre', env: 'MOSOLO_AUDIT_HMAC_KEY', kind: 'HMAC', configured: true, fingerprint: 'a1b2c3d4', length: 40, ageDays: 400, since: '2025-09-01',
      warnings: [{ code: 'AGE_DEPASSE', severity: 'ATTENTION', message: 'Clé en service depuis 400 jours.' }] },
    { id: 'clotures', purpose: 'Signature Ed25519 des clôtures et exports du Trésor', env: 'MOSOLO_CLOSURE_SIGNING_KEY', kind: 'ED25519', configured: false, fingerprint: null,
      warnings: [{ code: 'EPHEMERE', severity: 'CRITIQUE', message: 'MOSOLO_CLOSURE_SIGNING_KEY absente : clé générée au démarrage.' }] },
  ],
  summary: { total: 2, configured: 1, critical: 1, attention: 1 },
  note: 'Aucune valeur secrète n’est exposée.',
};

describe('Intégrité — risques résiduels (écrans)', () => {
  it('collusion : signaux explicables, paires et rotation, sans effet automatique ; bouton de détection pour l’audit', async () => {
    mockApi({ id: 'u-auditeur', roles: ['R22'] }, { '/v1/integrite/collusion': report });
    renderApp(<Collusion />);
    expect(await screen.findByText('Paire proposant → valideur concentrée')).toBeTruthy();
    expect(screen.getByText(/9 des 10 décisions/)).toBeTruthy();
    expect(screen.getAllByText('u-a → u-b').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('Alerte seulement')).toBeTruthy();
    expect(screen.getByText(/1 masqué\(s\)/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Lever les alertes/ })).toBeTruthy();
  });

  it('collusion : accès refusé hors audit, anti-fraude, sécurité et direction', async () => {
    mockApi({ id: 'u-guichet', roles: ['R12'] }, {});
    renderApp(<Collusion />);
    expect(await screen.findByText('Accès réservé')).toBeTruthy();
  });

  it('registre : statut par défaut à confirmer, source, demande d’un autre à décider avec motif', async () => {
    const calls = mockApi({ id: 'u-dg-dgipk', roles: ['R06'] }, { '/v1/integrite/thresholds': register });
    renderApp(<RegistreSeuils />);
    expect(await screen.findByText('PAR_DEFAUT — à confirmer par le maître d’ouvrage')).toBeTruthy();
    expect(screen.getByText('CONFIRME (acte Arrêté n° 001/2026)')).toBeTruthy();
    expect(screen.getByText(/backend\/src\/plugins\/canaux\/assisted.ts · ASSIST_ON_SITE_M/)).toBeTruthy();
    const approve = screen.getByRole('button', { name: 'Approuver' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Motif de décision SEUIL-0001'), { target: { value: 'Conforme à la décision du comité.' } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('/v1/integrite/thresholds/change-requests/SEUIL-0001/decision') && c.init?.method === 'POST')).toBe(true));
  });

  it('registre : l’auteur d’une demande ne la décide pas', async () => {
    mockApi({ id: 'u-rssi', roles: ['R28'] }, { '/v1/integrite/thresholds': register });
    renderApp(<RegistreSeuils />);
    expect(await screen.findByText('Décision par une autre personne habilitée.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approuver' })).toBeNull();
  });

  it('santé des clés : empreintes courtes et avertissements, réservé à l’administration et à la sécurité', async () => {
    mockApi({ id: 'u-superadmin', roles: ['R26'] }, { '/v1/integrite/key-health': keys });
    renderApp(<SanteCles />);
    expect(await screen.findByText('a1b2c3d4')).toBeTruthy();
    expect(screen.getByText(/clé générée au démarrage/)).toBeTruthy();
    expect(screen.getByText('Exploitation')).toBeTruthy();
    expect(screen.getByText('400 j')).toBeTruthy();
  });
});
