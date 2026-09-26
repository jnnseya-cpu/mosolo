import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useApp } from '../context';
import { Icon } from '../components/Icon';
import { MoneyText } from '../components/MoneyText';
import { StatusBadge } from '../components/StatusBadge';
import { MapStatusChip } from '../components/MapStatusChip';
import { QrCode } from '../components/QrCode';
import { EmptyState, ExampleNotice } from '../components/States';
import { DUE_LABEL, LEGAL_LABEL, OBJ_LABEL, cdf, findVertical, type DueStatus, type ObjStatus, type VObligation } from '../verticals/catalogue';
import { LEGAL_TONE } from './Services';
import RakaPay from './RakaPay';

export const DUE_TONE: Record<DueStatus, 'good' | 'warning' | 'serious' | 'info' | 'neutral'> = {
  A_PAYER: 'warning', SOLDEE: 'good', EN_RETARD: 'serious', SANS_ACTE: 'neutral', CONTESTEE: 'info',
};
const OBJ_MAP: Record<ObjStatus, 'green' | 'amber' | 'red' | 'grey'> = { VERIFIE: 'green', DECLARE: 'amber', OBSERVE: 'amber', CONTESTE: 'red' };

function ObligationCard({ o }: { o: VObligation }) {
  const { fmtDate } = useApp();
  const [open, setOpen] = useState(false);
  const payable = o.status === 'A_PAYER' || o.status === 'EN_RETARD';
  const notExecutable = /À VÉRIFIER|ACTE REQUIS/.test(o.basis);
  return (
    <li className="vx-due">
      <div className="vx-due-main">
        <div className="min0">
          <p className="row-title">{o.label}</p>
          <p className="small muted">{o.period}{o.due ? ` · échéance ${fmtDate(o.due)}` : ''}</p>
        </div>
        <div className="vx-due-side">
          {o.amount !== undefined ? <MoneyText money={cdf(o.amount)} /> : <span className="muted small">—</span>}
          <StatusBadge tone={DUE_TONE[o.status]} label={DUE_LABEL[o.status]} />
        </div>
      </div>
      {open && (
        <dl className="kv kv-dense vx-due-detail">
          <div><dt>Règle appliquée</dt><dd>{o.basis}</dd></div>
          {o.commune && <div><dt>Recette comptée pour</dt><dd>{o.commune} <span className="small muted">— commune où se trouve le bien, l’emplacement ou l’activité, pas celle de votre domicile</span></dd></div>}
          <div><dt>Effet</dt><dd>{notExecutable ? 'Aucun montant exigible tant que la règle n’est pas ACTIVE (quatre visas).' : 'Montant exigible à l’échéance ; contestation possible à tout moment.'}</dd></div>
        </dl>
      )}
      <div className="row-actions">
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((v) => !v)}><Icon name="info" size={16} /> Comprendre ce montant</button>
        {payable && !notExecutable && <Link className="btn btn-primary btn-sm" to="/espace">Payer depuis mon compte</Link>}
        {o.status !== 'SANS_ACTE' && <Link className="btn btn-secondary btn-sm" to="/espace">Contester</Link>}
      </div>
    </li>
  );
}

export default function VerticalSpace() {
  const { slug } = useParams();
  const { fmtDate } = useApp();
  const v = findVertical(slug);
  if (!v) return <Navigate to="/services" replace />;
  if (v.slug === 'rakapay') return <RakaPay />;
  return (
    <div className="page page-wide">
      <header className="vx-hero" style={{ ['--vx' as string]: v.accent }}>
        <Link to="/services" className="vx-back small"><Icon name="chevronRight" size={14} className="flip" /> Services de la Ville</Link>
        <div className="vx-hero-row">
          <span className="vx-hero-icon"><Icon name={v.icon} size={30} /></span>
          <div className="min0">
            <p className="eyebrow">{v.short} · modules {v.modules}</p>
            <h1>{v.name}</h1>
            <p className="lead">{v.promise}</p>
          </div>
        </div>
        <div className="vx-hero-facts">
          <StatusBadge tone={LEGAL_TONE[v.legal]} label={LEGAL_LABEL[v.legal]} />
          <span className="small muted"><Icon name="users" size={14} /> {v.audience}</span>
        </div>
      </header>
      <ExampleNotice text="Démonstration : objets, montants et références sont des exemples, non opposables." />

      <div className="vx-layout">
        <div className="stack">
          <section className="panel" aria-labelledby="vx-obj">
            <div className="panel-head"><h2 className="panel-title" id="vx-obj">{v.objectsTitle}</h2><span className="count">{v.objects.length}</span></div>
            {v.objects.length === 0 ? <EmptyState title="Aucun élément enregistré" /> : (
              <ul className="list-rows">
                {v.objects.map((o) => (
                  <li key={o.ref} className="list-row">
                    <div className="min0">
                      <p className="row-title">{o.label}</p>
                      <p className="small muted">{o.detail} · <span className="mono">{o.ref}</span></p>
                    </div>
                    <div className="row-side">
                      <MapStatusChip status={OBJ_MAP[o.status]} />
                      {o.status !== 'VERIFIE' && <span className="tag">{OBJ_LABEL[o.status]}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel" aria-labelledby="vx-due">
            <div className="panel-head"><h2 className="panel-title" id="vx-due">Mes obligations</h2><span className="count">{v.obligations.length}</span></div>
            {v.obligations.length === 0 ? <EmptyState title="Aucune obligation" /> : (
              <ul className="vx-dues">{v.obligations.map((o, i) => <ObligationCard key={i} o={o} />)}</ul>
            )}
          </section>

          <section className="panel" aria-labelledby="vx-rc">
            <div className="panel-head"><h2 className="panel-title" id="vx-rc">Mes quittances</h2><span className="count">{v.receipts.length}</span></div>
            {v.receipts.length === 0 ? <EmptyState title="Aucune quittance pour ce service" /> : (
              <ul className="list-rows">
                {v.receipts.map((r) => (
                  <li key={r.code} className="list-row receipt-row">
                    <figure className="receipt-qr">
                      <QrCode value={`${window.location.origin}/verifier/${r.code}`} size={88} alt={`Code QR de vérification de la quittance ${r.code}`} />
                      <figcaption className="mono small">{r.code}</figcaption>
                    </figure>
                    <div className="min0">
                      <p className="row-title">{r.label}</p>
                      <p className="small muted">{fmtDate(r.date)}</p>
                    </div>
                    <div className="row-side">
                      <MoneyText money={cdf(r.amount)} />
                      <StatusBadge tone="good" label="Définitive — rapprochée" />
                      <Link className="btn btn-ghost btn-sm" to={`/verifier/${r.code}`}>Vérifier</Link>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="stack">
          <section className="panel" aria-labelledby="vx-svc">
            <h2 className="panel-title" id="vx-svc">Démarches en ligne</h2>
            <ul className="vx-services">
              {v.services.map((s) => (
                <li key={s.label}>
                  <button type="button" className="list-button">
                    <span><strong>{s.label}</strong><span className="small muted">{s.hint}</span></span>
                    <Icon name="chevronRight" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <div className="callout callout-info"><Icon name="scale" size={18} /><p><strong>Point de vigilance.</strong> {v.vigilance}</p></div>
          <section className="panel" aria-labelledby="vx-rights">
            <h2 className="panel-title" id="vx-rights"><Icon name="shieldCheck" size={18} /> Vos droits</h2>
            <ul className="vx-rights">{v.rights.map((r) => <li key={r}><Icon name="check" size={16} /> {r}</li>)}</ul>
          </section>
        </aside>
      </div>
    </div>
  );
}
