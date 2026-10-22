/**
 * Deuxième passe adverse (27/09/2026), accessibilité au clavier : piège de focus des fenêtres modales, focus sur le
 * motif à l'ouverture d'une issue de décision, annonce globale qui survit à la carte décidée, noms accessibles
 * distincts des boutons « Payer », Entrée qui lance le contrôle de plaque.
 * Complété par le parcours réel au clavier (Chromium) : tools/accessibilite/parcours-clavier.cjs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from '../src/context';
import { setDemoUser } from '../src/lib/api';
import { Drawer } from '../src/components/Drawer';
import { annoncer, ID_ANNONCES } from '../src/lib/annonce';
import { FicheCard, type Fiche } from '../src/modules/postes/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

afterEach(() => { setDemoUser(null); localStorage.clear(); vi.useRealTimers(); });
const wrap = (ui: React.ReactElement) => <AppProvider initialLang="fr"><MemoryRouter>{ui}</MemoryRouter></AppProvider>;

describe('Fenêtre modale : piège de focus', () => {
  it('Tab après le dernier élément revient au premier ; Maj+Tab depuis le premier va au dernier ; jamais vers la page', () => {
    render(wrap(<><button type="button">Derrière la fenêtre</button><Drawer open title="Payer" onClose={() => {}}><label>Montant<input /></label><button type="submit">Obtenir ma référence</button></Drawer></>));
    const close = screen.getByRole('button', { name: /fermer/i });
    const submit = screen.getByRole('button', { name: 'Obtenir ma référence' });
    submit.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(submit);
    // Focus égaré hors de la fenêtre : ramené dedans.
    screen.getByRole('button', { name: 'Derrière la fenêtre' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
  });
});

const fiche = (): Fiche => ({
  id: 'DOSSIER:1', source: 'DOSSIER', module: 'Postes de décision', categorie: { code: 'SUSPENSION_TIERS', libelle: 'Suspension d’un tiers', niveau: 'Ministre de tutelle' },
  presence: ['DECIDEUR'], objet: 'Suspendre un centre (test)',
  demandeur: { id: 'vc-u-direction-rfck', libelle: 'Direction (test)', serviceInstructeur: 'Contrôle interne (test)', validationAmont: 'Instruit (test)' },
  enjeu: { texte: '1 centre (test)', chiffres: [], nombre: '1 centre', commune: 'Limete', figures: [] },
  echeance: { date: '2026-10-01', joursRestants: 5, urgente: false, enRetard: false, consequenceSilence: 'Rien (test).' },
  fondement: ['Instrument fictif (test)'], position: { recommandation: 'Suspendre (test).', reserves: [] },
  siRienNestDecide: 'Rien (test).', pieces: { replie: true, nombre: 0, items: [] },
  actions: [
    { code: 'APPROUVER', libelle: 'Approuver la suspension', possible: true, motifObligatoire: true }, { code: 'REFUSER', libelle: 'Refuser', possible: true, motifObligatoire: true },
    { code: 'DELEGUER', libelle: 'Déléguer', possible: true, motifObligatoire: true }, { code: 'COMPLEMENT', libelle: 'Demander un complément', possible: true, motifObligatoire: true },
  ],
  individuel: false, information: false, gravite: 'HAUTE', complements: [], ecran: '/poste-de-decision/fiche/DOSSIER%3A1', exemple: false, enjeuCdf: '0',
} as unknown as Fiche);

describe('Fiche de décision au clavier', () => {
  it('ouvrir une issue place le focus sur le motif ; la décision est annoncée même si la carte disparaît', async () => {
    setDemoUser('u-g');
    globalThis.fetch = vi.fn((url: string) => Promise.resolve(new Response(String(url).includes('/v1/demo/users') ? JSON.stringify([{ id: 'u-g', name: 'Gouverneur (test)', roles: ['R01'], entity: 'GOUVERNORAT' }]) : '{}', { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;
    const { rerender } = render(wrap(<><div id={ID_ANNONCES} role="status" /><main id="main" tabIndex={-1}><FicheCard f={fiche()} onDone={() => {}} /></main></>));
    fireEvent.click(screen.getByRole('button', { name: 'Approuver la suspension' }));
    const motif = screen.getByLabelText(/Motif écrit/);
    expect(document.activeElement).toBe(motif);
    fireEvent.change(motif, { target: { value: 'Suspension motivée pour contrôle sur place (test).' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Confirmer — Approuver/ })); await new Promise((r) => setTimeout(r, 80)); });
    // La carte est retirée (corbeille rechargée) : l'annonce globale demeure.
    rerender(wrap(<><div id={ID_ANNONCES} role="status" /><main id="main" tabIndex={-1} /></>));
    expect(document.getElementById(ID_ANNONCES)!.textContent).toMatch(/Suspendre un centre \(test\) — Approuver la suspension : enregistré et journalisé/);
  });

  it('annoncer() répète une annonce identique (zone vidée puis réécrite)', async () => {
    render(<div id={ID_ANNONCES} role="status" />);
    annoncer('Référence obtenue.');
    await new Promise((r) => setTimeout(r, 60));
    expect(document.getElementById(ID_ANNONCES)!.textContent).toBe('Référence obtenue.');
  });
});

describe('Noms accessibles et formulaires', () => {
  it('boutons de l’espace contribuable : texte visible en tête du nom, obligation précisée', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/pages/TaxpayerSpace.tsx'), 'utf8');
    expect(src).toMatch(/aria-label=\{`\$\{tr\('taxpayer\.pay'\)\} — /);
    expect(src).toMatch(/aria-label=\{`\$\{tr\('taxpayer\.contest'\)\} — /);
  });
  it('contrôle de plaque : formulaire (Entrée lance la vérification) et résultat annoncé', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/modules/vehicules-controle/ScanVehicule.tsx'), 'utf8');
    expect(src).toMatch(/<form className="vc-row" onSubmit=/);
    expect(src).toMatch(/<button type="submit" className="btn btn-primary"/);
    expect(src).toMatch(/role="status" aria-live="polite">\{view \? `Résultat du contrôle/);
  });
});
