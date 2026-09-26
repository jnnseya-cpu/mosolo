/**
 * Composants partagés du module « acces » : exécution d'une action avec second facteur (MFA simulé),
 * boîte d'envoi du bac à sable, étapes, libellés et types.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Drawer } from '../../components/Drawer';
import { Icon } from '../../components/Icon';
import { StatusBadge, type Tone } from '../../components/StatusBadge';
import { api, describeError } from '../../lib/api';

export const hasRole = (roles: string[] | undefined, ...want: string[]) => !!roles?.some((r) => want.includes(r));

// ───────────────────────────── Types (contrat /v1/acces) ─────────────────────────────

export interface EntityRow {
  id: string; name: string; shortName: string; kind: string; parentId: string | null; status: 'ACTIVE' | 'SUSPENDUE';
  createdAt: string; createdBy: string; decisionRef?: string; demo?: boolean; suspensionReason?: string;
  modules: { id: string; code: string; label: string; status: string }[]; accounts: number;
}
export interface ModuleVisa { step: string; by: string; role: string; at: string; note?: string }
export interface ModuleConfig {
  id: string; code: string; label: string; revenueScope: string; responsibleEntity: string; moduleManagerId?: string;
  beneficiaryAliases: string[]; objectTypes: string[]; ruleCodes: string[]; credentialTypes: string[]; validityModel: string;
  proofMechanisms: string[]; usageRules: string; channels: string[]; fieldWorkflows: string[]; dashboards: string[]; dependencies: string[];
  sharedReadWith: string[]; actReferences: string[]; status: string; visas: ModuleVisa[];
  recette?: { passed: boolean; report: string; by: string; at: string };
  history: { at: string; from: string | null; to: string; by: string; note?: string }[];
  attachments: { entity: string; from: string; to?: string; actReference: string; validatedBy: string }[];
  pendingReattachment?: { newEntity: string; actReference: string; motif: string; proposedBy: string; at: string };
  arbitrationId?: string; demo?: boolean; createdAt: string;
}
export interface Claimant { entity: string; claimId?: string; moduleConfigId?: string; holder: boolean }
export interface Arbitration {
  id: string; kind: 'FAIT_GENERATEUR' | 'COMPETENCE_MODULE';
  subject: { objectId?: string; factCode?: string; period?: string; revenueScope?: string; ruleCodes?: string[] };
  claimants: Claimant[]; status: 'OUVERT' | 'INSTRUIT' | 'DECIDE'; openedAt: string; openedBy: string;
  opinion?: { by: string; at: string; text: string; recommendedEntity?: string };
  decision?: { by: string; at: string; winnerEntity: string; motif: string; actReference: string; rectificationRequired: boolean };
  existingObligationIds: string[]; demo?: boolean;
}
export interface LevelsRef {
  accessLevels: { code: string; label: string; usage: string; invite: string }[];
  verificationLevels: Record<string, { label: string; proof: string; rights: string }>;
  roles: { code: string; label: string; level: string | null; sensitive: boolean }[];
  entityKinds: Record<string, string>;
  taxableFacts: string[]; proofTypes: string[]; mandateActions: string[]; consultationPurposes: string[]; legalForms: string[];
  sandbox: boolean;
}
export interface AccountRow {
  id: string; fullName: string; phoneMasked?: string; entity: string; accessLevel: string; accessLevelLabel: string; roles: string[]; roleLabels: string[];
  scope: { territory?: string[]; modules?: string[]; validUntil?: string }; canInvite: boolean; status: string; origin: string; sponsorId?: string;
  mfaMethod?: string; secretsPending: boolean; createdAt: string; activatedAt?: string; revokedAt?: string; revokedReason?: string;
  inviteRight: boolean; accessOperator: boolean;
}
export interface Me {
  user: { id: string; name: string; roles: string[]; entity: string; territory?: string[] };
  account: AccountRow | null; level: string | null; sensitive: boolean; inviteRight: boolean; accessOperator: boolean;
  mfa: { required: boolean; activeUntil: string | null }; sandbox: boolean;
}
export interface InvitationRow {
  id: string; inviterId: string; inviterEntity: string; fullName: string; phoneMasked: string; email?: string; entity: string;
  accessLevel: string; accessLevelLabel: string; roles: string[]; roleLabels: string[]; scope: AccountRow['scope']; canInvite: boolean; motif: string;
  expiresAt: string; createdAt: string; status: string; failedAttempts: number; finalizedAt?: string; finalizedVia?: string; accountId?: string; revokedReason?: string;
}
export interface ValidationRow {
  id: string; kind: string; subjectUserId: string; entity: string; requestedBy: string; requirement: string; motif: string; status: string;
  createdAt: string; decidedBy?: string; decidedAt?: string; decisionNote?: string; qualified: boolean;
  subject: { id: string; fullName?: string; entity?: string; accessLevelLabel?: string; roleLabels?: string[] };
}
export interface GrantRow { id: string; userId: string; kind: string; entity: string; grantedBy: string; status: string; createdAt: string }
export interface JournalRow { seq: number; at: string; actor: string; action: string; resourceType: string; resourceId: string | null; outcome: string; entity: string | null; hash: string }
export interface Proof { id: string; taxpayerId: string; type: string; referenceMasked: string; note?: string; status: string; declaredBy: string; declaredAt: string; reviewedBy?: string; reviewNote?: string }
export interface Mandate {
  id: string; mandantTaxpayerId: string; mandataireUserId: string; kind: 'CONFIANCE' | 'PROFESSIONNEL'; scope: string[]; objectIds: string[];
  validFrom: string; validTo: string; proofRef?: string; status: string; createdAt: string; revokedAt?: string; revokeReason?: string;
  mandataireName: string; mandantName: string; certified: boolean; demo?: boolean;
}
export interface Consultation {
  id: string; userId: string; userEntity: string; taxpayerId: string; purpose: string; motif: string; mode: 'PERIMETRE' | 'BRIS_DE_GLACE';
  grantedAt: string; expiresAt: string; reads: number; review?: { by: string; at: string; conclusion: string; note: string };
}

// ───────────────────────────── Libellés ─────────────────────────────

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'good' }, SUSPENDUE: { label: 'Suspendue', tone: 'critical' },
  BROUILLON: { label: 'Brouillon', tone: 'neutral' }, VALIDATION_PROGRAMME: { label: 'Visa programme attendu', tone: 'info' },
  VALIDATION_JURIDIQUE: { label: 'Visa juridique attendu', tone: 'info' }, RECETTE: { label: 'En recette', tone: 'warning' },
  SECONDE_VALIDATION: { label: 'Seconde validation attendue', tone: 'warning' }, ACTIF: { label: 'Actif', tone: 'good' },
  SUSPENDU: { label: 'Suspendu', tone: 'serious' }, RETIRE: { label: 'Retiré', tone: 'neutral' }, BLOQUE_ARBITRAGE: { label: 'Bloqué — arbitrage', tone: 'critical' },
  OUVERT: { label: 'Ouvert', tone: 'warning' }, INSTRUIT: { label: 'Avis rendu', tone: 'info' }, DECIDE: { label: 'Décidé', tone: 'good' },
  ENVOYEE: { label: 'Envoyée', tone: 'info' }, FINALISEE: { label: 'Finalisée', tone: 'good' }, EXPIREE: { label: 'Expirée', tone: 'neutral' },
  REFUSEE: { label: 'Refusée', tone: 'critical' }, REVOQUEE: { label: 'Révoquée', tone: 'critical' },
  ATTENTE_VALIDATION: { label: 'Seconde validation attendue', tone: 'warning' }, ATTENTE_SECRETS: { label: 'Secrets à définir par la personne', tone: 'warning' },
  REVOQUE: { label: 'Révoqué', tone: 'critical' }, EXPIRE: { label: 'Expiré', tone: 'neutral' },
  EN_ATTENTE: { label: 'En attente', tone: 'warning' }, APPROUVEE: { label: 'Approuvée', tone: 'good' }, REJETEE: { label: 'Rejetée', tone: 'critical' },
  DECLAREE: { label: 'Déclarée', tone: 'info' }, VALIDEE: { label: 'Validée', tone: 'good' },
  PROPOSEE: { label: 'Proposée', tone: 'info' }, VERIFIEE: { label: 'Vérifiée', tone: 'warning' }, EFFECTUEE: { label: 'Effectuée', tone: 'good' }, ANNULEE: { label: 'Annulée', tone: 'neutral' },
  ACCEPTEE: { label: 'Acceptée', tone: 'good' }, BLOQUEE: { label: 'Bloquée', tone: 'critical' }, RETIREE: { label: 'Retirée', tone: 'neutral' },
};

export function Status({ s }: { s: string }) {
  const v = STATUS[s] ?? { label: s, tone: 'neutral' as Tone };
  return <StatusBadge tone={v.tone} label={v.label} />;
}

export const REQUIREMENT_LABEL: Record<string, string> = {
  SECURITE: 'Seconde validation sécurité (personne distincte de l’invitant)',
  HORS_BANDE_CABINET: 'Confirmation hors bande par le Cabinet ou le Secrétariat général',
  HABILITATION_REGIE: 'Habilitation par la régie sur formation certifiée',
  AUTORITE_AUDIT: 'Validation par l’autorité d’audit',
};
export const VALIDATION_KIND: Record<string, string> = {
  ACTIVATION_COMPTE: 'Activation d’un compte', DROIT_INVITER: 'Délégation du droit d’inviter', OPERATEUR_ACCES: 'Désignation d’un opérateur d’accès',
};
export const FACT_LABEL: Record<string, string> = {
  PROPRIETE_BATIE: 'Propriété bâtie', PROPRIETE_NON_BATIE: 'Propriété non bâtie', REVENU_LOCATIF: 'Revenu locatif', STATIONNEMENT: 'Stationnement',
  AFFICHAGE_PUBLICITAIRE: 'Affichage publicitaire', OCCUPATION_DOMAINE_PUBLIC: 'Occupation du domaine public', ACTIVITE_COMMERCIALE: 'Activité commerciale',
  MARCHE_ETAL: 'Étal de marché', TRANSPORT_PUBLIC: 'Transport public', VEHICULE: 'Véhicule', AUTRE: 'Autre',
};
export const PROOF_LABEL: Record<string, string> = {
  OTP_TELEPHONE: 'Téléphone vérifié (code)', PIECE_IDENTITE: 'Pièce d’identité', ADRESSE: 'Adresse déclarée', CONTROLE_DOCUMENTAIRE: 'Contrôle documentaire',
  VISITE_TERRAIN: 'Visite de terrain', NIF: 'NIF', RCCM: 'RCCM', ID_NAT: 'Identification nationale', MANDAT_NOTARIE: 'Mandat notarié', ENROLEMENT_ASSISTE: 'Enrôlement assisté',
};
export const MANDATE_ACTION_LABEL: Record<string, string> = { CONSULTER: 'Consulter', DECLARER: 'Déclarer', PAYER: 'Payer', CONTESTER: 'Contester' };
export const PURPOSE_LABEL: Record<string, string> = { CONTROLE: 'Contrôle', RECOURS: 'Recours', AUDIT: 'Audit', ENQUETE: 'Enquête' };
export const REASON_LABEL: Record<string, string> = {
  MEME_PIECE_IDENTITE: 'Même pièce d’identité', MEME_RCCM: 'Même RCCM', MEME_NIF: 'Même NIF', MEME_ID_NAT: 'Même identification nationale',
  MEME_COURRIEL: 'Même courriel', NOM_PROCHE: 'Nom proche (insuffisant seul)', MEME_ADRESSE: 'Même adresse',
};
export const MODULE_STEPS = ['BROUILLON', 'VALIDATION_PROGRAMME', 'VALIDATION_JURIDIQUE', 'RECETTE', 'SECONDE_VALIDATION', 'ACTIF'] as const;
export const MODULE_STEP_LABEL: Record<string, string> = {
  BROUILLON: 'Fiche', VALIDATION_PROGRAMME: 'Programme', VALIDATION_JURIDIQUE: 'Juridique', RECETTE: 'Recette', SECONDE_VALIDATION: 'Comité', ACTIF: 'Actif',
};

export const splitList = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

// ───────────────────────────── Bac à sable ─────────────────────────────

export interface SandboxMessage { id: string; at: string; to: string; purpose: string; text: string }

export async function readOutbox(to: string): Promise<SandboxMessage[]> {
  const r = await api<{ items: SandboxMessage[] }>(`/v1/acces/sandbox/outbox?to=${encodeURIComponent(to)}`);
  return r.items;
}

/** Messages du bac à sable (codes et liens) — affichés uniquement tant qu'aucun fournisseur SMS n'est branché. */
export function SandboxBox({ to, title = 'Messages reçus (bac à sable)', refreshKey }: { to: string; title?: string; refreshKey?: unknown }) {
  const [items, setItems] = useState<SandboxMessage[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    if (!to) return;
    readOutbox(to).then((v) => { setItems(v); setErr(null); }).catch((e) => setErr(describeError(e).message));
  }, [to]);
  useEffect(() => { load(); }, [load, refreshKey]);
  return (
    <div className="ac-sandbox" role="region" aria-label={title}>
      <div className="row-between">
        <p className="ac-sandbox-title"><Icon name="phone" size={16} /> {title}</p>
        <button type="button" className="btn btn-ghost btn-sm" onClick={load}><Icon name="refresh" size={14} /> Actualiser</button>
      </div>
      <p className="small muted">Démonstration : aucun SMS n’est envoyé. En production, ces messages partent vers le téléphone de la personne et ne sont jamais affichés ici.</p>
      {err && <p className="small muted">{err}</p>}
      {items && items.length === 0 && <p className="small muted">Aucun message pour {to}.</p>}
      {items && items.length > 0 && (
        <ul className="ac-sms-list">
          {items.slice(0, 4).map((m) => (
            <li key={m.id} className="ac-sms"><span className="caps-sm muted">{m.purpose}</span><span>{m.text}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ───────────────────────────── Second facteur (MFA simulé) ─────────────────────────────

function MfaDialog({ userId, onDone, onCancel }: { userId: string; onDone: () => void; onCancel: () => void }) {
  const [challenge, setChallenge] = useState<{ challengeId: string; expiresAt: string } | null>(null);
  const [code, setCode] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api<{ challengeId: string; expiresAt: string }>('/v1/acces/mfa/challenge', { method: 'POST', body: {} })
      .then(setChallenge).catch((e) => setErr(describeError(e).message));
  }, []);
  async function fill() {
    try {
      const m = (await readOutbox(`app:${userId}`))[0];
      const c = m && /(\d{6})/.exec(m.text)?.[1];
      if (c) setCode(c);
    } catch (e) { setErr(describeError(e).message); }
  }
  async function verify() {
    if (!challenge) return;
    setBusy(true); setErr(null);
    try {
      await api('/v1/acces/mfa/verify', { method: 'POST', body: { challengeId: challenge.challengeId, code } });
      onDone();
    } catch (e) { setErr(describeError(e).message); } finally { setBusy(false); }
  }
  return (
    <Drawer open title="Second facteur requis" onClose={onCancel}>
      <div className="form">
        <div className="callout callout-info"><Icon name="lock" size={18} /><p>Action sensible : saisissez le code de votre application d’authentification. En production, une clé d’accès résistante à l’hameçonnage est exigée pour les rôles sensibles.</p></div>
        <div className="field">
          <label className="label" htmlFor="mfa-code">Code à 6 chiffres</label>
          <input id="mfa-code" className="mono ac-code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={busy || code.length !== 6 || !challenge} onClick={() => void verify()}><Icon name="shieldCheck" size={18} /> Valider</button>
          <button type="button" className="btn btn-secondary" onClick={() => void fill()}>Lire le code (bac à sable)</button>
        </div>
        {err && <p className="notice notice-err" role="alert">{err}</p>}
      </div>
    </Drawer>
  );
}

/**
 * Exécute une action d'API ; si le serveur exige un second facteur (MFA_REQUIRED), ouvre la saisie du code
 * puis rejoue l'action. Affiche le résultat (succès ou erreur RFC 9457) sous forme de notice.
 */
export function useAction(userId: string | undefined) {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ retry: () => void; cancel: () => void } | null>(null);

  const run = useCallback(async function exec<T>(fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T | null> {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      if (success) setMsg({ ok: true, text: typeof success === 'function' ? success(r) : success });
      return r;
    } catch (e) {
      const d = describeError(e);
      if (d.code === 'MFA_REQUIRED' && userId) {
        return await new Promise<T | null>((resolve) => {
          setPending({
            retry: () => { setPending(null); void exec(fn, success).then(resolve); },
            cancel: () => { setPending(null); setMsg({ ok: false, text: 'Action annulée : second facteur non validé.' }); resolve(null); },
          });
        });
      }
      setMsg({ ok: false, text: d.message });
      return null;
    } finally {
      setBusy(false);
    }
  }, [userId]);

  const node: ReactNode = (
    <>
      {msg && <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'notice notice-ok' : 'notice notice-err'}>{msg.text}</p>}
      {pending && userId && <MfaDialog userId={userId} onDone={pending.retry} onCancel={pending.cancel} />}
    </>
  );
  return { run, busy, node, clear: () => setMsg(null) };
}

/** Frise des étapes d'une fiche de module (maker-checker puis activation). */
export function ModuleSteps({ status }: { status: string }) {
  const idx = MODULE_STEPS.indexOf(status as (typeof MODULE_STEPS)[number]);
  return (
    <ol className="ac-steps" aria-label="Circuit de validation de la fiche">
      {MODULE_STEPS.map((s, i) => (
        <li key={s} className={idx < 0 ? '' : i < idx || status === 'ACTIF' ? 'done' : i === idx ? 'now' : ''}>
          <span className="ac-step-dot" aria-hidden="true">{idx >= 0 && (i < idx || status === 'ACTIF') ? <Icon name="check" size={11} /> : null}</span>
          <span>{MODULE_STEP_LABEL[s]}</span>
        </li>
      ))}
    </ol>
  );
}

export function Tabs<T extends string>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: [T, string, number?][]; label: string }) {
  return (
    <div className="seg seg-wrap ac-tabs" role="group" aria-label={label}>
      {items.map(([k, l, n]) => (
        <button key={k} type="button" aria-pressed={value === k} onClick={() => onChange(k)}>{l}{n !== undefined && n > 0 ? <span className="ac-count">{n}</span> : null}</button>
      ))}
    </div>
  );
}
