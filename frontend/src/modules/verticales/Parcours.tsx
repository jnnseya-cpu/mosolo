/**
 * Parcours de bout en bout d'une verticale (Spécification fonctionnelle des modules, Partie V) : chaque étape renvoie à
 * l'écran réel qui la sert et nomme la route de l'API qui l'exécute. Une verticale n'a ni compte contribuable, ni règle
 * hors registre, ni circuit de paiement propres : le parcours n'est qu'un assemblage lisible des circuits du socle.
 */
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { rolesDeLEcran } from '../../components/DemoRoleSwitch';
import { useApp } from '../../context';

const PUBLICS = ['R30', 'R31', 'R36'];

export interface EtapeParcours { rang: number; label: string; modules: number[]; ecran: string; route: string; garde?: string }
export interface ParcoursVerticale { nomPartieV: string; finalite: string; modules: number[]; etapes: EtapeParcours[]; reglesPropres: string[] }

export function ParcoursPanel({ parcours }: { parcours: ParcoursVerticale }) {
  const { user } = useApp();
  // Compte public : une étape servie par un écran d'agent est décrite (« réalisée par … »), sans lien vers l'outil.
  const publicSeul = !!user && user.roles.every((r) => PUBLICS.includes(r));
  const accessible = (ecran: string) => { const rs = rolesDeLEcran(ecran.split('?')[0]!); return !publicSeul || !rs.length || rs.some((r) => user!.roles.includes(r)); };
  return (
    <section className="panel" aria-labelledby="vx-parcours">
      <div className="panel-head">
        <h2 className="panel-title" id="vx-parcours"><Icon name="arrowRight" size={18} /> Parcours de bout en bout</h2>
        <span className="small muted">({parcours.nomPartieV}) · modules {parcours.modules.join(', ')}</span>
      </div>
      <p className="small">{parcours.finalite}</p>
      <ol className="list-rows vx-parcours">
        {parcours.etapes.map((e) => (
          <li key={e.rang} className="list-row">
            <div className="min0">
              <p className="row-title">{e.rang}. {e.label}</p>
              <p className="small muted">Modules {e.modules.join(', ')} · <span className="mono">{e.route}</span></p>
              {e.garde && <p className="small"><Icon name="scale" size={13} /> {e.garde}</p>}
            </div>
            <div className="row-side">{accessible(e.ecran) ? <Link className="btn btn-small" to={e.ecran}>Ouvrir l’écran</Link> : <span className="small muted">Réalisé par un agent habilité</span>}</div>
          </li>
        ))}
      </ol>
      <h3 className="small">Règles propres</h3>
      <ul className="small">{parcours.reglesPropres.map((r) => <li key={r}>{r}</li>)}</ul>
    </section>
  );
}
