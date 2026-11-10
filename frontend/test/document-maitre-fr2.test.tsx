/**
 * Écrans ajoutés pour le Document maître FR 2 (nouvelle version, ch. 1 à 17 et 19 à 30) : recours (propriétaire,
 * délai, décision), cycle de vie de l'objet, résiliation du bail, modèle de données et matrice d'habilitations.
 * Gardes d'interface seulement : le serveur reste juge (tests backend correspondants).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { visibleNav } from '../src/components/Shell';
import { AppealDeadlinesPanel, type AppealIndicators } from '../src/components/AppealDeadlinesPanel';
import { AppealCard, type AgentAppeal } from '../src/modules/recouvrement/Recours';
import { LifecyclePanel } from '../src/modules/fiscal/CycleDeVie';
import { LeaseTermination } from '../src/modules/fiscal/AttestationsBail';
import { EntityTable, RoleMatrixTable, type EntityView, type RoleRowView } from '../src/modules/referentiel/ModeleDonnees';
import type { LeaseRow } from '../src/modules/fiscal/types';
import { RentalCoverageTable, type RentalCoverage } from '../src/modules/fiscal/CouvertureLocative';
import { LayersList } from '../src/modules/fiscal/Couches';
import { FieldDeliverySummary, RemiseTerrainForm } from '../src/modules/recouvrement/RemiseTerrain';

afterEach(() => { setDemoUser(null); localStorage.clear(); });
const wrap = (ui: React.ReactElement) => render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);

const indicators: AppealIndicators = {
  asOf: '2026-11-26', open: 2, overdue: 1, approaching: 0, unassigned: 1, decided: 1, decidedLate: 1, decidedWithinDeadlineRate: '0 %',
  byOwner: [{ entity: 'DGIPK', userId: null, open: 1, overdue: 1 }],
  overdueItems: [{ id: 'REC-000001', entity: 'DGIPK', ownerUserId: null, decisionDueBy: '2026-11-25', daysLate: 1, status: 'DEPOSEE' }],
  basis: 'Valeurs de conception — à certifier',
};

const appeal = (over: Partial<AgentAppeal> = {}): AgentAppeal => ({
  id: 'REC-000001', obligationId: 'OBL-1', taxpayerId: 'TP-X', grounds: 'Bien non détenu depuis 2025.', status: 'DEPOSEE', submittedAt: '2026-09-26T09:00:00.000Z',
  type: 'BIEN_NON_DETENU', acknowledgement: { number: 'AR-REC-000001', at: '2026-09-26T09:00:00.000Z', contentHash: 'a'.repeat(64) },
  suspensiveEffect: { status: 'NON_DEMANDE' },
  deadlines: { notifiedOn: '2026-09-26', filingDeadline: '2026-10-26', filedLate: false, decisionDueBy: '2026-11-25', daysRemaining: -1, state: 'DELAI_DEPASSE' },
  owner: { entity: 'DGIPK', assignedAt: '2026-09-26T09:00:00.000Z' },
  history: [{ at: '2026-09-26T09:00:00.000Z', action: 'appeal.submitted', by: 'u-contribuable' }],
  ...over,
});

describe('§ 23 — recours : propriétaire, délai légal, état, décision motivée', () => {
  it('bloc des délais : recours hors délai, sans propriétaire, taux décidé dans le délai', () => {
    wrap(<AppealDeadlinesPanel data={indicators} />);
    expect(screen.getByText('Recours hors délai', { selector: '.kpi-label' })).toBeTruthy();
    expect(screen.getByText('Sans propriétaire nominatif')).toBeTruthy();
    expect(screen.getAllByText(/REC-000001/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/file du service/).length).toBeGreaterThan(0);
  });

  it('carte : la direction affecte, l’agent de contentieux instruit, l’autorité décide (pas celle qui a instruit)', () => {
    const owners = [{ id: 'u-contentieux', name: 'Agent de contentieux', entity: 'DGIPK' }];
    const { unmount } = wrap(<AppealCard a={appeal()} meId="u-dg" roles={['R06']} owners={owners} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: /Affecter/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Instruire/ })).toBeNull();
    expect(screen.getByText(/Délai dépassé/)).toBeTruthy();
    unmount();
    const u2 = wrap(<AppealCard a={appeal()} meId="u-contentieux" roles={['R20']} owners={[]} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: /Instruire/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Affecter/ })).toBeNull();
    u2.unmount();
    const proposed = appeal({ status: 'PROPOSITION', instructorId: 'u-x', proposal: { decision: 'REJETEE', analysis: 'Pièces insuffisantes.', at: '2026-09-27T09:00:00.000Z' } });
    const u3 = wrap(<AppealCard a={proposed} meId="u-decideur" roles={['R21']} owners={[]} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: /Décider/ })).toBeTruthy();
    u3.unmount();
    wrap(<AppealCard a={proposed} meId="u-x" roles={['R21']} owners={[]} onDone={() => {}} />);
    expect(screen.queryByRole('button', { name: /Décider/ })).toBeNull();
    expect(screen.getByText(/Quatre yeux/)).toBeTruthy();
  });

  it('navigation : écran des recours pour la direction, le contentieux et l’audit ; jamais pour le contribuable', () => {
    const has = (roles: string[], to: string) => visibleNav(roles).some((n) => n.to === to);
    for (const r of ['R06', 'R07', 'R20', 'R21', 'R22', 'R23']) expect(has([r], '/recours'), r).toBe(true);
    expect(has(['R30'], '/recours')).toBe(false);
    expect(has(['R10'], '/recours')).toBe(false);
    expect(has(['R22'], '/referentiel/modele-donnees')).toBe(true);
    expect(has(['R30'], '/referentiel/modele-donnees')).toBe(false);
  });
});

describe('§ 30 — cycle de vie de l’objet et du bail', () => {
  const lc = { state: 'ACTIF' as const, label: 'Actif', since: null, motif: null, reason: null, pendingClosureId: null, liquidationAllowed: true };

  it('objet actif : suspendre ou proposer la clôture ; suspendu : lever ; clôture proposée : approbation par une autre personne', () => {
    const a = wrap(<LifecyclePanel objectId="OBJ-1" lifecycle={lc} canAct canApprove={false} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: 'Suspendre' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Proposer la clôture' })).toBeTruthy();
    a.unmount();
    const b = wrap(<LifecyclePanel objectId="OBJ-1" lifecycle={{ ...lc, state: 'SUSPENDU', label: 'Suspendu', since: '2026-09-26T09:00:00.000Z', motif: 'LITIGE_LIMITES', reason: 'Litige de limites', liquidationAllowed: false }} canAct canApprove={false} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: 'Lever la suspension' })).toBeTruthy();
    expect(screen.getByText(/Aucune nouvelle liquidation/)).toBeTruthy();
    b.unmount();
    wrap(<LifecyclePanel objectId="OBJ-1" lifecycle={{ ...lc, pendingClosureId: 'CLO-000001' }} canAct={false} canApprove onDone={() => {}} />);
    expect(screen.getByRole('button', { name: 'Approuver la clôture' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Suspendre' })).toBeNull();
  });

  it('bail : résiliation proposée à la partie ; bail résilié affiché avec sa date et son auteur', () => {
    const lease = { id: 'BAIL-1', role: 'BAILLEUR', unitIgf: 'KIN-LIM-Q001-P000001-U01', commune: 'Limete', quartier: 'Kingabwa', rent: { amount: '100.00', currency: 'USD' }, periodicity: 'MENSUELLE', start: '2026-01-01', end: null, probativeStatus: 'DECLARE', attestation: null } as LeaseRow;
    const a = wrap(<LeaseTermination l={lease} onDone={() => {}} />);
    expect(screen.getByRole('button', { name: 'Résilier le bail' })).toBeTruthy();
    a.unmount();
    wrap(<LeaseTermination l={{ ...lease, state: 'RESILIE', termination: { endDate: '2026-09-30', reason: 'Départ du locataire', by: 'u-contribuable', byRole: 'BAILLEUR', at: '2026-09-26T09:00:00.000Z' } }} onDone={() => {}} />);
    expect(screen.getByText(/Bail résilié/)).toBeTruthy();
    expect(screen.getByText(/par le bailleur/)).toBeTruthy();
  });
});

describe('§ 30 et § 12 — modèle de données et matrice d’habilitations', () => {
  it('cycle de vie du Cahier rapproché des états du code, avec effectifs ; écart de matrice signalé', () => {
    const entities: EntityView[] = [{
      code: 'OBJET_FISCAL', entity: 'ObjetFiscal', purpose: 'Toute chose imposable', relations: '', confidentiality: 'Fiscal',
      cahierLifecycle: [{ cahier: 'provisoire', platform: ['PROVISOIRE'] }, { cahier: 'clos', platform: ['CLOS'] }],
      platformStates: ['PROVISOIRE', 'ACTIF', 'SUSPENDU', 'CLOS'], source: 'backend/src/modules/objects/service.ts', audit: [], retention: 'à confirmer',
      counts: { provisoire: 3, clos: 1 }, total: 4,
    }];
    const a = wrap(<EntityTable entities={entities} />);
    expect(screen.getAllByText('ObjetFiscal').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/· 3/).length).toBeGreaterThan(0);
    a.unmount();
    const rows: RoleRowView[] = [
      { cahierRole: 'Gouverneur', platformRoles: ['R01'], sees: 'Vision consolidée', can: 'Arbitrer', never: 'Changer un compte bénéficiaire', forbidden: [{ action: 'beneficiary.approve', label: '' }], checks: [{ role: 'R01', allowedOk: true, forbiddenBreaches: [], structuralBreaches: [] }], ok: true },
      { cahierRole: 'Enquêteur anti-fraude', platformRoles: ['R24'], sees: 'Alertes', can: 'Instruire', never: 'Sanctionner', forbidden: [{ action: 'integrite:case.decide', label: '' }], checks: [{ role: 'R24', allowedOk: true, forbiddenBreaches: ['integrite:case.decide'], structuralBreaches: [] }], ok: false },
    ];
    wrap(<RoleMatrixTable rows={rows} />);
    expect(screen.getAllByText('Conforme').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Écart : integrite:case.decide/).length).toBeGreaterThan(0);
  });
});

describe('§ 16.6 — couverture locative', () => {
  it('par zone : effectifs, occupation, parties, valeur par devise, estimation non mesurée ; accès minimal sans montant', () => {
    const row = {
      level: 'QUARTIER' as const, commune: 'Limete', quartier: 'Kingabwa', avenue: null,
      estimated: { parcels: null, units: null, status: 'NON_MESURE', note: 'Aucun modèle' },
      registered: { parcels: 2, buildings: 1, units: 3, validated: 2 },
      occupancy: { ownerOccupied: 1, leased: 2, vacant: 0, undeclared: 0, ownerOccupiedPct: 33.3, leasedPct: 66.7 },
      parties: { lessors: 1, tenants: 2 }, leases: { active: 2, verified: 0, terminated: 0, contested: 0 },
      declaredRentalValue: { USD: '5400.00' }, verifiedRentalValue: {},
      legallyTaxableBase: { status: 'NON_CALCULABLE', note: 'Aucune règle IRL ACTIVE' },
      obligations: { paid: 1, unpaid: 1, overdue: 0, paidAmount: { USD: '10.00' }, unpaidAmount: { USD: '20.00' } },
      concentrationPct: 100, census: { coverageRate: null, status: 'NON_MESURE', validationRate: 66.7 },
    };
    const data: RentalCoverage = { asOf: '2026-09-26', level: 'QUARTIER', access: 'full', rows: [row], notice: 'Agrégats sans donnée nominative.' };
    const a = wrap(<RentalCoverageTable data={data} />);
    expect(screen.getByText('Limete › Kingabwa')).toBeTruthy();
    expect(screen.getByText(/5400.00 USD/)).toBeTruthy();
    expect(screen.getByText(/Aucune règle IRL ACTIVE/)).toBeTruthy();
    expect(screen.getAllByText(/non mesuré/).length).toBeGreaterThan(0);
    a.unmount();
    wrap(<RentalCoverageTable data={{ ...data, access: 'minimal', rows: [{ ...row, declaredRentalValue: null, verifiedRentalValue: null, obligations: { ...row.obligations, paidAmount: null, unpaidAmount: null } }] }} />);
    expect(screen.getByText('masqué')).toBeTruthy();
    expect(screen.queryByText(/5400/)).toBeNull();
  });
});

describe('§ 17.1 — couches du cadastre fiscal', () => {
  it('liste les couches avec leur statut (jamais la couleur seule), leur source et leur effectif', () => {
    wrap(<LayersList layers={[
      { code: 'PARCELLES', label: 'Parcelles', status: 'DISPONIBLE', count: 12, source: 'Objets fiscaux', served: 'GET /v1/fiscal/map' },
      { code: 'POTENTIEL', label: 'Potentiel estimé', status: 'NON_MESURE', count: null, source: 'Modèle', served: '—', note: 'jamais inventé' },
      { code: 'PORTS', label: 'Ports et points d’embarquement', status: 'NON_DISPONIBLE', count: null, source: 'Verticale Ports', served: '—' },
    ]} />);
    expect(screen.getByText('Disponible')).toBeTruthy();
    expect(screen.getByText('Non mesuré')).toBeTruthy();
    expect(screen.getByText('Non disponible')).toBeTruthy();
    expect(screen.getByText(/· 12/)).toBeTruthy();
    expect(screen.getByText(/jamais inventé/)).toBeTruthy();
  });
});

describe('§ 15.2 — remise d’un avis formel sur le terrain', () => {
  it('formulaire : signature (empreinte seule) ou refus consigné ; résumé de la remise enregistrée', () => {
    const a = wrap(<RemiseTerrainForm noticeId="AF-2026-000001" onDone={() => {}} />);
    expect(screen.getByRole('button', { name: 'Signature recueillie' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refus de signer' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Enregistrer la remise' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Aucun paiement n’est reçu/)).toBeTruthy();
    a.unmount();
    wrap(<FieldDeliverySummary d={{ by: 'u-controleur', at: '2026-09-26T09:00:00.000Z', outcome: 'REFUS', refusalNote: 'Refus de signer', witness: 'Chef de quartier', position: { lat: -4.37, lon: 15.34 }, legalStatus: 'A_VERIFIER' }} />);
    expect(screen.getByText(/refus enregistré — Refus de signer/)).toBeTruthy();
    expect(screen.getByText(/valeur probante à vérifier/)).toBeTruthy();
  });
});
