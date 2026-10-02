import { useEffect, useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import { api, asList, describeError } from '../../lib/api';
import { AUTONOMY_HELP, AUTONOMY_LABEL, ENTITIES } from './labels';
import type { AutonomySettings, IaAgent } from './types';
import { AutonomieVisuels } from './visuels';

/** Paramètres d'autonomie par entité : le niveau A est désactivable par le responsable de l'entité (R08, R06). */
export default function IaAutonomy() {
  const { user, fmtDate } = useApp();
  const [entity, setEntity] = useState<string>(user?.entity && user.entity !== 'PUBLIC' ? user.entity : 'DGIPK');
  useEffect(() => { if (user?.entity && user.entity !== 'PUBLIC') setEntity(user.entity); }, [user?.entity]);
  const q = useApi(async () => api<AutonomySettings>(`/v1/ia/autonomy/${encodeURIComponent(entity)}`), [user?.id, entity]);
  const agents = useApi(async () => asList<IaAgent>(await api<unknown>('/v1/ia/agents')), [user?.id]);
  const [form, setForm] = useState<{ levelAEnabled: boolean; disabledActions: string[]; disabledAgents: string[] } | null>(null);
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { if (q.data) setForm({ levelAEnabled: q.data.levelAEnabled, disabledActions: q.data.disabledActions, disabledAgents: q.data.disabledAgents }); }, [q.data]);

  const withA = (agents.data ?? []).filter((a) => a.homeEntity === entity && a.allowedActions.some((x) => x.level === 'A'));
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  async function save() {
    if (!form) return;
    if (reason.trim().length < 3) { setMsg({ ok: false, text: 'Motif obligatoire (journalisé).' }); return; }
    setMsg(null);
    try {
      const out = await api<AutonomySettings>(`/v1/ia/autonomy/${encodeURIComponent(entity)}`, { method: 'PUT', body: { ...form, reason: reason.trim() } });
      q.setData(out);
      setReason('');
      setMsg({ ok: true, text: 'Paramètres enregistrés et journalisés.' });
    } catch (e) { setMsg({ ok: false, text: describeError(e).message }); }
  }

  return (
    <div className="stack">
      <div className="ia-levels">
        {(['A_AUTO', 'B_VALIDATION', 'C_RECOMMANDATION'] as const).map((l) => (
          <div key={l} className={`panel ia-level-card ia-level-${l[0]}`}>
            <div className="eyebrow">{AUTONOMY_LABEL[l]}</div>
            <p className="small">{AUTONOMY_HELP[l]}</p>
          </div>
        ))}
      </div>
      <section className="panel">
        <header className="panel-head">
          <h2 className="panel-title"><Icon name="gauge" size={16} /> Exécution automatique (niveau A) par entité</h2>
          <label className="field ia-select">
            <span className="label sr-only">Entité</span>
            <select value={entity} onChange={(e) => setEntity(e.target.value)} aria-label="Entité">
              {ENTITIES.map((e) => <option key={e} value={e}>{e}</option>)}
            </select>
          </label>
        </header>
        {q.loading && <Loading />}
        {q.error !== null && <ErrorState error={q.error} onRetry={q.reload} />}
        {q.data && form && (
          <div className="form">
            <AutonomieVisuels actions={q.data.actions.length} disabledActions={form.disabledActions.length} agents={withA.length} disabledAgents={form.disabledAgents.filter((c) => withA.some((a) => a.code === c)).length} levelAEnabled={form.levelAEnabled} />
            <label className="ia-switch">
              <input type="checkbox" checked={form.levelAEnabled} disabled={!q.data.canEdit} onChange={(e) => setForm({ ...form, levelAEnabled: e.target.checked })} />
              <span><strong>Niveau A actif pour {entity}</strong> — brouillons, résumés, tâches, classements et rappels facultatifs préparés automatiquement, puis journalisés.</span>
            </label>
            <fieldset className="field" disabled={!q.data.canEdit || !form.levelAEnabled}>
              <legend className="label">Actions de niveau A désactivées</legend>
              <div className="choice-grid ia-checks">
                {q.data.actions.map((a) => (
                  <label key={a.type} className="ia-check"><input type="checkbox" checked={form.disabledActions.includes(a.type)} onChange={() => setForm({ ...form, disabledActions: toggle(form.disabledActions, a.type) })} /> {a.label}</label>
                ))}
              </div>
            </fieldset>
            {withA.length > 0 && (
              <fieldset className="field" disabled={!q.data.canEdit || !form.levelAEnabled}>
                <legend className="label">Agents sans exécution automatique</legend>
                <div className="choice-grid ia-checks">
                  {withA.map((a) => (
                    <label key={a.code} className="ia-check"><input type="checkbox" checked={form.disabledAgents.includes(a.code)} onChange={() => setForm({ ...form, disabledAgents: toggle(form.disabledAgents, a.code) })} /> {a.name}</label>
                  ))}
                </div>
              </fieldset>
            )}
            {q.data.canEdit ? (
              <>
                <label className="field"><span className="label">Motif du changement</span>
                  <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. période de rodage : validation manuelle" /></label>
                <div className="btn-row"><button type="button" className="btn btn-primary" onClick={() => void save()}><Icon name="check" size={18} /> Enregistrer</button></div>
              </>
            ) : (
              <p className="small muted"><Icon name="lock" size={14} /> Lecture seule : seul le responsable de l’entité {entity} (administrateur d’entité, directeur général) modifie ces paramètres.</p>
            )}
            {q.data.updatedAt && <p className="small muted">Dernière modification le {fmtDate(q.data.updatedAt, true)} par {q.data.updatedBy} — {q.data.reason}</p>}
            {!q.data.updatedAt && <StatusBadge tone="info" label="Paramètres par défaut : niveau A actif" />}
          </div>
        )}
        {msg && <p role="status" className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
      </section>
    </div>
  );
}
