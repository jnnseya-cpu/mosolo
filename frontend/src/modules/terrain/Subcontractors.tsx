/**
 * Sous-traitance terrain et équipes d'agents (§ 15A ; H.8.4–H.8.6) : invitation après sélection, dossier,
 * diligence, accréditation en maker-checker avec période probatoire sur lot réduit, lots, agents inactifs
 * jusqu'à l'habilitation par la régie, badges, suspension motivée, rémunération indicative sur livrables vérifiés.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { hasRole, ReasonDrawer, useFeedback } from './common';
import { AGENT_STATUS, MODULE_LABEL, moduleLabel, ST_STATUS } from './labels';
import type { FieldAgent, Lot, MysteryCheck, Remuneration, Subcontractor } from './types';
import './terrain.css';

const addDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function Steps({ st }: { st: Subcontractor }) {
  const order = ['INVITE', 'EN_DILIGENCE', 'PROPOSITION', 'ACCREDITE_PROBATOIRE', 'ACCREDITE'];
  const label: Record<string, string> = { INVITE: 'Invitation après sélection (hors plateforme)', EN_DILIGENCE: 'Dossier complété — diligence de la régie', PROPOSITION: 'Proposition motivée (maker)', ACCREDITE_PROBATOIRE: 'Approbation par une autre personne (checker) — période probatoire', ACCREDITE: 'Confirmation après la période probatoire' };
  const reached = st.status === 'SUSPENDU' || st.status === 'RETIRE' ? order.indexOf('ACCREDITE_PROBATOIRE') : order.indexOf(st.status === 'EN_DILIGENCE' && st.proposal ? 'PROPOSITION' : st.status);
  return (
    <ol className="tr-steps">
      {order.map((s, i) => (
        <li key={s} className={i < reached || (i === reached && s === 'ACCREDITE') ? 'tr-step-done' : i === reached ? 'tr-step-now' : ''}>
          <span className="tr-step-dot" aria-hidden="true">{i < reached ? <Icon name="check" size={12} /> : null}</span>
          <span>{label[s]}</span>
        </li>
      ))}
    </ol>
  );
}

function InviteForm({ onDone }: { onDone: () => void }) {
  const fb = useFeedback();
  const [f, setF] = useState({ name: '', selectionReference: '', managerName: '', capacityAgents: '10', modules: ['FONCIER_LOCATIF'] as string[] });
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await fb.run(() => api('/v1/terrain/subcontractors', { method: 'POST', body: { name: f.name.trim(), selectionReference: f.selectionReference.trim(), managerName: f.managerName.trim(), capacityAgents: Number(f.capacityAgents), requestedModules: f.modules } }), 'Invitation envoyée : le responsable du sous-traitant complète son dossier.');
    if (ok) onDone();
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      {fb.node}
      <p className="small muted">Aucune inscription libre : l’invitation suit une sélection (appel à manifestation d’intérêt ou procédure de passation) conduite hors plateforme.</p>
      <div className="field"><label className="label" htmlFor="iv-n">Raison sociale</label><input id="iv-n" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></div>
      <div className="field"><label className="label" htmlFor="iv-s">Référence de la sélection</label><input id="iv-s" value={f.selectionReference} onChange={(e) => setF({ ...f, selectionReference: e.target.value })} required /></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="iv-m">Responsable invité (nom)</label><input id="iv-m" value={f.managerName} onChange={(e) => setF({ ...f, managerName: e.target.value })} required /></div>
        <div className="field"><label className="label" htmlFor="iv-c">Nombre maximal d’agents</label><input id="iv-c" inputMode="numeric" value={f.capacityAgents} onChange={(e) => setF({ ...f, capacityAgents: e.target.value })} /></div>
      </div>
      <fieldset className="field"><legend className="label">Modules visés</legend>
        <div className="tr-checks">
          {Object.entries(MODULE_LABEL).map(([k, l]) => (
            <label key={k}><input type="checkbox" checked={f.modules.includes(k)} onChange={(e) => setF({ ...f, modules: e.target.checked ? [...f.modules, k] : f.modules.filter((m) => m !== k) })} />{l}</label>
          ))}
        </div>
      </fieldset>
      <button type="submit" className="btn btn-primary btn-block" disabled={!f.name.trim() || !f.selectionReference.trim() || !f.managerName.trim() || f.modules.length === 0}>Inviter</button>
    </form>
  );
}

function HabilitationForm({ agent, st, onDone }: { agent: FieldAgent; st?: Subcontractor; onDone: () => void }) {
  const fb = useFeedback();
  const communesDefault = st?.accreditation?.communes.join(', ') ?? 'Limete';
  const [f, setF] = useState({ identityVerified: false, ethicsSigned: false, trainingCertificateRef: '', trainingValidUntil: addDays(365), module: st?.accreditation?.modules[0] ?? 'FONCIER_LOCATIF', communes: communesDefault, validUntil: st?.accreditation?.validUntil ?? addDays(180) });
  const [key, setKey] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    await fb.run(async () => {
      const r = await api<{ deviceId: string; deviceKeyOnce?: string; badge: { shortCode: string } }>(`/v1/terrain/agents/${agent.id}/habilitation`, {
        method: 'POST', body: { ...f, communes: f.communes.split(/[,;]+/).map((c) => c.trim()).filter(Boolean) },
      });
      setKey(r.deviceKeyOnce ? `Terminal ${r.deviceId} enrôlé — clé (affichée une seule fois) : ${r.deviceKeyOnce}. Badge ${r.badge.shortCode}.` : `Badge ${r.badge.shortCode} délivré.`);
    }, 'Agent habilité par la régie ; badge délivré.');
  }
  if (key) return <div className="form"><p className="notice notice-ok" role="status">{key}</p><button type="button" className="btn btn-primary btn-block" onClick={onDone}>Terminer</button></div>;
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      {fb.node}
      <p className="small">Habilitation de <strong>{agent.displayName}</strong>{st ? ` (${st.name})` : ' (équipe interne)'} — décision de la régie, jamais du sous-traitant.</p>
      <div className="tr-checks">
        <label><input type="checkbox" checked={f.identityVerified} onChange={(e) => setF({ ...f, identityVerified: e.target.checked })} />Identité vérifiée sur pièce</label>
        <label><input type="checkbox" checked={f.ethicsSigned} onChange={(e) => setF({ ...f, ethicsSigned: e.target.checked })} />Engagement déontologique signé (aucun encaissement, aucune décision fiscale)</label>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="hb-c">Certificat de formation</label><input id="hb-c" value={f.trainingCertificateRef} onChange={(e) => setF({ ...f, trainingCertificateRef: e.target.value })} placeholder="CERT-…" /></div>
        <div className="field"><label className="label" htmlFor="hb-cv">Certificat valable jusqu’au</label><input id="hb-cv" type="date" value={f.trainingValidUntil} onChange={(e) => setF({ ...f, trainingValidUntil: e.target.value })} /></div>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="hb-m">Module</label>
          <select id="hb-m" value={f.module} onChange={(e) => setF({ ...f, module: e.target.value })}>{(st?.accreditation?.modules ?? Object.keys(MODULE_LABEL)).map((m) => <option key={m} value={m}>{moduleLabel(m)}</option>)}</select>
        </div>
        <div className="field"><label className="label" htmlFor="hb-z">Communes (zone)</label><input id="hb-z" value={f.communes} onChange={(e) => setF({ ...f, communes: e.target.value })} /></div>
      </div>
      <div className="field"><label className="label" htmlFor="hb-v">Habilitation valable jusqu’au</label><input id="hb-v" type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></div>
      <p className="small muted">Un terminal enrôlé est lié à l’agent ; sa révocation est immédiate en cas de suspension.</p>
      <button type="submit" className="btn btn-primary btn-block"><Icon name="shieldCheck" size={18} /> Habiliter et délivrer le badge</button>
    </form>
  );
}

function AgentsPanel({ title, agents, st, roles, onChange }: { title: string; agents: FieldAgent[]; st?: Subcontractor; roles?: string[]; onChange: () => void }) {
  const fb = useFeedback();
  const [inviting, setInviting] = useState(false);
  const [name, setName] = useState('');
  const [quartiers, setQuartiers] = useState('');
  const [hab, setHab] = useState<FieldAgent | null>(null);
  const [susp, setSusp] = useState<FieldAgent | null>(null);
  const canInvite = st ? hasRole(roles, 'R35', 'R07') && (st.status === 'ACCREDITE' || st.status === 'ACCREDITE_PROBATOIRE') : hasRole(roles, 'R07');
  const canHab = hasRole(roles, 'R06', 'R07');
  const canSuspend = hasRole(roles, 'R06', 'R07', 'R09', 'R35');
  async function invite() {
    const ok = await fb.run(() => api(st ? `/v1/terrain/subcontractors/${st.id}/agents` : '/v1/terrain/agents', { method: 'POST', body: { displayName: name.trim(), declaredQuartiers: quartiers.split(/[,;]+/).map((q) => q.trim()).filter(Boolean) } }), 'Agent invité : compte nominatif inactif jusqu’à l’habilitation par la régie.');
    if (ok) { setName(''); setQuartiers(''); setInviting(false); onChange(); }
  }
  return (
    <div className="panel">
      <div className="panel-head"><h3 className="panel-title">{title}</h3>
        {canInvite && <div className="panel-tools"><button type="button" className="btn btn-sm btn-secondary" onClick={() => setInviting((v) => !v)}><Icon name="user" size={16} /> Inviter un agent</button></div>}
      </div>
      {fb.node}
      {inviting && (
        <div className="tr-inline-form">
          <div className="field"><label className="label" htmlFor={`ia-${st?.id ?? 'int'}`}>Nom d’usage (affiché sur le badge)</label><input id={`ia-${st?.id ?? 'int'}`} value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label className="label" htmlFor={`iq-${st?.id ?? 'int'}`}>Quartiers déclarés (résidence, proches)</label><input id={`iq-${st?.id ?? 'int'}`} value={quartiers} onChange={(e) => setQuartiers(e.target.value)} /><span className="hint">L’agent ne sera jamais affecté à ces quartiers (§ 15A.5). Aucun téléphone ni adresse n’est publié.</span></div>
          <div className="tr-actions-end"><button type="button" className="btn btn-primary btn-sm" disabled={name.trim().length < 2} onClick={() => void invite()}>Inviter</button></div>
        </div>
      )}
      {agents.length === 0 ? <EmptyState title="Aucun agent." icon="users" /> : (
        <ul className="list-rows">
          {agents.map((a) => (
            <li key={a.id} className="list-row">
              <div className="min0">
                <p className="tr-row-title">{a.displayName}</p>
                <p className="tr-sub">{a.habilitation ? `${moduleLabel(a.habilitation.module)} · ${a.habilitation.communes.join(', ')} · jusqu’au ${a.habilitation.validUntil}` : 'Non habilité — aucune action possible'}{a.badge ? <> · badge <span className="mono">{a.badge.shortCode}</span></> : null}</p>
              </div>
              <div className="row-actions">
                <StatusBadge tone={AGENT_STATUS[a.status].tone} label={AGENT_STATUS[a.status].label} />
                {canHab && (a.status === 'INVITE' || a.status === 'SUSPENDU') && <button type="button" className="btn btn-sm btn-primary" onClick={() => setHab(a)}>Habiliter</button>}
                {canSuspend && a.status === 'HABILITE' && <button type="button" className="btn btn-sm btn-secondary" onClick={() => setSusp(a)}><Icon name="ban" size={16} /> Suspendre</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Drawer open={!!hab} title="Habilitation par la régie" onClose={() => setHab(null)}>
        {hab && <HabilitationForm agent={hab} {...(st ? { st } : {})} onDone={() => { setHab(null); onChange(); }} />}
      </Drawer>
      <ReasonDrawer open={!!susp} title="Suspendre l’agent" danger confirmLabel="Suspendre immédiatement" onClose={() => setSusp(null)}
        intro={susp && <p>Suspension conservatoire de <strong>{susp.displayName}</strong> : son badge devient « suspendu » à la vérification publique et ses terminaux sont révoqués immédiatement. Ses missions non achevées reviennent à l’affectation.</p>}
        onConfirm={async (reason) => { await api(`/v1/terrain/agents/${susp!.id}/suspend`, { method: 'POST', body: { reason } }); onChange(); }} />
    </div>
  );
}

function RemunerationPanel({ id }: { id: string }) {
  const r = useApi(() => api<Remuneration>(`/v1/terrain/subcontractors/${id}/remuneration`), [id]);
  if (r.loading) return <Loading />;
  if (r.error || !r.data) return null;
  const d = r.data;
  return (
    <div className="panel">
      <div className="panel-head"><h3 className="panel-title">Rémunération indicative</h3>{d.example && <div className="panel-tools"><span className="ribbon">Exemple</span></div>}</div>
      <p className="small muted">{d.notice}</p>
      {d.available && d.lines ? (
        <>
          <DataTable
            columns={[
              { key: 'l', label: 'Livrable vérifié', primary: true, render: (x) => x.deliverable },
              { key: 'n', label: 'Nombre', num: true, render: (x) => x.count },
              { key: 'u', label: 'Prix unitaire', num: true, render: (x) => <MoneyText money={x.unitPrice} showIndicative={false} /> },
              { key: 'a', label: 'Montant indicatif', num: true, render: (x) => <MoneyText money={x.amount} showIndicative={false} /> },
            ]}
            rows={d.lines} rowKey={(x) => x.deliverable} caption="Rémunération indicative"
          />
          {d.total && <p style={{ marginTop: 8 }}><strong>Total indicatif :</strong> <MoneyText money={d.total} showIndicative={false} /> <span className="small muted">— contrat {d.contractReference}</span></p>}
        </>
      ) : <p className="small">{d.reason}</p>}
      <p className="small muted" style={{ marginTop: 8 }}>Non comptés : {d.deliverables.rejectedFindings} constats rejetés, {d.deliverables.pendingFindings} en attente de contrôle, {d.deliverables.missionsLate} missions hors délai.</p>
    </div>
  );
}

function DossierPanel({ st, roles, uid, onChange }: { st: Subcontractor; roles?: string[]; uid?: string; onChange: () => void }) {
  const fb = useFeedback();
  const regie = hasRole(roles, 'R06', 'R07');
  const [dossier, setDossier] = useState({ rccm: st.rccm ?? '', nif: st.nif ?? '', references: '' });
  const [dil, setDil] = useState({ legalExistence: false, taxClearance: false, noConflictOfInterest: false, publicAgentLinksDeclared: false, notes: '' });
  const [prop, setProp] = useState({ modules: st.requestedModules, communes: 'Limete', validUntil: addDays(365), probationUntil: addDays(60), reason: '' });
  const [decision, setDecision] = useState<null | 'approve' | 'confirm' | 'suspend' | 'reinstate' | 'withdraw'>(null);
  useEffect(() => { setDossier({ rccm: st.rccm ?? '', nif: st.nif ?? '', references: '' }); }, [st.id, st.rccm, st.nif]);
  const act = (path: string, body: unknown, ok: string) => fb.run(() => api(`/v1/terrain/subcontractors/${st.id}/${path}`, { method: 'POST', body }), ok).then((r) => { if (r) onChange(); });
  const DECISIONS: Record<string, { title: string; label: string; path: string; danger?: boolean; intro: string }> = {
    approve: { title: 'Approuver l’accréditation', label: 'Approuver (période probatoire)', path: 'accreditation/approve', intro: 'Seconde validation : vous devez être une autre personne que l’auteur de la proposition. L’accréditation commence par une période probatoire sur lot réduit.' },
    confirm: { title: 'Confirmer après la période probatoire', label: 'Confirmer l’accréditation', path: 'accreditation/confirm', intro: 'Décision motivée au vu du tableau de qualité (taux d’erreur, rejets, contrôles mystère).' },
    suspend: { title: 'Suspendre le sous-traitant', label: 'Suspendre', path: 'suspend', danger: true, intro: 'La suspension révoque d’un coup tous ses agents habilités, leurs badges et leurs terminaux. Décision humaine motivée — jamais automatique.' },
    reinstate: { title: 'Lever la suspension', label: 'Lever la suspension', path: 'reinstate', intro: 'Les agents restent suspendus : chacun devra être ré-habilité individuellement par la régie.' },
    withdraw: { title: 'Retirer l’accréditation', label: 'Retirer', path: 'withdraw', danger: true, intro: 'Retrait définitif : agents révoqués, lots clos.' },
  };
  const D = decision ? DECISIONS[decision]! : null;
  const isOwn = hasRole(roles, 'R35');
  return (
    <div className="panel">
      <div className="panel-head"><h3 className="panel-title">Accréditation</h3></div>
      {fb.node}
      <Steps st={st} />
      <dl className="kv kv-dense" style={{ marginTop: 12 }}>
        <div><dt>RCCM · NIF</dt><dd>{st.rccm ?? '—'} · {st.nif ?? '—'}</dd></div>
        <div><dt>Sélection</dt><dd>{st.selectionReference}</dd></div>
        <div><dt>Modules visés</dt><dd>{st.requestedModules.map(moduleLabel).join(', ')}</dd></div>
        {st.diligence && <div><dt>Diligence</dt><dd>{[['legalExistence', 'existence légale'], ['taxClearance', 'quitus fiscal'], ['noConflictOfInterest', 'pas de conflit d’intérêts'], ['publicAgentLinksDeclared', 'liens déclarés']].map(([k, l]) => `${(st.diligence as unknown as Record<string, boolean>)[k!] ? '✓' : '✗'} ${l}`).join(' · ')}</dd></div>}
        {st.proposal && st.status === 'EN_DILIGENCE' && <div><dt>Proposition</dt><dd>{st.proposal.modules.map(moduleLabel).join(', ')} · {st.proposal.communes.join(', ')} · probatoire jusqu’au {st.proposal.probationUntil} · par {st.proposal.proposedBy}</dd></div>}
        {st.accreditation && <div><dt>Accréditation</dt><dd>{st.accreditation.modules.map(moduleLabel).join(', ')} · {st.accreditation.communes.join(', ')} · jusqu’au {st.accreditation.validUntil} · probatoire jusqu’au {st.accreditation.probationUntil}<br /><span className="small muted">Proposée par {st.accreditation.proposedBy}, approuvée par {st.accreditation.approvedBy}</span></dd></div>}
      </dl>

      {(st.status === 'INVITE' || st.status === 'EN_DILIGENCE') && (isOwn || regie) && (
        <div className="tr-inline-form">
          <p className="section-title">Dossier du sous-traitant</p>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="ds-r">RCCM</label><input id="ds-r" value={dossier.rccm} onChange={(e) => setDossier({ ...dossier, rccm: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="ds-n">NIF</label><input id="ds-n" value={dossier.nif} onChange={(e) => setDossier({ ...dossier, nif: e.target.value })} /></div>
          </div>
          <div className="field"><label className="label" htmlFor="ds-ref">Références, capacité, équipements</label><textarea id="ds-ref" rows={2} value={dossier.references} onChange={(e) => setDossier({ ...dossier, references: e.target.value })} /></div>
          <div className="tr-actions-end"><button type="button" className="btn btn-sm btn-primary" disabled={dossier.rccm.length < 3 || dossier.nif.length < 3} onClick={() => void act('dossier', { rccm: dossier.rccm, nif: dossier.nif, ...(dossier.references ? { references: dossier.references } : {}) }, 'Dossier enregistré.')}>Enregistrer le dossier</button></div>
        </div>
      )}

      {st.status === 'EN_DILIGENCE' && regie && (
        <div className="tr-inline-form">
          <p className="section-title">Diligence de la régie</p>
          <div className="tr-checks">
            {([['legalExistence', 'Existence légale vérifiée'], ['taxClearance', 'Quitus fiscal à jour'], ['noConflictOfInterest', 'Absence de conflit d’intérêts avec les zones visées'], ['publicAgentLinksDeclared', 'Liens avec des agents publics déclarés']] as const).map(([k, l]) => (
              <label key={k}><input type="checkbox" checked={dil[k]} onChange={(e) => setDil({ ...dil, [k]: e.target.checked })} />{l}</label>
            ))}
          </div>
          <div className="tr-actions-end"><button type="button" className="btn btn-sm btn-secondary" onClick={() => void act('diligence', { legalExistence: dil.legalExistence, taxClearance: dil.taxClearance, noConflictOfInterest: dil.noConflictOfInterest, publicAgentLinksDeclared: dil.publicAgentLinksDeclared, ...(dil.notes ? { notes: dil.notes } : {}) }, 'Diligence enregistrée.')}>Enregistrer la diligence</button></div>
        </div>
      )}

      {st.status === 'EN_DILIGENCE' && regie && st.diligence && !st.proposal && (
        <div className="tr-inline-form">
          <p className="section-title">Proposer l’accréditation (maker)</p>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="pp-c">Communes</label><input id="pp-c" value={prop.communes} onChange={(e) => setProp({ ...prop, communes: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="pp-m">Modules</label><input id="pp-m" value={prop.modules.map(moduleLabel).join(', ')} readOnly /></div>
          </div>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="pp-p">Fin de la période probatoire</label><input id="pp-p" type="date" value={prop.probationUntil} onChange={(e) => setProp({ ...prop, probationUntil: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="pp-v">Fin de l’accréditation</label><input id="pp-v" type="date" value={prop.validUntil} onChange={(e) => setProp({ ...prop, validUntil: e.target.value })} /></div>
          </div>
          <div className="field"><label className="label" htmlFor="pp-r">Motif</label><textarea id="pp-r" rows={2} value={prop.reason} onChange={(e) => setProp({ ...prop, reason: e.target.value })} /></div>
          <div className="tr-actions-end"><button type="button" className="btn btn-sm btn-primary" disabled={prop.reason.trim().length < 5} onClick={() => void act('accreditation/propose', { ...prop, communes: prop.communes.split(/[,;]+/).map((c) => c.trim()).filter(Boolean) }, 'Proposition enregistrée : une autre personne doit l’approuver.')}>Proposer</button></div>
        </div>
      )}

      {regie && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          {st.status === 'EN_DILIGENCE' && st.proposal && <button type="button" className="btn btn-primary btn-sm" disabled={st.proposal.proposedBy === uid} title={st.proposal.proposedBy === uid ? 'Vous êtes l’auteur de la proposition' : undefined} onClick={() => setDecision('approve')}>Approuver (checker)</button>}
          {st.status === 'ACCREDITE_PROBATOIRE' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDecision('confirm')}>Confirmer après probation</button>}
          {(st.status === 'ACCREDITE' || st.status === 'ACCREDITE_PROBATOIRE') && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDecision('suspend')}><Icon name="ban" size={16} /> Suspendre</button>}
          {st.status === 'SUSPENDU' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setDecision('reinstate')}>Lever la suspension</button>}
          {st.status !== 'RETIRE' && st.status !== 'INVITE' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDecision('withdraw')}>Retirer l’accréditation</button>}
        </div>
      )}
      {st.history.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="small">Historique des décisions ({st.history.length})</summary>
          <ul className="list-rows">{st.history.map((h, i) => <li key={i} className="list-row"><span className="small">{h.at.slice(0, 16).replace('T', ' ')} · {h.from} → {h.to} · {h.by}</span><span className="small muted">{h.reason}</span></li>)}</ul>
        </details>
      )}
      {D && (
        <ReasonDrawer open title={D.title} confirmLabel={D.label} danger={D.danger} intro={<p>{D.intro}</p>} onClose={() => setDecision(null)}
          onConfirm={async (reason) => { await api(`/v1/terrain/subcontractors/${st.id}/${D.path}`, { method: 'POST', body: { reason } }); onChange(); }} />
      )}
    </div>
  );
}

function LotsPanel({ st, lots, roles, onChange }: { st: Subcontractor; lots: Lot[]; roles?: string[]; onChange: () => void }) {
  const fb = useFeedback();
  const regie = hasRole(roles, 'R06', 'R07');
  const acc = st.accreditation;
  const [f, setF] = useState({ commune: acc?.communes[0] ?? '', quartiers: '', periodStart: addDays(0), periodEnd: addDays(60), maxAgents: '3', module: acc?.modules[0] ?? 'FONCIER_LOCATIF' });
  const canCreate = regie && (st.status === 'ACCREDITE' || st.status === 'ACCREDITE_PROBATOIRE');
  return (
    <div className="panel">
      <div className="panel-head"><h3 className="panel-title">Lots attribués</h3></div>
      {fb.node}
      {lots.length === 0 ? <EmptyState title="Aucun lot." icon="grid" /> : (
        <ul className="list-rows">{lots.map((l) => (
          <li key={l.id} className="list-row">
            <div className="min0"><p className="tr-row-title"><span className="mono">{l.id}</span> · {l.commune}{l.quartiers.length ? ` (${l.quartiers.join(', ')})` : ''}</p><p className="tr-sub">{moduleLabel(l.module)} · du {l.periodStart} au {l.periodEnd} · {l.maxAgents} agents au plus</p></div>
            <div className="row-actions">{l.probation && <span className="tag">Lot probatoire réduit</span>}<StatusBadge tone={l.status === 'OUVERT' ? 'good' : 'neutral'} label={l.status === 'OUVERT' ? 'Ouvert' : 'Clos'} /></div>
          </li>))}
        </ul>
      )}
      {canCreate && acc && (
        <div className="tr-inline-form">
          <p className="section-title">Attribuer un lot</p>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="lt-c">Commune</label><select id="lt-c" value={f.commune} onChange={(e) => setF({ ...f, commune: e.target.value })}>{acc.communes.map((c) => <option key={c}>{c}</option>)}</select></div>
            <div className="field"><label className="label" htmlFor="lt-q">Quartiers</label><input id="lt-q" value={f.quartiers} onChange={(e) => setF({ ...f, quartiers: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="lt-s">Début</label><input id="lt-s" type="date" value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="lt-e">Fin</label><input id="lt-e" type="date" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} /></div>
          </div>
          <div className="field"><label className="label" htmlFor="lt-m">Nombre maximal d’agents</label><input id="lt-m" inputMode="numeric" value={f.maxAgents} onChange={(e) => setF({ ...f, maxAgents: e.target.value })} />{st.status === 'ACCREDITE_PROBATOIRE' && <span className="hint">Période probatoire : lot réduit (5 agents au plus).</span>}</div>
          <div className="tr-actions-end"><button type="button" className="btn btn-sm btn-primary" onClick={() => void fb.run(() => api('/v1/terrain/lots', { method: 'POST', body: { subcontractorId: st.id, module: f.module, commune: f.commune, quartiers: f.quartiers.split(/[,;]+/).map((q) => q.trim()).filter(Boolean), periodStart: f.periodStart, periodEnd: f.periodEnd, maxAgents: Number(f.maxAgents) } }), 'Lot attribué.').then((ok) => ok && onChange())}>Attribuer</button></div>
        </div>
      )}
    </div>
  );
}

function MysteryPanel({ subs, agents }: { subs: Subcontractor[]; agents: FieldAgent[] }) {
  const fb = useFeedback();
  const list = useApi(() => api<{ items: MysteryCheck[] }>('/v1/terrain/mystery-checks'), []);
  const [target, setTarget] = useState('');
  const [date, setDate] = useState(addDays(3));
  const nameOf = (m: MysteryCheck) => (m.target.kind === 'AGENT' ? agents.find((a) => a.id === m.target.id)?.displayName : subs.find((s) => s.id === m.target.id)?.name) ?? m.target.id;
  return (
    <div className="panel tr-section">
      <div className="panel-head"><h3 className="panel-title">Contrôles mystère</h3></div>
      <p className="small muted">Un résultat « irrégularité » ouvre une alerte et une proposition d’examen : aucune sanction automatique. Les résultats sont publiés sous forme agrégée.</p>
      {fb.node}
      <div className="tr-inline-form">
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="my-t">Cible</label>
            <select id="my-t" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choisir…</option>
              {subs.map((s) => <option key={s.id} value={`SOUS_TRAITANT:${s.id}`}>Sous-traitant — {s.name}</option>)}
              {agents.filter((a) => a.status === 'HABILITE').map((a) => <option key={a.id} value={`AGENT:${a.id}`}>Agent — {a.displayName}</option>)}
            </select>
          </div>
          <div className="field"><label className="label" htmlFor="my-d">Date prévue</label><input id="my-d" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></div>
        </div>
        <div className="tr-actions-end"><button type="button" className="btn btn-sm btn-primary" disabled={!target} onClick={() => { const [k, id] = target.split(':'); void fb.run(() => api('/v1/terrain/mystery-checks', { method: 'POST', body: { targetKind: k, targetId: id, plannedFor: date } }), 'Contrôle planifié.').then(() => list.reload()); }}>Planifier</button></div>
      </div>
      <ul className="list-rows">
        {(list.data?.items ?? []).map((m) => (
          <li key={m.id} className="list-row">
            <div className="min0"><p className="tr-row-title">{nameOf(m)}</p><p className="tr-sub"><span className="mono">{m.id}</span> · prévu le {m.plannedFor}{m.notes ? ` · ${m.notes}` : ''}</p></div>
            {m.status === 'REALISE' ? <StatusBadge tone={m.result === 'IRREGULARITE' ? 'critical' : 'good'} label={m.result === 'IRREGULARITE' ? 'Irrégularité' : 'Sans irrégularité'} /> : (
              <div className="row-actions">
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => void fb.run(() => api(`/v1/terrain/mystery-checks/${m.id}/result`, { method: 'POST', body: { result: 'SANS_IRREGULARITE', notes: 'Protocole respecté' } }), 'Résultat enregistré.').then(() => list.reload())}>Sans irrégularité</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => void fb.run(() => api(`/v1/terrain/mystery-checks/${m.id}/result`, { method: 'POST', body: { result: 'IRREGULARITE', notes: 'Irrégularité constatée — examen demandé' } }), 'Irrégularité enregistrée : alerte ouverte, décision à la régie.').then(() => list.reload())}>Irrégularité</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Subcontractors() {
  const { user } = useApp();
  const roles = user?.roles;
  const uid = user?.id;
  const subs = useApi(() => api<{ items: Subcontractor[] }>('/v1/terrain/subcontractors'), [uid]);
  const agents = useApi(() => api<{ items: FieldAgent[] }>('/v1/terrain/agents').catch(() => ({ items: [] as FieldAgent[] })), [uid]);
  const lots = useApi(() => api<{ items: Lot[] }>('/v1/terrain/lots').catch(() => ({ items: [] as Lot[] })), [uid]);
  const [sel, setSel] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);
  const items = subs.data?.items ?? [];
  const current = items.find((s) => s.id === sel) ?? (items.length === 1 ? items[0] : undefined);
  const reload = () => { subs.reload(); agents.reload(); lots.reload(); };
  const internal = useMemo(() => (agents.data?.items ?? []).filter((a) => !a.subcontractorId), [agents.data]);

  if (!user) return <div className="page"><EmptyState title="Choisissez un utilisateur de démonstration (direction de régie, responsable de module, sous-traitant…)" icon="users" /></div>;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Opérations de terrain" title="Sous-traitants et équipes" lead="Accréditation par module et pour une durée limitée, période probatoire sur lot réduit, agents inactifs jusqu’à l’habilitation par la régie, suspension sur décision motivée." />
      <div className="callout callout-danger" role="note"><Icon name="cash" size={20} /><p><strong>Ni agent, ni sous-traitant, ni responsable de module ne touche l’argent public</strong>, ne crée de dette hors règle ou ne valide seul ses propres résultats. La rémunération des sous-traitants est contractuelle, sur livrables vérifiés, payée sur crédit budgétaire hors plateforme.</p></div>
      <ExampleNotice text="Sous-traitants, agents et prix unitaires de démonstration : données fictives." />
      {subs.loading ? <Loading /> : subs.error ? <ErrorState error={subs.error} onRetry={subs.reload} /> : (
        <>
          <section className="section" aria-labelledby="st-t">
            <div className="section-head"><h2 id="st-t">Sous-traitants</h2><span className="count">{items.length}</span>
              {hasRole(roles, 'R06', 'R07') && <button type="button" className="btn btn-primary" onClick={() => setInviting(true)}><Icon name="send" size={18} /> Inviter un sous-traitant</button>}
            </div>
            {items.length === 0 ? <EmptyState title="Aucun sous-traitant dans votre périmètre." icon="building" /> : (
              <div className="tr-cards">
                {items.map((s) => {
                  const n = (agents.data?.items ?? []).filter((a) => a.subcontractorId === s.id);
                  return (
                    <button key={s.id} type="button" className="tr-card" aria-pressed={current?.id === s.id} onClick={() => setSel(s.id)}>
                      <div className="tr-card-top"><span className="tr-row-title">{s.name}</span><StatusBadge tone={ST_STATUS[s.status].tone} label={ST_STATUS[s.status].label} /></div>
                      <span className="tr-sub"><span className="mono">{s.id}</span> · {s.accreditation ? s.accreditation.communes.join(', ') : 'zone non attribuée'}</span>
                      <span className="small">{(s.accreditation?.modules ?? s.requestedModules).map(moduleLabel).join(', ')}</span>
                      <span className="small muted">{n.filter((a) => a.status === 'HABILITE').length} agents habilités · {n.filter((a) => a.status === 'INVITE').length} en attente · capacité {s.capacityAgents}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          {current && (
            <section className="section" aria-labelledby="st-d">
              <div className="section-head"><h2 id="st-d">{current.name}</h2></div>
              <div className="tr-grid tr-grid-even">
                <DossierPanel st={current} roles={roles} {...(uid ? { uid } : {})} onChange={reload} />
                <div className="tr-grid">
                  <LotsPanel st={current} lots={(lots.data?.items ?? []).filter((l) => l.subcontractorId === current.id)} roles={roles} onChange={reload} />
                  {hasRole(roles, 'R06', 'R07', 'R17', 'R22', 'R23', 'R35') && <RemunerationPanel id={current.id} />}
                </div>
              </div>
              <div className="tr-section">
                <AgentsPanel title="Agents du sous-traitant" agents={(agents.data?.items ?? []).filter((a) => a.subcontractorId === current.id)} st={current} roles={roles} onChange={reload} />
              </div>
            </section>
          )}

          {!hasRole(roles, 'R35') && internal.length > 0 && (
            <section className="section tr-section">
              <AgentsPanel title="Équipes internes de la régie" agents={internal} roles={roles} onChange={reload} />
            </section>
          )}
          {hasRole(roles, 'R22', 'R24') && <MysteryPanel subs={items} agents={agents.data?.items ?? []} />}
        </>
      )}
      <Drawer open={inviting} title="Inviter un sous-traitant" onClose={() => setInviting(false)}>
        <InviteForm onDone={() => { setInviting(false); subs.reload(); }} />
      </Drawer>
    </div>
  );
}
