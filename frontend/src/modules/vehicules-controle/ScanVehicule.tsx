/**
 * Scan unique au contrôle (chapitre 18) : plaque, QR de la vignette fiscale ou QR de la vignette technique ⇒ une vue
 * hiérarchique. Affichage seulement, jamais de sanction ; la décision de l'agent est enregistrée (identité, position,
 * horodatage). La vignette fiscale et la vignette technique sont deux lignes distinctes. Mode courtoisie affiché.
 * Hors ligne : paquet minimal chargé en début de mission, avec sa fraîcheur.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { QrScanner } from '../../components/QrScanner';
import { api, describeError } from '../../lib/api';
import { ageText, StateBadge } from './common';

interface Line { state: string; label: string; number?: string | null; receipt?: string | null }
export interface ScanView {
  scanId: string; method: string; plate: string;
  identification: { plate: string; categoryLabel: string; ownerRef: string | null; accountLink: string };
  vignetteFiscale: Line; taxeCirculation: Line; autorisationTransport: Line;
  controleTechnique: { state: string; label: string; lastDate: string | null; centre: string | null; result: string | null; echeance: string | null; stickerNumber: string | null };
  fourriere: { passages: number; sortiesRegulieres: number; enCours: number; fraisImpayes: number };
  quitus: { state: string; label: string; reasons?: string[] };
  courtesy: { id: string; until: string; decisionRef: string; notice: string } | null;
  notice: string; serverTime: string;
}
interface Pack { generatedAt: string; entries: unknown[]; officialDomain: string }

export function ScanResult({ v }: { v: ScanView }) {
  return (
    <div>
      {v.courtesy && <p className="vc-banner" role="status"><strong>Mode courtoisie</strong> jusqu’au {v.courtesy.until} ({v.courtesy.decisionRef}) — {v.courtesy.notice}</p>}
      <div className="vc-lines">
        <section className="vc-line" aria-label="Identification">
          <h3>1. Identification</h3>
          <p><strong>{v.identification.plate}</strong> · {v.identification.categoryLabel}</p>
          <p className="small muted">Propriétaire de référence : {v.identification.ownerRef ?? '—'} · {v.identification.accountLink === 'COMPTE_RATTACHE' ? 'compte rattaché' : 'compte non rattaché'}</p>
        </section>
        <section className="vc-line" aria-label="Vignette fiscale">
          <h3>2. Vignette fiscale</h3>
          <StateBadge state={v.vignetteFiscale.state} />
          <p className="small">{v.vignetteFiscale.label}{v.vignetteFiscale.receipt ? ` · quittance ${v.vignetteFiscale.receipt}` : ''}</p>
        </section>
        <section className="vc-line" aria-label="Taxe de circulation">
          <h3>3. Taxe spéciale de circulation</h3>
          <StateBadge state={v.taxeCirculation.state} />
          <p className="small">{v.taxeCirculation.label}</p>
        </section>
        <section className="vc-line" aria-label="Contrôle technique">
          <h3>4. Contrôle technique (vignette technique)</h3>
          <StateBadge state={v.controleTechnique.state} />
          <p className="small">{v.controleTechnique.label}</p>
          <p className="small muted">Dernier contrôle : {v.controleTechnique.lastDate?.slice(0, 10) ?? '—'} · {v.controleTechnique.centre ?? '—'} · échéance {v.controleTechnique.echeance ?? '—'}{v.controleTechnique.stickerNumber ? ` · vignette ${v.controleTechnique.stickerNumber}` : ''}</p>
        </section>
        <section className="vc-line" aria-label="Autorisation de transport">
          <h3>5. Autorisation de transport</h3>
          <StateBadge state={v.autorisationTransport.state} />
          <p className="small">{v.autorisationTransport.label}</p>
        </section>
        <section className="vc-line" aria-label="Fourrière">
          <h3>6. Historique de fourrière</h3>
          <p className="small">{v.fourriere.passages} passage(s) · {v.fourriere.sortiesRegulieres} sortie(s) régulière(s) · {v.fourriere.enCours} en cours · {v.fourriere.fraisImpayes} frais impayé(s)</p>
        </section>
        <section className="vc-line" aria-label="Quitus provincial">
          <h3>7. Quitus provincial</h3>
          <StateBadge state={v.quitus.state} />
          <p className="small">{v.quitus.label}{v.quitus.reasons?.length ? ` (${v.quitus.reasons.join(', ')})` : ''}</p>
        </section>
      </div>
      <p className="small muted">{v.notice}</p>
    </div>
  );
}

export default function ScanVehicule() {
  const { user } = useApp();
  const [saisie, setSaisie] = useState('');
  const [commune, setCommune] = useState('');
  const [scan, setScan] = useState(false);
  const [view, setView] = useState<ScanView | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [decision, setDecision] = useState('AUCUNE_SUITE');
  const [motif, setMotif] = useState('');
  const [pack, setPack] = useState<Pack | null>(null);

  async function run(value = saisie) {
    setMsg(null);
    try {
      setView(await api<ScanView>('/v1/vehicules/scan', { method: 'POST', body: { saisie: value, place: commune ? { commune } : {} } }));
    } catch (e) { const d = describeError(e); setMsg({ ok: false, text: `${d.message}${d.code ? ` (${d.code})` : ''}` }); }
  }
  async function decide() {
    if (!view) return;
    try {
      await api(`/v1/vehicules/scans/${view.scanId}/decision`, { method: 'POST', body: { decision, motif, position: commune ? { commune } : {} } });
      setMsg({ ok: true, text: 'Décision enregistrée (identité, position, horodatage).' });
    } catch (e) { const d = describeError(e); setMsg({ ok: false, text: `${d.message}${d.code ? ` (${d.code})` : ''}` }); }
  }
  async function loadPack() {
    try { setPack(await api<Pack>('/v1/vehicules/hors-ligne/paquet')); } catch (e) { setMsg({ ok: false, text: describeError(e).message }); }
  }

  return (
    <div className="page page-wide">
      <PageHead eyebrow="Chaîne véhicule · module 82" title="Scan unique du véhicule" lead="Plaque, QR de la vignette fiscale ou QR de la vignette technique : une seule vue. Affichage seulement — aucune sanction n’est prise par la plateforme." />
      {!user ? <p className="notice">Connectez-vous avec un compte de contrôleur.</p> : (
        <>
          <div className="vc-row">
            <label className="vc-form" style={{ flex: 1 }}><span>Plaque ou contenu du QR</span><input value={saisie} onChange={(e) => setSaisie(e.target.value)} placeholder="KN-0000-AB ou QR" /></label>
            <label className="vc-form"><span>Commune du contrôle</span><input value={commune} onChange={(e) => setCommune(e.target.value)} placeholder="Gombe" /></label>
            <button type="button" className="btn btn-primary" onClick={() => void run()} disabled={!saisie.trim()}>Vérifier</button>
            <button type="button" className="btn btn-secondary" onClick={() => setScan(true)}>Scanner un QR</button>
          </div>
          {scan && <QrScanner onResult={(raw) => { setScan(false); setSaisie(raw); void run(raw); }} onClose={() => setScan(false)} />}
          <p className="small">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => void loadPack()}>Charger le statut hors ligne</button>{' '}
            {pack ? <span role="status">Statut hors ligne chargé {ageText(pack.generatedAt)} ({pack.entries.length} véhicules) — domaine officiel : {pack.officialDomain}</span> : <span className="muted">Aucun statut hors ligne chargé.</span>}
          </p>
          {msg && <p className={msg.ok ? 'notice notice-ok' : 'notice notice-err'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
          {view && (
            <>
              <ScanResult v={view} />
              <div className="vc-form">
                <label><span>Décision de l’agent</span>
                  <select value={decision} onChange={(e) => setDecision(e.target.value)}>
                    <option value="AUCUNE_SUITE">Aucune suite</option>
                    <option value="INFORMATION_USAGER">Information de l’usager</option>
                    <option value="CONSTAT_A_INSTRUIRE" disabled={!!view.courtesy}>Constat à instruire (aucun montant){view.courtesy ? ' — suspendu (courtoisie)' : ''}</option>
                  </select>
                </label>
                <label><span>Motif</span><input value={motif} onChange={(e) => setMotif(e.target.value)} /></label>
                <button type="button" className="btn btn-primary btn-sm" disabled={motif.trim().length < 3} onClick={() => void decide()}>Enregistrer la décision</button>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
