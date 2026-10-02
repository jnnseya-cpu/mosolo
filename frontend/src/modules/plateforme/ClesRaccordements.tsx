/**
 * « Clés et raccordements » (29/09/2026) — console du super-administrateur (R26), validée par une seconde personne
 * (R26 ou responsable sécurité R28). Toutes les clés et tous les webhooks des services externes : paiement, IA, SMS/USSD,
 * e-mail, WhatsApp, cartes, MDM, identité…
 * ÉCRITURE SEULE : la valeur saisie part au serveur, chiffrée au repos, et n'est plus jamais affichée (pas même masquée).
 * Aucune valeur n'est conservée dans le navigateur (ni brouillon, ni stockage local) ; le champ est vidé après l'envoi.
 */
import { useState, type FormEvent } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { StatusBadge } from '../../components/StatusBadge';
import { ErrorState, Loading } from '../../components/States';
import '../prestataires/prestataires.css';

type Source = 'ENVIRONNEMENT' | 'CONSOLE' | 'ABSENTE';
interface Variable {
  name: string; group: string; purpose: string; secret: boolean; required: 'OBLIGATOIRE_EN_REEL' | 'FACULTATIVE';
  effect: 'IMMEDIAT' | 'AUCUN_LECTEUR' | 'ENVIRONNEMENT_SEUL'; format: string; proposedName: boolean; readBy: string[]; settable: boolean;
  envPresent: boolean; consolePresent: boolean; consoleUnreadable: boolean; activeSource: Source;
  consoleVersion: number | null; consoleEffectiveAt: string | null; consoleApprovedBy: string | null; consoleProposedBy: string | null;
  pending: { id: string; kind: 'DEFINIR' | 'RETIRER'; proposedBy: string; proposedAt: string } | null;
}
interface Group { id: string; label: string; test: 'APPEL_REEL' | 'CONFIGURATION'; variables: Variable[]; pending: number; missingRequired: string[] }
interface Keys {
  generatedAt: string; masterKey: { state: string; label: string; writable: boolean }; resolutionRule: string; groups: Group[];
  connectors: { configError: string | null; reloads: number; lastReloadAt: string | null }; publicUrl: { value: string | null; valid: boolean; note: string }; doctrine: string[];
}
interface Proposal { id: string; variable: string; kind: 'DEFINIR' | 'RETIRER'; status: string; motif: string; proposedBy: string; proposedAt: string; decidedBy: string | null; decidedAt: string | null; decisionMotif: string | null }
interface Webhook {
  id: string; label: string; method: string; path: string; url: string; urlReady: boolean; signature: string; secretVariable: string | null; secretSource: Source | null;
  lastDelivery: { at: string; verification: string; code: string | null; httpStatus: number | null } | null;
}
interface TestResult { kind: 'APPEL_REEL' | 'VALIDATION_A_BLANC'; ok: boolean; endpoint?: string; proves: string; detail: string; checks: { label: string; ok: boolean; detail?: string }[] }

/** Clés à saisir pour tester (02/10/2026) : l'adresse publique, BitriPay (3), KODA (2), IA (3, une suffit). */
const ESSENTIELLES = ['MOSOLO_PUBLIC_URL', 'BITRIPAY_API_KEY', 'BITRIPAY_WEBHOOK_SECRET', 'BITRIPAY_ED25519_PUBLIC_KEY', 'KODA_API_KEY', 'KODA_WEBHOOK_SECRET', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
const ESSENTIELLES_GROUPES = ['bitripay', 'koda', 'ia'];

const SOURCE: Record<Source, { tone: 'good' | 'info' | 'neutral'; label: string }> = {
  ENVIRONNEMENT: { tone: 'good', label: 'Active : environnement' }, CONSOLE: { tone: 'info', label: 'Active : console' }, ABSENTE: { tone: 'neutral', label: 'Absente' },
};
const EFFECT: Record<Variable['effect'], string> = {
  IMMEDIAT: 'Prise en compte immédiate, sans redéploiement',
  AUCUN_LECTEUR: 'Nom proposé — à confirmer : aucun module ne la lit encore',
  ENVIRONNEMENT_SEUL: 'Environnement seulement (lue au démarrage ou clé interne du socle)',
};
const STATUS: Record<string, { tone: 'warning' | 'good' | 'critical' | 'neutral'; label: string }> = {
  EN_ATTENTE: { tone: 'warning', label: 'En attente d’approbation' }, APPROUVEE: { tone: 'good', label: 'Approuvée' }, REJETEE: { tone: 'critical', label: 'Rejetée' }, REMPLACEE: { tone: 'neutral', label: 'Remplacée' },
};

export default function ClesRaccordements() {
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<Keys>('/v1/integrations/keys'), [user?.id]);
  const props = useApi(() => api<Proposal[]>('/v1/integrations/proposals'), [user?.id]);
  const hooks = useApi(() => api<{ publicUrl: Keys['publicUrl']; webhooks: Webhook[] }>('/v1/integrations/webhooks'), [user?.id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [motif, setMotif] = useState('');
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<string, TestResult>>({});
  const [copied, setCopied] = useState<string | null>(null);
  const canPropose = !!user?.roles.includes('R26');
  const canApprove = !!user?.roles.some((r) => r === 'R26' || r === 'R28');

  const reloadAll = () => { q.reload(); props.reload(); hooks.reload(); };

  async function proposer(e: FormEvent, v: Variable, kind: 'DEFINIR' | 'RETIRER') {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try {
      const res = await api<{ status: string; configurationWarning?: string | null }>(`/v1/integrations/keys/${encodeURIComponent(v.name)}/proposals`, { method: 'POST', body: { kind, ...(kind === 'DEFINIR' ? { value: value.trim() } : {}), motif } });
      // Clés d'IA (décision du 01/10/2026) : appliquées sur la seule décision du super-administrateur.
      // Valeur enregistrée mais raccordement encore incomplet (02/10/2026) : on dit ce qui manque, sans valeur.
      setMsg({ ok: true, text: res.status === 'APPROUVEE'
        ? `${v.name} : enregistrée et appliquée (approbation unique du super-administrateur, journalisée).${res.configurationWarning ? ` Raccordement pas encore actif : ${res.configurationWarning}` : ''}`
        : `${v.name} : proposition enregistrée. Elle ne s’appliquera qu’après l’approbation d’une autre personne (R26 ou R28).` });
      setEdit(null); setMotif('');
      reloadAll();
    } catch (x) {
      setMsg({ ok: false, text: describeError(x).message });
    } finally {
      // La valeur saisie est effacée du navigateur dans tous les cas (écriture seule).
      setValue('');
      setBusy(false);
    }
  }

  async function decider(p: Proposal, approve: boolean) {
    const m = approve ? undefined : window.prompt('Motif du rejet (obligatoire) :') ?? '';
    if (!approve && (!m || m.trim().length < 3)) return;
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ activeSource?: Source; configurationWarning?: string | null }>(`/v1/integrations/proposals/${p.id}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: approve ? {} : { motif: m } });
      setMsg({
        ok: !r.configurationWarning,
        text: approve
          ? `${p.variable} : approuvée. Source active : ${SOURCE[r.activeSource ?? 'ABSENTE'].label.replace('Active : ', '')}.${r.configurationWarning ? ` Attention — configuration encore incomplète : ${r.configurationWarning}` : ''}`
          : `${p.variable} : proposition rejetée ; la valeur en attente a été effacée.`,
      });
      reloadAll();
    } catch (x) {
      setMsg({ ok: false, text: describeError(x).message });
    } finally { setBusy(false); }
  }

  async function tester(g: Group) {
    setBusy(true); setMsg(null);
    try {
      const r = await api<TestResult>(`/v1/integrations/${g.id}/test`, { method: 'POST', body: {} });
      setTests((t) => ({ ...t, [g.id]: r }));
      hooks.reload();
    } catch (x) {
      setMsg({ ok: false, text: describeError(x).message });
    } finally { setBusy(false); }
  }

  async function copier(url: string) {
    try { await navigator.clipboard.writeText(url); setCopied(url); } catch { setCopied(null); }
  }

  if (q.loading && !q.data) return <div className="page"><Loading /></div>;
  if (q.error) return <div className="page"><ErrorState error={q.error} onRetry={q.reload} /></div>;
  const d = q.data;
  if (!d) return null;
  const pending = (props.data ?? []).filter((p) => p.status === 'EN_ATTENTE');
  const variables = d.groups.flatMap((g) => g.variables);
  // Ligne d'une variable (présentation commune au bloc « Pour tester » et aux groupes complets).
  const ligne = (v: Variable) => (
    <li key={v.name} className="list-row">
      <div className="min0">
        <p className="row-title mono small">{v.name}{v.secret ? ' (secret)' : ''}{v.required === 'OBLIGATOIRE_EN_REEL' ? ' — requise en réel' : ''}</p>
        <p className="small muted">{v.purpose}</p>
        <p className="small muted">{EFFECT[v.effect]}{v.readBy.length ? ` · lue par : ${v.readBy.join(', ')}` : ''}</p>
        {v.consolePresent && <p className="small muted">Console : version {v.consoleVersion} du {v.consoleEffectiveAt ? fmtDate(v.consoleEffectiveAt, true) : '—'} (proposée par {v.consoleProposedBy}, approuvée par {v.consoleApprovedBy}){v.consoleUnreadable ? ' — ILLISIBLE (clé maîtresse changée) : à ressaisir' : ''}{v.envPresent ? ' — inactive : l’environnement prévaut' : ''}</p>}
        {v.pending && <p className="small"><StatusBadge tone="warning" label={`Proposition en attente (${v.pending.kind === 'DEFINIR' ? 'définir' : 'retirer'}) par ${v.pending.proposedBy}`} /></p>}
        {edit === v.name && (
          <form className="form" onSubmit={(e) => void proposer(e, v, 'DEFINIR')} autoComplete="off">
            <div className="field">
              <label className="label" htmlFor={`val-${v.name}`}>Nouvelle valeur de {v.name} (écriture seule — jamais réaffichée)</label>
              {v.format === 'CLE_PUBLIQUE_ED25519'
                // Clé publique PEM sur plusieurs lignes : zone de texte (un champ d'une ligne retire les retours).
                ? <textarea id={`val-${v.name}`} className="input mono" rows={5} spellCheck={false}
                  value={value} onChange={(e) => setValue(e.target.value)} required />
                : <input id={`val-${v.name}`} className="input mono" type={v.secret ? 'password' : 'text'} autoComplete="new-password" spellCheck={false}
                  value={value} onChange={(e) => setValue(e.target.value)} required />}
            </div>
            <div className="field">
              <label className="label" htmlFor={`mot-${v.name}`}>Motif (obligatoire)</label>
              <input id={`mot-${v.name}`} className="input" value={motif} onChange={(e) => setMotif(e.target.value)} minLength={3} maxLength={500} required />
            </div>
            <div className="row-actions">
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !d.masterKey.writable}>Proposer</button>
              {v.consolePresent && <button type="button" className="btn btn-ghost btn-sm" disabled={busy || motif.trim().length < 3} onClick={(e) => void proposer(e as unknown as FormEvent, v, 'RETIRER')}>Proposer le retrait</button>}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEdit(null); setValue(''); }}>Annuler</button>
            </div>
          </form>
        )}
      </div>
      <div className="row-actions">
        <StatusBadge tone={SOURCE[v.activeSource].tone} label={SOURCE[v.activeSource].label} />
        {canPropose && v.settable && edit !== v.name && (
          <button type="button" className="btn btn-ghost btn-sm" disabled={!d.masterKey.writable} onClick={() => { setEdit(v.name); setValue(''); setMotif(''); }}>
            {v.consolePresent ? 'Faire tourner' : 'Définir'}
          </button>
        )}
      </div>
    </li>
  );

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Plateforme · sécurité" title="Clés et raccordements"
        lead="Toutes les clés et tous les webhooks des services externes (paiement, IA, SMS, e-mail, WhatsApp, cartes, MDM, identité). Écriture seule, chiffrement au repos ; chaque clé est appliquée dès sa saisie par le super-administrateur (décision du 01/10/2026), journalisée.">
        <button type="button" className="btn btn-ghost btn-sm" onClick={reloadAll}><Icon name="refresh" size={16} /> Actualiser</button>
      </PageHead>
      <p className={`notice ${d.masterKey.writable ? 'notice-ok' : 'notice-err'}`} role="status"><Icon name="lock" size={16} /> {d.masterKey.label}</p>
      <p className="notice" role="note"><Icon name="info" size={16} /> {d.resolutionRule}</p>
      {d.connectors.configError && <p className="notice notice-err" role="alert">Connecteurs de paiement : la dernière configuration n’a pas été appliquée — {d.connectors.configError} Les connecteurs précédents restent en service.</p>}
      {msg && <p className={`notice ${msg.ok ? 'notice-ok' : 'notice-err'}`} role="status">{msg.text}</p>}

      {/* Les seules clés à saisir pour tester (02/10/2026) : tout le reste est facultatif ou pour la mise en production,
          replié plus bas — rien n'est retiré. */}
      <section className="panel" aria-labelledby="cles-essentielles">
        <div className="panel-head">
          <div className="min0">
            <h2 className="panel-title" id="cles-essentielles">Pour tester : {ESSENTIELLES.length} clés seulement</h2>
            <p className="panel-sub">Paiement BitriPay et KODA, et au moins une clé d’IA. Comptes de règlement et autres réglages : valeurs par défaut déjà en place.</p>
          </div>
          <div className="row-actions">
            {ESSENTIELLES_GROUPES.map((id) => {
              const g = d.groups.find((x) => x.id === id);
              return g && <button key={id} type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void tester(g)}><Icon name="refresh" size={16} /> Tester {g.label.replace(/^Paiement — /, '')}</button>;
            })}
          </div>
        </div>
        {ESSENTIELLES_GROUPES.map((id) => tests[id] && (
          <div key={id} className="pr-test-res">
            <StatusBadge tone={tests[id]!.ok ? 'good' : 'critical'} label={`${d.groups.find((x) => x.id === id)?.label ?? id} — ${tests[id]!.ok ? 'réussi' : 'échec'}`} />
            <ul className="small">{tests[id]!.checks.map((c) => <li key={c.label}>{c.ok ? '✓' : '✗'} {c.label}{c.detail ? ` — ${c.detail}` : ''}</li>)}</ul>
          </div>
        ))}
        <ul className="list-rows compact-rows">
          {ESSENTIELLES.map((n) => variables.find((v) => v.name === n)).filter((v): v is Variable => !!v).map(ligne)}
        </ul>
      </section>

      <details className="panel">
        <summary>Autres paramètres, webhooks et historique (facultatifs ou pour la mise en production)</summary>

      <section className="panel" aria-labelledby="cles-attente">
        <div className="panel-head"><h2 className="panel-title" id="cles-attente">Propositions en attente d’approbation ({pending.length})</h2></div>
        {pending.length === 0 ? <p className="small muted">Aucune proposition en attente.</p> : (
          <ul className="list-rows">
            {pending.map((p) => (
              <li key={p.id} className="list-row">
                <div className="min0">
                  <p className="row-title"><span className="mono">{p.variable}</span> — {p.kind === 'DEFINIR' ? 'définir / faire tourner la valeur' : 'retirer la valeur de la console'}</p>
                  <p className="small muted">Proposée par {p.proposedBy} le {fmtDate(p.proposedAt, true)} — motif : {p.motif}</p>
                </div>
                {canApprove && (
                  <div className="row-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy || p.proposedBy === user?.id} title={p.proposedBy === user?.id ? 'Règle des deux personnes : une autre personne doit approuver.' : undefined} onClick={() => void decider(p, true)}>Approuver</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void decider(p, false)}>Rejeter</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="cles-webhooks">
        <div className="panel-head">
          <div>
            <h2 className="panel-title" id="cles-webhooks">Webhooks entrants à communiquer</h2>
            <p className="panel-sub">Adresse publique (MOSOLO_PUBLIC_URL) : <span className="mono">{hooks.data?.publicUrl.value ?? '— absente —'}</span> · {hooks.data?.publicUrl.note}</p>
          </div>
        </div>
        <ul className="list-rows">
          {(hooks.data?.webhooks ?? []).map((w) => (
            <li key={w.id} className="list-row">
              <div className="min0">
                <p className="row-title">{w.label}</p>
                <p className="small"><span className="mono">{w.method} {w.url}</span>{' '}
                  <button type="button" className="btn btn-ghost btn-sm" disabled={!w.urlReady} onClick={() => void copier(w.url)}>{copied === w.url ? 'Copiée' : 'Copier'}</button></p>
                <p className="small muted">Signature attendue : {w.signature}</p>
                {w.secretVariable && <p className="small muted">Secret : <span className="mono">{w.secretVariable}</span> — {SOURCE[w.secretSource ?? 'ABSENTE'].label}</p>}
              </div>
              <StatusBadge tone={!w.lastDelivery ? 'neutral' : w.lastDelivery.verification === 'VALIDE' ? 'good' : w.lastDelivery.verification === 'SIMULEE' ? 'info' : 'critical'}
                label={w.lastDelivery ? `${w.lastDelivery.verification === 'VALIDE' ? 'Signature valide' : w.lastDelivery.verification === 'SIMULEE' ? 'Simulée (démonstration)' : `Refusée${w.lastDelivery.code ? ` (${w.lastDelivery.code})` : ''}`} — ${fmtDate(w.lastDelivery.at, true)}` : 'Aucune réception'} />
            </li>
          ))}
        </ul>
      </section>

      {d.groups.map((g) => (
        <section key={g.id} className="panel" aria-labelledby={`grp-${g.id}`}>
          <div className="panel-head">
            <div className="min0">
              <h2 className="panel-title" id={`grp-${g.id}`}>{g.label}</h2>
              <p className="panel-sub">{g.missingRequired.length ? `Manquantes pour le réel : ${g.missingRequired.join(', ')}` : 'Variables requises présentes'}{g.pending ? ` · ${g.pending} en attente` : ''}</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void tester(g)}>
              <Icon name="refresh" size={16} /> Tester {g.test === 'APPEL_REEL' ? '(appel réel inoffensif)' : '(configuration seule)'}
            </button>
          </div>
          {tests[g.id] && (
            <div className="pr-test-res">
              <StatusBadge tone={tests[g.id]!.ok ? 'good' : 'critical'} label={`${tests[g.id]!.kind === 'APPEL_REEL' ? `Appel réel ${tests[g.id]!.endpoint ?? ''}` : 'Validation de configuration'} — ${tests[g.id]!.ok ? 'réussi' : 'échec'}`} />
              <p className="small">{tests[g.id]!.proves}</p>
              <ul className="small">{tests[g.id]!.checks.map((c) => <li key={c.label}>{c.ok ? '✓' : '✗'} {c.label}{c.detail ? ` — ${c.detail}` : ''}</li>)}</ul>
            </div>
          )}
          <ul className="list-rows compact-rows">
            {/* Les clés « Pour tester » sont saisies dans le bloc du haut (un seul formulaire par clé). */}
            {g.variables.filter((v) => !ESSENTIELLES.includes(v.name)).map(ligne)}
          </ul>
        </section>
      ))}

      <section className="panel" aria-labelledby="cles-historique">
        <details>
          <summary id="cles-historique">Historique des propositions ({(props.data ?? []).length}) — sans aucune valeur</summary>
          <ul className="list-rows compact-rows">
            {(props.data ?? []).map((p) => (
              <li key={p.id} className="list-row">
                <div className="min0">
                  <p className="row-title small"><span className="mono">{p.variable}</span> — {p.kind === 'DEFINIR' ? 'définir' : 'retirer'} · {p.proposedBy} le {fmtDate(p.proposedAt, true)}</p>
                  {p.decidedBy && <p className="small muted">Décision : {p.decidedBy}{p.decidedAt ? ` le ${fmtDate(p.decidedAt, true)}` : ''}{p.decisionMotif ? ` — ${p.decisionMotif}` : ''}</p>}
                </div>
                <StatusBadge tone={STATUS[p.status]?.tone ?? 'neutral'} label={STATUS[p.status]?.label ?? p.status} />
              </li>
            ))}
          </ul>
        </details>
      </section>
      </details>
      <ul className="pr-doctrine">{d.doctrine.map((x) => <li key={x}><Icon name="shieldCheck" size={16} /> {x}</li>)}</ul>
    </div>
  );
}
