import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../context';
import { Icon } from '../components/Icon';
import { MoneyText } from '../components/MoneyText';
import { StatusBadge } from '../components/StatusBadge';
import { QrCode } from '../components/QrCode';
import { ExampleNotice } from '../components/States';
import { cdf } from '../verticals/catalogue';

/**
 * Espace citoyen RakaPay (modules 76, 70, 71) et pass des moto-taxis wewa (module 81, composante de RakaPay).
 * Doctrine : tarif fixé par l'acte uniquement (J28) ; un wewa en vert n'a rien à payer et ne peut être
 * sanctionné ; aucun encaissement d'espèces sur la route ; paiement vers le compte public.
 * Données [EXEMPLE] : le montant de 500 FC par jour reprend l'illustration du § H.27.16.1, non opposable.
 */

type Tab = 'pass' | 'tickets' | 'history';
type Duration = 'JOUR' | 'SEMAINE' | 'MOIS';

const DAY_EXAMPLE = 500;
const DURATIONS: { id: Duration; label: string; days: number }[] = [
  { id: 'JOUR', label: 'Jour', days: 1 }, { id: 'SEMAINE', label: 'Semaine', days: 7 }, { id: 'MOIS', label: 'Mois', days: 30 },
];
const CHANNELS = [
  { id: 'USSD', icon: 'keypad', label: 'USSD', hint: 'Tout téléphone, sans internet' },
  { id: 'MOBILE_MONEY', icon: 'phone', label: 'Mobile Money', hint: 'Orange Money, M-Pesa, Airtel Money' },
  { id: 'COOP', icon: 'users', label: 'Paiement groupé', hint: 'Par votre coopérative, pour chaque membre' },
];

const PASS = {
  code: 'WEWA-LMT-0417', driver: 'Conducteur n° KIN-C-20417', plate: 'KN-M 20417', vest: 'Gilet W-LMT-0417',
  station: 'Station Rond-point Victoire', coop: 'Coopérative des wewa de Kalamu', validUntil: '2027-02-11T23:59:00+01:00',
};

const HISTORY = [
  { code: 'RKP-W-9F2A', label: 'Pass wewa — Semaine', date: '2027-02-05', amount: 3500, status: 'PROVISOIRE' as const },
  { code: 'RKP-W-7C11', label: 'Pass wewa — Semaine', date: '2027-01-29', amount: 3500, status: 'DEFINITIVE' as const },
  { code: 'RKP-W-5B80', label: 'Pass wewa — Semaine', date: '2027-01-22', amount: 3500, status: 'DEFINITIVE' as const },
  { code: 'RKP-T-3E47', label: 'Ticket bus urbain — Victoire → Gombe', date: '2027-01-20', amount: 500, status: 'DEFINITIVE' as const },
];

const TICKETS = [
  { icon: 'bus', title: 'Bus urbain', sub: 'Ticket trajet ou abonnement', state: 'Acte requis', tone: 'info' as const, active: true },
  { icon: 'parking', title: 'Stationnement', sub: 'Payé au temps passé — MOSOLO Parking', state: 'Acte requis', tone: 'info' as const, active: false },
  { icon: 'star', title: 'Événements', sub: 'Billets déclarés à MOSOLO Events', state: 'Base à vérifier', tone: 'warning' as const, active: false },
  { icon: 'moto', title: 'Pass wewa', sub: 'Moto-taxis : jour, semaine, mois', state: 'Acte requis (J28)', tone: 'info' as const, active: true },
];

function PassCard() {
  const { fmtDate } = useApp();
  const verifyUrl = `${window.location.origin}/verifier/${PASS.code}`;
  return (
    <article className="rk-pass" aria-label="Pass wewa numérique">
      <div className="rk-pass-top">
        <span className="rk-pass-brand"><Icon name="ticket" size={18} /> RakaPay · Pass wewa</span>
        <span className="rk-pass-state"><span className="rk-dot" aria-hidden="true" /> EN RÈGLE</span>
      </div>
      <div className="rk-pass-body">
        <div className="min0">
          <p className="rk-pass-plate mono">{PASS.plate}</p>
          <p className="rk-pass-line">{PASS.driver}</p>
          <p className="rk-pass-line">{PASS.vest}</p>
          <p className="rk-pass-line">{PASS.station}</p>
          <p className="rk-pass-valid">Valable jusqu’au <strong>{fmtDate(PASS.validUntil, true)}</strong></p>
        </div>
        <figure className="rk-pass-qr">
          <QrCode value={verifyUrl} size={116} alt={`Code QR du pass ${PASS.code}`} />
          <figcaption className="mono">{PASS.code}</figcaption>
        </figure>
      </div>
      <div className="rk-pass-strip" aria-hidden="true"><span /><span /><span /></div>
    </article>
  );
}

function BuyPass() {
  const [duration, setDuration] = useState<Duration>('SEMAINE');
  const [channel, setChannel] = useState('USSD');
  const [ref, setRef] = useState<string | null>(null);
  const d = DURATIONS.find((x) => x.id === duration)!;
  function submit(e: FormEvent) {
    e.preventDefault();
    setRef(`RKP-W-2027-${duration.slice(0, 1)}${String(417).padStart(6, '0')}`);
  }
  return (
    <section className="panel" aria-labelledby="rk-buy">
      <div className="panel-head">
        <div><h2 className="panel-title" id="rk-buy">Renouveler mon pass</h2><p className="panel-sub">Pass personnel, non transférable, lié à la moto et au conducteur</p></div>
      </div>
      {!ref ? (
        <form className="form" onSubmit={submit}>
          <fieldset className="field">
            <legend className="label">Durée</legend>
            <div className="seg" role="group">
              {DURATIONS.map((x) => <button key={x.id} type="button" aria-pressed={duration === x.id} onClick={() => setDuration(x.id)}>{x.label}</button>)}
            </div>
          </fieldset>
          <div className="rk-price">
            <MoneyText money={cdf(DAY_EXAMPLE * d.days)} />
            <p className="small muted">[EXEMPLE] {DAY_EXAMPLE} FC × {d.days} jour{d.days > 1 ? 's' : ''}. Le tarif est fixé uniquement par l’acte (J28) : ni l’agent ni l’opérateur ne peuvent le modifier.</p>
          </div>
          <fieldset className="field">
            <legend className="label">Moyen de paiement</legend>
            <div className="choice-grid">
              {CHANNELS.map((c) => (
                <label key={c.id} className={`choice ${channel === c.id ? 'checked' : ''}`}>
                  <input type="radio" name="rk-channel" value={c.id} checked={channel === c.id} onChange={() => setChannel(c.id)} />
                  <Icon name={c.icon} size={20} /> <span><strong>{c.label}</strong><br /><span className="small muted">{c.hint}</span></span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="callout callout-warn"><Icon name="cash" size={18} /><p><strong>Aucune espèce sur la route.</strong> Personne n’encaisse le pass en liquide : ni agent, ni policier, ni chef de station.</p></div>
          <button type="submit" className="btn btn-primary btn-block">Obtenir ma référence de paiement</button>
        </form>
      ) : (
        <div className="result-card" role="status">
          <p className="label">Référence de paiement</p>
          <p className="ref-big mono">{ref}</p>
          <dl className="kv">
            <div><dt>Montant</dt><dd><MoneyText money={cdf(DAY_EXAMPLE * d.days)} /> <span className="small muted">[EXEMPLE]</span></dd></div>
            <div><dt>Bénéficiaire</dt><dd>Compte public des recettes provinciales</dd></div>
            <div><dt>Recette comptée pour</dt><dd>Kalamu <span className="small muted">— commune de la station d’attache</span></dd></div>
            <div><dt>Statut</dt><dd><StatusBadge tone="warning" label="En attente de paiement" /></dd></div>
          </dl>
          <ol className="steps">
            <li>Composez le code USSD officiel publié avec l’acte, ou ouvrez votre Mobile Money.</li>
            <li>Saisissez la référence <span className="mono">{ref}</span>.</li>
            <li>Dès la confirmation signée de l’opérateur, votre pass passe au vert et une quittance provisoire vous est envoyée par SMS.</li>
            <li>La quittance devient définitive après rapprochement avec le relevé du compte public.</li>
          </ol>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRef(null)}>Modifier</button>
        </div>
      )}
    </section>
  );
}

function History() {
  const { fmtDate } = useApp();
  return (
    <section className="panel" aria-labelledby="rk-hist">
      <div className="panel-head"><h2 className="panel-title" id="rk-hist">Historique et quittances</h2><span className="count">{HISTORY.length}</span></div>
      <ul className="list-rows">
        {HISTORY.map((h) => (
          <li key={h.code} className="list-row receipt-row">
            <figure className="receipt-qr">
              <QrCode value={`${window.location.origin}/verifier/${h.code}`} size={72} alt={`Code QR de la quittance ${h.code}`} />
              <figcaption className="mono small">{h.code}</figcaption>
            </figure>
            <div className="min0">
              <p className="row-title">{h.label}</p>
              <p className="small muted">{fmtDate(h.date)}</p>
            </div>
            <div className="row-side">
              <MoneyText money={cdf(h.amount)} />
              <StatusBadge tone={h.status === 'DEFINITIVE' ? 'good' : 'warning'} label={h.status === 'DEFINITIVE' ? 'Définitive — rapprochée' : 'Provisoire — rapprochement en cours'} />
              <Link className="btn btn-ghost btn-sm" to={`/verifier/${h.code}`}>Vérifier</Link>
            </div>
          </li>
        ))}
      </ul>
      <p className="small muted">Historique utilisable, avec votre accord, auprès de partenaires (assurance, épargne, crédit).</p>
    </section>
  );
}

function Tickets() {
  return (
    <section className="panel" aria-labelledby="rk-tk">
      <div className="panel-head"><div><h2 className="panel-title" id="rk-tk">Tickets urbains</h2><p className="panel-sub">Un seul moteur de tickets pour tous les usages payants de la ville</p></div></div>
      <ul className="rk-tickets">
        {TICKETS.map((t) => (
          <li key={t.title} className="rk-ticket">
            <span className="rk-ticket-icon"><Icon name={t.icon} size={24} /></span>
            <div className="min0">
              <p className="row-title">{t.title}</p>
              <p className="small muted">{t.sub}</p>
            </div>
            <StatusBadge tone={t.tone} label={t.state} />
          </li>
        ))}
      </ul>
      <p className="small muted">Aucun ticket n’est vendu avant la publication de l’acte qui fixe son tarif. Les contrôleurs lisent le QR hors connexion ; ils constatent, ils n’encaissent jamais.</p>
    </section>
  );
}

const STEPS = [
  ['Enregistrement gratuit', 'Moto, conducteur, station et coopérative, avec une période de grâce.'],
  ['Paiement numérique', 'USSD, Mobile Money ou paiement groupé par la coopérative.'],
  ['Statut vert immédiat', 'Dès la confirmation signée de l’opérateur de paiement.'],
  ['Contrôle par QR', 'Le gilet et l’autocollant renvoient au statut, sans nom ni adresse.'],
  ['Compte public', 'Chaque paiement est rapproché avec le relevé du compte public.'],
];

export default function RakaPay() {
  const [tab, setTab] = useState<Tab>('pass');
  return (
    <div className="page page-wide">
      <header className="vx-hero rk-hero" style={{ ['--vx' as string]: '#1E9BD7' }}>
        <Link to="/services" className="vx-back small"><Icon name="chevronRight" size={14} className="flip" /> Services de la Ville</Link>
        <div className="vx-hero-row">
          <span className="vx-hero-icon"><Icon name="ticket" size={30} /></span>
          <div className="min0">
            <p className="eyebrow">Billetterie RakaPay · modules 76 · 70 · 71 · 81</p>
            <h1>RakaPay</h1>
            <p className="lead">Tickets urbains et pass des moto-taxis : achetés par téléphone, contrôlés par QR, rapprochés au compte public.</p>
          </div>
        </div>
        <div className="vx-hero-facts">
          <StatusBadge tone="info" label="Acte requis avant tout paiement (J28)" />
          <span className="small muted"><Icon name="users" size={14} /> Usagers des transports, conducteurs de wewa, coopératives</span>
        </div>
      </header>
      <ExampleNotice text="Démonstration : identité, plaque, montants et références sont des exemples, non opposables. Le tarif du pass sera fixé par l’acte." />

      <div className="seg seg-wrap rk-tabs" role="tablist" aria-label="RakaPay">
        {([['pass', 'moto', 'Mon pass wewa'], ['tickets', 'ticket', 'Tickets urbains'], ['history', 'history', 'Historique']] as const).map(([id, icon, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} aria-pressed={tab === id} onClick={() => setTab(id)}>
            <Icon name={icon} size={16} /> {label}
          </button>
        ))}
      </div>

      <div className="vx-layout">
        <div className="stack">
          {tab === 'pass' && (
            <>
              <PassCard />
              <div className="callout callout-strong rk-green">
                <Icon name="shieldCheck" size={20} />
                <p><strong>Un wewa en vert n’a rien à payer et ne peut être sanctionné.</strong> Toute demande d’argent sur la route est irrégulière : signalez-la, le signalement est protégé.</p>
              </div>
              <BuyPass />
            </>
          )}
          {tab === 'tickets' && <Tickets />}
          {tab === 'history' && <History />}
        </div>
        <aside className="stack">
          <section className="panel" aria-labelledby="rk-how">
            <h2 className="panel-title" id="rk-how">Comment ça marche</h2>
            <ol className="rk-steps">
              {STEPS.map(([t, d], i) => <li key={t}><span className="rk-step-n">{i + 1}</span><span><strong>{t}</strong><span className="small muted">{d}</span></span></li>)}
            </ol>
          </section>
          <section className="panel" aria-labelledby="rk-report">
            <h2 className="panel-title" id="rk-report"><Icon name="alert" size={18} /> Signaler un prélèvement irrégulier</h2>
            <p className="small muted">Lieu, heure, description. Vous n’avez pas à donner votre nom.</p>
            <button type="button" className="btn btn-secondary btn-block">Faire un signalement</button>
          </section>
          <section className="panel" aria-labelledby="rk-coop">
            <h2 className="panel-title" id="rk-coop"><Icon name="users" size={18} /> Ma coopérative</h2>
            <dl className="kv kv-dense">
              <div><dt>Coopérative</dt><dd>{PASS.coop}</dd></div>
              <div><dt>Station</dt><dd>{PASS.station}</dd></div>
              <div><dt>Membres en vert</dt><dd>38 / 42 <span className="small muted">[EXEMPLE]</span></dd></div>
            </dl>
          </section>
        </aside>
      </div>
    </div>
  );
}
