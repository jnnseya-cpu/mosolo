/**
 * Administration de l'apprentissage et des certifications (§ 24) :
 *  - registre des certifications par compte et par public (aucun classement), évaluations par un évaluateur distinct,
 *    délivrance et retrait motivé ;
 *  - contenus versionnés (fiches d'aide, modules) : rédaction, proposition, publication par une seconde personne ;
 *  - indicateurs agrégés : compréhension des contribuables (dossiers complets du premier coup), couverture des certificats.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { GardeConfidentialite } from './common';
import { AideContextuelle } from './AideContextuelle';
import { PROFIL_LIBELLE, PROFILS_CERTIFIES, type Contenu, type Indicateurs, type LigneRegistre, type Profil, type ProfilCertifie, type Question, type Registre, type StatutVersion } from './types';
import './apprentissage.css';

const STATUT: Record<StatutVersion, { label: string; tone: Tone }> = {
  BROUILLON: { label: 'Brouillon', tone: 'neutral' }, PROPOSEE: { label: 'Proposée — seconde personne attendue', tone: 'warning' },
  PUBLIEE: { label: 'Publiée', tone: 'good' }, REFUSEE: { label: 'Refusée', tone: 'neutral' }, REMPLACEE: { label: 'Remplacée', tone: 'neutral' },
};

function useAction() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<unknown>, ok: string, after?: () => void) => {
    setBusy(true); setMsg(null);
    try { await f(); setMsg({ ok: true, text: ok }); after?.(); } catch (e) { const d = describeError(e); setMsg({ ok: false, text: d.message + (d.code ? ` (${d.code})` : '') }); } finally { setBusy(false); }
  };
  const node = msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>;
  return { run, busy, node };
}

// ─────────────────────────────── registre des certifications ───────────────────────────────

function Dossier({ l, reg, onDone }: { l: LigneRegistre; reg: Registre; onDone: () => void }) {
  const a = useAction();
  const exig = reg.evaluationExigee[l.profil];
  const [resultat, setResultat] = useState<'CONFORME' | 'NON_CONFORME'>('CONFORME');
  const [obs, setObs] = useState('');
  const [refs, setRefs] = useState('');
  const [taille, setTaille] = useState(String(reg.parametres.echantillonTaille));
  const [conformes, setConformes] = useState('');
  const [motif, setMotif] = useState('');
  const [actes, setActes] = useState<{ auditId: string; action: string; ressource: string; le: string }[] | null>(null);
  const references = refs.split(/[\n;]+/).map((r) => r.trim()).filter(Boolean);
  async function evaluer(e: FormEvent) {
    e.preventDefault();
    await a.run(() => api('/v1/apprentissage/evaluations', { method: 'POST', body: {
      userId: l.userId, profil: l.profil, observations: obs.trim(), ...(references.length ? { references } : {}),
      ...(exig.type === 'ECHANTILLON' ? { echantillon: { taille: Number(taille), conformes: Number(conformes) } } : { resultat }),
    } }), 'Évaluation enregistrée (tracée dans l’audit).', () => { setObs(''); onDone(); });
  }
  return (
    <div className="panel stack">
      <p className="panel-title">{l.nom} <span className="mono small">{l.userId}</span> — {l.libelleProfil}</p>
      {l.valide ? <p className="notice notice-ok">En vigueur jusqu’au {l.certificat?.valableJusquau}{l.certificat?.demo ? ' — démonstration [EXEMPLE]' : ''}.</p>
        : <div className="notice notice-err"><p>Ce qui manque :</p><ul className="plain-list small">{l.manquants.map((m) => <li key={m}>{m}</li>)}</ul></div>}
      {l.aRevoir && <p className="callout callout-info small">{l.aRevoir}</p>}
      {a.node}
      <form className="form" onSubmit={(e) => void evaluer(e)} aria-label="Enregistrer une évaluation">
        <p className="caps-sm">{exig.libelle}</p>
        {exig.type === 'RESULTATS_VERIFIES' && (
          <p className="small">Indicateurs existants (lecture seule) : {reg.liensIndicateurs.map((x) => <Link key={x.chemin} to={x.chemin} className="mono">{x.libelle} </Link>)} — aucune mesure intrusive.</p>
        )}
        {exig.type === 'ECHANTILLON' ? (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void api<{ actes: typeof actes }>(`/v1/apprentissage/echantillon/${encodeURIComponent(l.userId)}`).then((r) => setActes(r.actes ?? []), () => setActes([]))}>
              <Icon name="refresh" size={14} /> Tirer un échantillon d’actes
            </button>
            {actes && (actes.length === 0 ? <p className="small muted">Aucun acte professionnel journalisé pour ce compte.</p> : <ul className="plain-list small">{actes.map((x) => <li key={x.auditId}><span className="mono">{x.action}</span> · {x.ressource}</li>)}</ul>)}
            <div className="field-row">
              <div className="field"><label className="label" htmlFor="ap-t">Actes contrôlés</label><input id="ap-t" type="number" min={1} value={taille} onChange={(e) => setTaille(e.target.value)} /></div>
              <div className="field"><label className="label" htmlFor="ap-c">Actes conformes</label><input id="ap-c" type="number" min={0} value={conformes} onChange={(e) => setConformes(e.target.value)} required /></div>
            </div>
            <p className="small muted">Conformité minimale : {reg.parametres.echantillonConformiteMinPct} % — {reg.parametres.statut}.</p>
          </>
        ) : (
          <div className="field"><label className="label" htmlFor="ap-r">Résultat</label>
            <select id="ap-r" value={resultat} onChange={(e) => setResultat(e.target.value as 'CONFORME' | 'NON_CONFORME')}><option value="CONFORME">Conforme</option><option value="NON_CONFORME">Non conforme (reprise proposée)</option></select>
          </div>
        )}
        <div className="field"><label className="label" htmlFor="ap-ref">Références (actes, dossiers ou indicateurs vérifiés ; une par ligne)</label><textarea id="ap-ref" rows={2} value={refs} onChange={(e) => setRefs(e.target.value)} /></div>
        <div className="field"><label className="label" htmlFor="ap-o">Observations</label><textarea id="ap-o" rows={2} value={obs} onChange={(e) => setObs(e.target.value)} required minLength={3} /></div>
        <button type="submit" className="btn btn-primary btn-sm" disabled={a.busy || obs.trim().length < 3}>Enregistrer l’évaluation</button>
      </form>
      <div className="btn-row">
        <button type="button" className="btn btn-primary btn-sm" disabled={a.busy} onClick={() => void a.run(() => api('/v1/apprentissage/certificats', { method: 'POST', body: { userId: l.userId, profil: l.profil } }), 'Certificat délivré.', onDone)}>
          <Icon name="shieldCheck" size={14} /> Délivrer le certificat
        </button>
      </div>
      {l.certificat && l.certificat.statut === 'DELIVRE' && (
        <div className="form">
          <label className="label" htmlFor="ap-m">Motif du retrait (décision humaine, tracée)</label>
          <textarea id="ap-m" rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} />
          <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || motif.trim().length < 5}
            onClick={() => void a.run(() => api(`/v1/apprentissage/certificats/${encodeURIComponent(l.certificat!.id)}/retrait`, { method: 'POST', body: { motif: motif.trim() } }), 'Certificat retiré.', onDone)}>Retirer le certificat</button>
        </div>
      )}
    </div>
  );
}

function RegistreTab() {
  const q = useApi(() => api<Registre>('/v1/apprentissage/certifications'), []);
  const [profil, setProfil] = useState<ProfilCertifie | ''>('');
  const [sel, setSel] = useState<string | null>(null);
  const lignes = useMemo(() => (q.data?.lignes ?? []).filter((l) => !profil || l.profil === profil), [q.data, profil]);
  const courant = lignes.find((l) => `${l.userId}|${l.profil}` === sel);
  if (q.loading) return <Loading />;
  if (q.error !== null) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  return (
    <div className="stack">
      <div className="field"><label className="label" htmlFor="ap-pf">Public</label>
        <select id="ap-pf" value={profil} onChange={(e) => setProfil(e.target.value as ProfilCertifie | '')}>
          <option value="">Tous les publics</option>{PROFILS_CERTIFIES.map((p) => <option key={p} value={p}>{PROFIL_LIBELLE[p]}</option>)}
        </select>
      </div>
      <DataTable caption="Registre des certifications" rows={lignes} rowKey={(l) => `${l.userId}|${l.profil}`} empty={<EmptyState title="Aucun compte pour ce public." icon="users" />} columns={[
        { key: 'u', label: 'Compte', primary: true, render: (l) => <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSel(`${l.userId}|${l.profil}`)}>{l.nom}</button> },
        { key: 'p', label: 'Public', render: (l) => l.libelleProfil },
        { key: 's', label: 'Certification', render: (l) => <StatusBadge tone={l.valide ? 'good' : 'warning'} label={l.valide ? `En vigueur → ${l.certificat?.valableJusquau}` : `${l.manquants.length} élément(s) manquant(s)`} /> },
      ]} />
      {courant && <Dossier key={sel} l={courant} reg={q.data} onDone={q.reload} />}
      <p className="small muted">{q.data.parametres.note}</p>
    </div>
  );
}

// ─────────────────────────────── contenus versionnés ───────────────────────────────

function ContenuCard({ c, onDone }: { c: Contenu; onDone: () => void }) {
  const { user } = useApp();
  const a = useAction();
  const [motif, setMotif] = useState('');
  const v = c.versions[c.versions.length - 1]!;
  const st = STATUT[v.statut];
  const moi = user?.id === v.auteur || user?.id === v.proposition?.par;
  const decider = (approve: boolean) => a.run(() => api(`/v1/apprentissage/contenus/${encodeURIComponent(c.id)}/publication/decision`, { method: 'POST', body: { approve, motif: motif.trim() } }), approve ? 'Version publiée.' : 'Publication refusée.', onDone);
  return (
    <li className="panel">
      <div className="panel-head">
        <div className="min0"><p className="panel-title">{v.titre} <span className="mono small">{c.cle}</span></p>
          <p className="panel-sub">{c.type === 'FICHE' ? 'Fiche d’aide' : 'Module'} · v{v.version} · {c.publics.map((p) => PROFIL_LIBELLE[p]).join(', ')} · auteur {v.auteur}</p></div>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <p className="small">{v.corps}</p>
      {v.lingala && <p className="small muted">Lingala (brouillon) : {v.lingala.corps}</p>}
      {v.epreuve && <p className="small muted">{v.epreuve.length} question(s) d’épreuve.</p>}
      {a.node}
      {v.statut === 'BROUILLON' && <button type="button" className="btn btn-primary btn-sm" disabled={a.busy} onClick={() => void a.run(() => api(`/v1/apprentissage/contenus/${encodeURIComponent(c.id)}/publication/propose`, { method: 'POST' }), 'Publication proposée : une seconde personne décide.', onDone)}>Proposer la publication</button>}
      {v.statut === 'PROPOSEE' && (moi ? <p className="small muted"><Icon name="lock" size={14} /> Quatre yeux : la publication revient à une autre personne que vous.</p> : (
        <div className="form">
          <label className="label" htmlFor={`ap-dm-${c.id}`}>Motif de la décision</label>
          <textarea id={`ap-dm-${c.id}`} rows={2} value={motif} onChange={(e) => setMotif(e.target.value)} />
          <div className="btn-row">
            <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || motif.trim().length < 5} onClick={() => void decider(true)}>Publier</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || motif.trim().length < 5} onClick={() => void decider(false)}>Refuser</button>
          </div>
        </div>
      ))}
    </li>
  );
}

function CreationForm({ onDone }: { onDone: () => void }) {
  const a = useAction();
  const [type, setType] = useState<'FICHE' | 'MODULE'>('FICHE');
  const [f, setF] = useState({ cle: '', titre: '', corps: '', lnTitre: '', lnCorps: '' });
  const [publics, setPublics] = useState<Profil[]>([]);
  const [qs, setQs] = useState<{ enonce: string; choix: string; bonne: number }[]>([]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const epreuve: Question[] = qs.map((q, i) => ({ id: `q${i + 1}`, enonce: q.enonce.trim(), choix: q.choix.split(';').map((c) => c.trim()).filter(Boolean), bonne: q.bonne }));
    await a.run(() => api('/v1/apprentissage/contenus', { method: 'POST', body: {
      type, cle: f.cle.trim(), publics, titre: f.titre.trim(), corps: f.corps.trim(),
      ...(f.lnTitre.trim() && f.lnCorps.trim() ? { lingala: { titre: f.lnTitre.trim(), corps: f.lnCorps.trim() } } : {}),
      ...(type === 'MODULE' ? { epreuve } : {}),
    } }), 'Brouillon créé : proposez-le à la publication.', () => { setF({ cle: '', titre: '', corps: '', lnTitre: '', lnCorps: '' }); setQs([]); onDone(); });
  }
  return (
    <form className="panel form" onSubmit={(e) => void submit(e)} aria-label="Nouveau contenu">
      <p className="panel-title">Nouveau contenu (brouillon)</p>
      <div className="seg seg-sm" role="group" aria-label="Type de contenu">
        <button type="button" aria-pressed={type === 'FICHE'} onClick={() => setType('FICHE')}>Fiche d’aide</button>
        <button type="button" aria-pressed={type === 'MODULE'} onClick={() => setType('MODULE')}>Module avec épreuve</button>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="ap-k">{type === 'FICHE' ? 'Clé de l’écran ou de l’action' : 'Code du module'}</label><input id="ap-k" value={f.cle} onChange={(e) => setF({ ...f, cle: e.target.value })} placeholder="terrain.habilitation" required /></div>
        <div className="field"><label className="label" htmlFor="ap-ti">Titre (français simple)</label><input id="ap-ti" value={f.titre} onChange={(e) => setF({ ...f, titre: e.target.value })} required /></div>
      </div>
      <fieldset className="field"><legend className="label">Publics</legend>
        <div className="ap-checks">{(Object.keys(PROFIL_LIBELLE) as Profil[]).map((p) => (
          <label key={p}><input type="checkbox" checked={publics.includes(p)} onChange={(e) => setPublics(e.target.checked ? [...publics, p] : publics.filter((x) => x !== p))} /> {PROFIL_LIBELLE[p]}</label>
        ))}</div>
      </fieldset>
      <div className="field"><label className="label" htmlFor="ap-co">Texte</label><textarea id="ap-co" rows={3} value={f.corps} onChange={(e) => setF({ ...f, corps: e.target.value })} required /></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="ap-lt">Titre lingala (brouillon, facultatif)</label><input id="ap-lt" value={f.lnTitre} onChange={(e) => setF({ ...f, lnTitre: e.target.value })} /></div>
        <div className="field"><label className="label" htmlFor="ap-lc">Texte lingala (brouillon)</label><textarea id="ap-lc" rows={2} value={f.lnCorps} onChange={(e) => setF({ ...f, lnCorps: e.target.value })} /></div>
      </div>
      {type === 'MODULE' && (
        <div className="ap-rows">
          {qs.map((q, i) => (
            <div key={i} className="ap-q-row">
              <div className="field"><label className="label" htmlFor={`ap-qe-${i}`}>Question {i + 1}</label><input id={`ap-qe-${i}`} value={q.enonce} onChange={(e) => setQs(qs.map((x, j) => (j === i ? { ...x, enonce: e.target.value } : x)))} required /></div>
              <div className="field"><label className="label" htmlFor={`ap-qc-${i}`}>Choix (séparés par « ; »)</label><input id={`ap-qc-${i}`} value={q.choix} onChange={(e) => setQs(qs.map((x, j) => (j === i ? { ...x, choix: e.target.value } : x)))} required /></div>
              <div className="field"><label className="label" htmlFor={`ap-qb-${i}`}>Bonne réponse (n°)</label><input id={`ap-qb-${i}`} type="number" min={1} max={6} value={q.bonne + 1} onChange={(e) => setQs(qs.map((x, j) => (j === i ? { ...x, bonne: Math.max(0, Number(e.target.value) - 1) } : x)))} /></div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setQs(qs.filter((_, j) => j !== i))}>Retirer</button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setQs([...qs, { enonce: '', choix: '', bonne: 0 }])}>Ajouter une question</button>
        </div>
      )}
      {a.node}
      <button type="submit" className="btn btn-primary" disabled={a.busy || !publics.length || (type === 'MODULE' && !qs.length)}>Créer le brouillon</button>
    </form>
  );
}

function ContenusTab() {
  const q = useApi(() => api<Contenu[]>('/v1/apprentissage/contenus'), []);
  if (q.loading) return <Loading />;
  if (q.error !== null) return <ErrorState error={q.error} onRetry={q.reload} />;
  const items = q.data ?? [];
  const attente = items.filter((c) => c.versions.some((v) => v.statut === 'PROPOSEE' || v.statut === 'BROUILLON'));
  return (
    <div className="stack">
      <p className="callout callout-info small"><Icon name="info" size={16} /> Contenu versionné : toute version est rédigée, proposée, puis publiée par une seconde personne distincte de l’auteur et du proposant. La version publiée reste en vigueur jusqu’à la décision.</p>
      <CreationForm onDone={q.reload} />
      <h3 className="h-sub">En attente ({attente.length})</h3>
      {attente.length === 0 ? <p className="small muted">Aucune version en attente.</p> : <ul className="plain-list stack">{attente.map((c) => <ContenuCard key={c.id} c={c} onDone={q.reload} />)}</ul>}
      <h3 className="h-sub">Tous les contenus ({items.length})</h3>
      <ul className="plain-list stack">{items.filter((c) => !attente.includes(c)).map((c) => <ContenuCard key={c.id} c={c} onDone={q.reload} />)}</ul>
    </div>
  );
}

// ─────────────────────────────── indicateurs agrégés ───────────────────────────────

function IndicateursTab() {
  const q = useApi(() => api<Indicateurs>('/v1/apprentissage/indicateurs'), []);
  if (q.loading) return <Loading />;
  if (q.error !== null) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  const c = q.data.comprehension;
  return (
    <div className="stack">
      <section className="panel" aria-labelledby="ap-cmp">
        <h2 id="ap-cmp" className="panel-title">Compréhension des contribuables</h2>
        <p className="kpi-value" aria-label="Taux de dossiers complets du premier coup">{c.libelle}</p>
        <p className="small">{c.definition}</p>
        <ul className="plain-list small">{c.sources.map((s) => <li key={s.source}>{s.source} : {s.disponible ? `${s.completsDuPremierCoup} / ${s.examines} dossier(s) examiné(s)${s.tauxPct ? ` (${s.tauxPct} %)` : ''}` : 'module non chargé'}</li>)}</ul>
        <p className="small muted">{c.note}</p>
      </section>
      <DataTable caption="Couverture des certificats par public (agrégée, jamais nominative)" rows={q.data.couverture} rowKey={(x) => x.profil} columns={[
        { key: 'p', label: 'Public', primary: true, render: (x) => x.libelle },
        { key: 'm', label: 'Validation', render: (x) => x.mode },
        { key: 'v', label: 'En vigueur', num: true, render: (x) => x.enVigueur },
        { key: 'e', label: 'Échéance < 30 j', num: true, render: (x) => x.echeanceSous30j },
        { key: 'x', label: 'Expirés', num: true, render: (x) => x.expires },
        { key: 'r', label: 'Retirés', num: true, render: (x) => x.retires },
      ]} />
      <GardeConfidentialite c={q.data.confidentialite} />
    </div>
  );
}

const TABS = [
  { id: 'registre', label: 'Certifications', icon: 'shieldCheck' },
  { id: 'contenus', label: 'Contenus (quatre yeux)', icon: 'file' },
  { id: 'indicateurs', label: 'Indicateurs', icon: 'gauge' },
] as const;

export default function Certifications() {
  const { user } = useApp();
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('registre');
  if (!user) return <div className="page"><EmptyState title="Choisissez un utilisateur de démonstration (régie, supervision, Trésor, sécurité…)." icon="users" /></div>;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Apprentissage et poste de travail" title="Administration des certifications"
        lead="Certification avant affectation (recenseurs), recertification annuelle (contrôleurs), évaluation continue (guichet), résultats vérifiés (cadres), contrôle par échantillon (finances), habilitation renouvelable (administrateurs).">
        <AideContextuelle cle="terrain.habilitation" />
      </PageHead>
      <ExampleNotice text="Contenus, certificats et évaluations de démonstration [EXEMPLE] : non contractuels. Seuils par défaut — à confirmer par le maître d’ouvrage." />
      <div className="seg seg-wrap" role="tablist" aria-label="Administration de l’apprentissage">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} aria-pressed={tab === t.id} onClick={() => setTab(t.id)}><Icon name={t.icon} size={16} /> {t.label}</button>
        ))}
      </div>
      <div role="tabpanel">
        {tab === 'registre' && <RegistreTab />}
        {tab === 'contenus' && <ContenusTab />}
        {tab === 'indicateurs' && <IndicateursTab />}
      </div>
    </div>
  );
}
