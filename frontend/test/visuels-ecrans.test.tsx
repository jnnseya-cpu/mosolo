/**
 * Visuels des écrans généraux, du terrain, de l'apprentissage et des prestataires (27/09/2026) : les graphiques se
 * rendent avec des données, affichent l'état vide sans données, offrent la vue tableau, ne mélangent jamais les devises ;
 * contrôle avant envoi du relevé bancaire du Trésor (plus de refus 400 pour une ligne incomplète).
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import {
  AuditVisuel, CatalogueEvenementsVisuel, EspaceVisuel, etatsDepuis, IaVisuel, RegistreVisuel, ServicesVisuel, TerrainAgentVisuel, TresorVisuel,
} from '../src/pages/visuels';
import { EquipementsVisuel, InspectionVisuel, QualiteVisuel, ReserveVisuel, SupervisionVisuel } from '../src/modules/terrain/visuels';
import { EspaceApprentissageVisuel, IndicateursApprentissageVisuel, MesCertificatsVisuel } from '../src/modules/apprentissage/visuels';
import type { Indicators } from '../src/modules/terrain/types';
import { TimelineStrip } from '../src/components/viz';
import Treasury from '../src/pages/Treasury';

function wrap(ui: ReactElement) {
  globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))) as unknown as typeof fetch;
  return render(<AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>);
}
const cdf = (a: string) => ({ amount: a, currency: 'CDF' as const });
const usd = (a: string) => ({ amount: a, currency: 'USD' as const });
const OBL = { EMISE: { label: 'Émise', tone: 'neutral' as const }, SOLDEE: { label: 'Soldée', tone: 'good' as const } };

describe('etatsDepuis', () => {
  it('garde tous les états déclarés (zéros compris) et ajoute les états inconnus', () => {
    const r = etatsDepuis(OBL, [{ key: 'EMISE', count: 2 }, { key: 'BIZARRE', count: 1 }]);
    expect(r.map((x) => [x.key, x.count])).toEqual([['EMISE', 2], ['SOLDEE', 0], ['BIZARRE', 1]]);
    expect(etatsDepuis(OBL, { EMISE: 1 }, { masquerZeros: true }).map((x) => x.key)).toEqual(['EMISE']);
  });
});

describe('Espace contribuable — visuel', () => {
  it('tuiles par devise (jamais additionnées), états des obligations, biens et vue tableau', () => {
    wrap(<EspaceVisuel p={{
      obligations: [{ id: 'o1', status: 'EMISE', amount: cdf('9000.00'), dueDate: '2026-10-27' }, { id: 'o2', status: 'EMISE', amount: usd('150.00'), dueDate: '2026-10-27' }, { id: 'o3', status: 'SOLDEE', amount: cdf('1000.00') }],
      objects: [{ id: 'b1', commune: 'Limete', probativeStatus: 'VERIFIE' }, { id: 'b2', commune: 'Gombe', probativeStatus: 'DECLARE' }],
      receipts: [{ id: 'r1', status: 'PROVISOIRE' }],
    }} obligationEtats={OBL} recuEtats={{ PROVISOIRE: { label: 'Provisoire', tone: 'warning' } }} probatoire={(s) => s} example />);
    expect(screen.getByRole('article', { name: /Reste dû \(CDF\) : 9\D/ })).toBeTruthy();
    expect(screen.getByRole('article', { name: /Reste dû \(USD\) : 150/ })).toBeTruthy();
    expect(screen.getByRole('article', { name: /Obligations à régler : 2/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /Mes obligations par état : Émise 2/ })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Vue tableau|Tableau/ })[0]!);
    expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
  });
  it('sans données : état vide, aucun zéro trompeur', () => {
    wrap(<EspaceVisuel p={{ obligations: [], objects: [], receipts: [] }} obligationEtats={OBL} recuEtats={{}} probatoire={(s) => s} />);
    expect(screen.getAllByText(/Aucune donnée pour cette période|Aucune échéance ouverte/).length).toBeGreaterThan(0);
    expect(screen.getByRole('article', { name: /Reste dû : 0/ })).toBeTruthy();
  });
});

describe('Trésor, audit, registre, services, IA, catalogue', () => {
  it('Trésor : un graphique de soldes par devise', () => {
    wrap(<TresorVisuel compteLabel={(a) => a.label ?? a.account} bal={{
      balanced: true, entries: 12,
      byCurrency: [{ currency: 'USD', debit: usd('10.00'), credit: usd('10.00'), balanced: true }, { currency: 'CDF', debit: cdf('500.00'), credit: cdf('500.00'), balanced: true }],
      accounts: [{ account: 'A', label: 'Compte public', currency: 'CDF', balance: cdf('500.00') }, { account: 'B', label: 'Recettes', currency: 'USD', balance: usd('-10.00') }],
    }} />);
    expect(screen.getByText('Soldes des comptes — CDF')).toBeTruthy();
    expect(screen.getByText('Soldes des comptes — USD')).toBeTruthy();
    expect(screen.getByRole('article', { name: /Écritures du grand livre : 12 — Équilibré/ })).toBeTruthy();
  });
  it('Audit : domaines, issues, chaîne intacte', () => {
    wrap(<AuditVisuel total={1228} chaine={{ ok: true, length: 1228 }} recours={{ open: 1, overdue: 0, approaching: 0 }}
      events={[{ at: new Date().toISOString(), action: 'titres.type.defined', outcome: 'SUCCESS' }, { at: new Date().toISOString(), action: 'acces.denied', outcome: 'DENIED' }]} />);
    expect(screen.getByRole('article', { name: /Chaîne de hachage : 1\s?228 maillons — Intacte/ })).toBeTruthy();
    expect(screen.getByRole('group', { name: /Issue des opérations : Réussie 1.*Refusée \(contrôle d’accès\) 1/ })).toBeTruthy();
  });
  it('Registre : visas sur 4 et états', () => {
    wrap(<RegistreVisuel etat={(s) => ({ label: s, tone: 'neutral' })} rules={[{ status: 'ACTIVE', approvals: [1, 2, 3, 4], currency: 'USD' }, { status: 'BROUILLON', approvals: [], currency: 'CDF' }]} />);
    expect(screen.getByRole('article', { name: /Règles actives : 1/ })).toBeTruthy();
    expect(screen.getByText('Avancement des visas')).toBeTruthy();
  });
  it('Services : statut juridique ; IA : niveaux d’autonomie ; accueil : catalogue', () => {
    wrap(<>
      <ServicesVisuel legalTone={{ ACTE_REQUIS: 'warning' }} items={[{ slug: 'avia', name: 'AVIA', legal: 'ACTE_REQUIS', legalLabel: 'Acte requis' }]} mine={[]} />
      <IaVisuel recs={[{ agent: 'Communication', autonomy: 'B_VALIDATION' }, { agent: 'Prévision', autonomy: 'C_RECOMMANDATION' }]} />
      <CatalogueEvenementsVisuel events={[{ categorie: 'paiement', obligatoire: true }, { categorie: 'paiement', obligatoire: false }]} categories={[{ code: 'paiement', libelle: 'Paiement' }]} />
    </>);
    expect(screen.getByRole('group', { name: /Services par statut juridique : Acte requis 1/ })).toBeTruthy();
    expect(screen.getByText('Aucun objet ni démarche dans les services')).toBeTruthy();
    expect(screen.getByRole('group', { name: /Par niveau d’autonomie : Niveau B .* 1/ })).toBeTruthy();
    expect(screen.getByText('Catalogue d’événements par catégorie')).toBeTruthy();
  });
  it('Terrain (agent) : missions et file', () => {
    wrap(<TerrainAgentVisuel fileEtats={{ pending: { label: 'En attente', tone: 'warning' } }} file={[{ state: 'pending' }]}
      missions={[{ id: 'M1', title: 'Recensement Limete', status: 'EN_COURS', objectives: { findings: 6 }, progress: { findings: 2, validated: 1, objectivePct: '33.3' } }]} />);
    expect(screen.getByRole('article', { name: /Missions ouvertes : 1/ })).toBeTruthy();
    expect(screen.getByRole('article', { name: /En attente d’envoi : 1/ })).toBeTruthy();
  });
});

describe('Terrain — visuels', () => {
  const ind: Indicators = {
    missions: { total: 3, byStatus: { A_AFFECTER: 1, AFFECTEE: 0, EN_COURS: 2, TERMINEE: 0, ANNULEE: 0 }, overdue: 0 },
    findings: { total: 7, validated: 2, rejected: 0, pending: 5, flaggedPct: '14.3', withPhotoPct: '85.7', byDay: [{ date: '2026-09-26', count: 7 }] },
    byCommune: [{ commune: 'Limete', missions: 2, findings: 7, validated: 2, flagged: 1, objectiveTarget: 26, objectivePct: '26.9', toleranceM: 50 }],
    agents: { total: 6, habilitated: 5, invited: 1, suspended: 0 }, subcontractors: null, badgeVerifications: null, cashHandled: false,
  };
  it('supervision : états des missions, carte des 24 communes (non mesurées hachurées)', () => {
    wrap(<SupervisionVisuel ind={ind} />);
    expect(screen.getByRole('group', { name: /Missions par état : À affecter 1.*En cours 2/ })).toBeTruthy();
    expect(screen.getByText('Atteinte de l’objectif par commune')).toBeTruthy();
    expect(screen.queryByText('Sous-traitants par état')).toBeNull();
  });
  it('inspection, qualité (seuil servi), équipements, réserve', () => {
    wrap(<>
      <InspectionVisuel d={{ constats: { total: 7, soumis: 5, valides: 2, rejetes: 0, horsZone: 1 }, tauxValidation: { valeur: '100 %', revus: 2 }, procesVerbaux: { total: 0, transmis: 0, valides: 0, rejetes: 0, refusDeSigner: 0 }, contestations: { total: 0, traitees: 0 } }} />
      <QualiteVisuel board={{ suspicions: [], rotation: { maxDays: 90, statut: 'PAR_DEFAUT — à confirmer par le maître d’ouvrage', items: [{ name: 'Équipe', commune: 'Limete', days: 10, overdue: false }] }, clawbacks: [{ status: 'PROPOSEE', amount: usd('20.00') }] }} />
      <EquipementsVisuel equipments={[{ state: 'ACTIF', binding: { status: 'A_ATTESTER' } }]} incidents={[]} />
      <ReserveVisuel d={{ mode: 'SIMULATION', points: { verified: 2, pending: 0, reclaimed: 0, suspected: 0, unattached: 0 }, items: [{ status: 'VERIFIE' }], modules: [{ module: 'DEMO', currency: 'USD', distributed: usd('590.00'), undistributed: usd('0.00') }], agents: [{ agentId: 'a', name: 'Agent', byKind: { OBJET_CONFIRME: 1 }, quality: { score: 1, byDefault: true } }] }} />
    </>);
    expect(screen.getByRole('article', { name: /Constats : 7/ })).toBeTruthy();
    expect(screen.getByText(/rotation après 90 jours \(PAR_DEFAUT — à confirmer/)).toBeTruthy();
    expect(screen.getByText('Montants à récupérer — USD')).toBeTruthy();
    expect(screen.getByText('Aucun incident')).toBeTruthy();
    expect(screen.getByRole('article', { name: /Points vérifiés : 2 — Simulation \(acte requis\)/ })).toBeTruthy();
    expect(screen.getByText('Réserve par module — USD')).toBeTruthy();
  });
});

describe('Apprentissage — visuels', () => {
  it('espace : épreuve non passée = non mesuré ; indicateurs ; mes certificats', () => {
    wrap(<>
      <EspaceApprentissageVisuel d={{ profils: [], fiches: [], seuilReussitePct: 80, statutSeuil: 'par défaut — à confirmer', confidentialite: { principe: '', enregistre: [], jamais: [] },
        modules: [{ id: 'M', type: 'MODULE', cle: 'k', publics: [], version: 1, titre: 'Recensement', corps: '', statut: 'PUBLIEE', auteur: 'x', creeLe: '', derniereEpreuve: null }],
        certifications: [{ applicable: true, valide: false, profil: 'RECENSEUR', certificat: null, manquants: ['MODULE'], exigences: [{ code: 'MODULE', libelle: 'Module', satisfaite: false }] }] }} />
      <IndicateursApprentissageVisuel d={{ comprehension: { definition: '', statut: 'NON_MESURE', tauxPct: null, libelle: 'Non mesuré : aucun dossier', examines: 0, completsDuPremierCoup: 0, sources: [], note: '' }, couverture: [{ profil: 'RECENSEUR', libelle: 'Agents recenseurs', mode: 'x', enVigueur: 5, expires: 0, retires: 0, echeanceSous30j: 1 }] }} />
      <MesCertificatsVisuel items={[{ statut: 'DELIVRE', enVigueur: true }]} />
    </>);
    expect(screen.getByRole('article', { name: /Modules réussis : 0/ })).toBeTruthy();
    expect(screen.getByText('Couverture des certificats par public')).toBeTruthy();
    expect(screen.getByRole('group', { name: /Mes certificats par état : En vigueur 1/ })).toBeTruthy();
  });
});

describe('Trésor — contrôle du relevé avant envoi', () => {
  it('une ligne incomplète est signalée sans appel au serveur', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
      return Promise.reject(new TypeError('Failed to fetch'));
    }) as unknown as typeof fetch;
    render(<AppProvider initialLang="fr"><MemoryRouter><Treasury /></MemoryRouter></AppProvider>);
    const form = document.getElementById('st-id')!.closest('form')!;
    fireEvent.submit(form);
    expect(await within(form).findByText(/Relevé incomplet — Ligne 1 : référence de paiement, montant décimal positif/)).toBeTruthy();
    expect(calls.some((c) => c.startsWith('POST') && c.includes('/v1/settlements/statements'))).toBe(false);
  });
});

describe('TimelineStrip — correctif', () => {
  it('sans événement : état vide, pas d’erreur « Invalid time value »', () => {
    wrap(<TimelineStrip title="Échéances" events={[]} emptyText="Aucune échéance ouverte" />);
    expect(screen.getByText('Aucune échéance ouverte')).toBeTruthy();
  });
});
