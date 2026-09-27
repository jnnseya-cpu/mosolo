/**
 * Plateforme et accès — module 52 (intégration et API partenaires : registre des interfaces, clients OAuth2, quotas,
 * journal des appels, rappels signés), module 53 (administration : environnements, déploiements et retours arrière
 * validés par le comité de contrôle des changements) et module 55 (supervision : métriques, alertes, incidents,
 * astreinte, délai de rétablissement contre le RTO).
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Section } from '../pilotage/shared';
import { Area, Choice, Field, hasRole } from '../pilotage/planif';
import { date, Ecran, Indicateurs, Statut, useRunner, useVue, type Indicator } from '../decision/commun';

// ───────────────────────────── module 52 ─────────────────────────────
interface Contract { id: string; code: string; partnerName: string; partnerKind: string; object: string; scopes: string[]; protocol: { reference: string; sha256: string; signedAt: string }; validFrom: string; validTo: string; status: string; proposedBy: string }
interface ClientRow { id: string; label: string; contract: string; status: string; quota: { perMinute: number; perDay: number; status: string }; certFingerprint: string | null; calls: number; errors: number; outOfObject: number; availabilityPct: string | null }
interface Partenaires {
  scopes: Record<string, string>; kinds: Record<string, string>; defaults: { tokenTtlSeconds: number; quota: { perMinute: number; perDay: number }; status: string }; delivery: string;
  contracts: Contract[]; clients: ClientRow[]; indicators: Indicator[];
  calls: { id: string; at: string; clientId: string | null; method: string; route: string; scope: string | null; status: number; outcome: string; latencyMs: number }[];
  subscriptions: { id: string; clientId: string; url: string; events: string[]; status: string }[];
  deliveries: { id: string; event: string; at: string; status: string; httpStatus?: number }[];
}
const CONTRACT: Record<string, [string, 'good' | 'warning' | 'critical' | 'neutral']> = { PROPOSE: ['Proposé — approbation attendue', 'warning'], ACTIF: ['Actif', 'good'], SUSPENDU: ['Suspendu', 'critical'], REFUSE: ['Refusé', 'neutral'] };

export function Partenaires() {
  const { user } = useApp();
  const q = useVue<Partenaires>('/v1/plateforme/partenaires');
  const r = useRunner(q.reload);
  const manage = hasRole(user?.roles, 'R26', 'R27');
  const approve = hasRole(user?.roles, 'R28', 'R25');
  const [motif, setMotif] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('BANQUE');
  const [object, setObject] = useState('');
  const [scopes, setScopes] = useState<string[]>([]);
  const [provider, setProvider] = useState('');
  const [protoRef, setProtoRef] = useState('');
  const [protoSha, setProtoSha] = useState('');
  const [signedAt, setSignedAt] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  return (
    <Ecran eyebrow="Plateforme et accès · module 52" title="Intégration et API partenaires" lead="Interfaces versionnées (REST/JSON, événements) ; OAuth2, TLS mutuel, portées limitées à l’objet contracté ; protocole signé pour chaque échange." q={q} msg={r.msg}>
      {(d) => (<>
        <Section title="Indicateurs" sub={`Jeton : ${d.defaults.tokenTtlSeconds} s ; quota par défaut : ${d.defaults.quota.perMinute}/min, ${d.defaults.quota.perDay}/jour (${d.defaults.status}). Rappels : ${d.delivery}.`}><Indicateurs items={d.indicators} /></Section>
        <Section title="Registre des interfaces (contrats et protocoles signés)">
          <Field label="Motif (approbation, suspension, révocation — 10 caractères minimum)" value={motif} onChange={setMotif} />
          <DataTable caption="Contrats" rows={d.contracts} rowKey={(c) => c.id} empty={<p className="muted">Aucun contrat.</p>} columns={[
            { key: 'c', label: 'Contrat', primary: true, render: (c) => <><strong>{c.code}</strong> — {c.partnerName}<br /><span className="small muted">{c.object}</span></> },
            { key: 's', label: 'Portées', render: (c) => c.scopes.join(', ') },
            { key: 'p', label: 'Protocole signé', render: (c) => `${c.protocol.reference} (${c.protocol.signedAt}) · ${c.protocol.sha256.slice(0, 10)}…` },
            { key: 't', label: 'Statut', render: (c) => <Statut code={c.status} map={CONTRACT} /> },
            { key: 'a', label: 'Actions', render: (c) => (
              <div className="btn-row">
                {c.status === 'PROPOSE' && approve && c.proposedBy !== user?.id && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.length < 10} onClick={() => void r.run(`/v1/plateforme/partenaires/contrats/${c.id}/decision`, { approve: true, motif }, 'Protocole approuvé : contrat actif.')}>Approuver</button>}
                {c.status === 'ACTIF' && approve && <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.length < 10} onClick={() => void r.run(`/v1/plateforme/partenaires/contrats/${c.id}/suspension`, { motif }, 'Contrat suspendu : jetons invalidés.')}>Suspendre</button>}
                {c.status === 'ACTIF' && manage && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run<{ clientSecret: string; client: { id: string } }>('/v1/plateforme/partenaires/clients', { contractId: c.id, label: `Client ${c.code}` }, 'Client créé.').then((x) => x && setSecret(`Identifiant ${x.client.id} — secret (affiché une seule fois) : ${x.clientSecret}`))}>Créer un client OAuth2</button>}
              </div>
            ) },
          ]} />
          {secret && <p className="notice notice-ok" role="status">{secret}</p>}
          {manage && (
            <div className="form">
              <p className="small muted">Inscrire un contrat d’interface : approbation par la sécurité ou le délégué à la protection des données.</p>
              <Field label="Code" value={code} onChange={setCode} />
              <Field label="Partenaire" value={name} onChange={setName} />
              <Choice label="Nature" value={kind} onChange={setKind} options={Object.entries(d.kinds)} />
              <Area label="Objet contracté" value={object} onChange={setObject} rows={2} />
              <fieldset className="field"><legend className="label">Portées</legend>
                {Object.entries(d.scopes).map(([s, l]) => <label key={s} className="small" style={{ display: 'block' }}><input type="checkbox" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} /> {s} — {l}</label>)}
              </fieldset>
              <Field label="Prestataire couvert (paiements)" value={provider} onChange={setProvider} />
              <Field label="Référence du protocole signé" value={protoRef} onChange={setProtoRef} />
              <Field label="Empreinte SHA-256 du protocole signé" value={protoSha} onChange={setProtoSha} />
              <Field label="Date de signature" type="date" value={signedAt} onChange={setSignedAt} />
              <Field label="Début" type="date" value={from} onChange={setFrom} />
              <Field label="Fin" type="date" value={to} onChange={setTo} />
              <button type="button" className="btn btn-primary" disabled={r.busy || !code || !scopes.length || !protoSha} onClick={() => void r.run('/v1/plateforme/partenaires/contrats', { code, partnerName: name, partnerKind: kind, object, scopes, dataCategories: ['Référence', 'Statut'], ...(provider ? { providerId: provider } : {}), protocol: { reference: protoRef, sha256: protoSha, signedAt }, consentRequired: false, validFrom: from, validTo: to }, 'Contrat inscrit au registre.')}>Inscrire</button>
            </div>
          )}
        </Section>
        <Section title="Clients, quotas et disponibilité des partenaires">
          <DataTable caption="Clients" rows={d.clients} rowKey={(c) => c.id} empty={<p className="muted">Aucun client.</p>} columns={[
            { key: 'c', label: 'Client', primary: true, render: (c) => `${c.id} — ${c.label} (${c.contract})` },
            { key: 'q', label: 'Quota', render: (c) => `${c.quota.perMinute}/min · ${c.quota.perDay}/jour` },
            { key: 'm', label: 'TLS mutuel', render: (c) => c.certFingerprint ?? 'non lié' },
            { key: 'n', label: 'Appels / erreurs / hors objet', num: true, render: (c) => `${c.calls} / ${c.errors} / ${c.outOfObject}` },
            { key: 'd', label: 'Disponibilité', num: true, render: (c) => (c.availabilityPct ? `${c.availabilityPct} %` : 'non mesurée') },
            { key: 's', label: 'Statut', render: (c) => (c.status === 'ACTIF' && approve ? <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.length < 10} onClick={() => void r.run(`/v1/plateforme/partenaires/clients/${c.id}/revocation`, { motif }, 'Client révoqué.')}>Révoquer</button> : c.status) },
          ]} />
        </Section>
        <Section title="Journal des appels (chaque appel est journalisé)">
          <DataTable caption="Appels" rows={d.calls.slice(0, 30)} rowKey={(c) => c.id} empty={<p className="muted">Aucun appel.</p>} columns={[
            { key: 'a', label: 'Heure', render: (c) => date(c.at) },
            { key: 'c', label: 'Client', render: (c) => c.clientId ?? '—' },
            { key: 'r', label: 'Route', primary: true, render: (c) => `${c.method} ${c.route}` },
            { key: 'o', label: 'Résultat', render: (c) => <StatusBadge tone={c.outcome === 'OK' ? 'good' : c.outcome === 'HORS_OBJET' ? 'critical' : 'warning'} label={`${c.status} ${c.outcome}`} /> },
            { key: 'l', label: 'Latence', num: true, render: (c) => `${c.latencyMs} ms` },
          ]} />
        </Section>
        <Section title="Événements signés (rappels)">
          <DataTable caption="Abonnements" rows={d.subscriptions} rowKey={(s) => s.id} empty={<p className="muted">Aucun abonnement.</p>} columns={[
            { key: 'c', label: 'Client', primary: true, render: (s) => s.clientId },
            { key: 'u', label: 'Adresse', render: (s) => s.url },
            { key: 'e', label: 'Événements', render: (s) => s.events.join(', ') },
          ]} />
          <DataTable caption="Livraisons" rows={d.deliveries.slice(0, 20)} rowKey={(x) => x.id} empty={<p className="muted">Aucune livraison.</p>} columns={[
            { key: 'a', label: 'Heure', render: (x) => date(x.at) },
            { key: 'e', label: 'Événement', primary: true, render: (x) => x.event },
            { key: 's', label: 'Statut', render: (x) => `${x.status}${x.httpStatus ? ` (${x.httpStatus})` : ''}` },
          ]} />
        </Section>
      </>)}
    </Ecran>
  );
}

// ───────────────────────────── module 53 ─────────────────────────────
interface Change { id: string; kind: string; environment: string; version?: string; config?: { key: string; value: string }; motif: string; requestedBy: string; approvals: { by: string }[]; status: string; execution?: { result: string; at: string; previousVersion: string | null } }
interface Admin { environments: { id: string; label: string; version: string | null; config: Record<string, string>; history: { at: string; kind: string; version?: string; result: string }[] }[]; changes: Change[]; params: { cabQuorum: number; postDeployWindowHours: number; status: string }; rule: string; indicators: Indicator[] }

export function Administration() {
  const { user } = useApp();
  const q = useVue<Admin>('/v1/plateforme/administration');
  const r = useRunner(q.reload);
  const [kind, setKind] = useState('DEPLOIEMENT');
  const [envCode, setEnvCode] = useState('RECETTE');
  const [version, setVersion] = useState('');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [motif, setMotif] = useState('');
  const [plan, setPlan] = useState('');
  const cab = hasRole(user?.roles, 'R26', 'R27', 'R28');
  const exec = hasRole(user?.roles, 'R26', 'R27');
  return (
    <Ecran eyebrow="Plateforme et accès · module 53" title="Administration de la plateforme" lead="Environnements, déploiements et retours arrière validés par le comité de contrôle des changements ; aucun pouvoir fiscal ni financier." q={q} msg={r.msg}>
      {(d) => (<>
        <Section title="Indicateurs" sub={`${d.rule} Quorum du comité : ${d.params.cabQuorum} ; fenêtre post-déploiement : ${d.params.postDeployWindowHours} h (${d.params.status}).`}><Indicateurs items={d.indicators} /></Section>
        <Section title="Environnements">
          <DataTable caption="Environnements" rows={d.environments} rowKey={(e) => e.id} columns={[
            { key: 'e', label: 'Environnement', primary: true, render: (e) => e.label },
            { key: 'v', label: 'Version en place', render: (e) => e.version ?? '—' },
            { key: 'c', label: 'Configuration technique', render: (e) => Object.entries(e.config).map(([k, v]) => `${k}=${v}`).join(' · ') || '—' },
            { key: 'h', label: 'Dernier changement', render: (e) => (e.history.at(-1) ? `${e.history.at(-1)!.kind} ${e.history.at(-1)!.version ?? ''} — ${e.history.at(-1)!.result}` : '—') },
          ]} />
        </Section>
        {exec && (
          <Section title="Demande de changement">
            <div className="form">
              <Choice label="Nature" value={kind} onChange={setKind} options={[['DEPLOIEMENT', 'Déploiement'], ['RETOUR_ARRIERE', 'Retour arrière'], ['CONFIGURATION', 'Configuration technique (non financière)']]} />
              <Choice label="Environnement" value={envCode} onChange={setEnvCode} options={[['RECETTE', 'Recette'], ['PRE_PRODUCTION', 'Pré-production'], ['PRODUCTION', 'Production']]} />
              {kind !== 'CONFIGURATION' ? <Field label="Version" value={version} onChange={setVersion} /> : (<><Field label="Clé technique" value={key} onChange={setKey} /><Field label="Valeur" value={value} onChange={setValue} /></>)}
              <Field label="Motif" value={motif} onChange={setMotif} />
              <Field label="Plan de retour arrière" value={plan} onChange={setPlan} />
              <button type="button" className="btn btn-primary" disabled={r.busy || motif.length < 10 || plan.length < 10} onClick={() => void r.run('/v1/plateforme/changements', { kind, environment: envCode, motif, rollbackPlan: plan, ...(kind === 'CONFIGURATION' ? { config: { key, value } } : { version }) }, 'Demande soumise au comité de contrôle des changements.')}>Soumettre</button>
            </div>
          </Section>
        )}
        <Section title="Demandes de changement">
          <DataTable caption="Changements" rows={d.changes} rowKey={(c) => c.id} empty={<p className="muted">Aucune demande.</p>} columns={[
            { key: 'c', label: 'Demande', primary: true, render: (c) => `${c.id} — ${c.kind} ${c.environment} ${c.version ?? (c.config ? `${c.config.key}=${c.config.value}` : '')}` },
            { key: 'a', label: 'Avis du comité', num: true, render: (c) => `${c.approvals.length} / ${d.params.cabQuorum}` },
            { key: 's', label: 'Statut', render: (c) => `${c.status}${c.execution ? ` (${c.execution.result})` : ''}` },
            { key: 'x', label: 'Actions', render: (c) => (
              <div className="btn-row">
                {c.status === 'DEMANDEE' && cab && c.requestedBy !== user?.id && !c.approvals.some((a) => a.by === user?.id) && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/plateforme/changements/${c.id}/avis`, { approve: true, motif: 'Avis favorable du comité de contrôle des changements' }, 'Avis enregistré.')}>Avis favorable</button>}
                {c.status === 'APPROUVEE' && exec && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/plateforme/changements/${c.id}/execution`, { result: 'SUCCES', report: 'Exécuté selon le plan approuvé' }, 'Changement exécuté.')}>Exécuter</button>}
              </div>
            ) },
          ]} />
        </Section>
      </>)}
    </Ecran>
  );
}

// ───────────────────────────── module 55 ─────────────────────────────
interface Supervision {
  targets: { availabilityPct: string; rtoHours: Record<string, number>; phase: string; source: string };
  thresholds: { latencyP95Ms: number; windowMinutes: number; status: string };
  window15: { requests: number; errors5xx: number; availabilityPct: string | null; p95Ms: number | null };
  routes: { method: string; route: string; count: number; errors5xx: number; errors4xx: number; meanMs: number | null }[];
  alerts: { code: string; raised: boolean; detail: string }[];
  onCall: { id: string; name: string; level: string; to: string }[];
  incidents: { id: string; title: string; service: string; severity: string; status: string; detectedAt: string; restored?: { at: string; by: string } }[];
  procedure: string[]; logs: { note: string; redacted: string[] }; metricsEndpoint: string; indicators: Indicator[];
}

export function SupervisionSante() {
  const { user } = useApp();
  const q = useVue<Supervision>('/v1/plateforme/supervision');
  const r = useRunner(q.reload);
  const [title, setTitle] = useState('');
  const [service, setService] = useState('');
  const [severity, setSeverity] = useState('S3');
  const [note, setNote] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [pm, setPm] = useState('');
  const [onCallUser, setOnCallUser] = useState('');
  const [onCallFrom, setOnCallFrom] = useState('');
  const [onCallTo, setOnCallTo] = useState('');
  const ops = hasRole(user?.roles, 'R26', 'R27', 'R28');
  return (
    <Ecran eyebrow="Plateforme et accès · module 55" title="Supervision et santé du système" lead="Observabilité (métriques, journaux, traces), alertes de disponibilité, latence et erreurs, incidents et astreinte." q={q} msg={r.msg}>
      {(d) => (<>
        <Section title="Indicateurs" sub={`Cibles ${d.targets.source} : disponibilité ${d.targets.availabilityPct} % ; RTO ${d.targets.rtoHours[d.targets.phase]} h (phase ${d.targets.phase}).`}><Indicateurs items={d.indicators} /></Section>
        <Section title="Fenêtre glissante et alertes" sub={`Seuils : latence p95 ${d.thresholds.latencyP95Ms} ms sur ${d.thresholds.windowMinutes} min (${d.thresholds.status}). Métriques : ${d.metricsEndpoint}.`}>
          <p>Requêtes : {d.window15.requests} · erreurs serveur : {d.window15.errors5xx} · disponibilité : {d.window15.availabilityPct ?? '—'} % · p95 : {d.window15.p95Ms ?? '—'} ms</p>
          {d.alerts.length ? d.alerts.map((a) => <p key={a.code}><StatusBadge tone="critical" label={a.code} /> {a.detail}</p>) : <p className="muted">Aucune alerte dans la fenêtre.</p>}
          <DataTable caption="Routes" rows={d.routes} rowKey={(x) => `${x.method} ${x.route}`} columns={[
            { key: 'r', label: 'Route (gabarit)', primary: true, render: (x) => `${x.method} ${x.route}` },
            { key: 'n', label: 'Requêtes', num: true, render: (x) => x.count },
            { key: 'e', label: 'Erreurs 5xx / 4xx', num: true, render: (x) => `${x.errors5xx} / ${x.errors4xx}` },
            { key: 'm', label: 'Latence moyenne', num: true, render: (x) => (x.meanMs === null ? '—' : `${x.meanMs} ms`) },
          ]} />
          <p className="small muted">{d.logs.note} Expurgé : {d.logs.redacted.join(', ')}.</p>
        </Section>
        <Section title="Astreinte" sub={d.onCall.length ? `En cours : ${d.onCall.map((s) => `${s.name} (${s.level})`).join(', ')}` : 'Aucune astreinte en cours : l’exploitation est notifiée.'}>
          {hasRole(user?.roles, 'R26', 'R27') && (
            <div className="form">
              <Field label="Personne d’astreinte (identifiant)" value={onCallUser} onChange={setOnCallUser} />
              <Field label="Début (ISO)" value={onCallFrom} onChange={setOnCallFrom} placeholder="2026-09-26T00:00:00Z" />
              <Field label="Fin (ISO)" value={onCallTo} onChange={setOnCallTo} placeholder="2026-09-27T00:00:00Z" />
              <button type="button" className="btn btn-secondary" disabled={r.busy || !onCallUser} onClick={() => void r.run('/v1/plateforme/astreintes', { userId: onCallUser, level: 'PRINCIPAL', from: onCallFrom, to: onCallTo }, 'Astreinte planifiée.')}>Planifier</button>
            </div>
          )}
        </Section>
        <Section title="Incidents — procédure" sub={d.procedure.join(' ')}>
          {ops && (
            <div className="form">
              <Field label="Incident" value={title} onChange={setTitle} />
              <Field label="Service" value={service} onChange={setService} />
              <Choice label="Sévérité" value={severity} onChange={setSeverity} options={[['S1', 'S1 — critique'], ['S2', 'S2 — majeur'], ['S3', 'S3 — modéré'], ['S4', 'S4 — mineur']]} />
              <button type="button" className="btn btn-primary" disabled={r.busy || title.length < 5 || service.length < 2} onClick={() => void r.run('/v1/plateforme/incidents', { title, service, severity }, 'Incident déclaré : astreinte notifiée.')}>Déclarer</button>
              <Field label="Note d’étape" value={note} onChange={setNote} />
              <Field label="Cause racine (clôture)" value={rootCause} onChange={setRootCause} />
              <Field label="Empreinte de la revue post-incident (clôture)" value={pm} onChange={setPm} />
            </div>
          )}
          <DataTable caption="Incidents" rows={d.incidents} rowKey={(i) => i.id} empty={<p className="muted">Aucun incident.</p>} columns={[
            { key: 'i', label: 'Incident', primary: true, render: (i) => `${i.id} — ${i.title} (${i.service})` },
            { key: 's', label: 'Sévérité / statut', render: (i) => `${i.severity} — ${i.status}` },
            { key: 'd', label: 'Détecté / rétabli', render: (i) => `${date(i.detectedAt)} → ${i.restored ? date(i.restored.at) : '…'}` },
            { key: 'a', label: 'Étape', render: (i) => (ops ? (
              <div className="btn-row">
                {i.status === 'DECLARE' && <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || note.length < 5} onClick={() => void r.run(`/v1/plateforme/incidents/${i.id}/etapes`, { step: 'PRISE_EN_CHARGE', note }, 'Pris en charge.')}>Prendre en charge</button>}
                {['DECLARE', 'PRIS_EN_CHARGE'].includes(i.status) && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy || note.length < 5} onClick={() => void r.run(`/v1/plateforme/incidents/${i.id}/etapes`, { step: 'RETABLI', note }, 'Service rétabli.')}>Rétabli</button>}
                {i.status === 'RETABLI' && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || note.length < 5 || rootCause.length < 5 || !/^[0-9a-f]{64}$/.test(pm)} onClick={() => void r.run(`/v1/plateforme/incidents/${i.id}/etapes`, { step: 'CLOS', note, rootCause, postMortemSha256: pm }, 'Incident clos.')}>Clore</button>}
              </div>
            ) : null) },
          ]} />
        </Section>
      </>)}
    </Ecran>
  );
}
