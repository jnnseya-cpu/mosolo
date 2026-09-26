/**
 * Invitations en cascade et gestion des accès (§ 12A ; H.6.4 à H.6.9) : invitation nominative sans élévation,
 * dans son périmètre ; secondes validations par une personne distincte ; inscription assistée par l'opérateur
 * d'accès désigné ; révocation (rattachement des invités au successeur) ; permissions ; journal par entité.
 */
import { useMemo, useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { Chip } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import {
  hasRole, REQUIREMENT_LABEL, SandboxBox, splitList, Status, Tabs, useAction, VALIDATION_KIND,
  type AccountRow, type EntityRow, type GrantRow, type InvitationRow, type JournalRow, type LevelsRef, type Me, type ModuleConfig, type ValidationRow,
} from './common';
import './acces.css';

type Tab = 'inviter' | 'invitations' | 'validations' | 'comptes' | 'permissions' | 'journal';
const RANK: Record<string, number> = { CONSULTATION: 1, AGENT_TERRAIN: 1, OPERATEUR: 2, SUPERVISEUR: 3, OPERATEUR_ACCES: 3, RESPONSABLE_MODULE: 4, ADMIN_ENTITE: 5, DIRECTION: 6, AUDIT: 90, ADMIN_TECHNIQUE: 99 };

function MeStrip({ me }: { me: Me }) {
  const { fmtDate } = useApp();
  const level = me.account?.accessLevelLabel ?? '—';
  return (
    <dl className="ac-me" aria-label="Mon profil d’accès">
      <div><dt>Entité</dt><dd>{me.user.entity}</dd></div>
      <div><dt>Niveau d’accès</dt><dd>{level}</dd></div>
      <div><dt>Droit d’inviter</dt><dd>{me.inviteRight ? 'Oui (permission explicite)' : 'Non'}</dd></div>
      <div><dt>Opérateur d’accès</dt><dd>{me.accessOperator ? 'Désigné' : 'Non'}</dd></div>
      <div><dt>Second facteur</dt><dd>{me.mfa.activeUntil ? `Validé jusqu’au ${fmtDate(me.mfa.activeUntil, true)}` : me.mfa.required ? 'Requis pour les actions sensibles' : 'Non requis'}</dd></div>
    </dl>
  );
}

function InviteForm({ ref_, entities, modules, me, onSent }: { ref_: LevelsRef; entities: EntityRow[]; modules: ModuleConfig[]; me: Me; onSent: () => void }) {
  const act = useAction(me.user.id);
  const [f, setF] = useState({ fullName: '', phone: '', email: '', entity: me.user.entity === 'PLATEFORME' ? 'DGIPK' : me.user.entity, accessLevel: 'OPERATEUR', roles: [] as string[], territory: '', modules: [] as string[], validUntil: '', canInvite: false, motif: '' });
  const [sentTo, setSentTo] = useState<string | null>(null);
  const eligibleRoles = useMemo(() => ref_.roles.filter((r) => {
    if (!r.level) return false;
    const special = ['AUDIT', 'ADMIN_TECHNIQUE'];
    return special.includes(r.level) || special.includes(f.accessLevel) ? r.level === f.accessLevel : (RANK[r.level] ?? 0) <= (RANK[f.accessLevel] ?? 0);
  }), [ref_.roles, f.accessLevel]);
  const sensitive = f.canInvite || f.roles.some((r) => ref_.roles.find((x) => x.code === r)?.sensitive);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const scope = {
      ...(splitList(f.territory).length ? { territory: splitList(f.territory) } : {}), ...(f.modules.length ? { modules: f.modules } : {}), ...(f.validUntil ? { validUntil: f.validUntil } : {}),
    };
    const phone = f.phone.replace(/[\s-]/g, '');
    const r = await act.run(() => api('/v1/acces/invitations', {
      method: 'POST', body: { fullName: f.fullName.trim(), phone, ...(f.email ? { email: f.email } : {}), entity: f.entity, accessLevel: f.accessLevel, roles: f.roles, scope, canInvite: f.canInvite, motif: f.motif.trim() },
    }), 'Invitation nominative envoyée : lien et code à usage unique, valables 72 h, liés au numéro invité.');
    if (r) { setSentTo(phone); onSent(); }
  }
  return (
    <div className="ac-grid ac-grid-even">
      <form className="panel form" onSubmit={(e) => void submit(e)} aria-labelledby="inv-title">
        <h2 className="panel-title" id="inv-title">Invitation nominative</h2>
        {!me.inviteRight && <p className="ac-guard ac-guard-warn"><Icon name="lock" size={16} /> <span>Vous ne détenez pas le droit d’inviter : il s’agit d’une permission explicite, délégable et révocable.</span></p>}
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="iv-name">Nom complet</label><input id="iv-name" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} required /></div>
          <div className="field"><label className="label" htmlFor="iv-phone">Téléphone de la personne</label><input id="iv-phone" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+243 81 …" required /></div>
        </div>
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="iv-mail">Courriel (facultatif)</label><input id="iv-mail" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="field"><label className="label" htmlFor="iv-ent">Entité</label>
            <select id="iv-ent" value={f.entity} onChange={(e) => setF({ ...f, entity: e.target.value })}>{entities.filter((x) => x.status === 'ACTIVE').map((x) => <option key={x.id} value={x.id}>{x.shortName}</option>)}</select></div>
        </div>
        <div className="field"><label className="label" htmlFor="iv-lvl">Niveau d’accès</label>
          <select id="iv-lvl" value={f.accessLevel} onChange={(e) => setF({ ...f, accessLevel: e.target.value, roles: [] })}>{ref_.accessLevels.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select>
          <span className="hint">{ref_.accessLevels.find((l) => l.code === f.accessLevel)?.usage}. Pas d’élévation : niveau inférieur ou égal au vôtre.</span></div>
        <fieldset className="field"><legend className="label">Rôles (incompatibilités du § 12.5 refusées)</legend>
          <div className="ac-checks">
            {eligibleRoles.map((r) => (
              <label key={r.code} className="ac-check"><input type="checkbox" checked={f.roles.includes(r.code)} onChange={() => setF({ ...f, roles: f.roles.includes(r.code) ? f.roles.filter((x) => x !== r.code) : [...f.roles, r.code] })} />
                <span>{r.label}{r.sensitive ? ' ·' : ''}{r.sensitive && <span className="small muted"> sensible</span>}</span></label>
            ))}
          </div></fieldset>
        <div className="field-row">
          <div className="field"><label className="label" htmlFor="iv-terr">Territoire (communes)</label><input id="iv-terr" value={f.territory} onChange={(e) => setF({ ...f, territory: e.target.value })} placeholder="Limete, Lemba" /></div>
          <div className="field"><label className="label" htmlFor="iv-until">Date de fin (accès temporaire)</label><input id="iv-until" type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></div>
        </div>
        <fieldset className="field"><legend className="label">Modules du périmètre</legend>
          <div className="ac-checks">{modules.filter((m) => m.status !== 'RETIRE').map((m) => (
            <label key={m.id} className="ac-check"><input type="checkbox" checked={f.modules.includes(m.id)} onChange={() => setF({ ...f, modules: f.modules.includes(m.id) ? f.modules.filter((x) => x !== m.id) : [...f.modules, m.id] })} /> {m.code}</label>
          ))}</div></fieldset>
        <label className="ac-check"><input type="checkbox" checked={f.canInvite} onChange={(e) => setF({ ...f, canInvite: e.target.checked })} /> Accorder le droit d’inviter (à partir du niveau superviseur)</label>
        <div className="field"><label className="label" htmlFor="iv-motif">Motif</label><input id="iv-motif" value={f.motif} onChange={(e) => setF({ ...f, motif: e.target.value })} required /></div>
        {sensitive && <p className="ac-guard ac-guard-warn"><Icon name="shieldCheck" size={16} /> <span>Rôle sensible ou droit d’inviter : clé d’accès obligatoire et compte inactif jusqu’à la seconde validation par une personne distincte de vous.</span></p>}
        {act.node}
        <button type="submit" className="btn btn-primary" disabled={act.busy || !f.roles.length}><Icon name="send" size={18} /> Envoyer l’invitation</button>
      </form>
      <div className="ac-stack">
        {sentTo ? <SandboxBox to={sentTo} title="Messages reçus par l’invité (bac à sable)" /> : (
          <div className="panel">
            <h2 className="panel-title">Règles de la cascade</h2>
            <ul className="plain-list small">
              <li>Niveau 0 : l’administrateur de la plateforme, sur décision écrite du Comité de pilotage.</li>
              <li>Niveau 1 : l’administrateur ou la direction d’une entité, dans son entité et ses sous-entités.</li>
              <li>Niveau 2 : le responsable de module ou le sous-traitant accrédité, dans son module ou son lot.</li>
              <li>Niveau 3 : le superviseur, sur délégation, pour les agents de son équipe.</li>
              <li>Le lien ne sert qu’une fois, expire après 72 h et ne fonctionne qu’avec le numéro invité.</li>
            </ul>
          </div>
        )}
        {sentTo && <p className="small muted">Le lien reçu ouvre la page « Finaliser mon invitation » (/invitation?jeton=…).</p>}
      </div>
    </div>
  );
}

function AssistedForm({ inv, userId, onDone }: { inv: InvitationRow; userId: string; onDone: () => void }) {
  const act = useAction(userId);
  const [f, setF] = useState({ docType: 'Carte d’électeur', docNumber: '', photo: false, mode: 'otp' as 'otp' | 'witness', otp: '', witness: '', device: 'poste-guichet-01', personDevice: '' });
  const field = inv.roles.includes('R10') || inv.roles.includes('R35');
  async function submit(e: FormEvent) {
    e.preventDefault();
    const r = await act.run(() => api(`/v1/acces/invitations/${inv.id}/assisted`, {
      method: 'POST',
      body: {
        identityDocument: { type: f.docType, number: f.docNumber }, photoTaken: f.photo, gps: { lat: -4.3316, lon: 15.3139 }, operatorDeviceId: f.device,
        ...(f.mode === 'otp' ? { otpCode: f.otp } : { witness: { fullName: f.witness } }), ...(field && f.personDevice ? { personDeviceId: f.personDevice } : {}),
      },
    }), 'Inscription assistée enregistrée : horodatée, géolocalisée, notifiée. La personne définira elle-même ses secrets.');
    if (r) onDone();
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)}>
      <p className="ac-guard"><Icon name="info" size={16} /> <span>Invitation existante uniquement ; niveau ({inv.accessLevelLabel}) et périmètre inchangés. Vous ne définissez aucun secret et ne pouvez pas vous connecter à la place de la personne.</span></p>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="as-t">Pièce présentée</label><input id="as-t" value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })} /></div>
        <div className="field"><label className="label" htmlFor="as-n">Numéro</label><input id="as-n" value={f.docNumber} onChange={(e) => setF({ ...f, docNumber: e.target.value })} required /></div>
      </div>
      <label className="ac-check"><input type="checkbox" checked={f.photo} onChange={(e) => setF({ ...f, photo: e.target.checked })} /> Photographie prise en présence de la personne</label>
      <div className="seg" role="group" aria-label="Preuve de présence">
        <button type="button" aria-pressed={f.mode === 'otp'} onClick={() => setF({ ...f, mode: 'otp' })}>Code reçu par la personne</button>
        <button type="button" aria-pressed={f.mode === 'witness'} onClick={() => setF({ ...f, mode: 'witness' })}>Témoin identifié</button>
      </div>
      {f.mode === 'otp'
        ? <div className="field"><label className="label" htmlFor="as-o">Code lu par la personne sur son téléphone</label><input id="as-o" className="mono" inputMode="numeric" maxLength={6} value={f.otp} onChange={(e) => setF({ ...f, otp: e.target.value.replace(/\D/g, '') })} /></div>
        : <div className="field"><label className="label" htmlFor="as-w">Témoin (nom complet)</label><input id="as-w" value={f.witness} onChange={(e) => setF({ ...f, witness: e.target.value })} /></div>}
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="as-d">Terminal de l’opérateur</label><input id="as-d" className="mono" value={f.device} onChange={(e) => setF({ ...f, device: e.target.value })} /></div>
        {field && <div className="field"><label className="label" htmlFor="as-pd">Terminal de terrain attribué</label><input id="as-pd" className="mono" value={f.personDevice} onChange={(e) => setF({ ...f, personDevice: e.target.value })} /></div>}
      </div>
      <p className="small muted">Empreinte digitale désactivée tant que la question juridique J18 n’est pas certifiée. Position GPS de démonstration.</p>
      {act.node}
      <button type="submit" className="btn btn-primary" disabled={act.busy || !f.photo}><Icon name="user" size={18} /> Finaliser en présence</button>
    </form>
  );
}

export default function Invitations() {
  const { user, users, fmtDate } = useApp();
  const roles = user?.roles ?? [];
  const [tab, setTab] = useState<Tab>('inviter');
  const me = useApi(() => api<Me>('/v1/acces/me'), [user?.id]);
  const ref = useApi(() => api<LevelsRef>('/v1/acces/levels'), []);
  const ents = useApi(() => api<{ items: EntityRow[] }>('/v1/acces/entities'), [user?.id]);
  const mods = useApi(() => api<{ items: ModuleConfig[] }>('/v1/acces/modules'), [user?.id]);
  const invs = useApi(() => api<{ items: InvitationRow[] }>('/v1/acces/invitations'), [user?.id, tab]);
  const accs = useApi(() => (tab === 'comptes' ? api<{ items: AccountRow[] }>('/v1/acces/accounts') : Promise.resolve(null)), [user?.id, tab]);
  const vals = useApi(() => api<{ items: ValidationRow[] }>(hasRole(roles, 'R02', 'R03', 'R22') && !hasRole(roles, 'R26', 'R28', 'R06', 'R08') ? '/v1/acces/validations/mine' : '/v1/acces/validations'), [user?.id, tab]);
  const grants = useApi(() => (tab === 'permissions' ? api<{ items: GrantRow[] }>('/v1/acces/grants') : Promise.resolve(null)), [user?.id, tab]);
  const journal = useApi(() => (tab === 'journal' ? api<{ items: JournalRow[] }>('/v1/acces/journal') : Promise.resolve(null)), [user?.id, tab]);
  const act = useAction(user?.id);
  const [assist, setAssist] = useState<InvitationRow | null>(null);
  const [decide, setDecide] = useState<ValidationRow | null>(null);
  const [dec, setDec] = useState({ note: '', oob: false, cert: '' });
  const [revoke, setRevoke] = useState<AccountRow | null>(null);
  const [rev, setRev] = useState({ motif: '', successorId: '' });
  const [grantF, setGrantF] = useState({ userId: '', kind: 'DROIT_INVITER', motif: '' });

  const pending = (vals.data?.items ?? []).filter((v) => v.status === 'EN_ATTENTE');
  const blocked = me.error !== null && (me.error as { status?: number }).status === 403;

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Accès et entités" title="Invitations et comptes de travail" lead="Aucun compte de travail par inscription publique : du Gouverneur à l’agent de terrain, chacun entre sur invitation nominative, dans le périmètre de celui qui l’invite, sans élévation." />
      {me.loading && <Loading />}
      {me.error !== null && !blocked && <ErrorState error={me.error} onRetry={me.reload} />}
      {me.data && <MeStrip me={me.data} />}
      <Tabs<Tab> value={tab} onChange={setTab} label="Rubriques" items={[
        ['inviter', 'Inviter'], ['invitations', 'Invitations', (invs.data?.items ?? []).filter((i) => i.status === 'ENVOYEE').length],
        ['validations', 'Secondes validations', pending.filter((v) => v.qualified).length], ['comptes', 'Comptes'], ['permissions', 'Permissions'], ['journal', 'Journal'],
      ]} />

      {tab === 'inviter' && ref.data && ents.data && me.data && <InviteForm ref_={ref.data} entities={ents.data.items} modules={mods.data?.items ?? []} me={me.data} onSent={invs.reload} />}

      {tab === 'invitations' && (
        <section className="panel" aria-label="Invitations">
          {invs.error !== null && <ErrorState error={invs.error} onRetry={invs.reload} />}
          {invs.data && (invs.data.items.length === 0 ? <EmptyState title="Aucune invitation dans votre périmètre" icon="send" /> : (
            <DataTable rows={invs.data.items} rowKey={(i) => i.id} caption="Invitations"
              columns={[
                { key: 'who', label: 'Invité', primary: true, render: (i) => <><span className="row-title">{i.fullName}</span><span className="small muted"> {i.phoneMasked}</span></> },
                { key: 'ent', label: 'Entité', render: (i) => i.entity },
                { key: 'lvl', label: 'Niveau et rôles', render: (i) => <><span>{i.accessLevelLabel}</span><div className="ac-chips">{i.roleLabels.map((r) => <Chip key={r}>{r}</Chip>)}</div></> },
                { key: 'by', label: 'Invitant', render: (i) => <span className="mono small">{i.inviterId}</span> },
                { key: 'exp', label: 'Échéance', render: (i) => fmtDate(i.expiresAt, true) },
                { key: 'st', label: 'État', render: (i) => <Status s={i.status} /> },
                { key: 'act', label: 'Actions', render: (i) => i.status === 'ENVOYEE' ? (
                  <div className="ac-actions">
                    {me.data?.accessOperator && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAssist(i)}>Inscription assistée</button>}
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act.run(() => api(`/v1/acces/invitations/${i.id}/revoke`, { method: 'POST', body: { motif: 'Invitation retirée par l’administration' } }), 'Invitation révoquée.').then(() => invs.reload())}>Révoquer</button>
                  </div>) : <span className="small muted">{i.finalizedVia === 'OPERATEUR_ACCES' ? 'Finalisée par l’opérateur d’accès' : i.accountId ?? ''}</span> },
              ]} />
          ))}
          {act.node}
        </section>
      )}

      {tab === 'validations' && (
        <section className="panel" aria-label="Secondes validations">
          {vals.error !== null && <ErrorState error={vals.error} onRetry={vals.reload} />}
          {vals.data && (vals.data.items.length === 0 ? <EmptyState title="Aucune demande" icon="shieldCheck" /> : (
            <div className="ac-card-list">
              {vals.data.items.map((v) => (
                <article key={v.id} className="ac-card">
                  <div className="ac-card-head">
                    <div className="min0"><p className="ac-card-title">{VALIDATION_KIND[v.kind] ?? v.kind} — {v.subject.fullName ?? v.subjectUserId}</p>
                      <div className="ac-meta"><span>{v.entity}</span><span>{v.subject.accessLevelLabel}</span><span>Demandé par <span className="mono">{v.requestedBy}</span></span><span>{fmtDate(v.createdAt, true)}</span></div></div>
                    <Status s={v.status} />
                  </div>
                  {v.subject.roleLabels && <div className="ac-chips">{v.subject.roleLabels.map((r) => <Chip key={r}>{r}</Chip>)}</div>}
                  <p className="small"><Icon name="lock" size={14} /> {REQUIREMENT_LABEL[v.requirement]}</p>
                  {v.status === 'EN_ATTENTE' && (v.qualified
                    ? <div className="ac-actions"><button type="button" className="btn btn-primary btn-sm" onClick={() => { setDecide(v); setDec({ note: '', oob: false, cert: '' }); }}>Examiner</button></div>
                    : <p className="small muted">Vous n’êtes pas habilité pour cette validation (ou vous êtes l’invitant).</p>)}
                  {v.decidedBy && <p className="small muted">Décidé par {v.decidedBy} le {fmtDate(v.decidedAt, true)}{v.decisionNote ? ` — ${v.decisionNote}` : ''}</p>}
                </article>
              ))}
            </div>
          ))}
        </section>
      )}

      {tab === 'comptes' && (
        <section className="panel" aria-label="Comptes de travail">
          {accs.error !== null && <ErrorState error={accs.error} onRetry={accs.reload} />}
          {accs.loading && <Loading />}
          {accs.data && (
            <DataTable rows={accs.data.items} rowKey={(a) => a.id} caption="Comptes de travail"
              columns={[
                { key: 'n', label: 'Compte', primary: true, render: (a) => <><span className="row-title">{a.fullName}</span><span className="mono small muted"> {a.id}</span></> },
                { key: 'e', label: 'Entité', render: (a) => a.entity },
                { key: 'l', label: 'Niveau', render: (a) => <>{a.accessLevelLabel}<div className="ac-chips">{a.roleLabels.map((r) => <Chip key={r}>{r}</Chip>)}</div></> },
                { key: 'o', label: 'Origine', render: (a) => <span className="small">{a.origin === 'INVITATION' ? `Invitation · parrain ${a.sponsorId ?? '—'}` : 'Compte de démonstration'}</span> },
                { key: 's', label: 'État', render: (a) => <Status s={a.status} /> },
                { key: 'x', label: 'Actions', render: (a) => a.status !== 'REVOQUE' && a.id !== user?.id && hasRole(roles, 'R26', 'R28', 'R08', 'R06')
                  ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRevoke(a); setRev({ motif: '', successorId: '' }); }}>Révoquer</button> : null },
              ]} />
          )}
        </section>
      )}

      {tab === 'permissions' && (
        <div className="ac-grid ac-grid-even">
          <section className="panel" aria-label="Permissions">
            <h2 className="panel-title">Droits d’inviter et opérateurs d’accès</h2>
            {grants.data && (grants.data.items.length === 0 ? <EmptyState title="Aucune permission" /> : (
              <ul className="list-rows">
                {grants.data.items.map((g) => (
                  <li key={g.id} className="list-row">
                    <div className="min0"><p className="row-title">{g.kind === 'DROIT_INVITER' ? 'Droit d’inviter' : 'Opérateur d’accès désigné'} — <span className="mono">{g.userId}</span></p>
                      <p className="small muted">{g.entity} · accordé par {g.grantedBy} · {fmtDate(g.createdAt)}</p></div>
                    <div className="ac-actions"><Status s={g.status === 'ACTIF' ? 'ACTIF' : g.status} />
                      {g.status === 'ACTIF' && hasRole(roles, 'R26', 'R08', 'R06') && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act.run(() => api(`/v1/acces/grants/${g.id}/revoke`, { method: 'POST', body: { motif: 'Révocation de la permission' } }), 'Permission révoquée.').then(() => grants.reload())}>Révoquer</button>}
                    </div>
                  </li>
                ))}
              </ul>
            ))}
            {act.node}
          </section>
          {hasRole(roles, 'R26', 'R08', 'R06') && (
            <section className="panel form" aria-label="Déléguer une permission">
              <h2 className="panel-title">Déléguer une permission</h2>
              <p className="small muted">Effet après seconde validation par la sécurité ou la direction de l’entité.</p>
              <div className="field"><label className="label" htmlFor="gr-u">Personne</label>
                <select id="gr-u" value={grantF.userId} onChange={(e) => setGrantF({ ...grantF, userId: e.target.value })}><option value="">—</option>
                  {users.filter((u) => u.id !== user?.id && !u.roles.every((r) => r === 'R30' || r === 'R31')).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
              <div className="field"><label className="label" htmlFor="gr-k">Permission</label>
                <select id="gr-k" value={grantF.kind} onChange={(e) => setGrantF({ ...grantF, kind: e.target.value })}><option value="DROIT_INVITER">Droit d’inviter</option><option value="OPERATEUR_ACCES">Opérateur d’accès désigné</option></select></div>
              <div className="field"><label className="label" htmlFor="gr-m">Motif</label><input id="gr-m" value={grantF.motif} onChange={(e) => setGrantF({ ...grantF, motif: e.target.value })} /></div>
              <button type="button" className="btn btn-primary" disabled={act.busy || !grantF.userId || grantF.motif.trim().length < 5}
                onClick={() => void act.run(() => api('/v1/acces/grants', { method: 'POST', body: grantF }), 'Demande enregistrée : seconde validation attendue.').then(() => { grants.reload(); vals.reload(); })}>Demander</button>
            </section>
          )}
        </div>
      )}

      {tab === 'journal' && (
        <section className="panel" aria-label="Journal des accès">
          <p className="small muted">Toute invitation, activation, modification de rôle ou révocation est journalisée dans le journal chaîné et visible de l’administrateur de l’entité et de l’audit.</p>
          {journal.error !== null && <ErrorState error={journal.error} onRetry={journal.reload} />}
          {journal.data && (journal.data.items.length === 0 ? <EmptyState title="Aucun événement" /> : (
            <DataTable rows={journal.data.items} rowKey={(r) => String(r.seq)} caption="Journal des accès"
              columns={[
                { key: 'at', label: 'Date', render: (r) => fmtDate(r.at, true) },
                { key: 'a', label: 'Action', primary: true, render: (r) => <span className="mono small">{r.action}</span> },
                { key: 'who', label: 'Acteur', render: (r) => <span className="mono small">{r.actor}</span> },
                { key: 'e', label: 'Entité', render: (r) => r.entity ?? '—' },
                { key: 'o', label: 'Issue', render: (r) => <Status s={r.outcome === 'DENIED' ? 'REFUSEE' : 'VALIDEE'} /> },
              ]} />
          ))}
        </section>
      )}

      <Drawer open={!!assist} title="Inscription assistée d’un intervenant" onClose={() => setAssist(null)}>
        {assist && user && <AssistedForm inv={assist} userId={user.id} onDone={() => { setAssist(null); invs.reload(); }} />}
      </Drawer>
      <Drawer open={!!decide} title="Seconde validation" onClose={() => setDecide(null)}>
        {decide && (
          <div className="form">
            <p className="ac-card-title">{decide.subject.fullName} — {decide.subject.accessLevelLabel}</p>
            <p className="small">{REQUIREMENT_LABEL[decide.requirement]}. Motif de l’invitant : « {decide.motif} »</p>
            {decide.requirement === 'HORS_BANDE_CABINET' && <label className="ac-check"><input type="checkbox" checked={dec.oob} onChange={(e) => setDec({ ...dec, oob: e.target.checked })} /> Identité confirmée hors bande (appel au numéro officiel)</label>}
            {decide.requirement === 'HABILITATION_REGIE' && <div className="field"><label className="label" htmlFor="dc-c">Référence de la formation certifiée</label><input id="dc-c" value={dec.cert} onChange={(e) => setDec({ ...dec, cert: e.target.value })} /></div>}
            <div className="field"><label className="label" htmlFor="dc-n">Observation</label><input id="dc-n" value={dec.note} onChange={(e) => setDec({ ...dec, note: e.target.value })} /></div>
            {act.node}
            <div className="btn-row">
              <button type="button" className="btn btn-primary" disabled={act.busy} onClick={() => void act.run(() => api(`/v1/acces/validations/${decide.id}/decision`, {
                method: 'POST', body: { decision: 'APPROUVEE', ...(dec.note ? { note: dec.note } : {}), ...(decide.requirement === 'HORS_BANDE_CABINET' ? { outOfBandConfirmed: dec.oob } : {}), ...(dec.cert ? { certificationRef: dec.cert } : {}) },
              }), 'Validation enregistrée : compte ou permission activé.').then((r) => { if (r) { setDecide(null); vals.reload(); } })}>Approuver</button>
              <button type="button" className="btn btn-secondary" disabled={act.busy || dec.note.trim().length < 3} onClick={() => void act.run(() => api(`/v1/acces/validations/${decide.id}/decision`, { method: 'POST', body: { decision: 'REJETEE', note: dec.note } }), 'Demande rejetée (motif tracé).').then((r) => { if (r) { setDecide(null); vals.reload(); } })}>Rejeter</button>
            </div>
          </div>
        )}
      </Drawer>
      <Drawer open={!!revoke} title="Révoquer un compte de travail" onClose={() => setRevoke(null)}>
        {revoke && (
          <div className="form">
            <p className="ac-guard ac-guard-crit"><Icon name="ban" size={16} /> <span>Révocation immédiate du compte et de ses terminaux. Les comptes qu’il a invités ne sont pas révoqués : ils sont rattachés au successeur ou à l’administrateur de l’entité.</span></p>
            <p><strong>{revoke.fullName}</strong> — {revoke.entity}</p>
            <div className="field"><label className="label" htmlFor="rv-m">Motif</label><textarea id="rv-m" rows={3} value={rev.motif} onChange={(e) => setRev({ ...rev, motif: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="rv-s">Successeur (facultatif)</label>
              <select id="rv-s" value={rev.successorId} onChange={(e) => setRev({ ...rev, successorId: e.target.value })}><option value="">Administrateur de l’entité</option>
                {users.filter((u) => u.entity === revoke.entity && u.id !== revoke.id).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
            {act.node}
            <button type="button" className="btn btn-primary" disabled={act.busy || rev.motif.trim().length < 5}
              onClick={() => void act.run(() => api(`/v1/acces/accounts/${revoke.id}/revoke`, { method: 'POST', body: { motif: rev.motif, ...(rev.successorId ? { successorId: rev.successorId } : {}) } }), 'Compte révoqué.').then((r) => { if (r) { setRevoke(null); accs.reload(); } })}>Révoquer</button>
          </div>
        )}
      </Drawer>
    </div>
  );
}
