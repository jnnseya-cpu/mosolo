/**
 * Écran de connexion : contribuable (téléphone + code à usage unique) et agent public (identifiant + mot de passe + TOTP).
 * Le jeton de session (Bearer) est conservé sur l'appareil ; le sélecteur d'utilisateur de démonstration reste disponible.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { QrCode } from '../../components/QrCode';
import { StatusBadge } from '../../components/StatusBadge';
import { useApp } from '../../context';
import { api, describeError, readStoredSession, safeSet, writeStoredSession } from '../../lib/api';
import { purgeUserQueues } from '../../lib/offlineQueue';
import './socle.css';

/** File d'enrôlement assisté (noms, téléphones de tiers) : effacée à la déconnexion. */
const ENROL_QUEUE = 'mosolo.canaux.enrolQueue';

type Mode = 'contribuable' | 'agent';

interface Challenge {
  challengeId: string;
  method: 'totp' | 'sms-otp';
  expiresAt: string;
  destination?: string;
  demoCode?: string;
}

interface TokenResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  acr: string;
  passkeyRequired: boolean;
  session: { id: string; expiresAt: string; sharedDevice: boolean };
  user: { id: string; name: string; roles: string[]; entity: string; taxpayerId?: string };
}

interface StoredSession extends TokenResponse {
  obtainedAt: string;
}

interface SessionRow {
  id: string;
  createdAt: string;
  expiresAt: string;
  sharedDevice: boolean;
  acr: string;
  active: boolean;
  current?: boolean;
  revokedAt?: string;
}

interface DemoAccounts {
  password: string;
  agents: { login: string; name: string; roles: string[]; sensitive: boolean; totpSecret: string; otpauth: string; currentCode: string }[];
  taxpayers: { userId: string; name: string; phone: string }[];
}

const ACR_LABEL: Record<string, string> = {
  'urn:mosolo:acr:otp': 'Code à usage unique (téléphone)',
  'urn:mosolo:acr:mfa': 'Mot de passe + code TOTP (MFA)',
  'urn:mosolo:acr:phr': 'Clé d’accès résistante au hameçonnage',
};

function loadSession(): StoredSession | null {
  const raw = readStoredSession();
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as StoredSession;
    return new Date(s.session.expiresAt) > new Date() ? s : null;
  } catch {
    return null;
  }
}

function bearer(s: StoredSession | null): Record<string, string> {
  return s ? { Authorization: `Bearer ${s.accessToken}` } : {};
}

function useCountdown(until: string | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.round((new Date(until).getTime() - now) / 1000)) : 0;
}

const fmtCountdown = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export default function Login() {
  const { user: demoUser, setUserId, fmtDate } = useApp();
  const [mode, setMode] = useState<Mode>('contribuable');
  const [session, setSession] = useState<StoredSession | null>(loadSession);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [phone, setPhone] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sharedDevice, setSharedDevice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState<DemoAccounts | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const remaining = useCountdown(challenge?.expiresAt);

  // Comptes fictifs (mode démonstration) ; rechargés à chaque défi pour afficher un code TOTP courant.
  const loadDemo = useCallback(() => {
    api<DemoAccounts>('/v1/auth/demo-accounts').then(setDemo).catch(() => setDemo(null));
  }, []);
  useEffect(() => { loadDemo(); }, [loadDemo]);

  const refreshSessions = useCallback(async (s: StoredSession | null) => {
    if (!s) { setSessions(null); return; }
    try {
      const r = await api<{ items: SessionRow[] }>('/v1/auth/sessions', { headers: bearer(s) });
      setSessions(r.items);
    } catch (e) {
      const d = describeError(e);
      if (d.code === 'SESSION_REVOKED' || d.code === 'TOKEN_EXPIRED' || d.code === 'SESSION_EXPIRED') {
        writeStoredSession(null);
        setSession(null);
      }
      setSessions(null);
    }
  }, []);

  useEffect(() => { void refreshSessions(session); }, [session, refreshSessions]);

  function reset(next?: Mode) {
    setChallenge(null); setCode(''); setError(null);
    if (next) setMode(next);
  }

  async function start(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === 'contribuable' && !/^\+?\d[\d\s]{8,16}$/.test(phone.trim())) { setError('Numéro de téléphone invalide (ex. +243 81 000 0001).'); return; }
    if (mode === 'agent' && (!login.trim() || !password)) { setError('Identifiant et mot de passe obligatoires.'); return; }
    setBusy(true);
    try {
      const body = mode === 'contribuable'
        ? { method: 'phone', phone: phone.replace(/\s/g, '') }
        : { method: 'password', login: login.trim(), password };
      setChallenge(await api<Challenge>('/v1/auth/login', { method: 'POST', body }));
      setCode('');
      if (mode === 'agent') loadDemo();
    } catch (err) {
      setError(describeError(err).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    if (!/^\d{6}$/.test(code)) { setError('Le code comporte 6 chiffres.'); return; }
    setBusy(true); setError(null);
    try {
      const t = await api<TokenResponse>('/v1/auth/otp', { method: 'POST', body: { challengeId: challenge.challengeId, code, sharedDevice } });
      const stored: StoredSession = { ...t, obtainedAt: new Date().toISOString() };
      // Appareil partagé : jeton gardé pour l'onglet seulement (sessionStorage), jamais dans localStorage.
      writeStoredSession(JSON.stringify(stored), sharedDevice || t.session.sharedDevice);
      setSession(stored);
      setChallenge(null); setCode(''); setPassword('');
    } catch (err) {
      const d = describeError(err);
      setError(d.message);
      if (d.code === 'CHALLENGE_EXHAUSTED' || d.code === 'CHALLENGE_EXPIRED' || d.code === 'CHALLENGE_INVALID') setChallenge(null);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!session) return;
    setBusy(true);
    try {
      await api('/v1/auth/logout', { method: 'POST', headers: bearer(session) });
    } catch { /* session déjà close côté serveur */ }
    writeStoredSession(null);
    purgeUserQueues(session.user.id, [ENROL_QUEUE]);
    safeSet(ENROL_QUEUE, null); // ancienne file non rattachée à un utilisateur
    setSession(null);
    setBusy(false);
  }

  async function revoke(id: string) {
    if (!session) return;
    try {
      await api(`/v1/auth/sessions/${encodeURIComponent(id)}/revoke`, { method: 'POST', headers: bearer(session), body: { reason: 'Révocation par l’utilisateur' } });
      if (id === session.session.id) { writeStoredSession(null); setSession(null); } else void refreshSessions(session);
    } catch (err) {
      setError(describeError(err).message);
    }
  }

  const demoAgent = useMemo(() => demo?.agents.find((a) => a.login === login.trim()), [demo, login]);

  if (session) {
    return (
      <div className="page socle-page">
        <PageHead eyebrow="Accès sécurisé" title="Session ouverte" lead="Vous êtes authentifié par un jeton de session signé, valable 15 minutes et renouvelable tant que la session est active." />
        <div className="socle-grid">
          <section className="panel">
            <div className="panel-head"><h2 className="panel-title">Identité</h2><StatusBadge tone="good" label="Connecté" /></div>
            <dl className="kv">
              <div><dt>Nom</dt><dd>{session.user.name}</dd></div>
              <div><dt>Identifiant</dt><dd className="mono">{session.user.id}</dd></div>
              <div><dt>Rôles</dt><dd>{session.user.roles.join(', ')}</dd></div>
              <div><dt>Entité</dt><dd>{session.user.entity}</dd></div>
              <div><dt>Niveau d’authentification</dt><dd>{ACR_LABEL[session.acr] ?? session.acr}</dd></div>
              <div><dt>Fin de session</dt><dd>{fmtDate(session.session.expiresAt, true)}{session.session.sharedDevice ? ' — appareil partagé' : ''}</dd></div>
            </dl>
            {session.passkeyRequired && (
              <div className="callout callout-warn">
                <Icon name="lock" size={18} />
                <p>Votre rôle est sensible : le document maître exige une clé d’accès résistante au hameçonnage (passkey / FIDO2). Son enregistrement est <strong>à raccorder</strong> à l’IdP souverain ; la session actuelle repose sur mot de passe + TOTP.</p>
              </div>
            )}
            <div className="row-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setUserId(session.user.id)} disabled={demoUser?.id === session.user.id}>
                <Icon name="sync" size={16} /> Aligner le sélecteur de démonstration
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void logout()} disabled={busy}>
                <Icon name="x" size={16} /> Se déconnecter
              </button>
            </div>
            <p className="hint">Tant que le client de l’application n’envoie pas encore le jeton sur toutes les pages, le sélecteur de démonstration détermine l’utilisateur des autres écrans.</p>
          </section>
          <section className="panel">
            <div className="panel-head"><h2 className="panel-title">Mes sessions</h2></div>
            {error && <p className="notice notice-err" role="alert">{error}</p>}
            {!sessions || sessions.length === 0 ? <p className="muted">Aucune session.</p> : (
              <ul className="socle-sessions">
                {sessions.map((s) => (
                  <li key={s.id}>
                    <div>
                      <span className="mono small">{s.id.slice(0, 16)}…</span>
                      <span className="small muted"> ouverte le {fmtDate(s.createdAt, true)}{s.sharedDevice ? ' · appareil partagé' : ''}</span>
                    </div>
                    <div className="socle-session-side">
                      {s.current && <StatusBadge tone="info" label="Cet appareil" />}
                      <StatusBadge tone={s.active ? 'good' : 'neutral'} label={s.active ? 'Active' : s.revokedAt ? 'Révoquée' : 'Expirée'} />
                      {s.active && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revoke(s.id)}>Révoquer</button>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="page socle-page">
      <PageHead eyebrow="Accès sécurisé" title="Connexion" lead="Contribuables : votre numéro de téléphone et un code reçu par SMS. Agents publics : identifiant, mot de passe et code de votre application d’authentification." />
      <div className="socle-grid">
        <section className="panel socle-form">
          <div className="seg seg-wrap" role="group" aria-label="Type de compte">
            <button type="button" aria-pressed={mode === 'contribuable'} onClick={() => reset('contribuable')}><Icon name="user" size={16} /> Contribuable</button>
            <button type="button" aria-pressed={mode === 'agent'} onClick={() => reset('agent')}><Icon name="shieldCheck" size={16} /> Agent public</button>
          </div>

          {!challenge ? (
            <form className="form" onSubmit={(e) => void start(e)} noValidate>
              {mode === 'contribuable' ? (
                <div className="field">
                  <label htmlFor="socle-phone" className="label">Numéro de téléphone</label>
                  <input id="socle-phone" type="tel" inputMode="tel" autoComplete="tel" placeholder="+243 81 000 0001" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  <span className="hint">Un code à 6 chiffres vous sera envoyé. Il expire après 5 minutes.</span>
                </div>
              ) : (
                <>
                  <div className="field">
                    <label htmlFor="socle-login" className="label">Identifiant</label>
                    <input id="socle-login" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} />
                  </div>
                  <div className="field">
                    <label htmlFor="socle-password" className="label">Mot de passe</label>
                    <input id="socle-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                    <span className="hint">Après 5 échecs, la connexion est suspendue 15 minutes ; vous en êtes informé.</span>
                  </div>
                </>
              )}
              {error && <p className="notice notice-err" role="alert">{error}</p>}
              <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
                {busy ? 'Envoi…' : mode === 'contribuable' ? 'Recevoir un code' : 'Continuer'}
              </button>
            </form>
          ) : (
            <form className="form" onSubmit={(e) => void verify(e)} noValidate>
              <div className="callout callout-info">
                <Icon name={challenge.method === 'totp' ? 'keypad' : 'phone'} size={18} />
                <p>
                  {challenge.method === 'totp'
                    ? 'Saisissez le code à 6 chiffres affiché par votre application d’authentification.'
                    : `Code envoyé au ${challenge.destination ?? 'numéro indiqué'}.`}
                  {' '}<span className="mono">{remaining > 0 ? `Expire dans ${fmtCountdown(remaining)}` : 'Expiré'}</span>
                </p>
              </div>
              {challenge.demoCode && (
                <p className="socle-demo-code" role="note">
                  <span className="badge badge-warning">Démonstration</span> Code affiché ici uniquement en mode démonstration : <strong className="mono">{challenge.demoCode}</strong>
                </p>
              )}
              <div className="field">
                <label htmlFor="socle-code" className="label">Code</label>
                <input id="socle-code" className="socle-code-input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
              </div>
              <label className="check">
                <input type="checkbox" checked={sharedDevice} onChange={(e) => setSharedDevice(e.target.checked)} />
                <span>Appareil partagé (cybercafé, guichet) : session limitée à 30 minutes, non prolongée</span>
              </label>
              {error && <p className="notice notice-err" role="alert">{error}</p>}
              <div className="row-actions">
                <button type="button" className="btn btn-ghost" onClick={() => reset()}>Recommencer</button>
                <button type="submit" className="btn btn-primary" disabled={busy || remaining === 0}>{busy ? 'Vérification…' : 'Se connecter'}</button>
              </div>
            </form>
          )}
        </section>

        <aside className="panel socle-aside">
          <div className="panel-head"><h2 className="panel-title">Comptes de démonstration</h2><span className="badge badge-warning">Fictifs</span></div>
          {!demo ? (
            <p className="muted">Indisponibles : le mode démonstration est désactivé sur ce serveur.</p>
          ) : mode === 'contribuable' ? (
            <ul className="socle-demo-list">
              {demo.taxpayers.map((t) => (
                <li key={t.userId}>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPhone(t.phone); reset(); }}>
                    <Icon name="phone" size={16} /> {t.name} <span className="mono small">{t.phone}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <div className="field">
                <label htmlFor="socle-demo-agent" className="label">Choisir un agent fictif</label>
                <select id="socle-demo-agent" value={demoAgent?.login ?? ''} onChange={(e) => { setLogin(e.target.value); setPassword(demo.password); reset(); }}>
                  <option value="">—</option>
                  {demo.agents.map((a) => <option key={a.login} value={a.login}>{a.name} ({a.roles.join(', ')})</option>)}
                </select>
                <span className="hint">Mot de passe de démonstration : <span className="mono">{demo.password}</span></span>
              </div>
              {demoAgent && (
                <div className="socle-totp">
                  <QrCode value={demoAgent.otpauth} size={120} alt={`Secret TOTP de démonstration de ${demoAgent.name}`} />
                  <div className="stack-sm">
                    <p className="small">Scannez avec une application d’authentification (TOTP, 30 s), ou utilisez le code courant :</p>
                    <p className="mono socle-current">{demoAgent.currentCode}</p>
                    <p className="hint">Code valable au chargement de cet écran ; un code déjà utilisé est refusé.</p>
                    {demoAgent.sensitive && <p className="hint"><Icon name="lock" size={14} /> Rôle sensible : clé d’accès exigée à terme (à raccorder).</p>}
                  </div>
                </div>
              )}
            </>
          )}
          <p className="hint">Le sélecteur d’utilisateur de démonstration de l’en-tête reste utilisable tant que le mode démonstration est actif.</p>
        </aside>
      </div>
    </div>
  );
}
