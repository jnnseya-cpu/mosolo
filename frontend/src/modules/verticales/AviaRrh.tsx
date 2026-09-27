/**
 * MOSOLO AVIA (KIN-AVIA FISCUS) — écrans du Cahier v2.9, chapitre 11C, ajoutés à la console des verticales :
 *  - Pôle de rapprochement des recettes (Revenue Reconciliation Hub, RRH) : flux, rapprochement mensuel, propositions ;
 *  - Contrôle de l'identifiant fiscal aérien (IFA) par lecteur QR ;
 *  - Cadre : arrêté provincial (double validation), coordination, mesures décidées par l'autorité, clé alternative 65/35,
 *    chiffres du dossier source [À VÉRIFIER].
 * Constats et propositions seulement : aucune facturation, compensation ni sanction automatique.
 */
import { useState, type FormEvent } from 'react';
import { useApi } from '../../hooks/useApi';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { QrScanner } from '../../components/QrScanner';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api, describeError } from '../../lib/api';
import { useApp } from '../../context';

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true); setError(null); setOk(null);
    try { const r = await fn(); if (success) setOk(success); return r; } catch (e) { setError(describeError(e).message); return undefined; } finally { setBusy(false); }
  };
  return { busy, error, ok, run };
}
function Feedback({ a }: { a: { error: string | null; ok: string | null } }) {
  return <>{a.error && <p className="notice notice-err" role="alert">{a.error}</p>}{a.ok && <p className="notice notice-ok" role="status">{a.ok}</p>}</>;
}
const n = (v: number) => v.toLocaleString('fr-FR');

// ------------------------------------------------------------------------------------------------ types

interface FlightLine { flightNumber: string; flightDate: string; destinations: string[]; sold: number; boarded: number; boardedWithoutIfa: number; exited: number; verified: number; taxOnBoarded: string; freightDeclaredKg: number; freightManifestKg: number }
interface AirlineLine {
  airlineTaxpayerId: string; airlineName: string; ticketingConnected: boolean; declarationId: string | null; declarationStatus: string | null;
  sold: number; boarded: number; boardedWithoutIfa: number; exited: number; verified: number; taxOnBoarded: string; bspSettled: string; remitted: string; remittanceGap: string;
  freight: { declaredKg: number; manifestKg: number; gapKg: number }; flightLines: FlightLine[]; hasGap: boolean; gapLabels: string[];
  proposal: { kind: string; label: string; status: 'PROPOSEE' | 'SOUMISE' | 'SANS_OBJET' }; submission?: { declarationId: string; declarationStatus: string };
}
interface Reconciliation { id: string; period: string; trigger: string; at: string; lines: AirlineLine[] }
interface Kpi { period: string; known: number; counted: number; verified: number; compensated: number; rates: { verified: string | null; compensated: string | null } }
interface Agency { id: string; name: string; kind: string; status: string; statusLabel: string }
interface Overview {
  notice: string; kpis: Kpi[]; agencies: Agency[];
  connectors: { code: string; label: string; state: string; example: boolean }[];
  reconciliations: { id: string; period: string; withGap: number; airlines: number }[];
}
interface SourceFigures { tag: string; notice: string; constat: { origin: string; rows: { label: string; value: string }[] }; scenarioPrudent: { origin: string; rows: { label: string; value: string }[]; principles: string[] } }
interface Cadre {
  availability: { available: boolean; reasons: string[]; act: { reference: string } | null };
  acts: { id: string; reference: string; title: string; signedOn: string; status: string; measuresEnabled: string[]; parameters: { penaltyPerTicketUsd: string | null; integrationDelayDays: number | null } }[];
  coordination: { partner: string; label: string; entry: { reference: string; confirmedAt: string } | null }[];
  measuresCatalogue: { code: string; label: string; computation: string }[];
  measures: { id: string; measure: string; airlineTaxpayerId: string; period: string; status: string; computation: { amountUsd: string | null; note: string }; decision?: { authority: string; reason: string } }[];
  alternativeKey: { label: string; statusLabel: string; reference: string };
  sourceFigures: SourceFigures;
  notice: string;
}

const TRIGGER_LABEL: Record<string, string> = { AUTOMATIQUE_MENSUEL: 'Automatique (calendrier mensuel)', ANALYSTE: 'Relancé par un analyste' };
const IFA_TONE: Record<string, 'good' | 'warning' | 'serious' | 'info'> = { VALIDE: 'good', SANS_IFA: 'warning', FALSIFIE: 'serious', INCONNU: 'warning', AUTRE_VOL: 'warning', DOUBLON: 'info' };

// ------------------------------------------------------------------------------------------------ chiffres source

/** Chiffres du dossier source (§ 11C.1) et scénario prudent (§ 11C.5) : affichés tels quels, jamais calculés. */
export function AviaSourceFigures({ f }: { f: SourceFigures }) {
  return (
    <section className="panel" aria-labelledby="avia-src">
      <h2 className="panel-title" id="avia-src"><Icon name="info" size={18} /> Chiffres du dossier source {f.tag}</h2>
      <p className="small muted">{f.notice}</p>
      <div className="vx-grid-2">
        <div>
          <p className="small"><strong>{f.constat.origin}</strong></p>
          <ul className="list-rows">{f.constat.rows.map((r) => <li key={r.label} className="list-row"><span>{r.label}</span><span className="small">{r.value} <em>{f.tag}</em></span></li>)}</ul>
        </div>
        <div>
          <p className="small"><strong>{f.scenarioPrudent.origin}</strong></p>
          <ul className="list-rows">{f.scenarioPrudent.rows.map((r) => <li key={r.label} className="list-row"><span>{r.label}</span><span className="small">{r.value} <em>{f.tag}</em></span></li>)}</ul>
          <p className="small muted">{f.scenarioPrudent.principles.join(' · ')}</p>
        </div>
      </div>
    </section>
  );
}

// ------------------------------------------------------------------------------------------------ RRH

function LineCard({ l, recId, onDone }: { l: AirlineLine; recId: string; onDone: () => void }) {
  const a = useAction();
  return (
    <li className="list-row list-row-stack">
      <div className="row-between">
        <div className="min0">
          <p className="row-title">{l.airlineName} <span className="mono small">{l.airlineTaxpayerId}</span></p>
          <p className="small muted">{l.ticketingConnected ? 'Billetterie transmise' : 'Billetterie non transmise'} · {l.declarationId ? `Déclaration ${l.declarationId}` : 'Aucune déclaration mensuelle'}</p>
        </div>
        <StatusBadge tone={l.hasGap ? 'warning' : 'good'} label={l.hasGap ? 'Écart constaté' : 'Concordant'} />
      </div>
      <p className="small">
        Vendus {n(l.sold)} · embarqués {n(l.boarded)} (dont {n(l.boardedWithoutIfa)} sans IFA) · sortis {n(l.exited)} · vérifiés {n(l.verified)} ·
        taxe des embarqués {l.taxOnBoarded} USD · réglé BSP {l.bspSettled} USD · crédité à la Ville {l.remitted} USD · écart {l.remittanceGap} USD ·
        fret déclaré {n(l.freight.declaredKg)} kg / manifesté {n(l.freight.manifestKg)} kg
      </p>
      {l.gapLabels.length > 0 && <ul className="small">{l.gapLabels.map((g) => <li key={g}>{g}</li>)}</ul>}
      <p className="small"><Icon name="scale" size={13} /> {l.proposal.label}{l.submission ? ` — soumise (déclaration ${l.submission.declarationId})` : ''}</p>
      <details>
        <summary className="small">Détail par vol ({l.flightLines.length})</summary>
        <DataTable rows={l.flightLines} rowKey={(f) => `${f.flightNumber}-${f.flightDate}`}
          columns={[
            { key: 'v', label: 'Vol', primary: true, render: (f) => `${f.flightNumber} · ${f.flightDate} → ${f.destinations.join(', ') || '—'}` },
            { key: 's', label: 'Vendus', num: true, render: (f) => f.sold },
            { key: 'b', label: 'Embarqués', num: true, render: (f) => f.boarded },
            { key: 'x', label: 'Sans IFA', num: true, render: (f) => f.boardedWithoutIfa },
            { key: 'e', label: 'Sortis', num: true, render: (f) => f.exited },
            { key: 't', label: 'Taxe embarqués (USD)', num: true, render: (f) => f.taxOnBoarded },
            { key: 'f', label: 'Fret décl./manif. (kg)', num: true, render: (f) => `${f.freightDeclaredKg} / ${f.freightManifestKg}` },
          ]} />
      </details>
      <Feedback a={a} />
      {l.proposal.status === 'PROPOSEE' && (
        <div className="row-actions">
          <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy}
            onClick={() => void a.run(async () => { await api(`/v1/verticales/avia/rrh/reconciliations/${encodeURIComponent(recId)}/lines/${encodeURIComponent(l.airlineTaxpayerId)}/submit`, { method: 'POST' }); onDone(); }, 'Écart soumis à la procédure contradictoire.')}>
            Soumettre à la procédure contradictoire
          </button>
        </div>
      )}
    </li>
  );
}

function AgencyRow({ ag, onDone }: { ag: Agency; onDone: () => void }) {
  const a = useAction();
  const [reason, setReason] = useState('');
  const decide = (decision: string, msg: string) => a.run(async () => { await api(`/v1/verticales/avia/rrh/agencies/${encodeURIComponent(ag.id)}/decision`, { method: 'POST', body: { decision, reason } }); onDone(); }, msg);
  return (
    <li className="list-row list-row-stack">
      <div className="row-between"><p className="row-title">{ag.name} <span className="small muted">({ag.kind === 'AGENT_FRET' ? 'agent de fret' : ag.kind === 'OPERATEUR_PARTIEL' ? 'opérateur partiel' : 'agence de voyages'})</span></p><StatusBadge tone={ag.status === 'CERTIFIEE' ? 'good' : ag.status === 'EN_ATTENTE' ? 'info' : 'warning'} label={ag.statusLabel} /></div>
      {(ag.status === 'EN_ATTENTE' || ag.status === 'CERTIFIEE') && (
        <div className="input-row">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motif de la décision" aria-label={`Motif — ${ag.name}`} />
          {ag.status === 'EN_ATTENTE' && <><button type="button" className="btn btn-primary btn-sm" disabled={a.busy || reason.trim().length < 5} onClick={() => void decide('CERTIFIEE', 'Compte certifié.')}>Certifier</button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || reason.trim().length < 5} onClick={() => void decide('REFUSEE', 'Certification refusée.')}>Refuser</button></>}
          {ag.status === 'CERTIFIEE' && <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || reason.trim().length < 5} onClick={() => void decide('SUSPENDUE', 'Compte suspendu.')}>Suspendre</button>}
        </div>
      )}
      <Feedback a={a} />
    </li>
  );
}

/** Pôle de rapprochement des recettes (Revenue Reconciliation Hub, RRH). */
export function AviaRrhSection() {
  const ov = useApi(() => api<Overview>('/v1/verticales/avia/rrh/overview'), []);
  const recs = useApi(() => api<Reconciliation[]>('/v1/verticales/avia/rrh/reconciliations'), []);
  const cadre = useApi(() => api<Cadre>('/v1/verticales/avia/cadre'), []);
  const a = useAction();
  const [period, setPeriod] = useState('');
  const reload = () => { ov.reload(); recs.reload(); };
  if (ov.loading) return <Loading />;
  if (ov.error || !ov.data) return <ErrorState error={ov.error} onRetry={ov.reload} />;
  const k = ov.data.kpis[0];
  const latestByPeriod = (recs.data ?? []).filter((r, i, all) => all.findIndex((x) => x.period === r.period) === i);
  const run = (e: FormEvent) => { e.preventDefault(); void a.run(async () => { await api('/v1/verticales/avia/rrh/reconciliations', { method: 'POST', body: { period } }); reload(); }, 'Rapprochement mensuel exécuté.'); };
  return (
    <div className="stack">
      <div className="callout callout-info"><Icon name="scale" size={18} /><p>{ov.data.notice}</p></div>
      {k && (
        <div className="vxc-kpis" aria-label="Indicateurs des départs">
          <div className="vxc-kpi"><strong>{n(k.known)}</strong><span>Départs connus (billets avec IFA) — {k.period}</span></div>
          <div className="vxc-kpi"><strong>{n(k.counted)}</strong><span>Départs comptés (embarquements RVA)</span></div>
          <div className="vxc-kpi"><strong>{n(k.verified)}</strong><span>Départs vérifiés (sortie DGM du même IFA){k.rates.verified ? ` — ${k.rates.verified} %` : ''}</span></div>
          <div className="vxc-kpi"><strong>{n(k.compensated)}</strong><span>Départs compensés (taxe créditée ou décision humaine){k.rates.compensated ? ` — ${k.rates.compensated} %` : ''}</span></div>
        </div>
      )}
      <section className="panel">
        <h2 className="panel-title"><Icon name="sync" size={18} /> Flux raccordés</h2>
        <ul className="list-rows">
          {ov.data.connectors.map((c) => <li key={c.code} className="list-row"><span>{c.label}</span><StatusBadge tone={c.state === 'RACCORDE' ? 'good' : 'neutral'} label={c.state === 'RACCORDE' ? (c.example ? 'Raccordé — [EXEMPLE]' : 'Raccordé') : 'Accord d’accès requis'} /></li>)}
          <li className="list-row"><span>Interface des compagnies structurées (API — ventes GDS, contrôle des départs DCS)</span><StatusBadge tone="info" label="Ouverte aux compagnies" /></li>
          <li className="list-row"><span>Embarquements (Régie des Voies Aériennes, RVA) · sorties (Direction Générale de Migration, DGM)</span><StatusBadge tone="info" label="Partenaires de données" /></li>
          <li className="list-row"><span>Reversements : relevés BSP et banques collectrices</span><StatusBadge tone="info" label="Partenaires" /></li>
        </ul>
      </section>
      <section className="panel">
        <h2 className="panel-title"><Icon name="table" size={18} /> Rapprochement mensuel : vendus ↔ embarqués ↔ sortis ↔ reversés</h2>
        <form className="input-row" onSubmit={run}>
          <input type="month" required value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Mois à rapprocher" />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={a.busy || !period}>Relancer le rapprochement du mois</button>
        </form>
        <Feedback a={a} />
        {recs.loading && <Loading />}
        {!!recs.error && <ErrorState error={recs.error} onRetry={recs.reload} />}
        {recs.data && latestByPeriod.length === 0 && <EmptyState title="Aucun rapprochement" />}
        {latestByPeriod.map((r) => (
          <div key={r.id} className="stack">
            <p className="small"><strong>{r.period}</strong> — {TRIGGER_LABEL[r.trigger] ?? r.trigger} · <span className="mono">{r.id}</span></p>
            <ul className="list-rows">{r.lines.map((l) => <LineCard key={l.airlineTaxpayerId} l={l} recId={r.id} onDone={reload} />)}</ul>
          </div>
        ))}
      </section>
      <section className="panel">
        <h2 className="panel-title"><Icon name="store" size={18} /> Portail des agences et opérateurs partiels (comptes certifiés)</h2>
        {ov.data.agencies.length === 0 ? <EmptyState title="Aucune agence" /> : <ul className="list-rows">{ov.data.agencies.map((ag) => <AgencyRow key={ag.id} ag={ag} onDone={ov.reload} />)}</ul>}
      </section>
      {cadre.data && <AviaSourceFigures f={cadre.data.sourceFigures} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ contrôle IFA

/** Contrôle terrain de l'identifiant fiscal aérien (IFA) par lecteur QR : constat journalisé, aucune mesure appliquée. */
export function AviaIfaControlSection() {
  const a = useAction();
  const [scan, setScan] = useState(false);
  const [form, setForm] = useState({ code: '', flightNumber: '', place: 'Aéroport international de N’Djili' });
  const [res, setRes] = useState<{ result: string; resultLabel: string; ifa: string | null; flight: { flightNumber: string; flightDate: string; destination: string } | null; boarded: boolean; exited: boolean; measure: { available: boolean; notice: string } | null } | null>(null);
  const control = (raw?: string) => void a.run(async () => {
    const code = (raw ?? form.code).trim();
    const body = { ...(code.startsWith('MT1.') ? { qr: code } : code ? { ifa: code } : {}), ...(form.flightNumber ? { flightNumber: form.flightNumber.toUpperCase() } : {}), place: form.place };
    setRes(await api('/v1/verticales/avia/ifa/controls', { method: 'POST', body }));
  });
  return (
    <div className="stack">
      <div className="callout callout-info"><Icon name="qr" size={18} /><p>Le QR fiscal de la carte d’embarquement porte l’IFA signé : il se vérifie hors ligne avec la clé publique des titres. Le contrôle constate et journalise ; aucune mesure n’est appliquée par le système.</p></div>
      <section className="panel">
        <h2 className="panel-title"><Icon name="qr" size={18} /> Contrôle par lecteur QR</h2>
        <form className="form" onSubmit={(e) => { e.preventDefault(); control(); }}>
          <label className="field"><span className="label">Contenu du QR ou code IFA (vide : passager sans IFA)</span><textarea rows={2} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></label>
          <div className="field-row">
            <label className="field"><span className="label">Vol (facultatif)</span><input value={form.flightNumber} onChange={(e) => setForm({ ...form, flightNumber: e.target.value })} /></label>
            <label className="field"><span className="label">Lieu du contrôle</span><input required value={form.place} onChange={(e) => setForm({ ...form, place: e.target.value })} /></label>
          </div>
          <div className="row-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setScan(true)}><Icon name="camera" size={16} /> Scanner le QR</button>
            <button type="submit" className="btn btn-primary btn-sm" disabled={a.busy}>Contrôler</button>
          </div>
        </form>
        {scan && <QrScanner onResult={(raw) => { setScan(false); setForm({ ...form, code: raw }); control(raw); }} onClose={() => setScan(false)} />}
        <Feedback a={a} />
        {res && (
          <div className="stack" role="status">
            <StatusBadge tone={IFA_TONE[res.result] ?? 'info'} label={res.resultLabel} />
            {res.ifa && <p className="small mono">{res.ifa}</p>}
            {res.flight && <p className="small">Vol {res.flight.flightNumber} du {res.flight.flightDate} → {res.flight.destination} · embarquement {res.boarded ? 'scanné' : 'non scanné'} · sortie DGM {res.exited ? 'validée' : 'non validée'}</p>}
            {res.measure && <p className="small"><Icon name="scale" size={13} /> {res.measure.notice}</p>}
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ cadre

const MEASURE_LABEL: Record<string, string> = {
  BILLET_SANS_IFA_NON_VALIDABLE: 'Billet sans IFA non validable au départ', PENALITE_ELECTRONIQUE: 'Pénalité électronique',
  SUSPENSION_ACCES_DEPART: 'Suspension d’accès au départ', RETRAIT_AGREMENT: 'Retrait d’agrément',
};

/** Arrêté provincial, coordination, mesures décidées par l'autorité compétente, clé alternative 65/35. */
export function AviaCadreSection() {
  const { fmtDate } = useApp();
  const q = useApi(() => api<Cadre>('/v1/verticales/avia/cadre'), []);
  const a = useAction();
  const [act, setAct] = useState({ reference: '', title: '', signedOn: '', documentSha256: '', measures: [] as string[], penalty: '', delay: '' });
  const [valReason, setValReason] = useState('');
  const [coord, setCoord] = useState<Record<string, string>>({});
  const [prop, setProp] = useState({ measure: 'BILLET_SANS_IFA_NON_VALIDABLE', airlineTaxpayerId: '', period: '' });
  const [dec, setDec] = useState<Record<string, { authority: string; reason: string }>>({});
  const [amount, setAmount] = useState('');
  const [sim, setSim] = useState<{ baseUsd: string; villeUsd: string; groupeUsd: string; notice: string; baseSource: string } | null>(null);
  if (q.loading) return <Loading />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const c = q.data;
  const post = (path: string, body: unknown, msg: string) => a.run(async () => { await api(path, { method: 'POST', body }); q.reload(); }, msg);
  const recordAct = (e: FormEvent) => { e.preventDefault(); void post('/v1/verticales/avia/cadre/actes', {
    reference: act.reference, title: act.title, signedOn: act.signedOn, documentSha256: act.documentSha256.trim().toLowerCase(), measuresEnabled: act.measures,
    parameters: { penaltyPerTicketUsd: act.penalty.trim() || null, integrationDelayDays: act.delay.trim() ? Number(act.delay) : null },
  }, 'Arrêté enregistré — seconde validation requise.'); };
  return (
    <div className="stack">
      <div className="callout callout-info"><Icon name="scale" size={18} /><p>{c.notice}</p></div>
      <Feedback a={a} />
      <section className="panel">
        <h2 className="panel-title"><Icon name="lock" size={18} /> Disponibilité des mesures</h2>
        <StatusBadge tone={c.availability.available ? 'good' : 'neutral'} label={c.availability.available ? `Ouvertes — arrêté ${c.availability.act?.reference ?? ''}` : 'Indisponibles — acte requis'} />
        {c.availability.reasons.map((r) => <p key={r} className="small">{r}</p>)}
      </section>
      <section className="panel">
        <h2 className="panel-title"><Icon name="file" size={18} /> Arrêté provincial (référence de l’acte + double validation)</h2>
        {c.acts.length > 0 && (
          <ul className="list-rows">{c.acts.map((x) => (
            <li key={x.id} className="list-row list-row-stack">
              <div className="row-between"><p className="row-title">{x.reference} — {x.title}</p><StatusBadge tone={x.status === 'ENREGISTRE' ? 'good' : x.status === 'EN_ATTENTE_VALIDATION' ? 'info' : 'neutral'} label={x.status === 'ENREGISTRE' ? 'Enregistré' : x.status === 'EN_ATTENTE_VALIDATION' ? 'En attente de seconde validation' : x.status === 'REMPLACE' ? 'Remplacé' : 'Rejeté'} /></div>
              <p className="small muted">Signé le {fmtDate(x.signedOn)} · mesures : {x.measuresEnabled.map((m) => MEASURE_LABEL[m] ?? m).join(', ') || 'aucune'} · pénalité par billet : {x.parameters.penaltyPerTicketUsd ? `${x.parameters.penaltyPerTicketUsd} USD` : 'non fixée'}</p>
              {x.status === 'EN_ATTENTE_VALIDATION' && (
                <div className="input-row">
                  <input value={valReason} onChange={(e) => setValReason(e.target.value)} placeholder="Motif de la seconde validation" aria-label="Motif de la seconde validation" />
                  <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || valReason.trim().length < 5} onClick={() => void post(`/v1/verticales/avia/cadre/actes/${x.id}/validate`, { approve: true, reason: valReason }, 'Arrêté enregistré.')}>Valider</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || valReason.trim().length < 5} onClick={() => void post(`/v1/verticales/avia/cadre/actes/${x.id}/validate`, { approve: false, reason: valReason }, 'Arrêté rejeté.')}>Rejeter</button>
                </div>
              )}
            </li>
          ))}</ul>
        )}
        <form className="form vx-inline-form" onSubmit={recordAct}>
          <div className="field-row">
            <label className="field"><span className="label">Référence de l’arrêté</span><input required value={act.reference} onChange={(e) => setAct({ ...act, reference: e.target.value })} /></label>
            <label className="field"><span className="label">Intitulé</span><input required value={act.title} onChange={(e) => setAct({ ...act, title: e.target.value })} /></label>
            <label className="field"><span className="label">Date de signature</span><input type="date" required value={act.signedOn} onChange={(e) => setAct({ ...act, signedOn: e.target.value })} /></label>
          </div>
          <label className="field"><span className="label">Empreinte SHA-256 du texte</span><input required pattern="[0-9a-fA-F]{64}" value={act.documentSha256} onChange={(e) => setAct({ ...act, documentSha256: e.target.value })} /></label>
          <fieldset className="field"><legend className="label">Mesures prévues par l’arrêté</legend>
            {c.measuresCatalogue.map((m) => <label key={m.code} className="check"><input type="checkbox" checked={act.measures.includes(m.code)} onChange={(e) => setAct({ ...act, measures: e.target.checked ? [...act.measures, m.code] : act.measures.filter((x) => x !== m.code) })} /> {m.label}</label>)}
          </fieldset>
          <div className="field-row">
            <label className="field"><span className="label">Pénalité par billet fixée par l’arrêté (USD, vide = non fixée)</span><input inputMode="decimal" value={act.penalty} onChange={(e) => setAct({ ...act, penalty: e.target.value })} /></label>
            <label className="field"><span className="label">Délai d’intégration (jours, vide = non fixé)</span><input inputMode="numeric" value={act.delay} onChange={(e) => setAct({ ...act, delay: e.target.value })} /></label>
          </div>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={a.busy}>Enregistrer l’arrêté</button>
        </form>
      </section>
      <section className="panel">
        <h2 className="panel-title"><Icon name="users" size={18} /> Coordination (RVA, DGM, aviation civile, compagnies)</h2>
        <ul className="list-rows">{c.coordination.map((p) => (
          <li key={p.partner} className="list-row list-row-stack">
            <div className="row-between"><span>{p.label}</span><StatusBadge tone={p.entry ? 'good' : 'neutral'} label={p.entry ? `Confirmée — ${p.entry.reference}` : 'À confirmer'} /></div>
            {!p.entry && <div className="input-row"><input value={coord[p.partner] ?? ''} onChange={(e) => setCoord({ ...coord, [p.partner]: e.target.value })} placeholder="Référence du protocole ou du procès-verbal" aria-label={`Référence — ${p.partner}`} />
              <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy || (coord[p.partner] ?? '').trim().length < 3} onClick={() => void post(`/v1/verticales/avia/cadre/coordination/${p.partner}`, { reference: coord[p.partner] }, 'Coordination confirmée.')}>Confirmer</button></div>}
          </li>
        ))}</ul>
      </section>
      <section className="panel">
        <h2 className="panel-title"><Icon name="alert" size={18} /> Mesures : le système calcule, l’autorité compétente décide au cas par cas</h2>
        <ul className="list-rows">{c.measuresCatalogue.map((m) => <li key={m.code} className="list-row"><span>{m.label}</span><span className="small muted">{m.computation}</span></li>)}</ul>
        <form className="input-row" onSubmit={(e) => { e.preventDefault(); void post('/v1/verticales/avia/cadre/mesures', prop, 'Mesure proposée — décision de l’autorité requise.'); }}>
          <select value={prop.measure} onChange={(e) => setProp({ ...prop, measure: e.target.value })} aria-label="Mesure">{c.measuresCatalogue.map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}</select>
          <input required value={prop.airlineTaxpayerId} onChange={(e) => setProp({ ...prop, airlineTaxpayerId: e.target.value })} placeholder="Compagnie (identifiant)" aria-label="Compagnie" />
          <input type="month" required value={prop.period} onChange={(e) => setProp({ ...prop, period: e.target.value })} aria-label="Mois" />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={a.busy || !c.availability.available}>Proposer</button>
        </form>
        {c.measures.map((m) => (
          <div key={m.id} className="list-row list-row-stack">
            <div className="row-between"><p className="row-title">{MEASURE_LABEL[m.measure] ?? m.measure} — {m.airlineTaxpayerId} · {m.period}</p><StatusBadge tone={m.status === 'PROPOSEE' ? 'info' : m.status === 'RETENUE' ? 'warning' : 'neutral'} label={m.status === 'PROPOSEE' ? 'Proposée' : m.status === 'RETENUE' ? 'Retenue par l’autorité' : 'Écartée'} /></div>
            <p className="small">{m.computation.note}{m.computation.amountUsd ? ` → ${m.computation.amountUsd} USD (calcul)` : ''}</p>
            {m.decision && <p className="small muted">{m.decision.authority} : {m.decision.reason}</p>}
            {m.status === 'PROPOSEE' && (
              <div className="input-row">
                <input value={dec[m.id]?.authority ?? ''} onChange={(e) => setDec({ ...dec, [m.id]: { authority: e.target.value, reason: dec[m.id]?.reason ?? '' } })} placeholder="Autorité compétente" aria-label="Autorité compétente" />
                <input value={dec[m.id]?.reason ?? ''} onChange={(e) => setDec({ ...dec, [m.id]: { authority: dec[m.id]?.authority ?? '', reason: e.target.value } })} placeholder="Motif" aria-label="Motif de la décision" />
                <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy} onClick={() => void post(`/v1/verticales/avia/cadre/mesures/${m.id}/decide`, { decision: 'RETENUE', ...dec[m.id] }, 'Décision enregistrée.')}>Retenir</button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={a.busy} onClick={() => void post(`/v1/verticales/avia/cadre/mesures/${m.id}/decide`, { decision: 'ECARTEE', ...dec[m.id] }, 'Décision enregistrée.')}>Écarter</button>
              </div>
            )}
          </div>
        ))}
      </section>
      <section className="panel">
        <h2 className="panel-title"><Icon name="bank" size={18} /> {c.alternativeKey.label}</h2>
        <StatusBadge tone="neutral" label={c.alternativeKey.statusLabel} />
        <p className="small muted">{c.alternativeKey.reference}</p>
        <form className="input-row" onSubmit={(e) => { e.preventDefault(); void a.run(async () => setSim(await api(`/v1/verticales/avia/cadre/remuneration-alternative${amount.trim() ? `?amount=${encodeURIComponent(amount.trim())}` : ''}`))); }}>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Montant récupéré (USD) — vide : rattrapages constatés" aria-label="Montant récupéré" />
          <button type="submit" className="btn btn-secondary btn-sm" disabled={a.busy}>Simuler</button>
        </form>
        {sim && <p className="small" role="status">Simulation : base {sim.baseUsd} USD ({sim.baseSource}) → Ville {sim.villeUsd} USD · Groupe {sim.groupeUsd} USD. {sim.notice}</p>}
      </section>
      <AviaSourceFigures f={c.sourceFigures} />
    </div>
  );
}
