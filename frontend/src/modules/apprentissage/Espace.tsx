/**
 * Espace d'apprentissage (§ 24) : pour chaque public dont relève l'utilisateur, le contenu attendu, le mode de
 * validation, les micro-leçons (fiches publiées), les modules et leurs épreuves, et l'état de ses certifications.
 * Français simple d'abord ; lingala en brouillon. Aucune mesure d'activité : seules les épreuves soumises comptent.
 */
import { useState, type FormEvent } from 'react';
// Parcours par rôle (29/09/2026) : liens adaptés au compte — un écran que le rôle n'utilise pas affiche « Réalisé par : … ».
import { LienEcran as Link } from '../../components/LienEcran';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { GardeConfidentialite } from './common';
import { EtatCertificationView } from './EtatCertification';
import type { ContenuVue, Epreuve, Espace as EspaceData } from './types';
import './apprentissage.css';
import { EspaceApprentissageVisuel } from './visuels';

function Fiche({ f }: { f: ContenuVue }) {
  const [ln, setLn] = useState(false);
  const t = ln && f.lingala ? f.lingala : f;
  return (
    <article className="panel">
      <p className="panel-title">{t.titre}</p>
      <p className="small">{t.corps}</p>
      {f.lingala && <button type="button" className="btn btn-ghost btn-sm" aria-pressed={ln} onClick={() => setLn(!ln)}>{ln ? 'Français' : 'Lingala (brouillon)'}</button>}
      {ln && <p className="small muted">{f.lingalaNote}</p>}
      <p className="small muted">Clé <span className="mono">{f.cle}</span> · version {f.version}</p>
    </article>
  );
}

function Module({ m, seuil, onDone }: { m: ContenuVue & { derniereEpreuve: Epreuve | null }; seuil: number; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [rep, setRep] = useState<Record<string, number>>({});
  const [res, setRes] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const qs = m.epreuve ?? [];
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setRes(null);
    try {
      const r = await api<{ epreuve: Epreuve; note: string }>(`/v1/apprentissage/modules/${encodeURIComponent(m.id)}/epreuve`, { method: 'POST', body: { reponses: rep } });
      setRes({ ok: r.epreuve.reussie, text: `Score ${r.epreuve.scorePct} % (seuil ${seuil} %). ${r.note}` });
      onDone();
    } catch (x) { setRes({ ok: false, text: describeError(x).message }); } finally { setBusy(false); }
  }
  const d = m.derniereEpreuve;
  return (
    <article className="panel">
      <div className="panel-head">
        <div className="min0"><p className="panel-title">{m.titre}</p><p className="panel-sub">{m.corps}</p></div>
        {d ? <StatusBadge tone={d.reussie ? 'good' : 'warning'} label={d.reussie ? `Réussie (${d.scorePct} %)` : `À reprendre (${d.scorePct} %)`} /> : <StatusBadge tone="neutral" label="Non passée" />}
      </div>
      {!!m.lecons?.length && <p className="small">Micro-leçons : {m.lecons.map((l) => <span key={l} className="mono">{l} </span>)}</p>}
      {m.controlePratique && <p className="small muted">Vérification pratique : {m.controlePratique}</p>}
      {!open ? <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(true)}><Icon name="check" size={14} /> Passer l’épreuve</button> : (
        <form className="ap-quiz" onSubmit={(e) => void submit(e)} aria-label={`Épreuve : ${m.titre}`}>
          {qs.map((q) => (
            <fieldset key={q.id}>
              <legend className="small"><strong>{q.enonce}</strong></legend>
              {q.choix.map((c, i) => (
                <label key={i}><input type="radio" name={`${m.id}-${q.id}`} checked={rep[q.id] === i} onChange={() => setRep({ ...rep, [q.id]: i })} /> {c}</label>
              ))}
            </fieldset>
          ))}
          {res && <p className={`notice ${res.ok ? 'notice-ok' : 'notice-err'}`} role="status">{res.text}</p>}
          <div className="btn-row">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || Object.keys(rep).length < qs.length}>Soumettre mes réponses</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setOpen(false); setRep({}); }}>Fermer</button>
          </div>
        </form>
      )}
    </article>
  );
}

export default function Espace() {
  const { user } = useApp();
  const q = useApi(() => api<EspaceData>('/v1/apprentissage/espace'), [user?.id]);
  if (!user) return <div className="page"><EmptyState title="Choisissez un utilisateur de démonstration pour ouvrir son espace d’apprentissage." icon="users" /></div>;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Apprentissage et poste de travail" title="Espace d’apprentissage"
        lead="Micro-apprentissage intégré au poste : explications courtes en français simple (lingala en brouillon), épreuves des modules et certification selon vos fonctions.">
        <Link className="btn btn-ghost btn-sm" to="/apprentissage/mes-certificats"><Icon name="shieldCheck" size={14} /> Mes certificats</Link>
      </PageHead>
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <div className="stack">
          <ExampleNotice text="Contenus et certificats de démonstration [EXEMPLE] : non contractuels." />
          {/* Visuels (27/09/2026) : modules, exigences et résultats, depuis l'espace déjà chargé. */}
          <EspaceApprentissageVisuel d={q.data} />
          <section className="section" aria-labelledby="ap-pub">
            <h2 id="ap-pub">Mes publics</h2>
            <div className="ap-grid">
              {q.data.profils.map((p) => (
                <article key={p.profil} className="panel"><p className="panel-title">{p.nom}</p><p className="small">{p.contenu}</p><p className="small muted">Validation : {p.libelle}</p></article>
              ))}
            </div>
          </section>
          {q.data.certifications.map((c) => <EtatCertificationView key={c.profil} etat={c} />)}
          <section className="section" aria-labelledby="ap-mod">
            <h2 id="ap-mod">Modules et épreuves</h2>
            <p className="small muted">Seuil de réussite : {q.data.seuilReussitePct} % — {q.data.statutSeuil}.</p>
            {q.data.modules.length === 0 ? <EmptyState title="Aucun module publié pour vos fonctions." icon="file" /> : (
              <div className="ap-grid">{q.data.modules.map((m) => <Module key={m.id} m={m} seuil={q.data!.seuilReussitePct} onDone={q.reload} />)}</div>
            )}
          </section>
          <section className="section" aria-labelledby="ap-fic">
            <h2 id="ap-fic">Micro-leçons</h2>
            {q.data.fiches.length === 0 ? <EmptyState title="Aucune fiche publiée pour vos fonctions." icon="file" /> : (
              <div className="ap-grid">{q.data.fiches.map((f) => <Fiche key={f.id} f={f} />)}</div>
            )}
          </section>
          <GardeConfidentialite c={q.data.confidentialite} />
        </div>
      )}
    </div>
  );
}
