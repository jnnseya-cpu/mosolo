/**
 * Remise d'un avis formel sur le terrain (Document maître FR 2, nouvelle version, § 15.2) : l'agent de constat habilité
 * recueille une signature (conservée par son empreinte SHA-256) ou enregistre un refus, avec sa position et l'heure du
 * serveur. Aucun paiement n'est reçu ; la valeur probante de la remise reste à vérifier (point juridique).
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { api } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import { Msg, useAction } from './actions';

export interface FieldDeliveryView {
  by: string; at: string; outcome: 'SIGNE' | 'REFUS'; signatureSha256?: string; refusalNote?: string; witness?: string;
  position: { lat: number; lon: number; accuracyM?: number }; legalStatus: string;
}

export const DELIVERABLE_KINDS = ['AVIS_FORMEL', 'MISE_EN_DEMEURE'];

export function FieldDeliverySummary({ d }: { d: FieldDeliveryView }) {
  const { fmtDate } = useApp();
  return (
    <p className="small">
      Remise en personne le {fmtDate(d.at, true)} par {d.by} : {d.outcome === 'SIGNE' ? <>signature recueillie (empreinte <span className="mono">{d.signatureSha256?.slice(0, 12)}…</span>)</> : <>refus enregistré — {d.refusalNote}</>}
      {d.witness ? ` · témoin : ${d.witness}` : ''} · position {d.position.lat.toFixed(5)}, {d.position.lon.toFixed(5)} · valeur probante à vérifier
    </p>
  );
}

export function RemiseTerrainForm({ noticeId, onDone }: { noticeId: string; onDone: () => void }) {
  const [outcome, setOutcome] = useState<'SIGNE' | 'REFUS'>('SIGNE');
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [witness, setWitness] = useState('');
  const { busy, msg, run } = useAction(onDone);
  const submit = () => void run(async () => {
    const position = await new Promise<{ lat: number; lon: number; accuracyM?: number }>((resolve, reject) => {
      if (!navigator.geolocation) { reject(new Error('Position indisponible : la remise exige la position de l’agent.')); return; }
      navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }), () => reject(new Error('Position refusée : la remise exige la position de l’agent.')), { enableHighAccuracy: true, timeout: 15_000 });
    });
    const signatureSha256 = outcome === 'SIGNE' && file ? await sha256Hex(await file.arrayBuffer()) : undefined;
    return api(`/v1/recouvrement/avis/${encodeURIComponent(noticeId)}/remise`, { method: 'POST', body: { outcome, position, ...(signatureSha256 ? { signatureSha256 } : {}), ...(outcome === 'REFUS' ? { refusalNote: note } : {}), ...(witness.trim() ? { witness: witness.trim() } : {}) } });
  }, outcome === 'SIGNE' ? 'Remise signée enregistrée.' : 'Refus de signer enregistré.');
  return (
    <section className="panel" aria-label="Remise sur le terrain">
      <p className="panel-title">Remise en personne (agent de constat)</p>
      <div className="seg" role="group" aria-label="Issue de la remise">
        <button type="button" aria-pressed={outcome === 'SIGNE'} onClick={() => setOutcome('SIGNE')}>Signature recueillie</button>
        <button type="button" aria-pressed={outcome === 'REFUS'} onClick={() => setOutcome('REFUS')}>Refus de signer</button>
      </div>
      {outcome === 'SIGNE' ? (
        <div className="field"><label className="label" htmlFor={`sig-${noticeId}`}>Signature (photo ou fichier) — seule l’empreinte est transmise</label>
          <input id={`sig-${noticeId}`} type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
      ) : (
        <div className="field"><label className="label" htmlFor={`rf-${noticeId}`}>Circonstances du refus</label>
          <textarea id={`rf-${noticeId}`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} minLength={5} maxLength={1000} /></div>
      )}
      <div className="field"><label className="label" htmlFor={`wt-${noticeId}`}>Témoin (facultatif)</label>
        <input id={`wt-${noticeId}`} value={witness} onChange={(e) => setWitness(e.target.value)} maxLength={200} /></div>
      <p className="small muted">Aucun paiement n’est reçu : le destinataire paie lui-même par un canal numérique.</p>
      <button type="button" className="btn btn-primary btn-sm" disabled={busy || (outcome === 'SIGNE' ? !file : note.trim().length < 5)} onClick={submit}>Enregistrer la remise</button>
      <Msg msg={msg} />
    </section>
  );
}
