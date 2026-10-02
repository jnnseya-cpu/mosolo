/**
 * Contestation sans écrit au guichet (§ 13A.6) : l'agent (R12) retrouve la personne, lit le résumé à voix haute,
 * recueille le consentement oral (enregistrement : empreinte SHA-256) ou devant témoin, puis enregistre la
 * réclamation au nom de la personne. Même circuit : instruction (R20), décision (R21). Aucun paiement demandé.
 */
import { useState, type FormEvent } from 'react';
import { formatMoney, type MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { api, describeError } from '../../lib/api';
import { sha256Hex } from '../../lib/crypto';
import { SituationContribuable } from './visuels';

interface Obl { id: string; label: string; amount: MoneyJSON | null; status: string; dueDate: string }
const TYPES: [string, string][] = [
  ['MONTANT_ERRONE', 'Montant erroné'], ['BIEN_NON_DETENU', 'Bien non détenu'], ['DOUBLE_IMPOSITION', 'Déjà payé / double imposition'],
  ['ACTIVITE_FERMEE', 'Activité fermée'], ['VEHICULE_VENDU', 'Véhicule vendu'], ['INFORMATION_ERRONEE', 'Information erronée'], ['AUTRE', 'Autre motif'],
];
const PAYABLE = ['EMISE', 'EXIGIBLE', 'EN_RETARD', 'PARTIELLEMENT_PAYEE'];

export default function ContestationAssistee() {
  const [taxpayerId, setTaxpayerId] = useState('');
  const [obls, setObls] = useState<Obl[] | null>(null);
  const [all, setAll] = useState<Obl[] | null>(null);
  const [f, setF] = useState({ obligationId: '', type: 'MONTANT_ERRONE', grounds: '', method: 'ORAL_ENREGISTRE', witnessName: '', readBack: false, suspensive: false });
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ id: string; acknowledgement?: { number: string } } | null>(null);
  async function find(e: FormEvent) {
    e.preventDefault(); setErr(null); setObls(null); setAll(null);
    try { const r = await api<{ obligations: Obl[] }>(`/v1/taxpayers/${encodeURIComponent(taxpayerId.trim())}`); setAll(r.obligations); setObls(r.obligations.filter((o) => PAYABLE.includes(o.status))); } catch (x) { setErr(describeError(x).message); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try {
      const evidenceSha256 = f.method === 'ORAL_ENREGISTRE' && file ? await sha256Hex(await file.arrayBuffer()) : undefined;
      const consent = { method: f.method, summaryReadBack: f.readBack, ...(evidenceSha256 ? { evidenceSha256 } : {}), ...(f.method === 'TEMOIN' && f.witnessName ? { witnessName: f.witnessName } : {}) };
      setDone(await api('/v1/canaux/contestations-assistees', { method: 'POST', body: { obligationId: f.obligationId, type: f.type, grounds: f.grounds, consent, ...(f.suspensive ? { requestSuspensiveEffect: true } : {}) } }));
    } catch (x) { setErr(describeError(x).message); }
  }
  const selected = obls?.find((o) => o.id === f.obligationId);
  const summary = selected ? `Vous contestez « ${selected.label} » (${f.obligationId}) — motif : ${TYPES.find(([k]) => k === f.type)?.[1]}. ${f.grounds}` : '';
  return (
    <div className="page">
      <PageHead eyebrow="Guichet MOSOLO" title="Contestation sans écrit"
        lead="La personne conteste oralement : vous lisez le résumé, recueillez son consentement (enregistrement ou témoin) et enregistrez la réclamation à son nom. Aucun frais, aucun paiement." />
      {done ? (
        <p className="notice" role="status">Réclamation <span className="mono">{done.id}</span> enregistrée{done.acknowledgement ? ` — accusé ${done.acknowledgement.number}` : ''}. Remettez ou lisez l’accusé à la personne.</p>
      ) : (
        <div className="stack">
          <form className="panel stack-sm" onSubmit={(e) => void find(e)}>
            <div className="field"><label className="label" htmlFor="ca-tp">Identifiant du contribuable</label><input id="ca-tp" required value={taxpayerId} onChange={(e) => setTaxpayerId(e.target.value)} /></div>
            <button type="submit" className="btn btn-secondary btn-sm">Rechercher ses obligations</button>
          </form>
          {all && <SituationContribuable obligations={all} />}
          {obls && (
            <form className="panel stack-sm" onSubmit={(e) => void submit(e)}>
              <div className="field"><label className="label" htmlFor="ca-ob">Obligation contestée</label>
                <select id="ca-ob" required value={f.obligationId} onChange={(e) => setF({ ...f, obligationId: e.target.value })}><option value="">—</option>{obls.map((o) => <option key={o.id} value={o.id}>{o.label} — {o.amount ? formatMoney(o.amount) : 'montant masqué'} — échéance {o.dueDate}</option>)}</select></div>
              <div className="field"><label className="label" htmlFor="ca-ty">Motif</label><select id="ca-ty" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
              <div className="field"><label className="label" htmlFor="ca-gr">Ce que dit la personne (transcription fidèle)</label><textarea id="ca-gr" rows={3} required minLength={5} value={f.grounds} onChange={(e) => setF({ ...f, grounds: e.target.value })} /></div>
              {summary && <p className="notice small" role="note">Résumé à lire : {summary}</p>}
              <label className="small"><input type="checkbox" checked={f.readBack} onChange={(e) => setF({ ...f, readBack: e.target.checked })} /> J’ai lu le résumé à la personne, qui le confirme.</label>
              <div className="field"><label className="label" htmlFor="ca-me">Consentement</label><select id="ca-me" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="ORAL_ENREGISTRE">Oral, enregistré</option><option value="TEMOIN">Devant témoin</option></select></div>
              {f.method === 'ORAL_ENREGISTRE'
                ? <div key="fichier" className="field"><label className="label" htmlFor="ca-fi">Enregistrement du consentement (seule son empreinte est transmise)</label><input id="ca-fi" type="file" accept="audio/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
                : <div key="temoin" className="field"><label className="label" htmlFor="ca-wi">Nom du témoin</label><input id="ca-wi" value={f.witnessName} onChange={(e) => setF({ ...f, witnessName: e.target.value })} /></div>}
              <label className="small"><input type="checkbox" checked={f.suspensive} onChange={(e) => setF({ ...f, suspensive: e.target.checked })} /> La personne demande l’effet suspensif (décidé par l’autorité, jamais d’office).</label>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!f.readBack || !f.obligationId}>Enregistrer la contestation</button>
            </form>
          )}
          {err && <p className="notice notice-err" role="alert">{err}</p>}
        </div>
      )}
    </div>
  );
}
