/**
 * Parcours de bout en bout d'une verticale (Spécification fonctionnelle des modules, Partie V) : chaque étape renvoie à
 * l'écran réel qui la sert et nomme la route de l'API qui l'exécute. Une verticale n'a ni compte contribuable, ni règle
 * hors registre, ni circuit de paiement propres : le parcours n'est qu'un assemblage lisible des circuits du socle.
 */
import { Link, useLocation } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { rolesDeLEcran } from '../../components/DemoRoleSwitch';
import { realisePar, useEcranAccessible } from '../../components/LienEcran';
import { useApp } from '../../context';

const PUBLICS = ['R30', 'R31', 'R36'];

/**
 * Étape servie par la page déjà ouverte (30/09/2026 : « Ouvrir l'écran » ne faisait rien, le lien menant à la même
 * page) : le bouton descend jusqu'à la section de l'étape. Sections candidates par mots de l'intitulé, puis repli.
 */
const SECTIONS: [RegExp, string[]][] = [
  [/billetterie|billet/i, ['vx-tix']],
  [/étal|etal/i, ['vx-stalls', 'vx-svc']],
  [/certificat|autorisations? (et|délivr)|patente/i, ['vx-certs', 'vx-svc']],
  [/paiement|payer|vignette|taxe|obligations|liquidation|reversement/i, ['vx-due', 'vx-svc']],
  [/demande|renouvel|enregistr|déclar|manifeste|import|registre|plan|géoréf|achat/i, ['vx-svc', 'vx-cases']],
];
const REPLI = ['vx-svc', 'vx-cases', 'vx-obj', 'vx-due'];
function allerALaSection(label: string) {
  const ids = [...(SECTIONS.find(([re]) => re.test(label))?.[1] ?? []), ...REPLI];
  const el = ids.map((id) => document.getElementById(id)).find((x): x is HTMLElement => !!x);
  const cible = (el?.closest('section') as HTMLElement | null) ?? el;
  if (!cible) return;
  cible.scrollIntoView({ behavior: 'smooth', block: 'start' });
  cible.classList.add('vx-surligne');
  window.setTimeout(() => cible.classList.remove('vx-surligne'), 2000);
}
/** Écrans de contrôle remplacés, pour l'usager, par son propre écran (§ I.41-42 : l'usager ne vérifie rien). */
const ECRAN_USAGER: Record<string, { to: string; label: string }> = {
  '/verifier-plaque': { to: '/mes-preuves', label: 'Mes preuves (QR à montrer)' },
};

export interface EtapeParcours { rang: number; label: string; modules: number[]; ecran: string; route: string; garde?: string }
export interface ParcoursVerticale { nomPartieV: string; finalite: string; modules: number[]; etapes: EtapeParcours[]; reglesPropres: string[] }

export function ParcoursPanel({ parcours }: { parcours: ParcoursVerticale }) {
  const { user } = useApp();
  const loc = useLocation();
  // Compte public : une étape servie par un écran d'agent est décrite (« réalisée par … »), sans lien vers l'outil.
  const publicSeul = !!user && user.roles.every((r) => PUBLICS.includes(r));
  // Parcours par rôle (29/09/2026) : règle généralisée à tous les comptes (components/LienEcran.tsx) ; la règle
  // d'origine des comptes publics reste appliquée en premier.
  const utilisable = useEcranAccessible();
  const accessible = (ecran: string) => { const rs = rolesDeLEcran(ecran.split('?')[0]!); return (!publicSeul || !rs.length || rs.some((r) => user!.roles.includes(r))) && utilisable(ecran); };
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
            <div className="row-side">{(() => {
              const chemin = e.ecran.split(/[?#]/)[0]!;
              if (chemin === loc.pathname) return <button type="button" className="btn btn-small" onClick={() => allerALaSection(e.label)}>Aller à cette étape</button>;
              const usager = publicSeul ? ECRAN_USAGER[chemin] : undefined;
              if (usager) return <Link className="btn btn-small" to={usager.to}>{usager.label}</Link>;
              return accessible(e.ecran) ? <Link className="btn btn-small" to={e.ecran}>Ouvrir l’écran</Link> : <span className="small muted">{publicSeul ? 'Réalisé par un agent habilité' : `Réalisé par : ${realisePar(chemin)}`}</span>;
            })()}</div>
          </li>
        ))}
      </ol>
      <h3 className="small">Règles propres</h3>
      <ul className="small">{parcours.reglesPropres.map((r) => <li key={r}>{r}</li>)}</ul>
    </section>
  );
}
