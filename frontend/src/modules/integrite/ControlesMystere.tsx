/** Contrôles mystère : planification, résultat par le contrôleur désigné, suites, publication agrégée. */
import { useMemo, useState } from 'react';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { Drawer } from '../../components/Drawer';
import { EmptyState, ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { useApp } from '../../context';
import { ActionError, EvidencePicker, hasRole, StateBadge, useAction, type Evidence } from './shared';
import { COMMUNES } from './Signalement';
import { MystereVisuels } from './visuels';
import './integrite.css';

interface Check {
  id: string; programme: string; targetKind: string; targetRef: string; commune: string; scenario: string; plannedFor: string; controllerId: string;
  status: string; alertId?: string; demo?: boolean;
  result?: { outcome: string; cashRequested: boolean; officialAmountShown: boolean | null; receiptIssued: boolean | null; observations: string; at: string };
  followUp?: { action: string; note: string; caseId?: string };
}
interface Summary { byTarget: { targetKind: string; realises: number; conformes: number; tauxConformite: string | null }[]; planifies: number; example: boolean }

const TARGET_LABELS: Record<string, string> = { AGENT: 'Agent', SOUS_TRAITANT: 'Sous-traitant', POINT_PAIEMENT: 'Point de paiement', GUICHET: 'Guichet' };
const FOLLOW_LABELS: Record<string, string> = { AUCUNE_SUITE: 'Aucune suite', RAPPEL_PROCEDURE: 'Rappel de la procédure', OUVRIR_DOSSIER: 'Ouvrir un dossier d’enquête' };

export default function ControlesMystere() {
  const { user, users, fmtDate } = useApp();
  const allowed = hasRole(user?.roles, 'R22', 'R24');
  const list = useApi(allowed ? () => api<Check[]>('/v1/integrite/mystery-checks') : null, [user?.id]);
  // Conversion justifiée : la synthèse publique regroupe plusieurs sections ; seule « controlesMystere » est lue ici.
  const summary = useApi(() => api<Summary>('/v1/public/integrite/summary').then((s) => (s as unknown as { controlesMystere: Summary }).controlesMystere), [user?.id]);
  const [open, setOpen] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const reload = () => { list.reload(); summary.reload(); };

  return (
    <div className="page page-wide ig-page">
      <PageHead eyebrow="Intégrité" title="Contrôles mystère"
        lead="Vérifications anonymes et périodiques auprès des agents, sous-traitants, guichets et points de paiement. Un constat non conforme ouvre un signal à instruire, jamais une sanction automatique.">
        {allowed && <button type="button" className="btn btn-primary" onClick={() => setPlanning(true)}><Icon name="clock" size={18} /> Planifier un contrôle</button>}
      </PageHead>
      <MystereVisuels checks={list.data} summary={summary.data} />

      <section className="section" aria-labelledby="cm-pub">
        <div className="section-head"><h2 id="cm-pub">Résultats publiés (agrégés)</h2></div>
        {summary.loading && <Loading />}
        {summary.error !== null && <ErrorState error={summary.error} onRetry={summary.reload} />}
        {summary.data && (
          <>
            <div className="ig-summary-grid">
              {summary.data.byTarget.map((t) => (
                <div key={t.targetKind} className="panel ig-summary">
                  <p className="caps-sm muted">{TARGET_LABELS[t.targetKind]}</p>
                  <p className="ig-big">{t.tauxConformite ?? '—'}</p>
                  <p className="small muted">{t.realises ? `${t.conformes} conformes sur ${t.realises} réalisés` : 'Aucun contrôle réalisé'}</p>
                </div>
              ))}
            </div>
            {summary.data.example && <ExampleNotice text="Résultats de démonstration (contrôles fictifs). Aucune cible n’est jamais nommée dans la publication." />}
          </>
        )}
      </section>

      {!allowed ? (
        <EmptyState title="Registre réservé" icon="lock">Le détail des contrôles est réservé à l’audit interne et aux enquêteurs anti-fraude.</EmptyState>
      ) : (
        <section className="section" aria-labelledby="cm-list">
          <div className="section-head"><h2 id="cm-list">Registre des contrôles</h2>{list.data && <span className="count">{list.data.length}</span>}</div>
          {list.loading && <Loading />}
          {list.error !== null && <ErrorState error={list.error} onRetry={list.reload} />}
          {list.data && (
            <DataTable rows={list.data} rowKey={(c) => c.id} caption="Contrôles mystère" empty={<EmptyState title="Aucun contrôle planifié" />}
              columns={[
                { key: 'id', label: 'Contrôle', primary: true, render: (c) => <><button type="button" className="btn-link ig-rowlink" onClick={() => setOpen(c.id)}>{TARGET_LABELS[c.targetKind]} · {c.targetRef}</button><span className="account-code">{c.id} · {c.programme}</span></> },
                { key: 'com', label: 'Commune', render: (c) => <span className="small">{c.commune}</span> },
                { key: 'date', label: 'Date prévue', render: (c) => <span className="small">{fmtDate(c.plannedFor)}</span> },
                { key: 'ctl', label: 'Contrôleur', render: (c) => <span className="mono small">{c.controllerId}</span> },
                { key: 'res', label: 'Résultat', render: (c) => (c.result ? <StateBadge value={c.result.outcome} /> : <span className="small muted">—</span>) },
                { key: 'st', label: 'État', render: (c) => <StateBadge value={c.status} /> },
              ]} />
          )}
        </section>
      )}

      <Drawer open={planning} title="Planifier un contrôle mystère" onClose={() => setPlanning(false)}>
        {planning && <PlanForm controllers={(users ?? []).filter((u) => u.roles.includes('R22') || u.roles.includes('R24'))} onDone={() => { setPlanning(false); reload(); }} />}
      </Drawer>
      <Drawer open={!!open} title="Contrôle mystère" onClose={() => setOpen(null)}>
        {open && list.data && <CheckDetail check={list.data.find((c) => c.id === open)!} onDone={reload} />}
      </Drawer>
    </div>
  );
}

function PlanForm({ controllers, onDone }: { controllers: { id: string; name: string }[]; onDone: () => void }) {
  const [f, setF] = useState({ programme: 'Programme T4 2026', targetKind: 'POINT_PAIEMENT', targetRef: '', commune: 'Gombe', scenario: '', plannedFor: '', controllerId: '' });
  const a = useAction();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ok = f.targetRef.trim().length >= 2 && f.scenario.trim().length >= 10 && !!f.plannedFor && !!f.controllerId;
  return (
    <div className="form">
      <div className="field"><label className="label" htmlFor="p-prog">Programme</label><input id="p-prog" value={f.programme} onChange={set('programme')} /></div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="p-kind">Type de cible</label>
          <select id="p-kind" value={f.targetKind} onChange={set('targetKind')}>{Object.entries(TARGET_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div className="field"><label className="label" htmlFor="p-ref">Cible</label><input id="p-ref" value={f.targetRef} onChange={set('targetRef')} placeholder="Référence du point, de l’équipe…" /></div>
      </div>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="p-com">Commune</label><select id="p-com" value={f.commune} onChange={set('commune')}>{COMMUNES.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="field"><label className="label" htmlFor="p-date">Date prévue</label><input id="p-date" type="date" value={f.plannedFor} onChange={set('plannedFor')} /></div>
      </div>
      <div className="field"><label className="label" htmlFor="p-sc">Scénario</label><textarea id="p-sc" rows={3} value={f.scenario} onChange={set('scenario')} placeholder="Ex. proposer un paiement en espèces et vérifier le refus." /></div>
      <div className="field"><label className="label" htmlFor="p-ctl">Contrôleur désigné</label>
        <select id="p-ctl" value={f.controllerId} onChange={set('controllerId')}><option value="">Choisir…</option>{controllers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
      <ActionError error={a.error} />
      <button type="button" className="btn btn-primary" disabled={a.busy || !ok} onClick={async () => { if (await a.run(() => api('/v1/integrite/mystery-checks', { method: 'POST', body: f }))) onDone(); }}>Planifier</button>
    </div>
  );
}

function CheckDetail({ check, onDone }: { check: Check; onDone: () => void }) {
  const { user, fmtDate } = useApp();
  const a = useAction();
  const [outcome, setOutcome] = useState('CONFORME');
  const [cash, setCash] = useState(false);
  const [amount, setAmount] = useState<'oui' | 'non' | 'na'>('oui');
  const [receipt, setReceipt] = useState<'oui' | 'non' | 'na'>('oui');
  const [obs, setObs] = useState('');
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [action, setAction] = useState('RAPPEL_PROCEDURE');
  const [note, setNote] = useState('');
  const tri = (v: 'oui' | 'non' | 'na') => (v === 'na' ? null : v === 'oui');
  const isController = user?.id === check.controllerId;
  const canOpenCase = hasRole(user?.roles, 'R24');
  const options = useMemo(() => Object.entries(FOLLOW_LABELS).filter(([k]) => k !== 'OUVRIR_DOSSIER' || canOpenCase), [canOpenCase]);
  if (!check) return <EmptyState title="Contrôle introuvable" />;
  return (
    <div className="ig-stack">
      <div className="panel-head"><div><p className="row-title">{TARGET_LABELS[check.targetKind]} · {check.targetRef}</p><p className="panel-sub">{check.id} · {check.commune} · {fmtDate(check.plannedFor)}</p></div><StateBadge value={check.status} /></div>
      {check.demo && <ExampleNotice text="Contrôle de démonstration (fictif)." />}
      <p><strong>Scénario :</strong> {check.scenario}</p>
      {check.result && (
        <dl className="kv kv-dense">
          <div><dt>Résultat</dt><dd><StateBadge value={check.result.outcome} /></dd></div>
          <div><dt>Espèces demandées</dt><dd>{check.result.cashRequested ? 'Oui' : 'Non'}</dd></div>
          <div><dt>Montant officiel affiché</dt><dd>{check.result.officialAmountShown === null ? 'Sans objet' : check.result.officialAmountShown ? 'Oui' : 'Non'}</dd></div>
          <div><dt>Preuve remise</dt><dd>{check.result.receiptIssued === null ? 'Sans objet' : check.result.receiptIssued ? 'Oui' : 'Non'}</dd></div>
          <div><dt>Observations</dt><dd>{check.result.observations}</dd></div>
          {check.alertId && <div><dt>Signal</dt><dd className="mono">{check.alertId}</dd></div>}
        </dl>
      )}
      {check.followUp && <div className="callout callout-info"><Icon name="check" size={18} /><span>Suite : {FOLLOW_LABELS[check.followUp.action]}{check.followUp.caseId ? ` (${check.followUp.caseId})` : ''} — {check.followUp.note}</span></div>}
      <ActionError error={a.error} />
      {check.status === 'PLANIFIE' && (isController ? (
        <fieldset className="line-box"><legend className="label">Enregistrer le résultat</legend>
          <div className="seg seg-sm" role="group" aria-label="Résultat">
            {['CONFORME', 'NON_CONFORME', 'NON_REALISABLE'].map((o) => <button key={o} type="button" aria-pressed={outcome === o} onClick={() => setOutcome(o)}>{o === 'CONFORME' ? 'Conforme' : o === 'NON_CONFORME' ? 'Non conforme' : 'Non réalisable'}</button>)}
          </div>
          <label className="check"><input type="checkbox" checked={cash} onChange={(e) => { setCash(e.target.checked); if (e.target.checked) setOutcome('NON_CONFORME'); }} /><span>Des espèces ont été demandées ou acceptées</span></label>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="r-am">Montant officiel affiché</label><select id="r-am" value={amount} onChange={(e) => setAmount(e.target.value as 'oui')}><option value="oui">Oui</option><option value="non">Non</option><option value="na">Sans objet</option></select></div>
            <div className="field"><label className="label" htmlFor="r-rc">Preuve remise</label><select id="r-rc" value={receipt} onChange={(e) => setReceipt(e.target.value as 'oui')}><option value="oui">Oui</option><option value="non">Non</option><option value="na">Sans objet</option></select></div>
          </div>
          <textarea aria-label="Observations" rows={3} value={obs} onChange={(e) => setObs(e.target.value)} placeholder="Observations factuelles" />
          <EvidencePicker value={evidence} onChange={setEvidence} />
          <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || obs.trim().length < 5} onClick={async () => {
            if (await a.run(() => api(`/v1/integrite/mystery-checks/${check.id}/result`, { method: 'POST', body: { outcome, cashRequested: cash, officialAmountShown: tri(amount), receiptIssued: tri(receipt), observations: obs, ...(evidence.length ? { evidence } : {}) } }))) onDone();
          }}>Enregistrer</button>
        </fieldset>
      ) : <p className="hint">Seul le contrôleur désigné (<span className="mono">{check.controllerId}</span>) enregistre le résultat.</p>)}
      {check.status === 'REALISE' && (
        <fieldset className="line-box"><legend className="label">Décider des suites</legend>
          <select aria-label="Suite" value={action} onChange={(e) => setAction(e.target.value)}>{options.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <textarea aria-label="Motif" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Motif (10 caractères au moins)" />
          <button type="button" className="btn btn-primary btn-sm" disabled={a.busy || note.trim().length < 10} onClick={async () => {
            if (await a.run(() => api(`/v1/integrite/mystery-checks/${check.id}/follow-up`, { method: 'POST', body: { action, note } }))) onDone();
          }}>Valider la suite</button>
        </fieldset>
      )}
    </div>
  );
}
