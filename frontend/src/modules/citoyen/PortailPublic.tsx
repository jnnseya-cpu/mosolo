/**
 * Module 5 — Portail web public : information (guides par profil, textes applicables, calendrier fiscal, points de
 * paiement), simulateurs d'IF, d'IRL, de vignette et de patente sur les RÈGLES PUBLIÉES (aucune donnée personnelle
 * enregistrée ; illustration non opposable si la fiche est « à vérifier » ; indisponible sans règle), vérification et
 * transparence. Visites mesurées anonymement (sans cookie). Protection anti-robots : défi résolu automatiquement.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import './citoyen.css';
import { PortailVisuels } from './visuels';

interface RegleSim { code: string; version: number; libelle: string; statut: string; base: string; entrees: string[]; rangs: number[]; nature: string }
interface Famille { famille: string; libelle: string; regles: RegleSim[]; disponible: boolean; motifIndisponible: string | null }
interface Catalogue { familles: Famille[]; avertissement: string }
interface Resultat { nature: string; montant: { amount: string; currency: string } | null; motif?: string; mention?: string; regle?: { code: string; version: number; statut: string; formule?: string; articles?: string[]; voieDeRecours?: string }; taux?: Record<string, string> }
interface Infos {
  guides: { profil: string; libelle: string; obligations: string[]; pieces: string[]; rappel: string }[];
  textes: { instruments: { id: string; titre: string; statut: string; demo: boolean }[] };
  calendrier: { echeances: { regle: string; libelle: string; periodicite: string; echeance: string; statut: string; aVerifier: boolean }[]; mention: string };
}

const NATURE: Record<string, { tone: 'good' | 'warning' | 'neutral'; label: string }> = {
  INDICATIF: { tone: 'good', label: 'Montant indicatif (règle ACTIVE)' },
  ILLUSTRATION_NON_OPPOSABLE: { tone: 'warning', label: 'Illustration non opposable (fiche à vérifier)' },
  INDISPONIBLE: { tone: 'neutral', label: 'Simulation indisponible (aucune règle publiée)' },
};

function Simulateur({ f }: { f: Famille }) {
  const [regle, setRegle] = useState(f.regles[0]?.code ?? '');
  const r = f.regles.find((x) => x.code === regle);
  const [rang, setRang] = useState(1);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [res, setRes] = useState<Resultat | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null); setRes(null);
    try { setRes(await api<Resultat>('/v1/public/simulations', { method: 'POST', body: { famille: f.famille, ...(regle ? { regle } : {}), rang, entrees: vals } })); } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <form className="panel stack-sm" onSubmit={(e) => void go(e)} aria-label={`Simulateur — ${f.libelle}`}>
      <p className="panel-title">{f.libelle}</p>
      {!f.disponible ? <p className="small muted">{f.motifIndisponible}</p> : (
        <>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor={`sim-r-${f.famille}`}>Règle</label>
              <select id={`sim-r-${f.famille}`} value={regle} onChange={(e) => { setRegle(e.target.value); setVals({}); }}>{f.regles.map((x) => <option key={x.code} value={x.code}>{x.libelle} (v{x.version}, {x.statut})</option>)}</select></div>
            {r && r.rangs.length > 0 && <div className="field"><label className="label" htmlFor={`sim-k-${f.famille}`}>Rang de localité</label><select id={`sim-k-${f.famille}`} value={rang} onChange={(e) => setRang(Number(e.target.value))}>{r.rangs.map((k) => <option key={k} value={k}>{k}</option>)}</select></div>}
          </div>
          {r?.entrees.map((k) => (
            <div className="field" key={k}><label className="label" htmlFor={`sim-${f.famille}-${k}`}>{k.replace(/_/g, ' ')}</label>
              <input id={`sim-${f.famille}-${k}`} inputMode="decimal" required pattern="[0-9]+([.,][0-9]+)?" title="Nombre (ex. 120 ou 120,5)" value={vals[k] ?? ''} onChange={(e) => setVals({ ...vals, [k]: e.target.value })} /></div>
          ))}
          <button type="submit" className="btn btn-primary btn-sm">Simuler</button>
        </>
      )}
      {err && <p className="notice notice-err small" role="alert">{err}</p>}
      {res && (
        <div className="stack-sm" role="status">
          <StatusBadge tone={NATURE[res.nature]?.tone ?? 'neutral'} label={NATURE[res.nature]?.label ?? res.nature} />
          {res.montant ? <p className="big-num">{res.montant.amount} {res.montant.currency}</p> : <p className="small">{res.motif}</p>}
          {res.mention && <p className="small">{res.mention}</p>}
          {res.regle?.formule && <p className="small muted">Formule : <span className="mono">{res.regle.formule}</span>{res.taux ? ` — taux : ${Object.entries(res.taux).map(([k, v]) => `${k} = ${v}`).join(', ')}` : ''}</p>}
          {res.regle?.voieDeRecours && <p className="small muted">Voie de recours : {res.regle.voieDeRecours}</p>}
        </div>
      )}
    </form>
  );
}

export default function PortailPublic() {
  const cat = useApi(() => api<Catalogue>('/v1/public/simulateurs'), []);
  const info = useApi(() => api<Infos>('/v1/public/informations'), []);
  useEffect(() => { void api('/v1/public/visites', { method: 'POST', body: { page: 'simulateurs' } }).catch(() => undefined); }, []);
  const [profil, setProfil] = useState<string>('');
  return (
    <div className="stack">
      <PageHead eyebrow="Module 5 — sans compte" title="Informations et simulateurs publics" lead="Simulez l’impôt foncier, l’IRL, la vignette et la patente sur les règles publiées au registre. Rien n’est enregistré à votre nom." />
      {cat.loading ? <Loading /> : cat.error ? <ErrorState error={cat.error} onRetry={cat.reload} /> : cat.data && (
        <section className="stack-sm" aria-label="Simulateurs">
          <p className="notice small">{cat.data.avertissement}</p>
          <PortailVisuels familles={cat.data.familles} echeances={info.data?.calendrier.echeances ?? null} />
          <div className="cit-grid">{cat.data.familles.map((f) => <Simulateur key={f.famille} f={f} />)}</div>
        </section>
      )}
      {info.data && (
        <>
          <section className="panel stack-sm" aria-label="Guides par profil">
            <p className="panel-title">Guides par profil</p>
            <select aria-label="Profil" value={profil} onChange={(e) => setProfil(e.target.value)}>
              <option value="">Choisir un profil…</option>
              {info.data.guides.map((g) => <option key={g.profil} value={g.profil}>{g.libelle}</option>)}
            </select>
            {info.data.guides.filter((g) => g.profil === profil).map((g) => (
              <div key={g.profil} className="small stack-sm">
                <p><strong>Obligations possibles :</strong> {g.obligations.join(' ; ') || '—'}</p>
                <p><strong>Pièces utiles :</strong> {g.pieces.join(', ') || '—'}</p>
                <p className="muted">{g.rappel}</p>
              </div>
            ))}
          </section>
          <section className="panel stack-sm" aria-label="Calendrier fiscal">
            <p className="panel-title">Calendrier fiscal</p>
            <p className="small muted">{info.data.calendrier.mention}</p>
            <ul className="plain-list small">{info.data.calendrier.echeances.map((e) => <li key={`${e.regle}-${e.libelle}`}>{e.libelle} — {e.periodicite}, échéance : {e.echeance} {e.aVerifier && <StatusBadge tone="warning" label="à vérifier" />}</li>)}</ul>
          </section>
          <section className="panel stack-sm" aria-label="Textes applicables">
            <p className="panel-title">Textes applicables</p>
            <ul className="plain-list small">{info.data.textes.instruments.map((t) => <li key={t.id}>{t.titre} — {t.statut}{t.demo ? ' (fictif, démonstration)' : ''}</li>)}</ul>
          </section>
        </>
      )}
      <section className="panel stack-sm">
        <p className="panel-title">Aller plus loin</p>
        <ul className="plain-list small">
          <li><Link to="/verifier">Vérifier une quittance, un titre, une carte MOSOLO ou un badge d’agent</Link></li>
          <li><Link to="/points-de-paiement">Points de paiement</Link> · <Link to="/transparence">Transparence : recettes agrégées par commune</Link></li>
          <li><Link to="/inscription">Créer un compte de contribuable</Link> (inscription publique : compte de contribuable uniquement)</li>
        </ul>
      </section>
    </div>
  );
}
