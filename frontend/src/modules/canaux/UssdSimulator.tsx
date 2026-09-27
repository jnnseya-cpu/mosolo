import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { ErrorState, ExampleNotice } from '../../components/States';
import { api } from '../../lib/api';
import './canaux.css';

interface ScreenOut {
  sessionId: string; channel: 'USSD' | 'SVI'; lang: string; text: string; prompts: string[];
  options: { key: string; label: string }[]; end: boolean; translationPending: boolean;
}

const PRESETS = [
  { msisdn: '+243810000001', label: 'Contribuable fictif (code secret 1234)' },
  { msisdn: '+243899999999', label: 'Téléphone d’un proche : carte MOSOLO 4821 7730 1595, code 2468' },
  { msisdn: '+243811111111', label: 'Numéro inconnu (vérification, points de paiement)' },
];

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
const KEY_LETTERS: Record<string, string> = { '2': 'abc', '3': 'def', '4': 'ghi', '5': 'jkl', '6': 'mno', '7': 'pqrs', '8': 'tuv', '9': 'wxyz', '0': '+' };

function speak(lines: string[]) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(lines.join(' '));
    u.lang = 'fr-FR';
    u.rate = 0.95;
    synth.speak(u);
  } catch { /* synthèse vocale indisponible */ }
}

export default function UssdSimulator() {
  const [channel, setChannel] = useState<'USSD' | 'SVI'>('USSD');
  const [msisdn, setMsisdn] = useState(PRESETS[0]!.msisdn);
  const [screen, setScreen] = useState<ScreenOut | null>(null);
  const [buffer, setBuffer] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [transcript, setTranscript] = useState<{ who: 'mosolo' | 'moi'; text: string }[]>([]);
  const [voice, setVoice] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);

  const base = channel === 'USSD' ? '/v1/ussd/sessions' : '/v1/ivr/sessions';
  const secret = !!screen && !screen.end && /code secret/i.test(screen.text);

  const show = useCallback((s: ScreenOut) => {
    setScreen(s);
    setTranscript((t) => [...t, { who: 'mosolo', text: s.channel === 'SVI' ? s.prompts.join(' ') : s.text }]);
    if (s.channel === 'SVI' && voice) speak(s.prompts);
  }, [voice]);

  async function dial() {
    setBusy(true); setError(null); setTranscript([]); setBuffer('');
    try {
      show(await api<ScreenOut>(base, { method: 'POST', body: { msisdn } }));
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  async function send(value = buffer) {
    if (!screen || screen.end || !value) return;
    setBusy(true); setError(null);
    setTranscript((t) => [...t, { who: 'moi', text: secret ? '••••' : value }]);
    setBuffer('');
    try {
      show(await api<ScreenOut>(`${base}/${screen.sessionId}/input`, { method: 'POST', body: { input: value } }));
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  function hangUp() {
    setScreen(null); setBuffer('');
    try { window.speechSynthesis?.cancel(); } catch { /* rien */ }
  }

  function press(k: string) {
    if (!screen) return;
    if (channel === 'SVI' && k === '#') { void send(); return; }
    setBuffer((b) => (b + k).slice(0, 20));
  }

  useEffect(() => { const el = logRef.current; if (el) el.scrollTop = el.scrollHeight; }, [transcript]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      if (/^[0-9*#]$/.test(e.key)) press(e.key);
      else if (e.key === 'Enter') void send();
      else if (e.key === 'Backspace') setBuffer((b) => b.slice(0, -1));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Canaux sans Internet — modules 6 et 64" title="Simulateur USSD et SVI" lead="Consulter, payer, vérifier sans smartphone ni Internet : menus numérotés courts, code secret, aucune donnée sensible à l’écran. Gratuit pour l’appelant (sous réserve des conventions opérateurs, J29)." />
      <ExampleNotice text="Simulateur de la passerelle opérateur. Code court et numéro vert [À RACCORDER — convention opérateur requise] ; contribuables et montants fictifs (règle de démonstration)." />
      <div className="cx-sim">
        <section className="cx-phone-col" aria-label="Téléphone simulé">
          <div className="cx-phone">
            <div className="cx-phone-top"><span className="cx-phone-speaker" aria-hidden="true" /></div>
            <div className="cx-lcd" aria-live="polite">
              <div className="cx-lcd-bar"><span>{channel === 'USSD' ? 'USSD' : 'Appel SVI'}</span><span>{screen && !screen.end ? '● en ligne' : 'MOSOLO'}</span></div>
              {!screen && <p className="cx-lcd-text">{channel === 'USSD' ? 'Composez *[code]# puis appuyez sur Appel.' : 'Appelez le numéro vert MOSOLO.'}</p>}
              {screen && <p className="cx-lcd-text">{channel === 'SVI' ? `Voix : ${screen.prompts[0] ?? ''}` : screen.text}</p>}
              {screen && channel === 'SVI' && screen.options.length > 0 && (
                <ul className="cx-lcd-opts">{screen.options.map((o) => <li key={o.key}>{o.key} · {o.label}</li>)}</ul>
              )}
              {screen && !screen.end && <p className="cx-lcd-input">&gt; {secret ? '•'.repeat(buffer.length) : buffer}<span className="cx-caret" aria-hidden="true" /></p>}
              {screen?.end && <p className="cx-lcd-end">Session terminée</p>}
            </div>
            <div className="cx-softkeys">
              <button type="button" className="cx-key cx-key-call" onClick={() => (screen && !screen.end ? void send() : void dial())} disabled={busy} aria-label={screen && !screen.end ? 'Envoyer' : 'Appeler'}>
                <Icon name={screen && !screen.end ? 'send' : 'phone'} size={20} />
              </button>
              <button type="button" className="cx-key cx-key-clear" onClick={() => setBuffer((b) => b.slice(0, -1))} disabled={!screen || !buffer} aria-label="Effacer">
                <Icon name="arrowRight" size={18} className="cx-flip" />
              </button>
              <button type="button" className="cx-key cx-key-end" onClick={hangUp} aria-label="Raccrocher"><Icon name="close" size={20} /></button>
            </div>
            <div className="cx-keypad">
              {KEYS.map((k) => (
                <button key={k} type="button" className="cx-key" onClick={() => press(k)} disabled={!screen || screen.end || busy} aria-label={`Touche ${k}`}>
                  <span className="cx-key-n">{k}</span><span className="cx-key-l">{KEY_LETTERS[k] ?? ''}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <div className="cx-sim-side">
          <section className="panel">
            <header className="panel-head"><h2 className="panel-title">Appel</h2></header>
            <div className="form">
              <div className="seg" role="group" aria-label="Canal">
                <button type="button" aria-pressed={channel === 'USSD'} onClick={() => { setChannel('USSD'); hangUp(); }}><Icon name="keypad" size={16} /> USSD</button>
                <button type="button" aria-pressed={channel === 'SVI'} onClick={() => { setChannel('SVI'); hangUp(); }}><Icon name="phone" size={16} /> SVI vocal</button>
              </div>
              <div className="field">
                <label className="label" htmlFor="cx-msisdn">Numéro appelant (simulé)</label>
                <input id="cx-msisdn" className="mono" value={msisdn} onChange={(e) => setMsisdn(e.target.value)} inputMode="tel" />
                <div className="chips">{PRESETS.map((p) => <button key={p.msisdn} type="button" className="btn btn-ghost btn-sm" onClick={() => setMsisdn(p.msisdn)} title={p.label}>{p.msisdn}</button>)}</div>
                <p className="hint">{PRESETS.find((p) => p.msisdn === msisdn)?.label ?? 'Numéro libre.'}</p>
              </div>
              {channel === 'SVI' && (
                <label className="check"><input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} /> Lire les messages à voix haute (synthèse du navigateur ; en production : audio pré-enregistré validé)</label>
              )}
              <button type="button" className="btn btn-primary" onClick={() => void dial()} disabled={busy}><Icon name="phone" size={18} /> {screen && !screen.end ? 'Recommencer l’appel' : 'Appeler'}</button>
            </div>
            {error !== null && <ErrorState error={error} />}
          </section>

          <section className="panel">
            <header className="panel-head">
              <div><h2 className="panel-title">{channel === 'SVI' ? 'Transcription vocale' : 'Échanges'}</h2><p className="panel-sub">Le code secret n’est jamais affiché ni journalisé en clair.</p></div>
              {screen?.translationPending && <span className="ribbon">Langue : traduction à valider</span>}
            </header>
            {transcript.length === 0 ? <p className="muted small">Aucun échange pour l’instant.</p> : (
              <ol className="cx-transcript" ref={logRef}>
                {transcript.map((t, i) => <li key={i} className={`cx-msg cx-msg-${t.who}`}><span className="cx-msg-who">{t.who === 'moi' ? 'Vous' : 'MOSOLO'}</span><span className="cx-msg-text">{t.text}</span></li>)}
              </ol>
            )}
          </section>

          <section className="panel">
            <header className="panel-head"><h2 className="panel-title">Garanties du canal</h2></header>
            <ul className="plain-list cx-guarantees">
              <li><Icon name="lock" size={16} /> Solde, paiement et quittances seulement après code secret ; 3 erreurs ⇒ blocage de 15 minutes.</li>
              <li><Icon name="shieldCheck" size={16} /> Ni nom complet, ni adresse, ni historique détaillé à l’écran.</li>
              <li><Icon name="ticket" size={16} /> « Payer » émet la référence du circuit commun : montant fixé par la règle, jamais saisi.</li>
              <li><Icon name="ban" size={16} /> Aucun agent ne vous demandera d’espèces ; aucun lien de paiement par SMS.</li>
              <li><Icon name="clock" size={16} /> Session close après 3 minutes d’inactivité ; vérifications limitées en fréquence.</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}
