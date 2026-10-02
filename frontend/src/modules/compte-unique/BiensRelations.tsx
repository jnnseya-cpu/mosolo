/**
 * « Mes biens et relations » (spécification « Liaison des biens et occupations » v1.0, 28/09/2026) — espace de la
 * personne : revendications (propriétaire, locataire, occupant, gestionnaire, exploitant) et leurs états, choix d'un
 * candidat ou « Mon adresse n'y figure pas », pièces (empreinte calculée sur l'appareil), invitations à envoyer et à
 * accepter, contestation, fin datée (déménagement) et historique. Une revendication ne vaut ni titre ni bail : elle
 * est vérifiée par une personne habilitée. Aucune donnée de l'autre partie n'est affichée avant vérification.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError, newIdempotencyKey } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { BarChartViz, KpiGrid, KpiTile } from '../../components/viz';
import { CLAIM_ORDER, CLAIM_ROLE, CLAIM_STATUS, RECORD_STATUS, sha256OfFile } from './common';
import type { Candidats, ClaimView, MesRelations } from './types';
import './compte-unique.css';

const COMMUNES = ['Bandalungwa', 'Barumbu', 'Bumbu', 'Gombe', 'Kalamu', 'Kasa-Vubu', 'Kimbanseke', 'Kinshasa', 'Kintambo', 'Kisenso', 'Lemba', 'Limete', 'Lingwala', 'Makala', 'Maluku', 'Masina', 'Matete', 'Mont-Ngafula', 'Ndjili', 'Ngaba', 'Ngaliema', 'Ngiri-Ngiri', 'Nsele', 'Selembao'];
const EVIDENCE_TYPES: Record<string, string> = {
  TITRE_FONCIER: 'Titre foncier', CERTIFICAT_ENREGISTREMENT: 'Certificat d’enregistrement', ACTE_DE_VENTE: 'Acte de vente', CONTRAT_DE_LOCATION: 'Contrat de location (bail)',
  QUITTANCE_LOYER: 'Quittance de loyer', FACTURE_SERVICE: 'Facture d’eau ou d’électricité', ATTESTATION_COUTUMIERE: 'Attestation coutumière', ACTE_SUCCESSORAL: 'Acte successoral',
  MANDAT_DE_GESTION: 'Mandat de gestion', AUTORISATION_EXPLOITATION: 'Autorisation d’exploitation', AUTRE: 'Autre pièce',
};

interface AddressForm { commune: string; quartier: string; avenue: string; number: string; building_label: string; unit_label: string; official_ref: string }
const EMPTY: AddressForm = { commune: 'Limete', quartier: '', avenue: '', number: '', building_label: '', unit_label: '', official_ref: '' };
const clean = (a: AddressForm) => Object.fromEntries(Object.entries(a).filter(([, v]) => v.trim() !== '').map(([k, v]) => [k, v.trim()]));

export default function BiensRelations() {
  const { user } = useApp();
  const q = useApi<MesRelations>(() => api<MesRelations>('/v1/moi/relations-biens'), [user?.id]);
  const [candidats, setCandidats] = useState<Candidats | null>(null);
  const d = q.data;
  const all = d ? [...d.actuelles, ...d.historiques] : [];
  const owners = all.filter((c) => (c.role === 'OWNER' || c.role === 'MANAGER') && c.statut === 'VERIFIED' && c.bien);

  return (
    <div className="page">
      <PageHead eyebrow="Mon compte unique" title="Mes biens et relations"
        lead="Un compte, plusieurs rôles : propriétaire ici, locataire là, exploitant ailleurs. Chaque relation est revendiquée, puis vérifiée par une personne habilitée ; l’historique est conservé." />
      {q.loading && <Loading />}
      {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
      {d && (
        <>
          <p className="notice" role="note"><Icon name="info" size={16} /> {d.mentionJuridique}</p>
          <KpiGrid max={4} label="Mes relations">
            <KpiTile label="Relations en cours" value={d.actuelles.length} />
            <KpiTile label="Vérifiées" value={d.actuelles.filter((c) => c.statut === 'VERIFIED').length} state={{ label: 'Vérifiée', tone: 'good' }} />
            <KpiTile label="À vérifier" value={d.actuelles.filter((c) => c.statut !== 'VERIFIED').length} />
            <KpiTile label="Historique (terminées)" value={d.historiques.length} />
          </KpiGrid>
          <BarChartViz title="Mes relations par état" orientation="horizontal" series={[{ key: 'n', label: 'Relations' }]}
            rows={d.parStatut.filter((s) => s.nombre > 0).sort((a, b) => CLAIM_ORDER.indexOf(a.statut) - CLAIM_ORDER.indexOf(b.statut)).map((s) => ({ key: s.statut, label: CLAIM_STATUS[s.statut]?.label ?? s.libelle, values: { n: s.nombre } }))}
            emptyText="Aucune relation pour l’instant" />
          {owners.length > 0 && (
            <nav className="cu-modules" aria-label="Mes bâtiments">
              {owners.map((c) => <Link key={c.claimId} className="chip" to={`/espace/biens/${encodeURIComponent(c.bien!.id)}`}><Icon name="building" size={14} /> Vue du propriétaire — {c.bien!.libelle}</Link>)}
            </nav>
          )}
          <div className="br-grid">
            <NouvelleRevendication drafts={d.actuelles.filter((c) => c.statut === 'DRAFT')} onDone={(c) => { setCandidats(c); q.reload(); }} />
            <RepondreInvitation onDone={q.reload} />
          </div>
          {candidats && <ChoixCandidat c={candidats} onDone={() => { setCandidats(null); q.reload(); }} />}
          <DeclarerBien onDone={q.reload} />
          <section className="section" aria-labelledby="br-cur">
            <div className="section-head"><h2 id="br-cur">Relations en cours</h2><span className="count">{d.actuelles.length}</span></div>
            {d.actuelles.length === 0 ? <EmptyState title="Aucune relation en cours" /> : d.actuelles.map((c) => <ClaimCard key={c.claimId} c={c} onChanged={q.reload} onCandidates={setCandidats} />)}
          </section>
          <section className="section" aria-labelledby="br-hist">
            <div className="section-head"><h2 id="br-hist">Historique d’occupation</h2><span className="count">{d.historiques.length}</span></div>
            {d.historiques.length === 0 ? <EmptyState title="Aucune relation terminée" /> : d.historiques.map((c) => <ClaimCard key={c.claimId} c={c} onChanged={q.reload} onCandidates={setCandidats} />)}
          </section>
          {d.relationsModule7.length > 0 && (
            <section className="section" aria-labelledby="br-m7">
              <div className="section-head"><h2 id="br-m7">Relations déclarées au module 7</h2><span className="count">{d.relationsModule7.length}</span></div>
              <ul className="list-rows">{d.relationsModule7.map((r) => <li key={r.relationId} className="list-row"><span>{r.role} — {r.bien?.libelle ?? '—'}</span><StatusBadge tone={CLAIM_STATUS[r.statut]?.tone ?? 'neutral'} label={CLAIM_STATUS[r.statut]?.label ?? r.statut} /></li>)}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}

function AddressFields({ a, set, prefix }: { a: AddressForm; set: (a: AddressForm) => void; prefix: string }) {
  const f = (k: keyof AddressForm, label: string, hint?: string) => (
    <div className="field">
      <label className="label" htmlFor={`${prefix}-${k}`}>{label}</label>
      <input id={`${prefix}-${k}`} value={a[k]} onChange={(e) => set({ ...a, [k]: e.target.value })} />
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
  return (
    <>
      <div className="field">
        <label className="label" htmlFor={`${prefix}-commune`}>Commune</label>
        <select id={`${prefix}-commune`} value={a.commune} onChange={(e) => set({ ...a, commune: e.target.value })}>{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select>
      </div>
      {f('quartier', 'Quartier')}
      {f('avenue', 'Avenue')}
      {f('number', 'Numéro')}
      {f('building_label', 'Bâtiment (si plusieurs)', 'Facultatif')}
      {f('unit_label', 'Unité (appartement, porte)', 'Facultatif ; « MAIN » pour une maison individuelle')}
      {f('official_ref', 'Référence du bien si connue', 'Identifiant officiel ou code KIN-… ; facultatif')}
    </>
  );
}

function NouvelleRevendication({ drafts, onDone }: { drafts: ClaimView[]; onDone: (c: Candidats | null) => void }) {
  const [role, setRole] = useState('TENANT');
  const [a, setA] = useState<AddressForm>(EMPTY);
  const [from, setFrom] = useState('');
  const [joint, setJoint] = useState(false);
  const [share, setShare] = useState('');
  const [draftId, setDraftId] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const draft = drafts.find((x) => x.claimId === draftId);
      const r = await api<ClaimView>('/v1/revendications-biens', {
        method: 'POST', idempotencyKey: newIdempotencyKey(),
        body: { role, address: clean(a), ...(from ? { valid_from: from } : {}), ...(joint ? { joint_tenancy: true } : {}), ...(share ? { share } : {}), ...(draft ? { claim_id: draft.claimId, version: draft.version } : {}) },
      });
      if (r.suite === 'CHOISIR_CANDIDAT') onDone(await api<Candidats>(`/v1/biens-candidats?revendication=${encodeURIComponent(r.claimId)}`));
      else { setMsg(r.candidats === 0 ? 'Aucun bien correspondant : un bien provisoire a été enregistré (sans effet fiscal). Ajoutez une pièce ou invitez l’autre partie.' : 'Revendication enregistrée.'); onDone(null); }
    } catch (x) { setMsg(describeError(x).message); } finally { setBusy(false); }
  }
  return (
    <form className="panel br-form" onSubmit={(e) => void submit(e)} aria-labelledby="br-new">
      <h2 id="br-new" className="br-full">Revendiquer une relation à un bien</h2>
      <fieldset className="br-full">
        <legend className="label">Mon rôle</legend>
        <div className="br-roles">{Object.entries(CLAIM_ROLE).map(([k, l]) => <label key={k} className="check"><input type="radio" name="br-role" value={k} checked={role === k} onChange={() => setRole(k)} /><span>{l}</span></label>)}</div>
      </fieldset>
      {drafts.length > 0 && (
        <div className="field br-full">
          <label className="label" htmlFor="br-draft">Compléter un brouillon ouvert à l’inscription</label>
          <select id="br-draft" value={draftId} onChange={(e) => { setDraftId(e.target.value); const dr = drafts.find((x) => x.claimId === e.target.value); if (dr) setRole(dr.role); }}>
            <option value="">— Nouvelle revendication —</option>
            {drafts.map((x) => <option key={x.claimId} value={x.claimId}>{CLAIM_ROLE[x.role] ?? x.role} (brouillon)</option>)}
          </select>
        </div>
      )}
      <AddressFields a={a} set={setA} prefix="br" />
      <div className="field"><label className="label" htmlFor="br-from">Depuis le (si connu)</label><input id="br-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
      {role === 'OWNER' && <div className="field"><label className="label" htmlFor="br-share">Quote-part (%) en copropriété</label><input id="br-share" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} /></div>}
      {role === 'TENANT' && <label className="check"><input type="checkbox" checked={joint} onChange={(e) => setJoint(e.target.checked)} /><span>Colocation (plusieurs locataires)</span></label>}
      <p className="small muted br-full">Ni le nom, ni le téléphone de l’autre partie ne sont demandés : le rapprochement se fait sur l’adresse, l’unité, la référence du bien et la position.</p>
      {msg && <p className="notice br-full" role="status">{msg}</p>}
      <button type="submit" className="btn btn-primary br-full" disabled={busy}>{busy ? 'Envoi…' : 'Rechercher mon bien et soumettre'}</button>
    </form>
  );
}

function ChoixCandidat({ c, onDone }: { c: Candidats; onDone: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const choose = async (body: Record<string, unknown>) => {
    setErr(null);
    try { await api(`/v1/revendications-biens/${encodeURIComponent(c.claimId)}/choix-candidat`, { method: 'POST', idempotencyKey: newIdempotencyKey(), body }); onDone(); } catch (x) { setErr(describeError(x).message); }
  };
  return (
    <section className="panel" aria-labelledby="br-cand">
      <h2 id="br-cand">Est-ce votre bien ?</h2>
      <p className="small muted">{c.avertissement}</p>
      <ul className="list-rows">
        {c.candidats.map((x) => (
          <li key={x.candidateId} className="list-row">
            <div className="min0"><p className="row-title">{x.libelle}</p><StatusBadge tone={RECORD_STATUS[x.statutEnregistrement]?.tone ?? 'neutral'} label={RECORD_STATUS[x.statutEnregistrement]?.label ?? x.statutEnregistrement} /></div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void choose({ candidate_id: x.candidateId })}>C’est mon bien</button>
          </li>
        ))}
      </ul>
      <button type="button" className="btn btn-secondary" onClick={() => void choose({ aucun: true })}>{c.aucun.libelle}</button>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
    </section>
  );
}

function RepondreInvitation({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState(() => new URLSearchParams(window.location.search).get('invitation') ?? '');
  const [claim, setClaim] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const answer = async (reponse: string) => {
    setMsg(null);
    try {
      const r = await api<{ message: string }>(`/v1/invitations-biens/${encodeURIComponent(token.trim())}/reponse`, { method: 'POST', idempotencyKey: newIdempotencyKey(), body: { reponse, ...(reponse === 'ACCEPTER' && claim ? { creer_ma_revendication: true } : {}) } });
      setMsg(r.message); onDone();
    } catch (x) { setMsg(describeError(x).message); }
  };
  return (
    <div className="panel br-form" aria-labelledby="br-inv">
      <h2 id="br-inv" className="br-full">Répondre à une invitation</h2>
      <div className="field br-full"><label className="label" htmlFor="br-token">Code de l’invitation reçue</label><input id="br-token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></div>
      <label className="check br-full"><input type="checkbox" checked={claim} onChange={(e) => setClaim(e.target.checked)} /><span>Créer aussi ma propre revendication sur ce bien</span></label>
      <p className="small muted br-full">Accepter confirme l’association ; la relation reste vérifiée par une personne habilitée. L’identité de la personne qui invite n’est pas affichée.</p>
      <div className="br-actions br-full">
        <button type="button" className="btn btn-primary btn-sm" disabled={!token.trim()} onClick={() => void answer('ACCEPTER')}>Accepter</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!token.trim()} onClick={() => void answer('REFUSER')}>Refuser</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!token.trim()} onClick={() => void answer('BIEN_ERRONE')}>Ce n’est pas le bon bien</button>
      </div>
      {msg && <p className="notice br-full" role="status">{msg}</p>}
    </div>
  );
}

function DeclarerBien({ onDone }: { onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [a, setA] = useState<AddressForm>(EMPTY);
  const [units, setUnits] = useState('');
  const [tenants, setTenants] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    const labels = units.split(',').map((s) => s.trim()).filter(Boolean);
    const contacts = tenants.split(',').map((s) => s.trim());
    try {
      const r = await api<{ units: { id: string; label: string }[]; doublonsEnRevue: number; invitations: unknown[] }>('/v1/biens-declares', {
        method: 'POST', idempotencyKey: newIdempotencyKey(),
        body: {
          plot: { commune: a.commune, quartier: a.quartier || 'À préciser', ...(a.avenue ? { avenue: a.avenue } : {}), ...(a.number ? { number: a.number } : {}), ...(a.official_ref ? { official_ref: a.official_ref } : {}), lat: -4.325, lon: 15.322 },
          ...(a.building_label ? { building: { label: a.building_label } } : {}),
          ...(labels.length ? { units: labels.map((l, i) => ({ label: l, ...(contacts[i] ? { locataire_connu: { contact: contacts[i] } } : {}) })) } : {}),
        },
      });
      setMsg(`Bien enregistré à titre provisoire : ${r.units.length} unité(s), ${r.invitations.length} invitation(s) envoyée(s)${r.doublonsEnRevue ? `, ${r.doublonsEnRevue} doublon(s) possible(s) transmis à la revue` : ''}.`);
      onDone();
    } catch (x) { setMsg(describeError(x).message); }
  }
  return (
    <section className="panel" aria-labelledby="br-decl">
      <button type="button" className="btn btn-ghost br-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="building" size={16} /> <span id="br-decl">Je suis propriétaire : déclarer mon bien, ses unités et mes locataires connus</span></button>
      {open && (
        <form className="br-form" onSubmit={(e) => void submit(e)}>
          <AddressFields a={a} set={setA} prefix="bd" />
          <div className="field br-full"><label className="label" htmlFor="bd-units">Unités (séparées par des virgules)</label><input id="bd-units" value={units} onChange={(e) => setUnits(e.target.value)} placeholder="1, 2, 3 — vide : maison individuelle (MAIN)" /></div>
          <div className="field br-full"><label className="label" htmlFor="bd-tenants">Contact des locataires connus, dans le même ordre (facultatif)</label><input id="bd-tenants" value={tenants} onChange={(e) => setTenants(e.target.value)} placeholder="+243…, , +243…" /><span className="hint">Une invitation opaque leur est envoyée ; aucun compte n’est créé pour eux.</span></div>
          {msg && <p className="notice br-full" role="status">{msg}</p>}
          <button type="submit" className="btn btn-primary br-full">Déclarer le bien</button>
        </form>
      )}
    </section>
  );
}

function ClaimCard({ c, onChanged }: { c: ClaimView; onChanged: () => void; onCandidates: (x: Candidats | null) => void }) {
  const { fmtDate } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const [evType, setEvType] = useState('CONTRAT_DE_LOCATION');
  const [contact, setContact] = useState('');
  const [sent, setSent] = useState<string | null>(null);
  const st = CLAIM_STATUS[c.statut] ?? { label: c.statutLibelle, tone: 'neutral' as const };
  const act = async (path: string, body: Record<string, unknown>) => {
    setErr(null);
    try { await api(`/v1/revendications-biens/${encodeURIComponent(c.claimId)}/${path}`, { method: 'POST', idempotencyKey: newIdempotencyKey(), body }); onChanged(); } catch (x) { setErr(describeError(x).message); }
  };
  const upload = async (file: File | undefined) => {
    if (!file) return;
    await act('preuves', { evidence_type: evType, sha256: await sha256OfFile(file), label: file.name.slice(0, 200), version: c.version });
  };
  const invite = async () => {
    setErr(null);
    try {
      const r = await api<{ expiresAt: string }>(`/v1/revendications-biens/${encodeURIComponent(c.claimId)}/invitations`, { method: 'POST', idempotencyKey: newIdempotencyKey(), body: { contact } });
      setSent(`Invitation envoyée (valable jusqu’au ${fmtDate(r.expiresAt)}).`); setContact(''); onChanged();
    } catch (x) { setErr(describeError(x).message); }
  };
  const open = !['REJECTED', 'SUPERSEDED', 'ENDED', 'DRAFT'].includes(c.statut);
  return (
    <article className="panel br-claim" aria-label={`${CLAIM_ROLE[c.role] ?? c.role} — ${c.bien?.libelle ?? 'adresse à compléter'}`}>
      <div className="br-claim-head">
        <h3 className="h-sub">{CLAIM_ROLE[c.role] ?? c.role}{c.quotePart ? ` · ${c.quotePart} %` : ''}{c.colocation ? ' · colocation' : ''}</h3>
        <StatusBadge tone={st.tone} label={st.label} />
      </div>
      <p className="row-title">{c.bien?.libelle ?? (c.adresseSaisie ? Object.values(c.adresseSaisie).join(', ') : 'Adresse à compléter')}</p>
      {c.bien && (
        <p className="small">
          {/* Provenance et confiance du BIEN, affichées à part du statut de la relation (§ 8). */}
          <StatusBadge tone={RECORD_STATUS[c.bien.statutEnregistrement]?.tone ?? 'neutral'} label={RECORD_STATUS[c.bien.statutEnregistrement]?.label ?? c.bien.statutEnregistrement} />{' '}
          <span className="muted">Provenance : {c.bien.provenance} · confiance {c.bien.confiance === 'ELEVEE' ? 'élevée' : 'faible'}</span>
        </p>
      )}
      <p className="small muted">{c.du ? `Depuis le ${fmtDate(c.du)}` : 'Date de début à préciser'}{c.au ? ` jusqu’au ${fmtDate(c.au)}` : ''}</p>
      {c.designationProprietaire && <p className="small">Propriétaire (pour votre attestation) : <strong>{c.designationProprietaire}</strong></p>}
      {c.pieces.length > 0 && <ul className="plain-list small">{c.pieces.map((p) => <li key={p.id}>{EVIDENCE_TYPES[p.type] ?? p.type} — <span className="mono">{p.sha256.slice(0, 12)}…</span> ({p.statut})</li>)}</ul>}
      {c.invitations.length > 0 && <ul className="plain-list small">{c.invitations.map((i) => <li key={i.id}>Invitation à {i.contact} — {i.statut === 'SANS_SUITE' ? 'sans suite (refusée ou expirée)' : i.statut === 'ACCEPTEE' ? 'acceptée' : 'en attente'}</li>)}</ul>}
      {open && (
        <div className="br-actions">
          <select aria-label="Type de pièce" value={evType} onChange={(e) => setEvType(e.target.value)}>{Object.entries(EVIDENCE_TYPES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <label className="btn btn-secondary btn-sm"><Icon name="file" size={14} /> Joindre une pièce<input type="file" hidden onChange={(e) => void upload(e.target.files?.[0])} /></label>
          <input aria-label="Contact de l’autre partie (téléphone ou courriel)" placeholder="Téléphone ou courriel de l’autre partie" value={contact} onChange={(e) => setContact(e.target.value)} />
          <button type="button" className="btn btn-ghost btn-sm" disabled={contact.trim().length < 6} onClick={() => void invite()}>Inviter</button>
          {c.statut !== 'DISPUTED' && c.statut !== 'UNDER_REVIEW' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const m = window.prompt('Motif de la contestation'); if (m) void act('contestations', { motif: m, version: c.version }); }}>Contester</button>}
          {c.statut === 'VERIFIED' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { const d = window.prompt('Date de fin (AAAA-MM-JJ)'); if (d) void act('fin', { valid_to: d, motif: 'Déménagement ou fin de la relation', version: c.version }); }}>J’ai déménagé / fin</button>}
        </div>
      )}
      {c.statut === 'REJECTED' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { const m = window.prompt('Motif de l’appel'); if (m) void act('appel', { motif: m }); }}>Faire appel</button>}
      {sent && <p className="notice" role="status">{sent}</p>}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <details className="small"><summary>Historique ({c.historique.length})</summary>
        <ol className="br-history">{c.historique.map((h, i) => <li key={`${h.at}-${i}`}>{fmtDate(h.at, true)} — {CLAIM_STATUS[h.to]?.label ?? h.to}{h.reason ? ` : ${h.reason}` : ''}</li>)}</ol>
      </details>
    </article>
  );
}
