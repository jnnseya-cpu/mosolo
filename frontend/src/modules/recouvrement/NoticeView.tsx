/**
 * Aperçu imprimable d'un avis légal numéroté (avis d'imposition, rappel, notification formelle, mise en demeure,
 * décision, échéancier) : mentions obligatoires, empreinte du contenu, preuve de notification, accusé de lecture.
 * L'ouverture par le contribuable destinataire enregistre l'accusé de lecture (horodaté côté serveur).
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { MoneyText } from '../../components/MoneyText';
import { ErrorState, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { api } from '../../lib/api';
import type { Notice, NoticeProof } from './types';
import './recouvrement.css';

const CHANNEL_LABEL: Record<string, string> = { 'in-app': 'Application', sms: 'SMS', email: 'Courriel', ussd: 'USSD', whatsapp: 'WhatsApp', svi: 'Serveur vocal', push: 'Notification', courrier: 'Courrier' };

export default function NoticeView() {
  const { id = '' } = useParams();
  const { user, fmtDate } = useApp();
  const q = useApi(() => api<Notice>(`/v1/recouvrement/avis/${encodeURIComponent(id)}`), [id, user?.id]);
  const proof = useApi(() => api<NoticeProof>(`/v1/recouvrement/avis/${encodeURIComponent(id)}/preuve`), [id, user?.id]);
  const [ack, setAck] = useState<string | null>(null);
  const n = q.data;
  const isRecipient = !!n && !!user && (user.taxpayerId === n.taxpayerId || user.roles.includes('R31'));

  useEffect(() => {
    if (!n || !isRecipient || n.readAt) return;
    api<Notice>(`/v1/recouvrement/avis/${encodeURIComponent(n.id)}/lecture`, { method: 'POST' })
      .then((r) => { setAck(r.readAt ?? null); proof.reload(); })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justifié : dépendances volontairement restreintes aux valeurs listées (sinon boucle de rendu ou rechargement à chaque rendu)
  }, [n?.id, isRecipient]);

  if (!n && q.loading) return <div className="page"><Loading /></div>;
  if (!n) return <div className="page"><ErrorState error={q.error} onRetry={q.reload} /></div>;
  const c = n.content;
  const readAt = n.readAt ?? ack;
  return (
    <div className="page rc-print-page">
      <div className="rc-print-tools">
        <Link to={isRecipient ? '/mes-arrieres' : '/recouvrement'} className="btn btn-ghost btn-sm"><Icon name="chevronRight" size={14} className="rc-flip" /> Retour</Link>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => window.print()}><Icon name="download" size={14} /> Imprimer</button>
      </div>
      <article className="rc-print" aria-label={`${c.title} ${c.number}`}>
        {c.demo && <p className="rc-demo-band">DÉMONSTRATION — règle fictive, document sans valeur juridique</p>}
        <header className="rc-doc-head">
          <div>
            <p className="rc-doc-issuer">Ville-Province de Kinshasa</p>
            <p className="small">{c.issuingAuthority} · {c.administeringEntity}</p>
          </div>
          <div className="rc-doc-ref">
            <p className="mono rc-doc-number">{c.number}</p>
            <p className="small">Émis le {fmtDate(c.issuedOn)}</p>
          </div>
        </header>
        <h1 className="rc-doc-title">{c.title}</h1>
        <section className="rc-doc-grid">
          <div><p className="caps-sm">Destinataire</p><p>{c.taxpayer.name}</p><p className="small mono">{c.taxpayer.iuc}</p></div>
          <div><p className="caps-sm">Obligation</p><p>{c.obligation.label}</p><p className="small mono">{c.obligation.id} · règle {c.obligation.ruleCode} v{c.obligation.ruleVersion}</p></div>
        </section>
        <section className="rc-doc-amount">
          <div><p className="caps-sm">Montant</p><MoneyText money={c.amount} /></div>
          <div><p className="caps-sm">{c.kind === 'MISE_EN_DEMEURE' ? 'À régler au plus tard le' : 'Échéance'}</p><p className="rc-doc-strong">{fmtDate(c.dueDate)}</p></div>
        </section>
        <section>
          {c.body.map((p) => <p key={p} className="rc-doc-p">{p}</p>)}
        </section>
        {c.installments && (
          <table className="data-table rc-doc-table">
            <caption className="sr-only">Échéances</caption>
            <thead><tr><th scope="col">N°</th><th scope="col">Date</th><th scope="col" className="num">Montant</th></tr></thead>
            <tbody>{c.installments.map((i) => <tr key={i.seq}><td>{i.seq}</td><td>{fmtDate(i.dueDate)}</td><td className="num"><MoneyText money={i.amount} showIndicative={false} /></td></tr>)}</tbody>
          </table>
        )}
        {c.decision && (
          <section className="rc-doc-box">
            <p className="caps-sm">Décision motivée</p>
            <p>{c.decision.motivation}</p>
            {c.decision.legalBasis && <p className="small">Fondement : {c.decision.legalBasis.title} — {c.decision.legalBasis.article}</p>}
            <p className="small muted">Décidée par {c.decision.by} le {fmtDate(c.decision.at, true)}</p>
          </section>
        )}
        <section className="rc-doc-box">
          <p className="caps-sm">Base légale</p>
          <ul className="plain-list">{c.legalBasis.map((l) => <li key={l.id}>{l.title} <span className="small muted">({l.status})</span></li>)}</ul>
          {!!c.articles.length && <p className="small">Articles : {c.articles.join(' · ')}</p>}
        </section>
        <section className="rc-doc-box rc-doc-remedy">
          <p className="caps-sm">Voie et délai de recours</p>
          <p>{c.remedy.path}</p>
          <p className="small">Délai : {c.remedy.delayDays} jours, soit jusqu’au {fmtDate(c.remedy.deadline)} [délai À VÉRIFIER — Édit n° 005/2021].</p>
        </section>
        <section className="rc-doc-box">
          <p className="caps-sm">Paiement</p>
          <p className="small">Compte public bénéficiaire : <span className="mono">{c.payment.beneficiaryAccountAlias}</span>{c.payment.paymentReference ? <> · référence <span className="mono">{c.payment.paymentReference}</span></> : null}</p>
          <p className="small">{c.payment.instructions}</p>
        </section>
        <ul className="plain-list small muted rc-doc-mentions">{c.mentions.map((m) => <li key={m}>{m}</li>)}</ul>
        <footer className="rc-doc-foot">
          <p className="small">Empreinte SHA-256 du contenu : <span className="mono rc-hash">{n.contentHash}</span></p>
          <p className="small">Notification : {n.notification === 'NOTIFIE' ? 'délivrée' : 'non délivrée'}{readAt ? ` · lu le ${fmtDate(readAt, true)}` : ' · non lu'}</p>
        </footer>
      </article>
      {proof.data && (
        <section className="panel rc-proof">
          <div className="panel-head"><p className="panel-title"><Icon name="shieldCheck" size={16} /> Preuve de notification</p></div>
          <ul className="list-rows compact-rows">
            {proof.data.deliveries.map((d) => (
              <li key={d.id} className="list-row"><span>{CHANNEL_LABEL[d.channel] ?? d.channel} · {d.recipientMasked}</span><span className="row-side small muted">{d.status} · {d.providerMode} · {fmtDate(d.at, true)}</span></li>
            ))}
          </ul>
          <p className="small muted">Accusé de lecture : {proof.data.readAcknowledgement ? `${fmtDate(proof.data.readAcknowledgement.at, true)} (${proof.data.readAcknowledgement.by})` : 'aucun à ce jour'}</p>
        </section>
      )}
    </div>
  );
}
