/**
 * Parcours de bout en bout d'une verticale (Spécification fonctionnelle des modules, Partie V) : chaque étape renvoie à
 * l'écran réel qui la sert et nomme la route de l'API qui l'exécute. Une verticale n'a ni compte contribuable, ni règle
 * hors registre, ni circuit de paiement propres : le parcours n'est qu'un assemblage lisible des circuits du socle.
 */
import { Link } from 'react-router-dom';
import { Icon } from '../../components/Icon';

export interface EtapeParcours { rang: number; label: string; modules: number[]; ecran: string; route: string; garde?: string }
export interface ParcoursVerticale { nomPartieV: string; finalite: string; modules: number[]; etapes: EtapeParcours[]; reglesPropres: string[] }

export function ParcoursPanel({ parcours }: { parcours: ParcoursVerticale }) {
  return (
    <section className="panel" aria-labelledby="vx-parcours">
      <div className="panel-head">
        <h2 className="panel-title" id="vx-parcours"><Icon name="arrowRight" size={18} /> Parcours de bout en bout</h2>
        <span className="small muted">({parcours.nomPartieV}) · modules {parcours.modules.join(', ')}</span>
      </div>
      <p className="small">{parcours.finalite}</p>
      <ol className="list-rows">
        {parcours.etapes.map((e) => (
          <li key={e.rang} className="list-row">
            <div className="min0">
              <p className="row-title">{e.rang}. {e.label}</p>
              <p className="small muted">Modules {e.modules.join(', ')} · <span className="mono">{e.route}</span></p>
              {e.garde && <p className="small"><Icon name="scale" size={13} /> {e.garde}</p>}
            </div>
            <div className="row-side"><Link className="btn btn-small" to={e.ecran}>Ouvrir l’écran</Link></div>
          </li>
        ))}
      </ol>
      <h3 className="small">Règles propres</h3>
      <ul className="small">{parcours.reglesPropres.map((r) => <li key={r}>{r}</li>)}</ul>
    </section>
  );
}
