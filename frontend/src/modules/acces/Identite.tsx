/**
 * Registre d'identité (§ 9 ; H.4.1) : contrôle des pièces (niveaux N1 à N3), file des doublons probables,
 * fusion sur preuve en double validation (trois personnes distinctes), réversible ; enrôlement assisté N0-A.
 */
import { useState, type FormEvent } from 'react';
import { LANGUAGES, LANGUAGE_CODES } from '@mosolo/shared';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { Chip } from '../../components/StatusBadge';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { hasRole, PROOF_LABEL, REASON_LABEL, Status, Tabs, useAction, type Proof } from './common';
import { IdentiteVisuels } from './visuels';
import './acces.css';

type Tab = 'pieces' | 'doublons' | 'fusions' | 'assiste';
interface Person { id: string; iuc: string; fullName: string; verificationLevel: string; createdAt: string; phoneMasked: string | null }
interface Candidate { id: string; a: Person; b: Person; reasons: string[]; score: string; nameOnly: boolean; merge?: { id: string; status: string } }
interface MergeRow { id: string; survivorId: string; absorbedId: string; reasons: string[]; evidence: string; documentRef?: string; status: string; proposedBy: string; verifiedBy?: string; approvedBy?: string; closeReason?: string; proposedAt: string }
type PendingProof = Proof & { taxpayer: { id: string; iuc: string; fullName: string; verificationLevel: string; kind: string } };

const COMMUNES = ['Bandalungwa', 'Barumbu', 'Bumbu', 'Gombe', 'Kalamu', 'Kasa-Vubu', 'Kimbanseke', 'Kinshasa', 'Kintambo', 'Kisenso', 'Lemba', 'Limete', 'Lingwala', 'Makala', 'Maluku', 'Masina', 'Matete', 'Mont-Ngafula', 'Ndjili', 'Ngaba', 'Ngaliema', 'Ngiri-Ngiri', 'Nsele', 'Selembao'];

function PersonBox({ p, label }: { p: Person; label: string }) {
  const { fmtDate } = useApp();
  return (
    <div className="ac-person">
      <p className="caps-sm muted">{label}</p>
      <p className="row-title">{p.fullName}</p>
      <p className="small mono">{p.iuc}</p>
      <p className="small muted">{p.verificationLevel} · {p.phoneMasked ?? 'sans téléphone'} · créé le {fmtDate(p.createdAt)}</p>
    </div>
  );
}

function AssistedEnrolment({ userId, territory }: { userId: string; territory?: string[] }) {
  const act = useAction(userId);
  const [f, setF] = useState({ fullName: '', language: 'ln', commune: territory?.[0] ?? 'Limete', phone: '', method: 'TEMOIN', witnessName: '', recordingRef: '' });
  const [done, setDone] = useState<{ taxpayerId: string; iuc: string; notice: string } | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await act.run(() => api<{ taxpayerId: string; iuc: string; notice: string }>('/v1/acces/assisted-enrolments', {
      method: 'POST',
      body: {
        fullName: f.fullName.trim(), language: f.language, commune: f.commune, ...(f.phone ? { phone: f.phone.replace(/[\s-]/g, '') } : {}),
        consent: { method: f.method, ...(f.method === 'TEMOIN' ? { witnessName: f.witnessName } : {}), ...(f.method === 'ORAL_ENREGISTRE' ? { recordingRef: f.recordingRef } : {}) },
      },
    }), 'Compte N0-A créé.');
    if (r) setDone(r);
  }
  return (
    <div className="ac-grid ac-grid-even">
      <form className="panel form" onSubmit={(e) => void submit(e)} aria-label="Enrôlement assisté">
        <h2 className="panel-title">Enrôlement assisté (N0-A)</h2>
        <p className="small muted">Pour une personne sans téléphone, sans Internet ou ne sachant pas lire : le résumé est lu à voix haute dans sa langue ; consentement oral enregistré ou devant témoin identifié.</p>
        <div className="field"><label className="label" htmlFor="ae-n">Nom complet</label><input id="ae-n" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required /></div>
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="ae-l">Langue</label><select id="ae-l" value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })}>{LANGUAGE_CODES.map((c) => <option key={c} value={c}>{LANGUAGES[c].nativeName}</option>)}</select></div>
          <div className="field"><label className="label" htmlFor="ae-c">Commune</label><select id="ae-c" value={f.commune} onChange={(e) => setF({ ...f, commune: e.target.value })}>{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select></div>
        </div>
        <div className="field"><label className="label" htmlFor="ae-p">Téléphone (facultatif)</label><input id="ae-p" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></div>
        <fieldset className="field"><legend className="label">Consentement</legend>
          <div className="radio-list">
            {[['TEMOIN', 'Devant témoin identifié'], ['ORAL_ENREGISTRE', 'Oral enregistré'], ['EMPREINTE', 'Empreinte digitale (désactivée, J18)']].map(([k, l]) => (
              <label key={k} className={`radio ${f.method === k ? 'checked' : ''}`}><input type="radio" name="consent" checked={f.method === k} onChange={() => setF({ ...f, method: k! })} /><span>{l}</span></label>
            ))}
          </div></fieldset>
        {f.method === 'TEMOIN' && <div className="field"><label className="label" htmlFor="ae-w">Témoin</label><input id="ae-w" value={f.witnessName} onChange={(e) => setF({ ...f, witnessName: e.target.value })} /></div>}
        {f.method === 'ORAL_ENREGISTRE' && <div className="field"><label className="label" htmlFor="ae-r">Référence de l’enregistrement</label><input id="ae-r" value={f.recordingRef} onChange={(e) => setF({ ...f, recordingRef: e.target.value })} /></div>}
        <p className="ac-guard"><Icon name="cash" size={16} /> <span>L’agent n’encaisse jamais : aucun paiement n’est demandé ni reçu lors de l’enrôlement.</span></p>
        {act.node}
        <button type="submit" className="btn btn-primary" disabled={act.busy}><Icon name="user" size={18} /> Créer le compte assisté</button>
      </form>
      {done && (
        <section className="panel result-card" role="status">
          <Status s="VALIDEE" />
          <dl className="ac-kv"><dt>IUC</dt><dd className="mono">{done.iuc}</dd><dt>Identifiant</dt><dd className="mono">{done.taxpayerId}</dd><dt>Niveau</dt><dd>N0-A — assisté</dd></dl>
          <p className="small">{done.notice}</p>
        </section>
      )}
    </div>
  );
}

export default function Identite() {
  const { user, fmtDate } = useApp();
  const roles = user?.roles ?? [];
  const canReview = hasRole(roles, 'R12', 'R11', 'R07', 'R06');
  const canDup = hasRole(roles, 'R12', 'R07', 'R06', 'R09');
  const [tab, setTab] = useState<Tab>(canReview ? 'pieces' : canDup ? 'doublons' : 'assiste');
  const proofs = useApi(() => (canReview ? api<{ items: PendingProof[] }>('/v1/acces/identity-proofs') : Promise.resolve({ items: [] as PendingProof[] })), [user?.id, tab]);
  const dups = useApi(() => (canDup ? api<{ items: Candidate[]; merges: MergeRow[] }>('/v1/acces/duplicates') : Promise.resolve({ items: [] as Candidate[], merges: [] as MergeRow[] })), [user?.id, tab]);
  const act = useAction(user?.id);
  const [review, setReview] = useState<PendingProof | null>(null);
  const [note, setNote] = useState('');
  const [propose, setPropose] = useState<Candidate | null>(null);
  const [pf, setPf] = useState({ survivor: 'a' as 'a' | 'b', evidence: '', documentRef: '' });

  const mergeAction = (id: string, path: string, body: unknown, ok: string) =>
    void act.run(() => api(`/v1/acces/merges/${id}/${path}`, { method: 'POST', body }), ok).then(() => dups.reload());

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Registre d’identité" title="Pièces, doublons et fusions" lead="Un compte principal par personne ou organisation. Aucune fusion automatique sur la seule similitude de noms : la fusion exige une preuve, deux validations par des personnes distinctes, et reste réversible." />
      <Tabs<Tab> value={tab} onChange={setTab} label="Rubriques" items={[
        ...(canReview ? [['pieces', 'Pièces à contrôler', proofs.data?.items.length] as [Tab, string, number?]] : []),
        ...(canDup ? [['doublons', 'Doublons probables', dups.data?.items.filter((c) => !c.merge).length] as [Tab, string, number?], ['fusions', 'Fusions', dups.data?.merges.filter((m) => ['PROPOSEE', 'VERIFIEE'].includes(m.status)).length] as [Tab, string, number?]] : []),
        ...(hasRole(roles, 'R10', 'R12') ? [['assiste', 'Enrôlement assisté'] as [Tab, string, number?]] : []),
      ]} />
      {(canReview || canDup) && <IdentiteVisuels proofs={canReview ? proofs.data?.items ?? null : null} candidates={canDup ? dups.data?.items ?? null : null} merges={canDup ? dups.data?.merges ?? null : null} />}
      {!canReview && !canDup && !hasRole(roles, 'R10', 'R12') && <EmptyState title="Espace réservé au registre d’identité (guichet, contrôle, supervision)" icon="lock" />}

      {tab === 'pieces' && canReview && (
        <section className="panel" aria-label="Pièces à contrôler">
          {proofs.loading && <Loading />}
          {proofs.error !== null && <ErrorState error={proofs.error} onRetry={proofs.reload} />}
          {proofs.data && (proofs.data.items.length === 0 ? <EmptyState title="Aucune pièce en attente" icon="check" /> : (
            <ul className="list-rows">
              {proofs.data.items.map((p) => (
                <li key={p.id} className="list-row">
                  <div className="min0">
                    <p className="row-title">{PROOF_LABEL[p.type] ?? p.type} · <span className="mono">{p.referenceMasked}</span></p>
                    <p className="small muted">{p.taxpayer.fullName} ({p.taxpayer.iuc}) · niveau {p.taxpayer.verificationLevel} · saisie par {p.declaredBy} le {fmtDate(p.declaredAt, true)}</p>
                    {p.note && <p className="small">{p.note}</p>}
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setReview(p); setNote(''); }}>Contrôler</button>
                </li>
              ))}
            </ul>
          ))}
        </section>
      )}

      {tab === 'doublons' && canDup && (
        <section className="ac-stack" aria-label="Doublons probables">
          {dups.error !== null && <ErrorState error={dups.error} onRetry={dups.reload} />}
          {dups.data && (dups.data.items.length === 0 ? <EmptyState title="Aucun rapprochement proposé" icon="check" /> : dups.data.items.map((c) => (
            <article key={c.id} className="ac-card">
              <div className="ac-card-head">
                <div className="ac-chips">{c.reasons.map((r) => <Chip key={r}>{REASON_LABEL[r] ?? r}</Chip>)}</div>
                <div className="ac-score" aria-label={`Score ${c.score}`}><span className="small">Indice de rapprochement {c.score}</span><div className="ac-score-bar"><span style={{ width: `${Number(c.score) * 100}%` }} /></div></div>
              </div>
              <div className="ac-pair"><PersonBox p={c.a} label="Compte A" /><span className="ac-versus" aria-hidden="true">≈</span><PersonBox p={c.b} label="Compte B" /></div>
              {c.nameOnly && <p className="ac-guard ac-guard-warn"><Icon name="alert" size={16} /> <span>Similitude de noms seulement : une pièce justificative référencée est exigée pour proposer une fusion.</span></p>}
              <div className="ac-actions">
                {c.merge ? <span className="small">Fusion {c.merge.id} : <Status s={c.merge.status} /></span>
                  : hasRole(roles, 'R12', 'R07') && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setPropose(c); setPf({ survivor: 'a', evidence: '', documentRef: '' }); }}>Proposer une fusion</button>}
              </div>
            </article>
          )))}
          {act.node}
        </section>
      )}

      {tab === 'fusions' && canDup && (
        <section className="ac-stack" aria-label="Fusions">
          {dups.data && (dups.data.merges.length === 0 ? <EmptyState title="Aucune demande de fusion" /> : dups.data.merges.map((m) => (
            <article key={m.id} className="ac-card">
              <div className="ac-card-head">
                <div className="min0"><p className="ac-card-title">{m.id} — <span className="mono">{m.absorbedId}</span> → <span className="mono">{m.survivorId}</span></p>
                  <div className="ac-meta"><span>Proposée par {m.proposedBy}</span>{m.verifiedBy && <span>Vérifiée par {m.verifiedBy}</span>}{m.approvedBy && <span>Approuvée par {m.approvedBy}</span>}</div></div>
                <Status s={m.status} />
              </div>
              <p className="small">Preuve : {m.evidence}{m.documentRef ? ` · pièce ${m.documentRef}` : ''}</p>
              {m.closeReason && <p className="small muted">Motif : {m.closeReason}</p>}
              <div className="ac-actions">
                {m.status === 'PROPOSEE' && hasRole(roles, 'R09', 'R07') && <button type="button" className="btn btn-primary btn-sm" onClick={() => mergeAction(m.id, 'verify', {}, 'Fusion vérifiée : approbation par une troisième personne attendue.')}>Vérifier</button>}
                {m.status === 'VERIFIEE' && hasRole(roles, 'R06', 'R07') && <button type="button" className="btn btn-primary btn-sm" onClick={() => mergeAction(m.id, 'approve', {}, 'Fusion effectuée (réversible) ; les deux titulaires sont notifiés.')}>Approuver</button>}
                {['PROPOSEE', 'VERIFIEE'].includes(m.status) && hasRole(roles, 'R06', 'R07') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => mergeAction(m.id, 'close', { action: 'REJETER', motif: 'Preuve insuffisante' }, 'Demande rejetée.')}>Rejeter</button>}
                {m.status === 'EFFECTUEE' && hasRole(roles, 'R06', 'R07') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => mergeAction(m.id, 'close', { action: 'ANNULER', motif: 'Annulation de la fusion (erreur constatée)' }, 'Fusion annulée : comptes rétablis.')}>Annuler la fusion</button>}
              </div>
            </article>
          )))}
          {act.node}
        </section>
      )}

      {tab === 'assiste' && user && hasRole(roles, 'R10', 'R12') && <AssistedEnrolment userId={user.id} {...(user.territory ? { territory: user.territory } : {})} />}

      <Drawer open={!!review} title="Contrôle d’une pièce" onClose={() => setReview(null)}>
        {review && (
          <div className="form">
            <p><strong>{PROOF_LABEL[review.type]}</strong> · <span className="mono">{review.referenceMasked}</span></p>
            <p className="small muted">{review.taxpayer.fullName} · {review.taxpayer.iuc}</p>
            <p className="small">Le contrôle est fait par une personne distincte de celle qui a saisi la pièce. Le niveau de vérification est recalculé automatiquement ; il ne baisse jamais d’office.</p>
            <div className="field"><label className="label" htmlFor="rv-note">Observation</label><input id="rv-note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
            {act.node}
            <div className="btn-row">
              <button type="button" className="btn btn-primary" disabled={act.busy || note.trim().length < 3} onClick={() => void act.run(() => api<{ verificationLevel: string }>(`/v1/acces/identity-proofs/${review.id}/review`, { method: 'POST', body: { decision: 'VALIDEE', note } }), (r) => `Pièce validée ; niveau du compte : ${r.verificationLevel}.`).then((r) => { if (r) { setReview(null); proofs.reload(); } })}>Valider</button>
              <button type="button" className="btn btn-secondary" disabled={act.busy || note.trim().length < 3} onClick={() => void act.run(() => api(`/v1/acces/identity-proofs/${review.id}/review`, { method: 'POST', body: { decision: 'REJETEE', note } }), 'Pièce rejetée (motif tracé).').then((r) => { if (r) { setReview(null); proofs.reload(); } })}>Rejeter</button>
            </div>
          </div>
        )}
      </Drawer>
      <Drawer open={!!propose} title="Proposer une fusion d’identités" onClose={() => setPropose(null)}>
        {propose && (
          <div className="form">
            <fieldset className="field"><legend className="label">Compte conservé</legend>
              <div className="radio-list">
                {(['a', 'b'] as const).map((k) => (
                  <label key={k} className={`radio ${pf.survivor === k ? 'checked' : ''}`}><input type="radio" name="surv" checked={pf.survivor === k} onChange={() => setPf({ ...pf, survivor: k })} /><span>{propose[k].fullName} ({propose[k].iuc})</span></label>
                ))}
              </div></fieldset>
            <div className="field"><label className="label" htmlFor="pf-e">Preuve constatée</label><textarea id="pf-e" rows={3} value={pf.evidence} onChange={(e) => setPf({ ...pf, evidence: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="pf-d">Référence de la pièce justificative{propose.nameOnly ? ' (obligatoire)' : ''}</label><input id="pf-d" value={pf.documentRef} onChange={(e) => setPf({ ...pf, documentRef: e.target.value })} /></div>
            <p className="small muted">Les preuves des deux comptes sont conservées ; les obligations et objets ne sont jamais réécrits.</p>
            {act.node}
            <button type="button" className="btn btn-primary" disabled={act.busy || pf.evidence.trim().length < 10}
              onClick={() => void act.run(() => api('/v1/acces/merges', { method: 'POST', body: {
                survivorId: propose[pf.survivor].id, absorbedId: propose[pf.survivor === 'a' ? 'b' : 'a'].id, evidence: pf.evidence.trim(), ...(pf.documentRef ? { documentRef: pf.documentRef } : {}),
              } }), 'Fusion proposée : vérification par une autre personne attendue.').then((r) => { if (r) { setPropose(null); dups.reload(); } })}>Proposer</button>
          </div>
        )}
      </Drawer>
      <div style={{ marginTop: 24 }}><ExampleNotice text="Comptes, pièces et doublons de démonstration (données fictives)." /></div>
    </div>
  );
}
