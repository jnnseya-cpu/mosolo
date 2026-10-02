/**
 * Mandats (§ 9.1, § 13.5 ; H.7.1) : le contribuable désigne un mandataire aux droits limités (actions, objets),
 * datés et révocables ; mandat de tiers professionnel réservé à un mandataire certifié N3. Le mandataire voit ses
 * mandants et peut renoncer. Chaque acte du mandataire est notifié au mandant.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { Chip, StatusBadge } from '../../components/StatusBadge';
import { ValidityCountdown } from '../../components/ValidityCountdown';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { hasRole, MANDATE_ACTION_LABEL, Status, useAction, type Mandate } from './common';
import { MandatsVisuels } from './visuels';
import './acces.css';

interface MandatesResp { items: Mandate[]; mandataires: { id: string; name: string; certified: boolean }[] }
interface TaxpayerResp { taxpayer: { verificationLevel: string; fullName: string }; objects: { id: string; category: string; commune?: string; quartier?: string }[] }

const addYears = (n: number) => { const d = new Date(); d.setFullYear(d.getFullYear() + n); return d.toISOString().slice(0, 10); };

function MandateCard({ m, asMandant, onRevoke }: { m: Mandate; asMandant: boolean; onRevoke: () => void }) {
  const { fmtDate } = useApp();
  return (
    <article className="ac-card">
      <div className="ac-card-head">
        <div className="min0">
          <p className="ac-card-title">{asMandant ? m.mandataireName : m.mandantName}</p>
          <div className="ac-meta">
            <span>{m.kind === 'PROFESSIONNEL' ? 'Mandat de tiers professionnel' : 'Mandataire de confiance'}</span>
            <span>Du {fmtDate(m.validFrom)} au {fmtDate(m.validTo)}</span>
            {(m.status === 'ACTIF' || m.status === 'EXPIRE') && <ValidityCountdown compact from={m.validFrom} until={m.validTo} label="Mandat" />}
            {m.certified && <span><Icon name="shieldCheck" size={14} /> Certifié N3</span>}
          </div>
        </div>
        <Status s={m.status} />
      </div>
      <div className="ac-chips">
        {m.scope.map((s) => <Chip key={s}>{MANDATE_ACTION_LABEL[s] ?? s}</Chip>)}
        <Chip>{m.objectIds.length ? `${m.objectIds.length} objet(s) désigné(s)` : 'Tous les objets'}</Chip>
      </div>
      {m.proofRef && <p className="small muted">Pièce : {m.proofRef}</p>}
      {m.demo && <p className="small example-inline">Mandat de démonstration (fictif)</p>}
      {m.revokeReason && <p className="small muted">Fin : {m.revokeReason}</p>}
      {m.status === 'ACTIF' && <div className="ac-actions"><button type="button" className="btn btn-secondary btn-sm" onClick={onRevoke}><Icon name="ban" size={14} /> {asMandant ? 'Révoquer' : 'Renoncer au mandat'}</button></div>}
    </article>
  );
}

export default function Mandats() {
  const { user } = useApp();
  const isMandant = hasRole(user?.roles, 'R30');
  const data = useApi(() => api<MandatesResp>('/v1/acces/mandates'), [user?.id]);
  const tp = useApi(() => (isMandant && user?.taxpayerId ? api<TaxpayerResp>(`/v1/taxpayers/${user.taxpayerId}`) : Promise.resolve(null)), [user?.id]);
  const act = useAction(user?.id);
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<Mandate | null>(null);
  const [motif, setMotif] = useState('');
  const [f, setF] = useState({ mandataireUserId: '', kind: 'CONFIANCE' as 'CONFIANCE' | 'PROFESSIONNEL', scope: ['CONSULTER'] as string[], objectIds: [] as string[], validTo: addYears(1), proofRef: '' });
  const level = tp.data?.taxpayer.verificationLevel;
  const levelOk = level ? ['N1', 'N2', 'N3'].includes(level) : true;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await act.run(() => api('/v1/acces/mandates', { method: 'POST', body: { ...f, ...(f.objectIds.length ? {} : { objectIds: undefined }), ...(f.proofRef ? {} : { proofRef: undefined }) } }), 'Mandat accordé : le mandataire et vous-même êtes notifiés.');
    if (r) { setOpen(false); data.reload(); }
  }

  if (!user || !hasRole(user.roles, 'R30', 'R31')) {
    return <div className="page"><PageHead eyebrow="Mandats" title="Mes mandataires" /><EmptyState title="Espace réservé aux contribuables et mandataires" icon="users" /></div>;
  }
  const items = data.data?.items ?? [];
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Mandats" title={isMandant ? 'Mes mandataires' : 'Mes mandants'}
        lead={isMandant ? 'Désignez une personne ou un cabinet pour agir en votre nom, sur des actions et des objets précis, pour une durée limitée. Vous pouvez révoquer à tout moment.' : 'Contribuables qui vous ont confié un mandat. Chacun de vos actes leur est notifié.'}>
        {isMandant && <button type="button" className="btn btn-primary" onClick={() => setOpen(true)} disabled={!levelOk}><Icon name="users" size={18} /> Désigner un mandataire</button>}
      </PageHead>
      {isMandant && !levelOk && <p className="callout callout-warn"><Icon name="alert" size={18} /> <span>Votre compte est au niveau {level} : désigner un mandataire exige le niveau N1 (pièce d’identité contrôlée et adresse déclarée).</span></p>}
      {data.loading && <Loading />}
      {data.error !== null && <ErrorState error={data.error} onRetry={data.reload} />}
      {data.data && items.length > 0 && <MandatsVisuels items={items} />}
      {data.data && (items.length === 0 ? <EmptyState title="Aucun mandat" icon="users" /> : (
        <div className="ac-card-list">{items.map((m) => <MandateCard key={m.id} m={m} asMandant={isMandant} onRevoke={() => { setTarget(m); setMotif(''); }} />)}</div>
      ))}
      {!open && !target && act.node}

      <Drawer open={open} title="Désigner un mandataire" onClose={() => setOpen(false)}>
        <form className="form" onSubmit={(e) => void submit(e)}>
          <div className="field"><label className="label" htmlFor="md-who">Mandataire</label>
            <select id="md-who" value={f.mandataireUserId} onChange={(e) => setF({ ...f, mandataireUserId: e.target.value })} required><option value="">—</option>
              {(data.data?.mandataires ?? []).map((m) => <option key={m.id} value={m.id}>{m.name}{m.certified ? ' — certifié N3' : ''}</option>)}</select></div>
          <div className="seg" role="group" aria-label="Nature du mandat">
            <button type="button" aria-pressed={f.kind === 'CONFIANCE'} onClick={() => setF({ ...f, kind: 'CONFIANCE' })}>Mandataire de confiance</button>
            <button type="button" aria-pressed={f.kind === 'PROFESSIONNEL'} onClick={() => setF({ ...f, kind: 'PROFESSIONNEL' })}>Tiers professionnel (N3)</button>
          </div>
          <fieldset className="field"><legend className="label">Actions autorisées</legend>
            <div className="ac-checks">{Object.entries(MANDATE_ACTION_LABEL).map(([k, l]) => (
              <label key={k} className="ac-check"><input type="checkbox" checked={f.scope.includes(k)} onChange={() => setF({ ...f, scope: f.scope.includes(k) ? f.scope.filter((x) => x !== k) : [...f.scope, k] })} /> {l}</label>
            ))}</div></fieldset>
          {(tp.data?.objects.length ?? 0) > 0 && (
            <fieldset className="field"><legend className="label">Objets concernés (aucun coché = tous)</legend>
              <div className="ac-checks">{tp.data!.objects.map((o) => (
                <label key={o.id} className="ac-check"><input type="checkbox" checked={f.objectIds.includes(o.id)} onChange={() => setF({ ...f, objectIds: f.objectIds.includes(o.id) ? f.objectIds.filter((x) => x !== o.id) : [...f.objectIds, o.id] })} /> <span className="small">{o.category} · {o.commune}</span></label>
              ))}</div></fieldset>
          )}
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="md-to">Fin du mandat (3 ans au plus)</label><input id="md-to" type="date" value={f.validTo} onChange={(e) => setF({ ...f, validTo: e.target.value })} required /></div>
            <div className="field"><label className="label" htmlFor="md-pr">Pièce (mandat écrit, facultatif)</label><input id="md-pr" value={f.proofRef} onChange={(e) => setF({ ...f, proofRef: e.target.value })} /></div>
          </div>
          <p className="small muted">Le mandataire n’encaisse jamais de fonds : tout paiement se fait par référence vers le compte public.</p>
          {act.node}
          <button type="submit" className="btn btn-primary" disabled={act.busy || !f.scope.length}>Accorder le mandat</button>
        </form>
      </Drawer>
      <Drawer open={!!target} title={isMandant ? 'Révoquer le mandat' : 'Renoncer au mandat'} onClose={() => setTarget(null)}>
        <div className="form">
          <p>Effet immédiat : le mandataire perd l’accès à votre dossier. Les deux parties sont notifiées.</p>
          <div className="field"><label className="label" htmlFor="md-mot">Motif</label><input id="md-mot" value={motif} onChange={(e) => setMotif(e.target.value)} /></div>
          {act.node}
          <button type="button" className="btn btn-primary" disabled={act.busy || motif.trim().length < 3}
            onClick={() => void act.run(() => api(`/v1/acces/mandates/${target!.id}/revoke`, { method: 'POST', body: { motif } }), 'Mandat clos.').then((r) => { if (r) { setTarget(null); data.reload(); } })}>Confirmer</button>
        </div>
      </Drawer>
      <div style={{ marginTop: 24 }}><ExampleNotice text="Mandataires et mandats de démonstration : cabinets et personnes fictifs." /></div>
      <StatusBadge tone="info" label="Chaque acte du mandataire est notifié au mandant" />
    </div>
  );
}
