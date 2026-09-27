/**
 * Module 4 — Application citoyenne Android et iOS (même application, enveloppée par Capacitor ; ici à l'identique dans
 * le navigateur) : installation, contrôle d'intégrité de l'appareil, code d'accès et verrouillage automatique de
 * l'appareil partagé, portefeuille de titres CHIFFRÉ consultable hors connexion, QR dynamique de 30 secondes,
 * prolongation, avis sur l'application. Aucune validité calculée sur l'horloge du téléphone.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { QrCode } from '../../components/QrCode';
import { api, describeError, INSTALLATION_KEY, installationId, newIdempotencyKey, safeSet } from '../../lib/api';
import {
  BLOCAGE_MS, codeDefini, contenuStocke, definirCode, effacerPortefeuille, ESSAIS_MAX, ouvrirPortefeuille, PAR_DEFAUT, PIN_VALIDE, plateforme,
  portefeuillePresent, scellerPortefeuille, verifierCode, verifierIntegrite, verrouillageAuto, VERROUILLAGE_AUTO_MS, type Portefeuille,
} from '../../lib/mobile';
import { DynamicQr, type CredentialView } from '../titres/common';
import './citoyen.css';
import { PortefeuilleVisuel } from './visuels';

interface InstallationVue { id: string; plateforme: string; versionApp: string; integrite: { statut: string; signaux: string[]; source: string }; heureServeur: string }

const VERSION_APP = '1.0.0';

function useInstallation(lang: string) {
  const [inst, setInst] = useState<InstallationVue | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = useCallback(async () => {
    setErr(null);
    try {
      const current = installationId();
      const v = await api<InstallationVue>('/v1/public/application/installations', { method: 'POST', body: { ...(current ? { installationId: current } : {}), plateforme: plateforme(), versionApp: VERSION_APP, langue: lang } });
      safeSet(INSTALLATION_KEY, v.id);
      const verdict = await verifierIntegrite();
      setInst(await api<InstallationVue>(`/v1/public/application/installations/${v.id}/integrite`, { method: 'POST', body: verdict }));
    } catch (e) { setErr(describeError(e).message); }
  }, [lang]);
  useEffect(() => { void run(); }, [run]);
  return { inst, err, retry: run };
}

function Verrou({ onOpen }: { onOpen: (pin: string) => void }) {
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    const r = await verifierCode(pin);
    if (r.ok) { onOpen(pin); setPin(''); return; }
    setMsg(r.bloqueJusqua ? `Trop d’essais : appareil bloqué ${Math.round(BLOCAGE_MS / 60000)} minutes.` : `Code incorrect — ${r.restants} essai(s) restant(s).`);
  }
  return (
    <form className="panel stack-sm" onSubmit={(e) => void go(e)} aria-label="Déverrouiller">
      <p className="panel-title">Application verrouillée</p>
      <label className="label" htmlFor="app-pin">Code d’accès de l’appareil</label>
      <input id="app-pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
      <button type="submit" className="btn btn-primary btn-sm">Déverrouiller</button>
      {msg && <p className="notice notice-err small" role="alert">{msg}</p>}
    </form>
  );
}

function DefinirCode({ onDone }: { onDone: (pin: string) => void }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault(); setErr(null);
    if (!PIN_VALIDE.test(a)) { setErr('Code de 4 à 8 chiffres.'); return; }
    if (a !== b) { setErr('Les deux saisies diffèrent.'); return; }
    await definirCode(a); onDone(a); setA(''); setB('');
  }
  return (
    <form className="panel stack-sm" onSubmit={(e) => void go(e)} aria-label="Définir le code d’accès">
      <p className="panel-title">Protéger cet appareil (appareil partagé)</p>
      <p className="small muted">Le code chiffre le portefeuille et verrouille l’application après {Math.round(VERROUILLAGE_AUTO_MS / 60000)} minutes d’inactivité ({PAR_DEFAUT}) ; {ESSAIS_MAX} essais au plus.</p>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="pin-a">Nouveau code</label><input id="pin-a" type="password" inputMode="numeric" value={a} onChange={(e) => setA(e.target.value)} /></div>
        <div className="field"><label className="label" htmlFor="pin-b">Confirmer le code</label><input id="pin-b" type="password" inputMode="numeric" value={b} onChange={(e) => setB(e.target.value)} /></div>
      </div>
      <button type="submit" className="btn btn-primary btn-sm">Enregistrer le code</button>
      {err && <p className="notice notice-err small" role="alert">{err}</p>}
    </form>
  );
}

function PortefeuilleVue({ pin, compromis }: { pin: string; compromis: boolean }) {
  const { user, fmtDate } = useApp();
  const [wallet, setWallet] = useState<Portefeuille | null>(null);
  const [live, setLive] = useState<CredentialView[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  useEffect(() => { void ouvrirPortefeuille(pin).then(setWallet); }, [pin]);
  useEffect(() => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  async function synchroniser() {
    setMsg(null);
    try {
      const titres = await api<CredentialView[]>('/v1/titres');
      setLive(titres);
      const p: Portefeuille = {
        titres: titres.map((c) => ({ id: c.id, numero: c.number, libelle: c.typeLabel, jetonStatique: c.staticToken, validUntil: c.validUntil, etatServeur: c.status.status, texteServeur: c.status.text })),
        quittances: titres.flatMap((c) => c.receiptNumbers.map((n) => ({ numero: n, montant: c.amount ? `${c.amount.amount} ${c.amount.currency}` : '—', date: c.issuedAt }))).slice(0, 20),
        preferences: { langue: 'fr' },
        synchroniseA: titres[0]?.status.serverTime ?? new Date().toISOString(),
      };
      await scellerPortefeuille(pin, p);
      setWallet(p);
      setMsg(`Portefeuille chiffré mis à jour : ${p.titres.length} titre(s).`);
    } catch (e) { setMsg(describeError(e).message); }
  }
  async function prolonger(id: string) {
    setMsg(null);
    try { await api(`/v1/titres/${encodeURIComponent(id)}/prolongations`, { method: 'POST', body: { channel: 'MOBILE_MONEY' }, idempotencyKey: newIdempotencyKey() }); setMsg('Prolongation demandée : payez la référence reçue ; le titre est prolongé à la confirmation.'); } catch (e) { setMsg(describeError(e).message); }
  }
  return (
    <section className="stack-sm" aria-label="Portefeuille de titres">
      <div className="btn-row">
        {user?.taxpayerId && <button type="button" className="btn btn-primary btn-sm" onClick={() => void synchroniser()} disabled={!online}>Synchroniser (en ligne)</button>}
        <StatusBadge tone={online ? 'good' : 'warning'} label={online ? 'En ligne' : 'Hors connexion : portefeuille chiffré'} />
      </div>
      {msg && <p className="notice small" role="status">{msg}</p>}
      {compromis && <p className="notice notice-err small" role="alert">Appareil modifié détecté : QR dynamique, paiement et prolongation sont refusés sur cet appareil (guichet ou USSD possibles).</p>}
      {online && live && !compromis && live.filter((c) => c.state === 'EMIS').map((c) => (
        <article key={c.id} className="panel stack-sm">
          <p className="panel-title">{c.typeLabel} — <span className="mono">{c.number}</span></p>
          <DynamicQr credentialId={c.id} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void prolonger(c.id)}>Prolonger ou renouveler</button>
        </article>
      ))}
      {wallet ? (
        <div className="panel stack-sm">
          <p className="panel-title">Titres enregistrés sur l’appareil (chiffrés)</p>
          <p className="small muted">État fourni par le serveur le {fmtDate(wallet.synchroniseA, true)} — jamais recalculé sur l’horloge du téléphone.</p>
          <PortefeuilleVisuel titres={wallet.titres} />
          <ul className="plain-list small">{wallet.titres.map((t) => (
            <li key={t.id}>
              <strong>{t.libelle}</strong> <span className="mono">{t.numero}</span> — {t.texteServeur} (état {t.etatServeur} à la synchronisation ; fin {fmtDate(t.validUntil, true)})
              {!online && t.jetonStatique && <div><QrCode value={t.jetonStatique} size={120} alt={`QR signé hors ligne du titre ${t.numero}`} /></div>}
            </li>))}</ul>
          {wallet.quittances.length > 0 && <p className="small">Quittances récentes : {wallet.quittances.map((q) => q.numero).join(', ')}</p>}
        </div>
      ) : <p className="small muted">Aucun titre enregistré sur l’appareil : synchronisez une fois en ligne.</p>}
    </section>
  );
}

function Avis({ id }: { id: string }) {
  const [note, setNote] = useState(5);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form className="panel stack-sm" onSubmit={(e) => { e.preventDefault(); void api(`/v1/public/application/installations/${id}/avis`, { method: 'POST', body: { note } }).then(() => setDone('Merci pour votre avis.'), (x: unknown) => setDone(describeError(x).message)); }}>
      <p className="panel-title">Noter l’application</p>
      <label className="label" htmlFor="app-note">Note (1 à 5)</label>
      <select id="app-note" value={note} onChange={(e) => setNote(Number(e.target.value))}>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}</select>
      <button type="submit" className="btn btn-secondary btn-sm">Envoyer</button>
      {done && <p className="small" role="status">{done}</p>}
    </form>
  );
}

export default function Application() {
  const { lang } = useApp();
  const { inst, err, retry } = useInstallation(lang);
  const [pin, setPin] = useState<string | null>(null);
  const [aCode, setACode] = useState(codeDefini());
  const timer = useRef<ReturnType<typeof verrouillageAuto> | null>(null);
  useEffect(() => {
    if (!pin) return;
    timer.current = verrouillageAuto(() => setPin(null));
    const touch = () => timer.current?.touch();
    for (const ev of ['pointerdown', 'keydown', 'scroll']) window.addEventListener(ev, touch);
    return () => { timer.current?.stop(); for (const ev of ['pointerdown', 'keydown', 'scroll']) window.removeEventListener(ev, touch); };
  }, [pin]);
  const compromis = inst?.integrite.statut === 'COMPROMIS';
  return (
    <div className="stack">
      <PageHead eyebrow="Module 4" title="Application citoyenne (Android et iOS)" lead="Pages légères (2G), reprise après coupure, paiement Mobile Money, titres à QR dynamique, vérification, notifications, six langues." />
      <section className="panel stack-sm" aria-label="Cet appareil">
        <p className="panel-title">Cet appareil</p>
        {err && <p className="notice notice-err small" role="alert">{err} <button type="button" className="btn btn-link btn-sm" onClick={() => void retry()}>Réessayer</button></p>}
        {inst ? (
          <ul className="plain-list small">
            <li>Plateforme : <strong>{inst.plateforme === 'ANDROID' ? 'Android' : inst.plateforme === 'IOS' ? 'iOS' : 'Navigateur (PWA)'}</strong> · version {inst.versionApp}</li>
            <li>Intégrité : <StatusBadge tone={compromis ? 'critical' : inst.integrite.statut === 'CONFORME' ? 'good' : 'neutral'} label={compromis ? `Appareil modifié (${inst.integrite.signaux.join(', ')})` : inst.integrite.statut === 'CONFORME' ? 'Conforme' : 'Non évaluée'} /> <span className="muted">(source : {inst.integrite.source === 'MODULE_NATIF' ? 'module natif' : 'navigateur'})</span></li>
            <li>Heure de référence : serveur ({inst.heureServeur})</li>
          </ul>
        ) : !err && <p className="small muted">Enregistrement de l’installation…</p>}
      </section>
      {!aCode ? <DefinirCode onDone={(p) => { setACode(true); setPin(p); }} />
        : !pin ? <Verrou onOpen={setPin} />
        : (
          <>
            <div className="btn-row">
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setPin(null)}>Verrouiller maintenant</button>
              {portefeuillePresent() && <button type="button" className="btn btn-secondary btn-sm" onClick={() => { effacerPortefeuille(); setPin(pin); }}>Effacer le portefeuille de cet appareil</button>}
            </div>
            <PortefeuilleVue pin={pin} compromis={!!compromis} />
          </>
        )}
      <section className="panel stack-sm">
        <p className="panel-title">Autres fonctions</p>
        <ul className="plain-list small">
          <li><Link to="/fiscal/verifier">Scanner de vérification (quittance, titre)</Link> · <Link to="/verifier-agent">badge d’agent</Link></li>
          <li><Link to="/mes-arrieres">Mes échéances et paiements (Mobile Money de tous les opérateurs agréés, carte, banque)</Link></li>
          <li><Link to="/points-de-paiement">Points de paiement</Link> · <Link to="/canaux/ussd">sans Internet : USSD et SVI</Link></li>
        </ul>
        {contenuStocke() && <p className="small muted">Stockage local : contenu chiffré (AES-GCM), illisible sans le code.</p>}
      </section>
      {inst && <Avis id={inst.id} />}
    </div>
  );
}
