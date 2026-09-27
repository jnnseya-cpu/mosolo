/**
 * Espace de l'exploitant publicitaire — renouvellement d'autorisation en ligne, contrats publicitaires et suivi des
 * échéances (§ 11B.5). Le renouvellement reprend la fiche et les pièces de l'autorisation, puis suit la même instruction.
 */
import { useState, type FormEvent } from 'react';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import '../referentiel/referentiel.css';
import { ContratsVisuels } from './visuels';

interface Expiry { kind: 'CONTRAT' | 'AUTORISATION'; id: string; reference: string; deviceId: string; until: string; daysLeft: number; expiringSoon: boolean; expired: boolean; advertiser?: string; beyondAuthorization?: boolean; renewalPending?: boolean }
interface Device { id: string; reference: string; address: string }

export default function AdContrats() {
  const { user } = useApp();
  const ok = !!user?.taxpayerId;
  const exp = useApi(ok ? () => api<{ noticeDays: number; items: Expiry[] }>('/v1/publicite/echeances') : null, [user?.id]);
  const devices = useApi(ok ? () => api<{ items: Device[] }>('/v1/publicite/devices/mine') : null, [user?.id]);
  const [err, setErr] = useState<string | null>(null);
  const [f, setF] = useState({ deviceId: '', advertiser: '', reference: '', from: '', to: '', file: '' });
  const reload = () => { exp.reload(); devices.reload(); };
  const renew = async (id: string) => {
    const periodTo = window.prompt('Nouvelle fin de validité (AAAA-MM-JJ)');
    if (!periodTo || !/^\d{4}-\d{2}-\d{2}$/.test(periodTo)) return;
    setErr(null);
    try { await api(`/v1/publicite/authorizations/${id}/renewal`, { method: 'POST', body: { periodTo } }); reload(); } catch (e) { setErr(describeError(e).message); }
  };
  const addContract = async (e: FormEvent) => {
    e.preventDefault(); setErr(null);
    try {
      const sha256 = await sha256Hex(f.file || `${f.reference}|${f.advertiser}`);
      await api('/v1/publicite/contrats', { method: 'POST', body: { deviceId: f.deviceId, advertiser: f.advertiser, reference: f.reference, from: f.from, to: f.to, sha256 } });
      setF({ deviceId: '', advertiser: '', reference: '', from: '', to: '', file: '' }); reload();
    } catch (ex) { setErr(describeError(ex).message); }
  };
  return (
    <div className="page page-wide">
      <PageHead eyebrow="MOSOLO Advertising · KIN PUB CONTROL" title="Contrats et échéances"
        lead="Renouvelez vos autorisations en ligne avant l’échéance et suivez vos contrats publicitaires : un contrat qui dépasse l’autorisation est signalé." />
      {!ok ? <EmptyState title="Compte exploitant requis" icon="megaphone" /> : (
        <div className="stack">
          {err && <p className="notice notice-err" role="alert">{err}</p>}
          {exp.loading && <Loading />}
          {!!exp.error && <ErrorState error={exp.error} onRetry={exp.reload} />}
          {exp.data && <ContratsVisuels items={exp.data.items} noticeDays={exp.data.noticeDays} />}
          {exp.data && (
            <section className="panel">
              <div className="panel-head"><h2 className="panel-title"><Icon name="clock" size={18} /> Échéances (préavis {exp.data.noticeDays} jours)</h2><span className="count">{exp.data.items.length}</span></div>
              {!exp.data.items.length ? <EmptyState title="Aucune échéance" icon="check" /> : (
                <ul className="list-rows">{exp.data.items.map((i) => (
                  <li key={`${i.kind}-${i.id}`} className="list-row">
                    <div className="min0">
                      <p className="row-title">{i.kind === 'CONTRAT' ? 'Contrat' : 'Autorisation'} <span className="mono">{i.reference}</span>{i.advertiser ? ` — ${i.advertiser}` : ''}</p>
                      <p className="small muted">Jusqu’au {i.until} · {i.expired ? 'échu' : `${i.daysLeft} jour(s)`}{i.beyondAuthorization ? ' · au-delà de l’autorisation en cours' : ''}{i.renewalPending ? ' · renouvellement en instruction' : ''}</p>
                    </div>
                    <div className="row-side">
                      <StatusBadge tone={i.expired ? 'critical' : i.expiringSoon || i.beyondAuthorization ? 'warning' : 'good'} label={i.expired ? 'Échu' : i.expiringSoon ? 'Bientôt échu' : 'En cours'} />
                      {i.kind === 'AUTORISATION' && !i.renewalPending && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void renew(i.id)}>Renouveler en ligne</button>}
                    </div>
                  </li>
                ))}</ul>
              )}
            </section>
          )}
          <form className="panel stack-sm" onSubmit={addContract}>
            <h2 className="panel-title"><Icon name="file" size={18} /> Enregistrer un contrat publicitaire</h2>
            <div className="row-wrap">
              <select value={f.deviceId} onChange={(e) => setF({ ...f, deviceId: e.target.value })} aria-label="Support"><option value="">Support…</option>{devices.data?.items.map((d) => <option key={d.id} value={d.id}>{d.reference} — {d.address}</option>)}</select>
              <input value={f.advertiser} onChange={(e) => setF({ ...f, advertiser: e.target.value })} placeholder="Annonceur" aria-label="Annonceur" />
              <input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} placeholder="Référence du contrat" aria-label="Référence du contrat" />
            </div>
            <div className="row-wrap">
              <input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="Début" />
              <input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="Fin" />
              <input value={f.file} onChange={(e) => setF({ ...f, file: e.target.value })} placeholder="Nom du fichier du contrat (empreinte seule)" aria-label="Fichier du contrat" />
            </div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!f.deviceId || !f.advertiser || !f.reference || !f.from || !f.to}>Enregistrer</button>
            <p className="hint">Seule l’empreinte du contrat est conservée ; le document reste chez vous.</p>
          </form>
        </div>
      )}
    </div>
  );
}
