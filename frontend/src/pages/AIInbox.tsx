import { useSearchParams } from 'react-router-dom';
import { useApp } from '../context';
import { PageHead } from '../components/Shell';
import { Icon } from '../components/Icon';
import IaInbox from '../modules/ia/IaInbox';
import IaAgents from '../modules/ia/IaAgents';
import IaAutonomy from '../modules/ia/IaAutonomy';
import IaMemory from '../modules/ia/IaMemory';
import IaJournal from '../modules/ia/IaJournal';
import '../modules/ia/ia.css';

const VIEWS = [
  { id: 'boite', label: 'Boîte de réception', icon: 'analysis' },
  { id: 'agents', label: 'Agents', icon: 'users' },
  { id: 'autonomie', label: 'Autonomie', icon: 'gauge' },
  { id: 'memoire', label: 'Mémoire', icon: 'lock' },
  { id: 'journal', label: 'Journal IA', icon: 'history' },
] as const;
type View = (typeof VIEWS)[number]['id'];

const JOURNAL_ROLES = ['R01', 'R06', 'R08', 'R17', 'R22', 'R23', 'R24', 'R25', 'R29'];

/**
 * Couche d'intelligence (§ 23.5) : boîte de réception par agent et par niveau d'autonomie, catalogue des agents,
 * paramètres d'autonomie par entité, explorateur de la mémoire à quatre niveaux et journal IA.
 * L'IA propose ; un humain habilité décide.
 */
export default function AIInbox() {
  const { user } = useApp();
  const [params, setParams] = useSearchParams();
  const roles = user?.roles ?? [];
  const taxpayer = roles.length > 0 && roles.every((r) => r === 'R30' || r === 'R31');
  const views = VIEWS.filter((v) => {
    if (taxpayer) return v.id === 'boite' || v.id === 'agents' || v.id === 'memoire';
    if (v.id === 'journal') return roles.some((r) => JOURNAL_ROLES.includes(r));
    return true;
  });
  const requested = params.get('vue') as View | null;
  const view: View = requested && views.some((v) => v.id === requested) ? requested : 'boite';
  const go = (v: View) => setParams(v === 'boite' ? {} : { vue: v }, { replace: true });

  return (
    <div className="page page-wide ia-page">
      <PageHead
        eyebrow="Couche d’intelligence"
        title="Recommandations et agents"
        lead="Les agents préparent, résument, détectent et recommandent à partir des données du socle. Le niveau A s’exécute seul (sans effet juridique ni financier), le niveau B attend votre validation, le niveau C n’est jamais exécuté."
      />
      <div className="seg seg-wrap ia-tabs" role="tablist" aria-label="Vues de la couche d’intelligence">
        {views.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={view === v.id} aria-pressed={view === v.id} onClick={() => go(v.id)}>
            <Icon name={v.icon} size={16} /> {v.label}
          </button>
        ))}
      </div>
      {view === 'boite' && <IaInbox />}
      {view === 'agents' && <IaAgents onRan={() => undefined} />}
      {view === 'autonomie' && <IaAutonomy />}
      {view === 'memoire' && <IaMemory />}
      {view === 'journal' && <IaJournal />}
    </div>
  );
}
