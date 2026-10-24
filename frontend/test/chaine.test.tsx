import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { SeptQuestionsPanel } from '../src/modules/chaine/SeptQuestions';
import type { Maillon, SeptQuestionsView } from '../src/modules/chaine/types';

const CODES = ['RECENSER', 'IDENTIFIER', 'GEOLOCALISER', 'QUALIFIER', 'CALCULER', 'NOTIFIER', 'PAYER', 'RAPPROCHER', 'QUITTANCER', 'CONTROLER', 'RECOUVRER', 'AUDITER', 'PLANIFIER'];
const LABELS = ['Recenser', 'Identifier', 'Géolocaliser', 'Qualifier', 'Calculer', 'Notifier', 'Payer', 'Rapprocher', 'Quittancer', 'Contrôler', 'Recouvrer', 'Auditer', 'Planifier'];

const maillons: Maillon[] = CODES.map((code, i) => ({
  rang: i + 1, code, label: LABELS[i]!, garde: `Garde ${code}`,
  status: i < 6 ? 'FAIT' : code === 'QUITTANCER' ? 'BLOQUE' : code === 'RECOUVRER' ? 'SANS_OBJET' : 'EN_ATTENTE',
  at: i < 6 ? '2026-09-26T09:00:00.000Z' : null, actor: i < 6 ? { kind: 'system', id: 'moteur-liquidation' } : null,
  auditEventId: i < 6 ? `AUD-0000000${i}` : null, auditSeq: i < 6 ? i : null, chainHash: i < 6 ? 'a'.repeat(64) : null, evidence: [],
  detail: `Détail ${code}`, ...(code === 'QUITTANCER' ? { reason: 'Quittance sans paiement confirmé.', rupture: false } : {}),
}));

const view: SeptQuestionsView = {
  objet: { id: 'OBJ-1', ref: 'KIN-LIM-Q001-P000001', category: 'PARCELLE', categoryLabel: 'Parcelle', commune: 'Limete', quartier: 'Kingabwa', status: 'VALIDE', demo: true },
  access: 'minimal', generatedAt: '2026-09-26T09:00:00.000Z',
  questions: [
    { code: 'QUI', question: 'Qui ?', status: 'MASQUE', answer: 'Compte unique rattaché — nom non communiqué à ce profil.', sources: { taxpayerId: null } },
    { code: 'QUOI', question: 'Quoi ?', status: 'REPONDU', answer: 'Parcelle KIN-LIM-Q001-P000001', sources: { objectId: 'OBJ-1', objectRef: 'KIN-LIM-Q001-P000001' } },
    { code: 'OU', question: 'Où ?', status: 'REPONDU', answer: 'Limete › Kingabwa', sources: { igfCode: 'KIN-LIM-Q001-P000001', precision: { accuracyM: 8, source: 'CONSTAT_TERRAIN' } } },
    { code: 'REGLE', question: 'Quelle règle ?', status: 'REPONDU', answer: 'DEMO-IF-BATI v1 (ACTIVE)', sources: { rules: [{ code: 'DEMO-IF-BATI', version: 1, statusAtLiquidation: 'ACTIVE', legalReferences: [{ id: 'demo-instrument-001', status: 'EN_VIGUEUR' }] }] } },
    { code: 'COMBIEN', question: 'Combien ?', status: 'MASQUE', answer: 'Montant non communiqué à ce profil (accès minimal).', sources: { breakdown: [] } },
    { code: 'PAYE', question: 'Payé ?', status: 'EN_ATTENTE', answer: 'Non payé.', sources: { status: 'NON_PAYE', obligations: [] } },
    { code: 'COMPTE_PUBLIC', question: 'L’argent est-il arrivé sur le compte public et comptabilisé ?', status: 'EN_ATTENTE', answer: 'Aucun paiement confirmé.', sources: { payments: [] } },
  ],
  chaine: { obligationId: 'OBL-1', maillons, complete: false, ruptures: 0 },
  obligations: [{ obligationId: 'OBL-1', label: 'Impôt foncier', status: 'EMISE', current: true, complete: false, ruptures: 0, maillons }],
  hiddenObligations: 0,
};

function mock() {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/objects/OBJ-1/sept-questions')) return Promise.resolve(new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } }));
    return Promise.reject(new TypeError('Failed to fetch'));
  }) as unknown as typeof fetch;
}

describe('Sept questions et chaîne opératoire', () => {
  it('affiche les sept questions, le stepper de treize maillons et le détail du maillon bloqué ; accès minimal signalé', async () => {
    mock();
    render(<AppProvider initialLang="fr"><MemoryRouter><SeptQuestionsPanel objectId="OBJ-1" /></MemoryRouter></AppProvider>);
    expect(await screen.findByText('Les sept questions')).toBeTruthy();
    for (const q of ['Qui ?', 'Quoi ?', 'Où ?', 'Quelle règle ?', 'Combien ?', 'Payé ?', 'L’argent est-il arrivé sur le compte public et comptabilisé ?']) expect(screen.getByText(q)).toBeTruthy();
    expect(screen.getByText('Accès minimal : ni nom ni montant')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Chaîne opératoire en treize maillons' });
    const steps = within(list).getAllByRole('listitem');
    expect(steps).toHaveLength(13);
    // Maillon ouvert par défaut : le premier bloqué, état en texte (jamais la couleur seule).
    const current = steps.find((s) => s.getAttribute('aria-current') === 'step')!;
    expect(within(current).getByText('Quittancer')).toBeTruthy();
    expect(within(current).getByText('Bloqué')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Quittance sans paiement confirmé');
    // Sélection d'un autre maillon : horodatage, événement d'audit et empreinte de chaîne.
    fireEvent.click(within(steps[4]!).getByRole('button'));
    expect(steps[4]!.getAttribute('aria-current')).toBe('step');
    expect(screen.getByText('Détail CALCULER')).toBeTruthy();
    expect(screen.getByText(/AUD-00000004/)).toBeTruthy();
    expect(screen.getByText(/précision ± 8 m \(constat terrain\)/)).toBeTruthy();
  });
});
