/** Éléments communs du module d'apprentissage : garde de confidentialité affichée à l'écran (§ 24). */
import { Icon } from '../../components/Icon';
import type { Confidentialite } from './types';

export function GardeConfidentialite({ c }: { c: Confidentialite }) {
  return (
    <section className="panel ap-priv" aria-labelledby="ap-priv-t">
      <h2 id="ap-priv-t" className="panel-title"><Icon name="lock" size={16} /> Confidentialité : actes professionnels, pas surveillance</h2>
      <p className="small">{c.principe}</p>
      <p className="caps-sm">Ce qui est enregistré</p>
      <ul className="plain-list small">{c.enregistre.map((x) => <li key={x}>{x}</li>)}</ul>
      <p className="caps-sm">Ce qui n’est jamais enregistré</p>
      <ul className="plain-list small">{c.jamais.map((x) => <li key={x}>{x}</li>)}</ul>
    </section>
  );
}
