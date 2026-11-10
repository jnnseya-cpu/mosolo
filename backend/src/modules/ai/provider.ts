/**
 * Fournisseur d'intelligence. Le socle livre un fournisseur DÉTERMINISTE à base de règles (aucun appel à un LLM externe) ;
 * un fournisseur fondé sur un modèle pourra implémenter la même interface, derrière la passerelle IA (§ 23.3).
 */
import type { AIRecommendationOutput, AutonomyLevel } from '@mosolo/shared';

export type AIContext = 'governor' | 'rental' | 'treasury' | 'communications';
export const AI_CONTEXTS: AIContext[] = ['governor', 'rental', 'treasury', 'communications'];

/** Vue en LECTURE SEULE des données, fournie à l'agent (aucune méthode d'écriture). */
export interface AIDataSnapshot {
  readonly today: string;
  readonly governor: {
    readonly weakestCommunes: readonly { commune: string; complianceRate: string; collected: string }[];
    readonly reconRateJ1: string;
    readonly overdue: string;
    readonly example: true;
  };
  readonly treasury: { readonly openExceptions: number; readonly missingSettlements: number; readonly confirmedAwaitingSettlement: number };
  readonly rental: { readonly rentableUnits: number; readonly declaredLeases: number; readonly unitsWithoutLease: number; readonly subjectCommune?: string };
  readonly communications: { readonly attempted: number; readonly sandboxLogged: number; readonly channelsWired: number; readonly channelsTotal: number };
}

export interface AIDraft extends AIRecommendationOutput {
  agent: string;
  autonomy: AutonomyLevel;
}

export interface AIProvider {
  readonly modelVersion: string;
  generate(context: AIContext, data: AIDataSnapshot, subjectId?: string): AIDraft[];
}

function addDays(today: string, days: number): string {
  return new Date(new Date(today).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export class DeterministicRuleProvider implements AIProvider {
  readonly modelVersion = 'regles-deterministes-1.0';

  generate(context: AIContext, d: AIDataSnapshot, subjectId?: string): AIDraft[] {
    switch (context) {
      case 'governor':
        return this.governor(d);
      case 'treasury':
        return [this.treasury(d)];
      case 'rental':
        return [this.rental(d, subjectId)];
      case 'communications':
        return [this.communications(d)];
    }
  }

  private governor(d: AIDataSnapshot): AIDraft[] {
    const [w1, w2, w3] = d.governor.weakestCommunes;
    const names = [w1, w2, w3].filter(Boolean).map((c) => c!.commune);
    return [
      {
        agent: 'Aide à la décision exécutive',
        autonomy: 'C_RECOMMANDATION',
        situation: `Taux de conformité le plus faible : ${w1?.commune ?? '—'} (${w1?.complianceRate ?? '—'} %), puis ${names.slice(1).join(' et ')}. [Données EXEMPLE]`,
        insight: 'La base vérifiée y est stable alors que les recouvrements baissent : le problème est la conformité, pas l’assiette.',
        risk: 'Sans action, les arriérés de ces communes continueront de croître et la contestation deviendra plus probable.',
        recommendation: `Autoriser une campagne de régularisation à ${w1?.commune ?? 'la commune la moins conforme'} (information, rappel, échéancier), sans pénalité nouvelle.`,
        nextAction: 'Demander à la DGIPK un plan de campagne chiffré pour validation.',
        owner: 'R05 — Ministre provincial des Finances (décision) ; R06 — DG DGIPK (exécution)',
        deadline: addDays(d.today, 14),
        confidence: 'MEDIUM',
        sources: ['Tableau de bord du Gouverneur (données EXEMPLE)', 'Échelle de la recette — niveaux 4 et 5'],
        decision: {
          bestOption: `Campagne de régularisation ciblée à ${w1?.commune ?? '—'} pendant 60 jours.`,
          alternativeOption: 'Campagne provinciale générale (coût plus élevé, effet dilué).',
          riskOfInaction: 'Hausse des arriérés et perte de confiance dans l’équité du recouvrement.',
          financialImpact: 'Effet estimé non opposable : +4 à +7 % des encaissements de la commune sur le trimestre [EXEMPLE].',
          operationalImpact: '2 équipes terrain et le centre d’appel mobilisés 8 semaines.',
        },
      },
      {
        agent: 'Rapprochement',
        autonomy: 'C_RECOMMANDATION',
        situation: `Taux de rapprochement J−1 : ${d.governor.reconRateJ1} % ; ${d.treasury.openExceptions} exception(s) ouverte(s) dans le système.`,
        insight: 'Les exceptions de règlement proviennent surtout des crédits groupés de prestataires.',
        risk: 'Des confirmations sans crédit au-delà de J+1 exposent la province à un risque de trésorerie.',
        recommendation: 'Exiger des prestataires le fichier de détail quotidien des crédits groupés.',
        nextAction: 'Le Trésor adresse une mise en demeure contractuelle aux prestataires concernés.',
        owner: 'R17 — Comptable public / Trésor',
        deadline: addDays(d.today, 7),
        confidence: 'MEDIUM',
        sources: ['Files d’exceptions de rapprochement', 'Tableau de bord du Gouverneur (données EXEMPLE)'],
        decision: {
          bestOption: 'Fichier de détail obligatoire + pénalités contractuelles.',
          alternativeOption: 'Rapprochement manuel renforcé (plus lent, coûteux).',
          riskOfInaction: 'Accumulation d’exceptions de plus de 30 jours.',
          financialImpact: 'Sécurisation du flux confirmé non encore réglé.',
          operationalImpact: 'Charge des analystes de rapprochement réduite.',
        },
      },
      {
        agent: 'Intelligence locative',
        autonomy: 'C_RECOMMANDATION',
        situation: 'Couverture locative inférieure à 60 % à Limete et Ngaliema malgré un fort poids économique. [Données EXEMPLE]',
        insight: 'Les unités probablement louées sans bail déclaré sont concentrées dans ces deux communes.',
        risk: 'Sous-déclaration persistante de l’impôt sur les revenus locatifs.',
        recommendation: 'Lancer un recensement locatif assisté (invitation à déclarer, puis visite).',
        nextAction: 'Le DG DGIPK valide le plan de mission terrain proposé.',
        owner: 'R06 — Directeur général DGIPK',
        deadline: addDays(d.today, 21),
        confidence: 'LOW',
        sources: ['Couverture locative par commune (données EXEMPLE)'],
        decision: {
          bestOption: 'Invitation à déclarer suivie de visites ciblées.',
          alternativeOption: 'Visites systématiques (coût élevé).',
          riskOfInaction: 'Perte de recettes locatives et iniquité entre bailleurs.',
          financialImpact: 'Non chiffré de façon opposable [EXEMPLE].',
          operationalImpact: 'Missions terrain sur 6 semaines.',
        },
      },
    ];
  }

  private treasury(d: AIDataSnapshot): AIDraft {
    const n = d.treasury.openExceptions + d.treasury.missingSettlements;
    return {
      agent: 'Rapprochement',
      autonomy: 'C_RECOMMANDATION',
      situation: `${d.treasury.openExceptions} exception(s) ouverte(s), ${d.treasury.missingSettlements} règlement(s) manquant(s) à J+1, ${d.treasury.confirmedAwaitingSettlement} paiement(s) confirmé(s) en attente de crédit.`,
      insight: n === 0 ? 'Aucune anomalie de rapprochement.' : 'Les écarts portent sur des références sans crédit ou des crédits sans confirmation.',
      risk: n === 0 ? 'Faible.' : 'Exceptions non traitées au-delà de 5 jours ouvrés : non-conformité au délai cible.',
      recommendation: n === 0 ? 'Maintenir la clôture quotidienne signée.' : 'Traiter les exceptions par ordre d’âge, en quatre yeux au-delà des tolérances.',
      nextAction: n === 0 ? 'Aucune.' : 'Affecter les exceptions aux analystes de rapprochement (R18).',
      owner: 'R17 — Comptable public / Trésor',
      deadline: addDays(d.today, 5),
      confidence: 'HIGH',
      sources: ['Files d’exceptions de rapprochement', 'Grand livre'],
    };
  }

  private rental(d: AIDataSnapshot, subjectId?: string): AIDraft {
    return {
      agent: 'Intelligence locative',
      autonomy: 'B_VALIDATION',
      situation: `${d.rental.rentableUnits} unité(s) louable(s) enregistrée(s), ${d.rental.declaredLeases} bail(aux) déclaré(s)${subjectId ? ` (objet ${subjectId})` : ''}.`,
      insight: `${d.rental.unitsWithoutLease} unité(s) sans bail déclaré : situation d’occupation à qualifier.`,
      risk: 'Sous-déclaration possible ; contestation si la preuve est faible.',
      recommendation: 'Envoyer une invitation à déclarer le bail ou la vacance (pièces justificatives).',
      nextAction: 'Valider l’envoi de la demande de pièces (niveau B : un clic de validation).',
      owner: 'R09 — Superviseur terrain',
      deadline: addDays(d.today, 15),
      confidence: 'MEDIUM',
      sources: ['Registre des objets fiscaux', 'Déclarations de baux'],
    };
  }

  private communications(d: AIDataSnapshot): AIDraft {
    return {
      agent: 'Communication',
      autonomy: 'B_VALIDATION',
      situation: `${d.communications.attempted} envoi(s) tenté(s), dont ${d.communications.sandboxLogged} journalisé(s) en bac à sable ; ${d.communications.channelsWired}/${d.communications.channelsTotal} canaux raccordés.`,
      insight: 'Les canaux sans clé fournisseur fonctionnent en bac à sable : aucun message n’est réellement transmis.',
      risk: 'En production, un avis obligatoire non transmis ne fait pas courir les délais légaux.',
      recommendation: 'Contractualiser et configurer les fournisseurs SMS et courriel avant l’ouverture au public.',
      nextAction: 'Soumettre la configuration des clés fournisseurs au comité des changements.',
      owner: 'R08 — Administrateur d’entité ; R26 — Super-administrateur (configuration technique)',
      deadline: addDays(d.today, 30),
      confidence: 'HIGH',
      sources: ['Journal de délivrance', 'Configuration des canaux'],
    };
  }
}
