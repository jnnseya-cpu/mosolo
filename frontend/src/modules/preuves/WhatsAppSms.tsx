/**
 * Canaux sans application — simulateur de démonstration : assistant WhatsApp officiel (consentement, vérification,
 * où payer, comment payer SANS lien de paiement, rappels non nominatifs, signalement) et SMS « V <code> » pour les
 * téléphones basiques. Les messages passent par les mêmes routes que la passerelle réelle (webhook signé en production).
 */
import { useRef, useState, type FormEvent } from 'react';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { ExampleNotice } from '../../components/States';
import { API_URL, api, describeError } from '../../lib/api';
import './preuves.css';

interface Bubble { from: 'me' | 'mosolo'; text: string; at: string }
const now = () => new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kinshasa' });
const QUICK = ['Bonjour', 'OUI', 'MENU', '1', '2', '3', '4', '5', '6', 'STOP'];

export default function WhatsAppSms() {
  return (
    <div className="page">
      <PageHead eyebrow="Canaux sans application" title="WhatsApp et SMS"
        lead="Pour les habitants qui n’ont pas l’application : l’assistant WhatsApp officiel (sur consentement) et les SMS « V + code » depuis n’importe quel téléphone. Mêmes réponses que l’application, à l’heure du serveur." />
      <ExampleNotice text="Simulateur de démonstration : aucun message réel n’est envoyé. En production, la passerelle de l’opérateur signe chaque message (HMAC)." />
      <div className="wa-grid">
        <WhatsAppPhone />
        <SmsPhone />
      </div>
      <section className="card wa-lite">
        <h2 className="h3"><Icon name="offline" size={18} /> Internet lent ou téléphone basique</h2>
        <p>La <a href={`${API_URL}/l`} target="_blank" rel="noreferrer">version légère</a> fonctionne sans JavaScript, sans image ni police externe, en moins de 10 Ko par page (KaiOS, Opera Mini, 2G). Elle vérifie les preuves, liste les points de paiement, explique comment payer et permet de signaler un abus.</p>
        <p className="small muted">Sans aucune donnée mobile : USSD gratuit et serveur vocal (menu « USSD et SVI »), guichet MOSOLO, points agréés, preuve imprimée.</p>
      </section>
    </div>
  );
}

function WhatsAppPhone() {
  const [from, setFrom] = useState('+243810000009');
  const [text, setText] = useState('');
  const [chat, setChat] = useState<Bubble[]>([]);
  const [consent, setConsent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const send = async (msg: string) => {
    const m = msg.trim();
    if (!m) return;
    setErr(null);
    setChat((c) => [...c, { from: 'me', text: m, at: now() }]);
    setText('');
    try {
      const r = await api<{ results: { replies: string[]; consent: boolean }[] }>('/v1/whatsapp/webhook', { method: 'POST', body: { from, text: m } });
      const res = r.results[0]!;
      setConsent(res.consent);
      setChat((c) => [...c, ...res.replies.map((t) => ({ from: 'mosolo' as const, text: t, at: now() }))]);
      window.setTimeout(() => end.current?.scrollIntoView({ block: 'end' }), 30);
    } catch (e) { setErr(describeError(e).message); }
  };
  const submit = (e: FormEvent) => { e.preventDefault(); void send(text); };
  return (
    <section className="wa-phone" aria-label="Assistant WhatsApp MOSOLO">
      <header className="wa-head">
        <span className="wa-avatar" aria-hidden="true">M</span>
        <div><strong>MOSOLO · Ville de Kinshasa</strong><span className="wa-cert"><Icon name="shieldCheck" size={12} /> compte certifié</span></div>
        <span className={`wa-consent ${consent ? 'on' : ''}`}>{consent ? 'Consentement donné' : 'Sans consentement'}</span>
      </header>
      <div className="wa-body" role="log" aria-live="polite">
        {chat.length === 0 && <p className="wa-hint">Écrivez « Bonjour » : l’assistant demande d’abord votre consentement.</p>}
        {chat.map((b, i) => (
          <div key={i} className={`wa-bubble wa-${b.from}`}><span style={{ whiteSpace: 'pre-wrap' }}>{b.text}</span><time>{b.at}</time></div>
        ))}
        <div ref={end} />
      </div>
      <div className="wa-quick" role="group" aria-label="Réponses rapides">
        {QUICK.map((q) => <button key={q} type="button" className="chip" onClick={() => void send(q)}>{q}</button>)}
      </div>
      <form className="wa-input" onSubmit={submit}>
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message ou code à vérifier" aria-label="Message WhatsApp" />
        <button className="btn btn-primary" aria-label="Envoyer"><Icon name="send" size={16} /></button>
      </form>
      <label className="small wa-num">Numéro (démonstration) <input className="input mono" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
      {err && <p className="notice notice-err small">{err}</p>}
    </section>
  );
}

function SmsPhone() {
  const [from] = useState('+243990000001');
  const [text, setText] = useState('V ');
  const [log, setLog] = useState<{ q: string; a: string }[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      const r = await api<{ reply: string }>('/v1/sms/inbound', { method: 'POST', body: { from, text } });
      setLog((l) => [...l, { q: text, a: r.reply }]);
      setText('V ');
    } catch (x) { setErr(describeError(x).message); }
  };
  return (
    <section className="sms-phone" aria-label="SMS depuis un téléphone basique">
      <div className="sms-screen" role="log" aria-live="polite">
        <p className="sms-title">Messages · MOSOLO</p>
        {log.length === 0 && <p className="sms-hint">Envoyez « V » suivi du code (ex. V PKT…), « POINTS Gombe » ou « AIDE ».</p>}
        {log.map((m, i) => (
          <div key={i}>
            <p className="sms-out">{m.q}</p>
            <p className="sms-in">{m.a}<span className="sms-len">{m.a.length} car. · GSM-7</span></p>
          </div>
        ))}
      </div>
      <form className="sms-form" onSubmit={(e) => void submit(e)}>
        <input className="input mono" value={text} onChange={(e) => setText(e.target.value)} aria-label="Texte du SMS" maxLength={160} />
        <button className="btn btn-primary">Envoyer</button>
      </form>
      <p className="small muted">Numéro court officiel : [À RACCORDER — convention opérateur requise]. Réponse sans accents (160 caractères par SMS), gratuite pour l’usager.</p>
      {err && <p className="notice notice-err small">{err}</p>}
    </section>
  );
}
