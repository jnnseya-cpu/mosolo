import { beforeEach, describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { webcrypto } from 'node:crypto';
import IaRecCard from '../src/modules/ia/IaRecCard';
import { __resetSecureStoreForTests, migrateClearDrafts, openDraft, SEALED_PREFIX, sealDraft } from '../src/modules/ia/secureStore';
import type { IaRec } from '../src/modules/ia/types';
import { renderWithApp } from './helpers';

// jsdom n'expose pas toujours SubtleCrypto : on branche l'implémentation WebCrypto de Node (même API).
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });

describe('Brouillons hors ligne chiffrés (AES-GCM, clé dérivée non exportable)', () => {
  beforeEach(() => { localStorage.clear(); __resetSecureStoreForTests(); });

  it('ne stocke jamais le texte en clair et le restitue au seul utilisateur concerné', async () => {
    const secret = 'Motif confidentiel : surface 135 m² contestée';
    expect(await sealDraft('ia-motif:IAR-1', secret, 'u-superviseur')).toBe(true);
    const raw = localStorage.getItem(SEALED_PREFIX + 'ia-motif:IAR-1')!;
    expect(raw).not.toContain('Motif');
    expect(raw).not.toContain('135');
    expect(JSON.parse(raw)).toMatchObject({ v: 1, alg: 'AES-GCM-256' });
    expect((await openDraft<string>('ia-motif:IAR-1', 'u-superviseur'))?.data).toBe(secret);
    // Autre utilisateur, autre clé ou contenu altéré : indéchiffrable.
    expect(await openDraft('ia-motif:IAR-1', 'u-autre')).toBeNull();
    localStorage.setItem(SEALED_PREFIX + 'ia-motif:IAR-2', raw);
    expect(await openDraft('ia-motif:IAR-2', 'u-superviseur')).toBeNull();
    const env = JSON.parse(raw);
    env.ct = env.ct.slice(0, -4) + (env.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    localStorage.setItem(SEALED_PREFIX + 'ia-motif:IAR-1', JSON.stringify(env));
    expect(await openDraft('ia-motif:IAR-1', 'u-superviseur')).toBeNull();
  });

  it('migre les brouillons historiques en clair vers le stockage chiffré', async () => {
    localStorage.setItem('mosolo.draft.declaration', JSON.stringify({ data: { surface: 120 }, pending: true }));
    expect(await migrateClearDrafts('u-contribuable')).toBe(1);
    expect(localStorage.getItem('mosolo.draft.declaration')).toBeNull();
    expect((await openDraft<{ data: { surface: number } }>('declaration', 'u-contribuable'))?.data.data.surface).toBe(120);
  });
});

const rec: IaRec = {
  id: 'IAR-000001', agentCode: 'INTELLIGENCE_LOCATIVE', agent: 'Intelligence locative', crossAgents: ['Intelligence des données', 'Prédiction'],
  autonomy: 'B_VALIDATION', status: 'EMISE', entity: 'DGIPK', subject: { type: 'object', id: 'OBJ-1' },
  situation: 'Unité OBJ-1 : aucun bail déclaré.', insight: 'Facteurs affichés.', risk: 'Sous-déclaration possible.',
  recommendation: 'Demander au bailleur de déclarer le bail ou la vacance.', nextAction: 'Valider l’envoi (niveau B).', owner: 'R09 — Superviseur terrain',
  deadline: '2026-10-11', confidence: 'MEDIUM', sources: ['Registre des objets fiscaux'],
  actions: [{ id: 'ACT-1', type: 'DEMANDER_PIECES', level: 'B', label: 'Envoyer la demande de pièces au bailleur', params: {}, status: 'PROPOSEE' }],
  citations: [{ domain: 'OBJETS', ref: 'OBJ-1', label: 'Unité OBJ-1' }], factors: [{ label: 'Aucun bail en cours déclaré', weight: '0.40' }],
  example: false, modelVersion: 'regles-deterministes-ia-2.0', promptVersion: 'intelligence_locative-v1-abcdef0123', inputHash: 'a'.repeat(64), outputHash: 'b'.repeat(64),
  purpose: 'Qualifier les unités', requestedBy: 'u-superviseur', createdAt: '2026-09-26T09:00:00Z',
  notice: 'Préparé avec l’assistance de l’IA — sans effet tant qu’un agent habilité ne l’a pas validé.',
  canDecide: true, canValidate: true, canUndo: false, effects: [],
};

describe('IaRecCard', () => {
  it('affiche les 8 rubriques, le niveau B et le bouton de validation ; pas d’acceptation simple', () => {
    renderWithApp(<IaRecCard rec={rec} onChange={() => undefined} />);
    for (const l of ['1. Situation', '2. Analyse', '3. Risque', '4. Recommandation', '5. Prochaine action', '6. Responsable', '7. Échéance', '8. Niveau de confiance']) {
      expect(screen.getByText(l)).toBeTruthy();
    }
    expect(screen.getByText('Niveau B')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Valider et exécuter/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Accepter$/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Rejeter/ })).toBeTruthy();
    expect(screen.getByText(/sans effet tant qu’un agent habilité/)).toBeTruthy();
    expect(screen.getByText('Aucun bail en cours déclaré')).toBeTruthy();
  });
});
