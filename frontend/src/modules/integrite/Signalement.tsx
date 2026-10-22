/** Écran public : signaler une irrégularité (anonymat possible) et suivre son signalement par code secret. */
import { useState } from 'react';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { api, newIdempotencyKey } from '../../lib/api';
import { useApp } from '../../context';
import { ActionError, CATEGORY_LABELS, EvidencePicker, StateBadge, Tabs, useAction, type Evidence } from './shared';
import { SignalementPublicVisuels } from './visuels';
import './integrite.css';

export const COMMUNES = [
  'Bandalungwa', 'Barumbu', 'Bumbu', 'Gombe', 'Kalamu', 'Kasa-Vubu', 'Kimbanseke', 'Kinshasa', 'Kintambo', 'Kisenso', 'Lemba', 'Limete',
  'Lingwala', 'Makala', 'Maluku', 'Masina', 'Matete', 'Mont-Ngafula', 'Ndjili', 'Ngaba', 'Ngaliema', 'Ngiri-Ngiri', "N'sele", 'Selembao',
];

const CATEGORY_HINTS: Record<string, string> = {
  DEMANDE_ESPECES: 'Un agent vous a demandé de l’argent en main propre.',
  FAUX_AGENT: 'Badge absent, non vérifiable ou hors de sa zone.',
  FAUSSE_QUITTANCE: 'Quittance que la vérification publique ne reconnaît pas.',
  POINT_PAIEMENT_IRREGULIER: 'Montant modifié, refus de référence, pas de preuve.',
  PRELEVEMENT_WEWA: 'Prélèvement sur la route sans ticket officiel.',
  SOUS_TRAITANT_ENCAISSE: 'Un prestataire de recensement encaisse.',
  COMPORTEMENT_AGENT: 'Menace, intimidation, abus de fonction.',
  AUTRE: 'Toute autre irrégularité.',
};

const TARGETS = [
  { id: '', label: 'Non précisé' }, { id: 'AGENT', label: 'Un agent' }, { id: 'POINT_PAIEMENT', label: 'Un point de paiement' },
  { id: 'QUITTANCE', label: 'Une quittance' }, { id: 'SOUS_TRAITANT', label: 'Un sous-traitant' }, { id: 'GUICHET', label: 'Un guichet' },
];

interface Submitted { reference: string; trackingCode: string; message: string; reminder: string }
interface Tracked {
  reference: string; categoryLabel: string; status: string; statusLabel: string; receivedAt: string; updatedAt: string;
  outcome: { code: string; label: string; at: string } | null; messages: { at: string; from: string; text: string }[]; evidenceCount: number;
}

export default function Signalement() {
  const [tab, setTab] = useState<'signaler' | 'suivre' | 'canaux'>('signaler');
  return (
    <div className="page ig-page">
      <PageHead
        eyebrow="Ligne d’intégrité"
        title="Signaler une irrégularité"
        lead="Demande d’espèces, faux agent, fausse quittance, point de paiement irrégulier : signalez-le, même sans donner votre nom. Votre identité est protégée et n’est jamais communiquée à la personne mise en cause."
      />
      <div className="callout callout-info ig-promise">
        <Icon name="shieldCheck" size={20} />
        <div>
          <strong>Un agent MOSOLO ne demande jamais d’espèces.</strong> Tout paiement se fait sur une référence, vers un compte public, et donne une quittance vérifiable.
        </div>
      </div>
      <SignalementPublicVisuels />
      <Tabs label="Signalement" value={tab} onChange={setTab} items={[
        { id: 'signaler', label: 'Signaler' }, { id: 'suivre', label: 'Suivre mon signalement' }, { id: 'canaux', label: 'SMS et serveur vocal' },
      ]} />
      {tab === 'signaler' && <ReportForm onTrack={() => setTab('suivre')} />}
      {tab === 'suivre' && <TrackPanel />}
      {tab === 'canaux' && <ChannelsPanel />}
    </div>
  );
}

function ReportForm({ onTrack }: { onTrack: () => void }) {
  const [category, setCategory] = useState('DEMANDE_ESPECES');
  const [description, setDescription] = useState('');
  const [commune, setCommune] = useState('');
  const [place, setPlace] = useState('');
  const [occurredOn, setOccurredOn] = useState('');
  const [targetKind, setTargetKind] = useState('');
  const [targetRef, setTargetRef] = useState('');
  const [anonymous, setAnonymous] = useState(true);
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const [done, setDone] = useState<Submitted | null>(null);
  const [copied, setCopied] = useState(false);
  const [idem] = useState(newIdempotencyKey);
  const a = useAction();

  const tooShort = description.trim().length < 10;
  const contactMissing = !anonymous && !phone.trim() && !email.trim();

  const submit = async () => {
    const body = {
      category, description, anonymous,
      ...(commune ? { commune } : {}), ...(place ? { place } : {}), ...(occurredOn ? { occurredOn } : {}),
      ...(targetKind ? { target: { kind: targetKind, ...(targetRef ? { reference: targetRef } : {}) } } : {}),
      ...(!anonymous ? { contact: { ...(phone ? { phone } : {}), ...(email ? { email } : {}) } } : {}),
      ...(evidence.length ? { evidence } : {}),
    };
    const r = await a.run(() => api<Submitted>('/v1/public/integrite/reports', { method: 'POST', body, idempotencyKey: idem }));
    if (r) setDone(r);
  };

  if (done) {
    return (
      <section className="panel ig-receipt" aria-live="polite">
        <div className="ig-receipt-head">
          <Icon name="check" size={28} />
          <div>
            <h2 className="panel-title">Signalement {done.reference} enregistré</h2>
            <p className="small muted">Il sera qualifié puis transmis à un enquêteur anti-fraude.</p>
          </div>
        </div>
        <p className="label">Votre code de suivi secret</p>
        <p className="ig-code" aria-label={`Code de suivi ${done.trackingCode.split('').join(' ')}`}>{done.trackingCode}</p>
        <div className="btn-row">
          <button type="button" className="btn btn-secondary" onClick={() => { void navigator.clipboard?.writeText(done.trackingCode).then(() => setCopied(true)); }}>
            <Icon name={copied ? 'check' : 'file'} size={18} /> {copied ? 'Copié' : 'Copier le code'}
          </button>
          <button type="button" className="btn btn-primary" onClick={onTrack}>Suivre mon signalement <Icon name="arrowRight" size={18} /></button>
        </div>
        <div className="callout callout-warn"><Icon name="lock" size={18} /><span>{done.message}</span></div>
        <p className="small muted">{done.reminder}</p>
      </section>
    );
  }

  return (
    <section className="panel" aria-labelledby="ig-form-title">
      <h2 id="ig-form-title" className="panel-title">Que s’est-il passé ?</h2>
      <div className="form">
        <fieldset className="field">
          <legend className="label">Nature de l’irrégularité</legend>
          <div className="choice-grid">
            {Object.entries(CATEGORY_LABELS).map(([k, label]) => (
              <label key={k} className={`choice ig-choice ${category === k ? 'checked' : ''}`}>
                <input type="radio" name="ig-category" value={k} checked={category === k} onChange={() => setCategory(k)} />
                <span><span className="row-title">{label}</span><span className="hint ig-block">{CATEGORY_HINTS[k]}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label className="label" htmlFor="ig-desc">Description des faits</label>
          <textarea id="ig-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000}
            placeholder="Où, quand, comment ? Décrivez ce que vous avez vu ou vécu, sans données inutiles sur des tiers." aria-describedby="ig-desc-hint" />
          <span id="ig-desc-hint" className="hint">10 caractères au moins. N’indiquez ni mot de passe ni code de paiement.</span>
        </div>
        <div className="field-row">
          <div className="field">
            <label className="label" htmlFor="ig-commune">Commune</label>
            <select id="ig-commune" value={commune} onChange={(e) => setCommune(e.target.value)}>
              <option value="">Non précisée</option>
              {COMMUNES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="field">
            <label className="label" htmlFor="ig-date">Date des faits</label>
            <input id="ig-date" type="date" value={occurredOn} onChange={(e) => setOccurredOn(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="label" htmlFor="ig-place">Lieu précis (facultatif)</label>
          <input id="ig-place" value={place} onChange={(e) => setPlace(e.target.value)} maxLength={200} placeholder="Marché, avenue, rond-point…" />
        </div>
        <div className="field-row">
          <div className="field">
            <label className="label" htmlFor="ig-target">Qui ou quoi est concerné ?</label>
            <select id="ig-target" value={targetKind} onChange={(e) => setTargetKind(e.target.value)}>
              {TARGETS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          {targetKind && (
            <div className="field">
              <label className="label" htmlFor="ig-target-ref">Référence visible (facultatif)</label>
              <input id="ig-target-ref" value={targetRef} onChange={(e) => setTargetRef(e.target.value)} maxLength={120}
                placeholder={targetKind === 'QUITTANCE' ? 'Numéro de quittance' : targetKind === 'AGENT' ? 'Code du badge' : 'Nom ou numéro affiché'} />
            </div>
          )}
        </div>
        <fieldset className="field">
          <legend className="label">Souhaitez-vous être recontacté ?</legend>
          <div className="radio-list">
            <label className={`radio ${anonymous ? 'checked' : ''}`}>
              <input type="radio" name="ig-anon" checked={anonymous} onChange={() => setAnonymous(true)} />
              <span><span className="row-title">Rester anonyme</span><span className="hint ig-block">Aucune coordonnée conservée. Suivi par code secret uniquement.</span></span>
            </label>
            <label className={`radio ${!anonymous ? 'checked' : ''}`}>
              <input type="radio" name="ig-anon" checked={!anonymous} onChange={() => setAnonymous(false)} />
              <span><span className="row-title">Laisser un contact protégé</span><span className="hint ig-block">Chiffré, jamais affiché aux enquêteurs ni à la personne mise en cause.</span></span>
            </label>
          </div>
        </fieldset>
        {!anonymous && (
          <div className="field-row">
            <div className="field">
              <label className="label" htmlFor="ig-phone">Téléphone</label>
              <input id="ig-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+243 …" />
            </div>
            <div className="field">
              <label className="label" htmlFor="ig-email">Adresse électronique</label>
              <input id="ig-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </div>
        )}
        <div className="field">
          <span className="label">Pièces (photo, reçu…)</span>
          <EvidencePicker value={evidence} onChange={setEvidence} />
        </div>
        <ActionError error={a.error} />
        <div className="btn-row">
          <button type="button" className="btn btn-primary" disabled={a.busy || tooShort || contactMissing} onClick={() => void submit()}>
            <Icon name="send" size={18} /> {a.busy ? 'Envoi…' : 'Envoyer le signalement'}
          </button>
        </div>
        {contactMissing && <p className="hint">Indiquez un téléphone ou une adresse, ou choisissez l’anonymat.</p>}
        <p className="small muted ig-legal">
          <Icon name="lock" size={14} /> Un signalement n’est pas une plainte pénale : il déclenche une vérification. Aucune sanction n’est prise sans instruction contradictoire et décision motivée d’une autorité habilitée.
        </p>
      </div>
    </section>
  );
}

function TrackPanel() {
  const { fmtDate } = useApp();
  const [code, setCode] = useState('');
  const [data, setData] = useState<Tracked | null>(null);
  const [text, setText] = useState('');
  const [evidence, setEvidence] = useState<Evidence[]>([]);
  const a = useAction();
  const c = useAction();

  const track = async () => {
    const r = await a.run(() => api<Tracked>('/v1/public/integrite/reports/track', { method: 'POST', body: { code } }));
    if (r) setData(r);
  };
  const complement = async () => {
    const r = await c.run(() => api<Tracked>('/v1/public/integrite/reports/track/complement', { method: 'POST', body: { code, text, ...(evidence.length ? { evidence } : {}) } }));
    if (r) { setData(r); setText(''); setEvidence([]); }
  };
  const steps = ['RECU', 'QUALIFIE', 'TRANSMIS', 'CLOS'];
  const idx = data ? steps.indexOf(data.status) : -1;

  return (
    <div className="ig-stack">
      <section className="panel" aria-labelledby="ig-track-title">
        <h2 id="ig-track-title" className="panel-title">Suivre avec votre code secret</h2>
        <form className="input-row ig-track-row" onSubmit={(e) => { e.preventDefault(); void track(); }}>
          <label className="sr-only" htmlFor="ig-code">Code de suivi</label>
          <input id="ig-code" className="mono" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX" autoComplete="off" spellCheck={false} maxLength={20} />
          <button type="submit" className="btn btn-primary" disabled={a.busy || code.replace(/[\s-]/g, '').length < 12}>Consulter</button>
        </form>
        <p className="hint">Exemple de démonstration : <button type="button" className="btn-link" onClick={() => setCode('DEMO-2026-0001')}>DEMO-2026-0001</button></p>
        <ActionError error={a.error} />
      </section>
      {data && (
        <section className="panel" aria-live="polite">
          <div className="panel-head">
            <div>
              <h2 className="panel-title">{data.reference}</h2>
              <p className="panel-sub">{data.categoryLabel} · reçu le {fmtDate(data.receivedAt, true)}</p>
            </div>
            <StateBadge value={data.status} />
          </div>
          <ol className="ig-steps" aria-label="Étapes du traitement">
            {['Reçu', 'Qualifié', 'Transmis à l’enquêteur', 'Clos'].map((s, i) => (
              <li key={s} className={i <= idx ? 'done' : ''} aria-current={i === idx ? 'step' : undefined}>
                <span className="ig-step-dot">{i < idx || data.status === 'CLOS' ? <Icon name="check" size={12} /> : i + 1}</span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
          {data.outcome && <div className="callout callout-info"><Icon name="info" size={18} /><span><strong>Issue :</strong> {data.outcome.label}</span></div>}
          <h3 className="ig-h3">Échanges avec la ligne</h3>
          <ul className="ig-thread">
            {data.messages.map((m, i) => (
              <li key={i} className={m.from === 'SIGNALANT' ? 'me' : ''}>
                <span className="small muted">{m.from === 'SIGNALANT' ? 'Vous' : 'Ligne d’intégrité'} · {fmtDate(m.at, true)}</span>
                <p>{m.text}</p>
              </li>
            ))}
          </ul>
          {data.status !== 'CLOS' && (
            <div className="form ig-complement">
              <div className="field">
                <label className="label" htmlFor="ig-more">Compléter mon signalement</label>
                <textarea id="ig-more" rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />
              </div>
              <EvidencePicker value={evidence} onChange={setEvidence} />
              <ActionError error={c.error} />
              <div className="btn-row">
                <button type="button" className="btn btn-secondary" disabled={c.busy || text.trim().length < 5} onClick={() => void complement()}><Icon name="send" size={18} /> Envoyer le complément</button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function ChannelsPanel() {
  const [from, setFrom] = useState('+243810000099');
  const [sms, setSms] = useState('SIGNAL ESPECES ANONYME agent au marché de Matete demande 5000 FC');
  const [reply, setReply] = useState<string | null>(null);
  const [digits, setDigits] = useState(['1', '1']);
  const [transcript, setTranscript] = useState('Un collecteur exige de l’argent sans ticket au rond-point.');
  const [script, setScript] = useState<string | null>(null);
  const s = useAction();
  const v = useAction();
  return (
    <div className="two-col">
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title"><Icon name="message" size={18} /> Par SMS</h2>
          <span className="ribbon">Simulation</span>
        </div>
        <p className="small">Envoyez <span className="mono">SIGNAL</span> suivi d’un mot-clé (<span className="mono">ESPECES</span>, <span className="mono">FAUX</span>, <span className="mono">QUITTANCE</span>, <span className="mono">POINT</span>, <span className="mono">WEWA</span>), éventuellement <span className="mono">ANONYME</span>, puis les faits. Numéro court : à attribuer par l’opérateur (démonstration).</p>
        <div className="form">
          <div className="field"><label className="label" htmlFor="ig-sms-from">Numéro de l’expéditeur (fictif)</label><input id="ig-sms-from" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
          <div className="field"><label className="label" htmlFor="ig-sms">Texte du SMS</label><textarea id="ig-sms" rows={3} value={sms} onChange={(e) => setSms(e.target.value)} maxLength={640} /></div>
          <ActionError error={s.error} />
          <button type="button" className="btn btn-secondary" disabled={s.busy} onClick={() => void s.run(async () => setReply((await api<{ reply: string }>('/v1/public/integrite/reports/sms', { method: 'POST', body: { from: from.replace(/\s/g, ''), text: sms } })).reply))}>
            <Icon name="send" size={18} /> Simuler l’envoi
          </button>
          {reply && <div className="ig-sms-bubble" aria-live="polite"><span className="small muted">Réponse automatique</span><p>{reply}</p></div>}
        </div>
      </section>
      <section className="panel">
        <div className="panel-head">
          <h2 className="panel-title"><Icon name="phone" size={18} /> Numéro gratuit et serveur vocal</h2>
          <span className="ribbon">Simulation</span>
        </div>
        <p className="small">Touche 1 : espèces · 2 : faux agent · 3 : fausse quittance · 4 : point de paiement · 5 : wewa · 9 : autre. Puis 1 pour rester anonyme, 2 pour être rappelé.</p>
        <div className="form">
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="ig-d1">Choix du motif</label>
              <select id="ig-d1" value={digits[0]} onChange={(e) => setDigits([e.target.value, digits[1]!])}>{['1', '2', '3', '4', '5', '9'].map((d) => <option key={d}>{d}</option>)}</select></div>
            <div className="field"><label className="label" htmlFor="ig-d2">Anonymat</label>
              <select id="ig-d2" value={digits[1]} onChange={(e) => setDigits([digits[0]!, e.target.value])}><option value="1">1 — anonyme</option><option value="2">2 — rappel</option></select></div>
          </div>
          <div className="field"><label className="label" htmlFor="ig-tr">Transcription du message vocal</label><textarea id="ig-tr" rows={3} value={transcript} onChange={(e) => setTranscript(e.target.value)} /></div>
          <ActionError error={v.error} />
          <button type="button" className="btn btn-secondary" disabled={v.busy} onClick={() => void v.run(async () => setScript((await api<{ script: string }>('/v1/public/integrite/reports/svi', { method: 'POST', body: { digits, transcript, callerNumber: '+243810000098' } })).script))}>
            <Icon name="phone" size={18} /> Simuler l’appel
          </button>
          {script && <div className="ig-sms-bubble" aria-live="polite"><span className="small muted">Message vocal diffusé</span><p>{script}</p></div>}
        </div>
      </section>
    </div>
  );
}
