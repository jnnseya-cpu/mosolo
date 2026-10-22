/**
 * Module 14 — Stationnement public (Spécification fonctionnelle) : écrans complémentaires de ParkSmart.
 *  - Exemptions (régie) : véhicules officiels et cas prévus par la règle ; demande avec pièces, décision d'une autre
 *    personne, révocation motivée.
 *  - Sessions par USSD ou SMS (usager) : simulateur du canal texte — même moteur que la passerelle de l'opérateur
 *    [À RACCORDER — convention requise].
 *  - Tous les titres actifs d'une plaque (contrôleur).
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';

export interface ActiveTitle { kind: 'SESSION' | 'RESERVATION' | 'TITRE' | 'EXEMPTION'; zone: string | null; reference: string; validFrom: string | null; validUntil: string | null; light: 'VERT' | 'AMBRE'; text: string }
interface Exemption {
  id: string; plate: string; category: 'VEHICULE_OFFICIEL' | 'CAS_PREVU_PAR_LA_REGLE'; holder: string; ruleCode: string | null; exemptionBasis: string | null; zoneIds: string[];
  validFrom: string; validUntil: string; motif: string; status: string; inForce: boolean; requestedBy: string; decision?: { by: string; motif: string };
}

const KIND_LABEL: Record<ActiveTitle['kind'], string> = { SESSION: 'Session', RESERVATION: 'Réservation', TITRE: 'Abonnement ou titre', EXEMPTION: 'Exemption' };
const STATUS: Record<string, { label: string; tone: 'good' | 'warning' | 'info' | 'neutral' | 'critical' }> = {
  DEMANDEE: { label: 'Demandée', tone: 'info' }, ACCORDEE: { label: 'Accordée', tone: 'good' }, REFUSEE: { label: 'Refusée', tone: 'critical' }, REVOQUEE: { label: 'Révoquée', tone: 'neutral' },
};

/** Liste des titres valables d'une plaque (sessions, réservations, titres § 19A, exemptions) — heure du serveur. */
export function ActiveTitles({ items }: { items: ActiveTitle[] | undefined }) {
  const { fmtDate } = useApp();
  if (!items) return null;
  return (
    <section className="panel" aria-label="Titres actifs de la plaque">
      <h3 className="panel-title"><Icon name="ticket" size={16} /> Tous les titres actifs de la plaque ({items.length})</h3>
      {items.length ? (
        <ul className="list-rows">{items.map((t) => (
          <li key={`${t.kind}-${t.reference}`} className="list-row">
            <StatusBadge tone={t.light === 'VERT' ? 'good' : 'warning'} label={KIND_LABEL[t.kind]} />
            <span>{t.text} — {t.zone ?? ''}{t.validUntil ? ` · jusqu’à ${t.kind === 'EXEMPTION' ? t.validUntil : fmtDate(t.validUntil, true)}` : ''}</span>
            <span className="mono small">{t.reference}</span>
          </li>
        ))}</ul>
      ) : <p className="small muted">Aucun titre valable à l’heure du serveur.</p>}
    </section>
  );
}

const sha256Hex = async (text: string) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** Régie : exemptions (demande par la régie, décision d'une AUTRE personne, révocation). */
export function ExemptionsPanel({ tick }: { tick: number }) {
  const { user } = useApp();
  const list = useApi(() => api<{ items: Exemption[] }>('/v1/parking/exemptions').then((r) => r.items), [tick, user?.id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [plate, setPlate] = useState('');
  const [category, setCategory] = useState<Exemption['category']>('VEHICULE_OFFICIEL');
  const [holder, setHolder] = useState('');
  const [ruleCode, setRuleCode] = useState('');
  const [basis, setBasis] = useState('');
  const [from, setFrom] = useState('');
  const [until, setUntil] = useState('');
  const [piece, setPiece] = useState('');
  const [motif, setMotif] = useState('');
  const run = async (path: string, body: unknown, ok: string) => {
    setMsg(null);
    try { await api(path, { method: 'POST', body }); setMsg({ ok: true, text: ok }); list.reload(); } catch (e) { setMsg({ ok: false, text: describeError(e).message }); }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    // Pièce justificative : seule son empreinte est transmise (le document reste au dossier papier ou numérisé).
    const documents = piece.trim() ? [/^[0-9a-f]{64}$/.test(piece.trim()) ? piece.trim() : await sha256Hex(piece.trim())] : [];
    await run('/v1/parking/exemptions', { plate, category, holder, ...(category === 'CAS_PREVU_PAR_LA_REGLE' ? { ruleCode, exemptionBasis: basis } : {}), zoneIds: [], validFrom: from, validUntil: until, documents, motif }, 'Exemption demandée : décision d’une autre personne requise.');
  };
  const decide = (id: string, approve: boolean) => { const m = window.prompt('Motif de la décision'); if (m && m.trim().length >= 5) void run(`/v1/parking/exemptions/${id}/decide`, { approve, motif: m.trim() }, approve ? 'Exemption accordée.' : 'Exemption refusée.'); };
  const revoke = (id: string) => { const m = window.prompt('Motif de la révocation'); if (m && m.trim().length >= 5) void run(`/v1/parking/exemptions/${id}/revoke`, { motif: m.trim() }, 'Exemption révoquée.'); };
  return (
    <div className="stack">
      <section className="panel stack-sm">
        <h2 className="panel-title"><Icon name="shieldCheck" size={18} /> Demander une exemption</h2>
        <form className="stack-sm" onSubmit={submit}>
          <div className="row-wrap">
            <input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="Plaque" aria-label="Plaque exemptée" />
            <select value={category} onChange={(e) => setCategory(e.target.value as Exemption['category'])} aria-label="Nature de l’exemption">
              <option value="VEHICULE_OFFICIEL">Véhicule officiel</option><option value="CAS_PREVU_PAR_LA_REGLE">Cas prévu par la règle</option>
            </select>
            <input value={holder} onChange={(e) => setHolder(e.target.value)} placeholder="Administration ou titulaire" aria-label="Bénéficiaire" />
          </div>
          {category === 'CAS_PREVU_PAR_LA_REGLE' && (
            <div className="row-wrap">
              <input value={ruleCode} onChange={(e) => setRuleCode(e.target.value)} placeholder="Code de la grille tarifaire" aria-label="Règle tarifaire" />
              <input value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="Exonération inscrite dans la fiche" aria-label="Exonération de la règle" />
            </div>
          )}
          <div className="row-wrap">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Début de validité" />
            <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Fin de validité" />
            <input value={piece} onChange={(e) => setPiece(e.target.value)} placeholder="Pièce (référence ou empreinte SHA-256)" aria-label="Pièce justificative" />
            <input value={motif} onChange={(e) => setMotif(e.target.value)} placeholder="Motif" aria-label="Motif de la demande" />
          </div>
          <button type="submit" className="btn btn-secondary btn-sm" disabled={plate.length < 4 || holder.length < 3 || !from || !until || motif.length < 5}>Demander</button>
        </form>
        {msg && <p className={msg.ok ? 'notice notice-ok' : 'err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      </section>
      <section className="panel">
        <h2 className="panel-title"><Icon name="table" size={18} /> Exemptions</h2>
        {list.loading && !list.data ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data?.length ? <EmptyState title="Aucune exemption" /> : (
          <ul className="list-rows">{list.data.map((x) => (
            <li key={x.id} className="list-row list-row-stack">
              <div className="row-between">
                <p className="row-title"><span className="pk-plate">{x.plate}</span> — {x.category === 'VEHICULE_OFFICIEL' ? 'Véhicule officiel' : `Cas prévu par la règle ${x.ruleCode} : ${x.exemptionBasis}`} · {x.holder}</p>
                <StatusBadge tone={STATUS[x.status]?.tone ?? 'neutral'} label={`${STATUS[x.status]?.label ?? x.status}${x.inForce ? ' — en vigueur' : ''}`} />
              </div>
              <p className="small muted">Du {x.validFrom} au {x.validUntil} · {x.motif}{x.decision ? ` · décision : ${x.decision.motif}` : ''}</p>
              <div className="row-wrap">
                {x.status === 'DEMANDEE' && user?.id !== x.requestedBy && <>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => decide(x.id, true)}>Accorder</button>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => decide(x.id, false)}>Refuser</button>
                </>}
                {x.status === 'DEMANDEE' && user?.id === x.requestedBy && <span className="small muted">Décision par une autre personne (quatre yeux).</span>}
                {x.status === 'ACCORDEE' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => revoke(x.id)}>Révoquer</button>}
              </div>
            </li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}

/** Usager : sessions par USSD ou SMS (simulateur du canal texte ; passerelle opérateur à raccorder par convention). */
export function TextChannelPanel({ onChange }: { onChange?: () => void }) {
  const [channel, setChannel] = useState<'SMS' | 'USSD'>('SMS');
  const [text, setText] = useState('');
  const [log, setLog] = useState<{ sent: string; reply: string; ok: boolean }[]>([]);
  const [access, setAccess] = useState<{ ussd: string; sms: string; status: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const send = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try {
      const r = await api<{ reply: string; outcome: string; access: { ussd: string; sms: string; status: string } }>('/v1/parking/canal-texte/simulateur', { method: 'POST', body: { channel, text } });
      setLog([{ sent: `${channel} › ${text}`, reply: r.reply, ok: r.outcome === 'OK' }, ...log].slice(0, 10));
      setAccess(r.access); setText(''); onChange?.();
    } catch (ex) { setErr(describeError(ex).message); }
  };
  return (
    <section className="panel stack-sm">
      <h2 className="panel-title"><Icon name="keypad" size={18} /> Stationner par USSD ou SMS</h2>
      <p className="small">Sans smartphone : SMS « STAT zone plaque minutes », « PROL ticket minutes », « FIN ticket », « ETAT plaque » ; USSD : 1*zone*plaque*minutes, 2*ticket*minutes, 3*ticket, 4*plaque. Le paiement se fait par Mobile Money ou USSD, jamais en espèces.</p>
      {access && <p className="small muted">Accès : {access.ussd} · {access.sms} — [{access.status}]</p>}
      <form className="row-wrap" onSubmit={send}>
        <select value={channel} onChange={(e) => setChannel(e.target.value as 'SMS' | 'USSD')} aria-label="Canal"><option value="SMS">SMS</option><option value="USSD">USSD</option></select>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={channel === 'SMS' ? 'STAT DEMO-GOMBE-CENTRE KN-0001-DM 60' : '1*DEMO-GOMBE-CENTRE*KN-0001-DM*60'} aria-label="Message" />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!text.trim()}>Envoyer</button>
      </form>
      {err && <p className="err" role="alert">{err}</p>}
      <ul className="list-rows" aria-label="Échanges">{log.map((l, i) => <li key={i} className="list-row list-row-stack"><p className="small mono">{l.sent}</p><p className={l.ok ? 'small' : 'small err'}>{l.reply}</p></li>)}</ul>
    </section>
  );
}
