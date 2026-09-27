/**
 * Module 12 — Autorisations de transport : registre des licences (taxi, bus, minibus, moto-taxi, poids lourd) avec
 * validité géographique et horaire, carte conducteur rattachée (QR signé), contrôle par plaque ou QR (couleur et temps
 * restant à l'heure du serveur), autorisation sans règle publiée impossible (non opposable), suspension uniquement par
 * décision motivée à deux personnes, rappels et renouvellement. Taxe journalière : billetterie (module 76), acte requis.
 */
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { QrCode } from '../../components/QrCode';
import { ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { ActionMotivee, BlocIndicateurs, Tableau } from './common';
import './citoyen.css';
import { TransportVisuels } from './visuels';

interface Autorisation { id: string; certificatCode: string; categorieLibelle: string; plaque: string; zones: string[]; corridor?: string; horaires: { debut: string; fin: string }; statut: string; opposable: boolean; mention: string | null; validite: { text: string }; cartes: { numero: string; statut: string }[]; suspension?: { proposee: { par: string; motif: string; action: string }; approuvee?: unknown }; taxeJournaliere: string }
interface Controle { couleur: string; resultat: string; heureKinshasa: string; vignette: { texte: string }; notice: string }
const TONE: Record<string, 'good' | 'warning' | 'critical' | 'neutral'> = { VERT: 'good', AMBRE: 'warning', ROUGE: 'critical', GRIS: 'neutral' };

export default function Transport() {
  const { user } = useApp();
  const citoyen = !!user && user.roles.some((r) => r === 'R30' || r === 'R31');
  const gestion = !!user && user.roles.some((r) => ['R06', 'R07', 'R11'].includes(r));
  const list = useApi(user ? () => api<Autorisation[]>('/v1/citoyen/transport/autorisations') : null, [user?.id]);
  const kpi = useApi(gestion ? () => api<Record<string, unknown>>('/v1/citoyen/transport/indicateurs') : null, [user?.id]);
  const [msg, setMsg] = useState<string | null>(null);
  const [ctl, setCtl] = useState<Controle | null>(null);
  const [c, setC] = useState({ plaque: '', qr: '', commune: '' });
  const [n, setN] = useState({ certificatCode: '', categorie: 'TAXI', plaque: '', zones: '', corridor: '', debut: '05:00', fin: '22:00' });
  const [carte, setCarte] = useState<{ numero: string; qr: string } | null>(null);
  const act = (p: Promise<unknown>) => p.then(() => list.reload(), (x: unknown) => setMsg(describeError(x).message));
  async function controler(e: FormEvent) {
    e.preventDefault(); setMsg(null); setCtl(null);
    try { setCtl(await api<Controle>('/v1/citoyen/transport/controles', { method: 'POST', body: { commune: c.commune, ...(c.plaque ? { plaque: c.plaque } : {}), ...(c.qr ? { qr: c.qr } : {}) } })); } catch (x) { setMsg(describeError(x).message); }
  }
  async function enregistrer(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    try {
      await api('/v1/citoyen/transport/autorisations', { method: 'POST', body: { certificatCode: n.certificatCode, categorie: n.categorie, plaque: n.plaque, zones: n.zones.split(',').map((z) => z.trim()).filter(Boolean), ...(n.corridor ? { corridor: n.corridor } : {}), horaires: { debut: n.debut, fin: n.fin } } });
      list.reload();
    } catch (x) { setMsg(describeError(x).message); }
  }
  return (
    <div className="stack">
      <PageHead eyebrow="Module 12" title="Autorisations de transport" lead="Licences, zones et horaires, carte conducteur, contrôle par plaque ou QR. Aucune autorisation sans règle publiée ; suspension uniquement par décision motivée." />
      <p className="small"><Link to="/services/mobilite">Demander une autorisation (décision motivée)</Link> · <Link to="/fiscal/dependances">Condition « vignette valide »</Link> · <Link to="/titres/catalogue">Titre journalier via la billetterie (acte requis)</Link></p>
      {msg && <p className="notice notice-err small" role="alert">{msg}</p>}
      {gestion && <BlocIndicateurs titre="Indicateurs du module 12" indicateurs={kpi.data} />}
      {!citoyen && user && (
        <form className="panel stack-sm" onSubmit={(e) => void controler(e)} aria-label="Contrôle">
          <p className="panel-title">Contrôler un véhicule</p>
          <div className="cit-inline">
            <input aria-label="Plaque" placeholder="Plaque" value={c.plaque} onChange={(e) => setC({ ...c, plaque: e.target.value })} />
            <input aria-label="QR de carte conducteur" placeholder="ou QR de la carte conducteur" value={c.qr} onChange={(e) => setC({ ...c, qr: e.target.value })} />
            <input aria-label="Commune du contrôle" placeholder="Commune" value={c.commune} onChange={(e) => setC({ ...c, commune: e.target.value })} />
            <button type="submit" className="btn btn-primary btn-sm">Contrôler</button>
          </div>
          {ctl && <div role="status" className="stack-sm"><StatusBadge tone={TONE[ctl.couleur] ?? 'neutral'} label={`${ctl.couleur} — ${ctl.resultat}`} /><p className="small">Heure de Kinshasa (serveur) : {ctl.heureKinshasa} · {ctl.vignette.texte}</p><p className="small muted">{ctl.notice}</p></div>}
        </form>
      )}
      {list.loading ? <Loading /> : list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : (
        <section className="panel stack-sm" aria-label="Autorisations">
          <p className="panel-title">{citoyen ? 'Mes autorisations' : 'Registre des autorisations'}</p>
          <TransportVisuels autorisations={list.data ?? []} />
          <Tableau entetes={['Certificat', 'Catégorie', 'Plaque', 'Zones / corridor', 'Horaires', 'Statut', 'Validité', 'Actions']} vide="Aucune autorisation enregistrée."
            lignes={(list.data ?? []).map((a) => [a.certificatCode, a.categorieLibelle, a.plaque, `${a.zones.join(', ') || 'toutes'}${a.corridor ? ` — ${a.corridor}` : ''}`, `${a.horaires.debut}–${a.horaires.fin}`,
              <span key="s"><StatusBadge tone={a.statut === 'ACTIVE' ? 'good' : a.statut === 'SUSPENDUE' ? 'critical' : 'neutral'} label={a.statut} />{a.mention && <span className="small muted"> {a.mention}</span>}</span>,
              a.validite.text,
              <span key="a" className="cit-inline">
                {citoyen && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void act(api(`/v1/citoyen/transport/autorisations/${a.id}/renouvellement`, { method: 'POST' }))}>Renouveler</button>}
                {gestion && a.statut === 'EN_ATTENTE_REGLE' && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void act(api(`/v1/citoyen/transport/autorisations/${a.id}/activation`, { method: 'POST' }))}>Activer (règle publiée)</button>}
                {gestion && <ActionMotivee label="Émettre une carte conducteur (id contribuable ; permis)" tone="secondary" onSubmit={(v) => { const [conducteurTaxpayerId, permisRef] = v.split(';').map((s) => s.trim()); return api<{ numero: string; qr: string }>(`/v1/citoyen/transport/autorisations/${a.id}/cartes`, { method: 'POST', body: { conducteurTaxpayerId, permisRef } }).then((r) => { setCarte(r); list.reload(); }); }} />}
                {gestion && (!a.suspension || !!a.suspension.approuvee) && a.statut !== 'RETIREE' && <ActionMotivee label={a.statut === 'SUSPENDUE' ? 'Proposer la levée' : 'Proposer la suspension'} onSubmit={(motif) => api(`/v1/citoyen/transport/autorisations/${a.id}/suspension`, { method: 'POST', body: { action: a.statut === 'SUSPENDUE' ? 'LEVER' : 'SUSPENDRE', motif, decisionRef: `DEC-${a.id}` } }).then(list.reload)} />}
                {gestion && a.suspension && !a.suspension.approuvee && a.suspension.proposee.par !== user?.id && <>
                  <ActionMotivee label="Approuver la décision" onSubmit={(motif) => api(`/v1/citoyen/transport/autorisations/${a.id}/suspension/decision`, { method: 'POST', body: { approuver: true, motif } }).then(list.reload)} />
                  <ActionMotivee label="Rejeter" tone="secondary" onSubmit={(motif) => api(`/v1/citoyen/transport/autorisations/${a.id}/suspension/decision`, { method: 'POST', body: { approuver: false, motif } }).then(list.reload)} />
                </>}
              </span>])} />
          {carte && <div className="stack-sm" role="status"><p className="small">Carte conducteur <span className="mono">{carte.numero}</span></p><QrCode value={carte.qr} size={128} alt={`QR de la carte conducteur ${carte.numero}`} /></div>}
          {gestion && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void api<{ rappels: number }>('/v1/citoyen/transport/rappels', { method: 'POST' }).then((r) => setMsg(`${r.rappels} rappel(s) envoyé(s).`), (x: unknown) => setMsg(describeError(x).message))}>Envoyer les rappels de renouvellement</button>}
        </section>
      )}
      {gestion && (
        <form className="panel stack-sm" onSubmit={(e) => void enregistrer(e)} aria-label="Enregistrer une autorisation">
          <p className="panel-title">Enregistrer une autorisation décidée (certificat TRP)</p>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="tr-c">Certificat</label><input id="tr-c" value={n.certificatCode} onChange={(e) => setN({ ...n, certificatCode: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="tr-k">Catégorie</label><select id="tr-k" value={n.categorie} onChange={(e) => setN({ ...n, categorie: e.target.value })}>{[['TAXI', 'Taxi'], ['BUS', 'Bus'], ['MINIBUS', 'Minibus'], ['MOTO_TAXI', 'Moto-taxi'], ['POIDS_LOURD', 'Poids lourd']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
            <div className="field"><label className="label" htmlFor="tr-p">Plaque</label><input id="tr-p" value={n.plaque} onChange={(e) => setN({ ...n, plaque: e.target.value })} /></div>
          </div>
          <div className="field-row">
            <div className="field"><label className="label" htmlFor="tr-z">Communes autorisées (virgules ; vide = toutes)</label><input id="tr-z" value={n.zones} onChange={(e) => setN({ ...n, zones: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="tr-co">Corridor</label><input id="tr-co" value={n.corridor} onChange={(e) => setN({ ...n, corridor: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="tr-d">Début</label><input id="tr-d" value={n.debut} onChange={(e) => setN({ ...n, debut: e.target.value })} /></div>
            <div className="field"><label className="label" htmlFor="tr-f">Fin</label><input id="tr-f" value={n.fin} onChange={(e) => setN({ ...n, fin: e.target.value })} /></div>
          </div>
          <button type="submit" className="btn btn-primary btn-sm">Enregistrer</button>
        </form>
      )}
    </div>
  );
}
