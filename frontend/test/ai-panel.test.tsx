import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { AIRecommendation } from '@mosolo/shared';
import { AIInsightPanel } from '../src/components/AIInsightPanel';
import { renderWithApp } from './helpers';

const rec: AIRecommendation = {
  id: 'rec-1', agent: 'Agent de pilotage', modelVersion: 'test-1', autonomy: 'C_RECOMMANDATION', createdAt: '2027-02-10T09:15:00Z', status: 'EMISE',
  situation: 'Kalamu à 41 % de sa cible', insight: '62 % des unités sans bail déclaré', risk: '0,9 Md CDF non mobilisé',
  recommendation: 'Campagne SMS ciblée', nextAction: 'Soumettre au DG DGIPK', owner: 'DG DGIPK', deadline: '12 février 2027',
  confidence: 'MEDIUM', sources: ['Registre des objets'],
  decision: { bestOption: 'SMS + guichets', alternativeOption: 'Mission terrain', riskOfInaction: 'Retard consolidé', financialImpact: '0,4 à 0,6 Md CDF', operationalImpact: '4 agents' },
};

describe('AIInsightPanel', () => {
  it('affiche les huit champs du format standard, le bloc de décision et l’avertissement', () => {
    renderWithApp(<AIInsightPanel rec={rec} />);
    for (const label of ['Situation', 'Analyse', 'Risque', 'Recommandation', 'Prochaine action', 'Responsable', 'Échéance', 'Niveau de confiance']) {
      expect(screen.getByText(label, { selector: 'dt' })).toBeTruthy();
    }
    for (const value of [rec.situation, rec.insight, rec.risk, rec.recommendation, rec.nextAction, rec.owner, rec.deadline, 'Moyen']) {
      expect(screen.getByText(value)).toBeTruthy();
    }
    expect(screen.getByText('Meilleure option')).toBeTruthy();
    expect(screen.getByText('Risque de l’inaction')).toBeTruthy();
    expect(screen.getByText(/sans effet tant qu’un agent habilité ne l’a pas validé/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Accepter/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Rejeter/ })).toBeTruthy();
  });
});
