/**
 * Accès et délégations — module 51 : délégations temporaires et expirantes (sans élévation), décision RBAC + ABAC
 * expliquée par attribut, détections (conflits d'intérêts, privilèges excessifs, comptes partagés), échéancier de
 * révocation automatique à la fin d'une affectation. Accès juste-à-temps : « Accès privilégiés » ; revues : « Revue des accès ».
 */
import { useState } from 'react';
import { useApp } from '../../context';
// Parcours par rôle (29/09/2026) : liens adaptés au compte (« Réalisé par : … » si l'écran n'est pas le sien).
import { LienEcran } from '../../components/LienEcran';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { api, describeError } from '../../lib/api';
import { Section } from '../pilotage/shared';
import { Choice, Field, hasRole } from '../pilotage/planif';
import { Ecran, useRunner, useVue, type Indicator } from '../decision/commun';
import { IndicateursVisuels } from '../plateforme/visuels';
import { DELEGATION_STATUS, DelegationsVisuels } from './visuels';

interface Delegation { id: string; delegatorId: string; delegateId: string; roles: string[]; from: string; to: string; motif: string; status: string }
interface Vue {
  params: { maxDays: number; nonDelegable: string[]; status: string }; delegations: Delegation[]; rule: string; indicators: Indicator[];
  detections: { kind: string; userId: string; detail: string; severity: string }[]; links: Record<string, string>;
}
interface Explain { decision: string; checks: { attribute: string; ok: boolean; detail: string }[] }

export default function Delegations() {
  const { user } = useApp();
  const q = useVue<Vue>('/v1/acces/delegations');
  const r = useRunner(q.reload);
  const [delegate, setDelegate] = useState('');
  const [roles, setRoles] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [motif, setMotif] = useState('');
  const [who, setWho] = useState('');
  const [action, setAction] = useState('taxpayer.read');
  const [commune, setCommune] = useState('');
  const [device, setDevice] = useState('');
  const [sens, setSens] = useState('INTERNE');
  const [expl, setExpl] = useState<Explain | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const approver = hasRole(user?.roles, 'R08', 'R06', 'R07', 'R28');
  async function explain() {
    setErr(null);
    try { setExpl(await api<Explain>('/v1/acces/abac/explication', { method: 'POST', body: { userId: who, action, ...(commune ? { commune } : {}), ...(device ? { deviceId: device } : {}), sensitivity: sens } })); } catch (e) { setErr(describeError(e).message); }
  }
  return (
    <Ecran eyebrow="Plateforme et accès · module 51" title="Accès et délégations" lead="Rôles et attributs, délégations temporaires, accès juste-à-temps motivé, revues ; comptes partagés interdits." q={q} msg={r.msg}>
      {(d) => (<>
        <Section title="Indicateurs" sub={d.rule}><IndicateursVisuels items={d.indicators} /><DelegationsVisuels delegations={d.delegations} detections={d.detections} /></Section>
        <Section title="Déléguer temporairement un de mes rôles" sub={`Durée maximale ${d.params.maxDays} jours ; rôles non délégables : ${d.params.nonDelegable.join(', ')} (${d.params.status}). Approbation par une autre personne.`}>
          <div className="form">
            <Field label="Délégataire (identifiant, même entité)" value={delegate} onChange={setDelegate} />
            <Field label="Rôles délégués (ex. R11, séparés par des virgules)" value={roles} onChange={setRoles} hint={`Vos rôles : ${user?.roles.join(', ') ?? '—'}`} />
            <Field label="Du" type="date" value={from} onChange={setFrom} />
            <Field label="Au" type="date" value={to} onChange={setTo} />
            <Field label="Motif" value={motif} onChange={setMotif} />
            <button type="button" className="btn btn-primary" disabled={r.busy || !delegate || !roles || motif.length < 10} onClick={() => void r.run('/v1/acces/delegations', { delegateId: delegate, roles: roles.split(',').map((x) => x.trim()).filter(Boolean), from, to, motif }, 'Délégation proposée : approbation attendue.')}>Proposer</button>
          </div>
        </Section>
        <Section title="Délégations">
          <DataTable caption="Délégations" rows={d.delegations} rowKey={(x) => x.id} empty={<p className="muted">Aucune délégation.</p>} columns={[
            { key: 'd', label: 'Délégation', primary: true, render: (x) => `${x.id} — ${x.delegatorId} → ${x.delegateId} (${x.roles.join(', ')})` },
            { key: 'p', label: 'Période', render: (x) => `${x.from} → ${x.to}` },
            { key: 's', label: 'Statut', render: (x) => <StatusBadge tone={x.status === 'ACTIVE' ? 'good' : x.status === 'PROPOSEE' ? 'warning' : 'neutral'} label={DELEGATION_STATUS[x.status]?.label ?? x.status} /> },
            { key: 'a', label: 'Actions', render: (x) => (
              <div className="btn-row">
                {x.status === 'PROPOSEE' && approver && x.delegatorId !== user?.id && x.delegateId !== user?.id && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/acces/delegations/${x.id}/decision`, { approve: true, motif: 'Intérim validé par l’administrateur' }, 'Délégation active.')}>Approuver</button>}
                {x.status === 'ACTIVE' && (x.delegatorId === user?.id || approver) && <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/acces/delegations/${x.id}/fin`, { motif: 'Fin anticipée de la délégation' }, 'Délégation terminée : rôles retirés.')}>Terminer</button>}
              </div>
            ) },
          ]} />
          {hasRole(user?.roles, 'R08', 'R28', 'R26') && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/acces/echeancier', {}, 'Échéancier exécuté : délégations échues retirées, affectations échues révoquées.')}>Exécuter l’échéancier (fin d’affectation)</button>}
        </Section>
        <Section title="Détections — à examiner par une personne" sub="Aucune sanction automatique.">
          <DataTable caption="Détections" rows={d.detections} rowKey={(x) => `${x.kind}-${x.userId}-${x.detail}`} empty={<p className="muted">Aucune détection.</p>} columns={[
            { key: 'k', label: 'Nature', render: (x) => <StatusBadge tone={x.severity === 'ELEVEE' ? 'critical' : 'warning'} label={x.kind === 'CONFLIT_INTERETS' ? 'Conflit d’intérêts' : x.kind === 'COMPTE_PARTAGE' ? 'Compte partagé' : 'Privilège excessif'} /> },
            { key: 'u', label: 'Compte', primary: true, render: (x) => x.userId },
            { key: 'd', label: 'Détail', render: (x) => x.detail },
          ]} />
          <p className="small"><LienEcran to={d.links.justeATemps ?? '/acces/elevations'}>Accès juste-à-temps</LienEcran> · <LienEcran to={d.links.revues ?? '/integrite/revue-acces'}>Revues des accès</LienEcran> · <LienEcran to={d.links.invitations ?? '/acces/invitations'}>Invitations et comptes</LienEcran></p>
        </Section>
        {hasRole(user?.roles, 'R08', 'R28', 'R22', 'R23', 'R26') && (
          <Section title="Décision RBAC + ABAC expliquée" sub="Territoire, module, dossier, période, appareil, sensibilité.">
            <div className="form">
              <Field label="Compte" value={who} onChange={setWho} />
              <Field label="Action" value={action} onChange={setAction} />
              <Field label="Commune" value={commune} onChange={setCommune} />
              <Field label="Terminal" value={device} onChange={setDevice} />
              <Choice label="Sensibilité" value={sens} onChange={setSens} options={[['PUBLIC', 'Public'], ['INTERNE', 'Interne'], ['CONFIDENTIEL', 'Confidentiel'], ['SENSIBLE', 'Sensible']]} />
              <button type="button" className="btn btn-secondary" disabled={!who} onClick={() => void explain()}>Expliquer</button>
              {err && <p className="notice notice-err" role="alert">{err}</p>}
              {expl && (
                <DataTable caption="Attributs" rows={expl.checks} rowKey={(c) => c.attribute} columns={[
                  { key: 'a', label: 'Attribut', primary: true, render: (c) => c.attribute },
                  { key: 'o', label: 'Résultat', render: (c) => <StatusBadge tone={c.ok ? 'good' : 'critical'} label={c.ok ? 'Conforme' : 'Refus'} /> },
                  { key: 'd', label: 'Détail', render: (c) => c.detail },
                ]} />
              )}
              {expl && <p><strong>Décision : {expl.decision === 'AUTORISE' ? 'autorisé' : 'refusé'}</strong></p>}
            </div>
          </Section>
        )}
      </>)}
    </Ecran>
  );
}
