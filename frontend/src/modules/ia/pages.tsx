/** Écrans autonomes (liens directs) : paramètres d'autonomie, mémoire, journal IA. */
import { PageHead } from '../../components/Shell';
import IaAutonomy from './IaAutonomy';
import IaJournal from './IaJournal';
import IaMemory from './IaMemory';
import './ia.css';

export function AutonomyPage() {
  return (
    <div className="page page-wide ia-page">
      <PageHead eyebrow="Couche d’intelligence" title="Paramètres d’autonomie" lead="Le responsable de chaque entité active ou désactive l’exécution automatique de niveau A, action par action et agent par agent." />
      <IaAutonomy />
    </div>
  );
}

export function MemoryPage() {
  return (
    <div className="page page-wide ia-page">
      <PageHead eyebrow="Couche d’intelligence" title="Mémoire à quatre niveaux" lead="Ce que la plateforme retient, pourquoi, combien de temps, qui peut le consulter et comment l’effacer." />
      <IaMemory />
    </div>
  );
}

export function JournalPage() {
  return (
    <div className="page page-wide ia-page">
      <PageHead eyebrow="Couche d’intelligence" title="Journal IA" lead="Chaque recommandation : finalité, versions, données citées, empreintes, décision humaine et délai — reconstituable." />
      <IaJournal />
    </div>
  );
}
