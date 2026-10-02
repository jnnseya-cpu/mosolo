/**
 * Enquête de satisfaction (§ 39) : facultative, après paiement ou après visite, anonyme et agrégée (jamais nominative).
 */
import { useState } from 'react';
import { PageHead } from '../../components/Shell';
import { Choice, Field, Notice, useRunner } from './planif';
import './pilotage.css';
import { ProgressMeter } from '../../components/viz';

export default function Satisfaction() {
  const r = useRunner(() => undefined);
  const [moment, setMoment] = useState('APRES_PAIEMENT');
  const [note, setNote] = useState(0);
  const [receipt, setReceipt] = useState('');
  return (
    <div className="page">
      <PageHead eyebrow="Service · § 39" title="Votre avis" lead="Réponse facultative et anonyme : elle sert seulement à améliorer le service. Aucune conséquence sur votre dossier." />
      <div className="form">
        <Choice label="Moment" value={moment} onChange={setMoment} options={[['APRES_PAIEMENT', 'Après un paiement'], ['APRES_VISITE', 'Après une visite']]} />
        <div className="field" role="group" aria-label="Note de 1 à 5">
          <span className="label">Note (1 = pas satisfait, 5 = très satisfait)</span>
          <div className="btn-row">{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" className={`btn btn-sm ${note === n ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={note === n} onClick={() => setNote(n)}>{n}</button>)}</div>
        </div>
        {note > 0 && <ProgressMeter label="Votre note" unit="/ 5" max={5} value={note} tone={note >= 4 ? 'good' : note === 3 ? 'warning' : 'serious'} toneLabel={['', 'Pas satisfait', 'Peu satisfait', 'Moyennement satisfait', 'Satisfait', 'Très satisfait'][note]} />}
        <p className="small muted">Les moyennes agrégées (jamais nominatives, masquées sous 5 réponses) sont suivies par les autorités dans « Accords de service entre entités ».</p>
        <Field label="Numéro de quittance (facultatif, évite les doublons)" value={receipt} onChange={setReceipt} />
        <Notice msg={r.msg} />
        <div className="btn-row"><button type="button" className="btn btn-primary" disabled={r.busy || note === 0} onClick={() => void r.run('/v1/satisfaction', { moment, note, channel: 'WEB', ...(receipt ? { receiptNumber: receipt } : {}) }, 'Merci pour votre avis.')}>Envoyer</button></div>
      </div>
    </div>
  );
}
