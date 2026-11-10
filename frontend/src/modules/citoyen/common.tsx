/**
 * Éléments communs des écrans « parcours du citoyen » (modules 1 à 12) : rendu d'un indicateur (valeur réelle ou
 * « non mesuré » avec sa raison), petite action motivée, tableau simple.
 */
import { useState, type ReactNode } from 'react';
import { describeError } from '../../lib/api';
import { TuilesIndicateurs } from './visuels';

export interface Indicateur { valeur?: unknown; raison?: string; numerateur?: number; denominateur?: number; unite?: string; definition?: string; [k: string]: unknown }

const LIBELLES: Record<string, string> = {
  comptesActifsParNiveau: 'Comptes actifs par niveau', tauxRattachementNif: 'Taux de rattachement NIF', doublons: 'Doublons détectés et résolus', delaiVerification: 'Délai de vérification',
  enrolementsParCanal: 'Enrôlements par canal', tauxCompletsPremierCoup: 'Dossiers complets du premier coup', delaiMoyen: 'Délai moyen', tauxRejet: 'Taux de rejet',
  utilisateursActifs: 'Utilisateurs actifs', tauxPaiementEnLigne: 'Taux de paiement en ligne', delaiDeclarationPaiement: 'Délai déclaration → paiement', satisfaction: 'Satisfaction',
  installationsActives: 'Installations actives', transactionsMobiles: 'Transactions mobiles', tauxEchecPaiement: 'Taux d’échec de paiement', noteApplication: 'Note de l’application', appareilsCompromis: 'Appareils modifiés détectés',
  visites: 'Visites', simulations: 'Simulations', verifications: 'Vérifications', conversionInscription: 'Conversion vers l’inscription',
  sessionsUssd: 'Sessions USSD', paiementsUssd: 'Paiements USSD', tauxDelivranceSms: 'Taux de délivrance SMS', coutParMessage: 'Coût par message',
  tauxObjetsRattaches: 'Taux d’objets rattachés', delaiRattachement: 'Délai de rattachement', litigesOuverts: 'Litiges ouverts', obligationsARevoir: 'Obligations à revoir (date d’effet)',
  couvertureGeofiscale: 'Taux de couverture géofiscale', objetsGeolocalises: 'Objets géolocalisés', precisionMoyenne: 'Précision moyenne',
  bauxEnregistres: 'Baux enregistrés', couvertureLocative: 'Couverture locative', assietteIrlVerifiee: 'Assiette IRL vérifiée', tauxConformite: 'Taux de conformité',
  etablissementsRecenses: 'Établissements recensés', patentesActives: 'Patentes actives', tauxRenouvellement: 'Taux de renouvellement', commercesNonEnregistresDetectes: 'Commerces non enregistrés détectés',
  couvertureParc: 'Couverture du parc', tauxPaiement: 'Taux de paiement', controlesParJour: 'Contrôles par jour', mutationsBloqueesPuisRegularisees: 'Mutations bloquées puis régularisées', lotsImmatriculations: 'Lots du registre des immatriculations',
  autorisationsActives: 'Autorisations actives', tauxConformiteControles: 'Taux de conformité aux contrôles', renouvellementsATemps: 'Renouvellements à temps',
};

export const libelle = (k: string) => LIBELLES[k] ?? k;

function valeurTexte(v: unknown): string {
  if (v === null || v === undefined) return 'non mesuré';
  if (Array.isArray(v)) return v.length ? v.map((m) => (m && typeof m === 'object' && 'amount' in m ? `${(m as { amount: string }).amount} ${(m as { currency: string }).currency}` : String(m))).join(' + ') : '0';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Une ligne d'indicateur : valeur (avec % si ratio), détail, ou « non mesuré » avec la raison. */
export function LigneIndicateur({ cle, ind }: { cle: string; ind: unknown }) {
  if (typeof ind === 'number' || typeof ind === 'string') return <li><strong>{libelle(cle)}</strong> : {ind}</li>;
  const i = (ind ?? {}) as Indicateur;
  const ratio = i.denominateur !== undefined && i.valeur !== null && i.valeur !== undefined;
  const extra = Object.entries(i).filter(([k]) => !['valeur', 'raison', 'numerateur', 'denominateur', 'unite', 'definition', 'fenetre', 'parametre'].includes(k));
  return (
    <li>
      <strong>{libelle(cle)}</strong> : {i.valeur === null ? <span className="muted">non mesuré</span> : <>{valeurTexte(i.valeur)}{ratio ? ' %' : ''}{i.unite ? ` ${i.unite}` : ''}</>}
      {ratio && <span className="small muted"> ({i.numerateur}/{i.denominateur})</span>}
      {i.raison && <span className="small muted"> — {i.raison}</span>}
      {extra.length > 0 && <span className="small muted"> · {extra.map(([k, v]) => `${k} : ${valeurTexte(v)}`).join(' · ')}</span>}
      {i.definition && <div className="small muted">{i.definition}</div>}
    </li>
  );
}

export function BlocIndicateurs({ titre, indicateurs }: { titre: string; indicateurs: Record<string, unknown> | null | undefined }) {
  if (!indicateurs) return null;
  return (
    <section className="panel stack-sm" aria-label={titre}>
      <p className="panel-title">{titre}</p>
      <TuilesIndicateurs titre={titre} indicateurs={indicateurs} />
      <ul className="plain-list small">{Object.entries(indicateurs).map(([k, v]) => <LigneIndicateur key={k} cle={k} ind={v} />)}</ul>
    </section>
  );
}

/** Action à motif obligatoire (décision humaine motivée). */
export function ActionMotivee({ label, onSubmit, tone = 'primary' }: { label: string; onSubmit: (motif: string) => Promise<unknown>; tone?: 'primary' | 'secondary' }) {
  const [open, setOpen] = useState(false);
  const [motif, setMotif] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <button type="button" className={`btn btn-${tone} btn-sm`} onClick={() => setOpen(true)}>{label}</button>;
  return (
    <span className="stack-sm">
      <input aria-label={`Motif — ${label}`} placeholder="Motif (obligatoire)" value={motif} onChange={(e) => setMotif(e.target.value)} />
      <button type="button" className={`btn btn-${tone} btn-sm`} disabled={motif.trim().length < 3} onClick={() => { setErr(null); onSubmit(motif).then(() => { setOpen(false); setMotif(''); }, (e: unknown) => setErr(describeError(e).message)); }}>Confirmer : {label}</button>
      {err && <span className="notice notice-err small" role="alert">{err}</span>}
    </span>
  );
}

export function Tableau({ entetes, lignes, vide }: { entetes: string[]; lignes: ReactNode[][]; vide: string }) {
  if (!lignes.length) return <p className="small muted">{vide}</p>;
  return (
    <div className="rtable-wrap">
      <table className="data-table rtable">
        <thead><tr>{entetes.map((e) => <th key={e} scope="col">{e}</th>)}</tr></thead>
        <tbody>{lignes.map((l, i) => <tr key={i}>{l.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
