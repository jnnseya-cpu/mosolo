/**
 * Gestion des équipements terrain — module 58 : MDM (enrôlement, politiques, effacement à distance), liaison
 * appareil–utilisateur attestée, expiration automatique des données, révocations (y compris en masse), détection
 * d'appareil modifié (quarantaine levée par une personne). Outil MDM réel [À RACCORDER — convention requise].
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Section } from '../pilotage/shared';
import { Field, hasRole } from '../pilotage/planif';
import { date, Ecran, Indicateurs, useRunner, useVue, type Indicator } from '../decision/commun';
import { EquipementsVisuel } from './visuels';

interface Equipment {
  id: string; userId: string; userName: string; policyCode: string; policyVersion: number; model: string; os: string; state: string;
  binding: { status: string; attestedAt?: string }; lastCheckIn?: string; lastReport?: { verdict: string; reasons: string[] };
  commands: { id: string; kind: string; status: string; at: string; perimetre?: string }[]; quarantine?: { reasons: string[] };
  ownership?: 'PERSONNEL' | 'PROVINCE'; charte?: { version: string; acceptedAt: string };
}
interface Vue {
  mdm: { adapter: string; external: boolean; label: string }; rule: string; indicators: Indicator[];
  policies: { id: string; code: string; version: number; label: string; screenLockMinutes: number; minOsVersion: number; offlineDataTtlDays: number; status: string }[];
  equipments: Equipment[]; incidents: { id: string; at: string; kind: string; detail: string; deviceId: string }[];
  personnel?: { regle: string; charte: { version: string; texte: readonly string[] }; telephonesPersonnels: number; terminauxProvince: number; chartesAcceptees: number };
}
const perso = (e: Equipment) => e.ownership !== 'PROVINCE';
const STATE: Record<string, 'good' | 'warning' | 'critical' | 'neutral'> = { ACTIF: 'good', DONNEES_EXPIREES: 'warning', QUARANTAINE: 'critical', REVOQUE: 'neutral' };

export default function Equipements() {
  const { user } = useApp();
  const q = useVue<Vue>('/v1/equipements');
  const r = useRunner(q.reload);
  const [deviceId, setDeviceId] = useState('');
  const [userId, setUserId] = useState('');
  const [model, setModel] = useState('');
  const [os, setOs] = useState('');
  const [motif, setMotif] = useState('');
  const [key, setKey] = useState<string | null>(null);
  const [ownership, setOwnership] = useState<'PERSONNEL' | 'PROVINCE'>('PERSONNEL');
  const sec = hasRole(user?.roles, 'R28', 'R08');
  return (
    <Ecran eyebrow="Terrain · module 58" title="Gestion des équipements terrain" lead="Enregistrer, sécuriser et révoquer les terminaux des agents ; suivi des résultats, pas surveillance intrusive." q={q} msg={r.msg}>
      {(d) => (<>
        <Section title="Indicateurs" sub={d.rule}><Indicateurs items={d.indicators} /></Section>
        {/* Visuels (27/09/2026) : terminaux, liaison et incidents, depuis la même vue. */}
        <EquipementsVisuel equipments={d.equipments} incidents={d.incidents} />
        {d.personnel && (
          <Section title="Téléphones personnels des agents (Android et iOS)" sub={d.personnel.regle}>
            <p className="small">{d.personnel.telephonesPersonnels} téléphone(s) personnel(s) · {d.personnel.chartesAcceptees} charte(s) acceptée(s) · {d.personnel.terminauxProvince} terminal(aux) de la Province</p>
            <details>
              <summary className="small">Charte d’usage du téléphone personnel (version {d.personnel.charte.version} — par défaut, à confirmer)</summary>
              <ul className="small">{d.personnel.charte.texte.map((t) => <li key={t}>{t}</li>)}</ul>
            </details>
          </Section>
        )}
        <Section title="Outil de gestion des terminaux (MDM)"><StatusBadge tone={d.mdm.external ? 'good' : 'warning'} label={d.mdm.adapter} /> <span className="small">{d.mdm.label}</span></Section>
        <Section title="Politiques (versionnées)">
          <DataTable caption="Politiques" rows={d.policies} rowKey={(p) => p.id} columns={[
            { key: 'p', label: 'Politique', primary: true, render: (p) => `${p.code} v${p.version} — ${p.label}` },
            { key: 'l', label: 'Verrouillage / système minimal', render: (p) => `${p.screenLockMinutes} min / ${p.minOsVersion}` },
            { key: 'e', label: 'Expiration des données hors ligne', render: (p) => `${p.offlineDataTtlDays} jours (${p.status === 'PAR_DEFAUT' ? 'par défaut, à confirmer' : 'confirmée'})` },
          ]} />
        </Section>
        {hasRole(user?.roles, 'R28', 'R08', 'R09') && (
          <Section title="Enrôler un terminal">
            <div className="form">
              <Field label="Identifiant du terminal" value={deviceId} onChange={setDeviceId} />
              <Field label="Agent affecté (identifiant)" value={userId} onChange={setUserId} />
              <Field label="Modèle" value={model} onChange={setModel} />
              <Field label="Système" value={os} onChange={setOs} />
              <div className="field"><label className="label" htmlFor="eq-own">Propriété du téléphone</label>
                <select id="eq-own" value={ownership} onChange={(ev) => setOwnership(ev.target.value as 'PERSONNEL' | 'PROVINCE')}>
                  <option value="PERSONNEL">Téléphone personnel de l’agent (application MOSOLO seulement)</option>
                  <option value="PROVINCE">Terminal de la Province (appareil entier)</option>
                </select>
              </div>
              <button type="button" className="btn btn-primary" disabled={r.busy || !deviceId || !userId || model.length < 2 || os.length < 2} onClick={() => void r.run<{ deviceKeyOnce: string }>('/v1/equipements/terminaux', { deviceId, userId, model, os, ownership }, 'Terminal enrôlé.').then((x) => x && setKey(`Clé du terminal (affichée une seule fois) : ${x.deviceKeyOnce}`))}>Enrôler</button>
              {key && <p className="notice notice-ok" role="status">{key}</p>}
            </div>
          </Section>
        )}
        <Section title="Terminaux">
          {sec && <Field label="Motif (effacement, révocation, levée — 10 caractères minimum)" value={motif} onChange={setMotif} />}
          <DataTable caption="Terminaux" rows={d.equipments} rowKey={(e) => e.id} empty={<p className="muted">Aucun terminal.</p>} columns={[
            { key: 't', label: 'Terminal', primary: true, render: (e) => `${e.id} — ${e.userName}` },
            { key: 'o', label: 'Propriété', render: (e) => (perso(e) ? <>Personnel{e.charte ? ` · charte acceptée (${date(e.charte.acceptedAt)})` : ' · charte à accepter'}</> : 'Province') },
            { key: 's', label: 'État', render: (e) => <StatusBadge tone={STATE[e.state] ?? 'neutral'} label={e.state} /> },
            { key: 'b', label: 'Liaison appareil–utilisateur', render: (e) => (e.binding.status === 'ATTESTEE' ? `Attestée (${date(e.binding.attestedAt)})` : 'À attester') },
            { key: 'i', label: 'Dernier signalement', render: (e) => (e.lastReport ? `${date(e.lastCheckIn)} — ${e.lastReport.verdict}${e.lastReport.reasons.length ? ` : ${e.lastReport.reasons.join(' ')}` : ''}` : 'aucun') },
            { key: 'c', label: 'Commandes en attente', render: (e) => e.commands.filter((c) => c.status === 'EN_ATTENTE').map((c) => (c.kind === 'EFFACEMENT' ? (c.perimetre === 'APPAREIL' ? 'Effacement de l’appareil' : 'Effacement des données MOSOLO') : c.kind)).join(', ') || '—' },
            { key: 'a', label: 'Actions', render: (e) => (sec ? (
              <div className="btn-row">
                {e.state !== 'REVOQUE' && <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.length < 10} onClick={() => void r.run(`/v1/equipements/terminaux/${e.id}/effacement`, { motif }, perso(e) ? 'Effacement des données MOSOLO programmé (le téléphone n’est pas touché).' : 'Effacement à distance programmé.')}>{perso(e) ? 'Effacer les données MOSOLO' : 'Effacer'}</button>}
                {e.state !== 'REVOQUE' && <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.length < 10} onClick={() => void r.run(`/v1/equipements/terminaux/${e.id}/revocation`, { motif }, 'Terminal révoqué.')}>Révoquer</button>}
                {e.state === 'QUARANTAINE' && e.userId !== user?.id && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.length < 10} onClick={() => void r.run(`/v1/equipements/terminaux/${e.id}/levee-quarantaine`, { motif }, 'Quarantaine levée.')}>Lever la quarantaine</button>}
              </div>
            ) : e.userId === user?.id && e.state !== 'REVOQUE' ? <div className="btn-row">{perso(e) && !e.charte && d.personnel && <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/equipements/terminaux/${e.id}/charte`, { version: d.personnel!.charte.version }, 'Charte acceptée.')}>Accepter la charte</button>}<button type="button" className="btn btn-ghost btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/equipements/terminaux/${e.id}/perte`, { motif: 'Terminal perdu déclaré par l’agent' }, perso(e) ? 'Perte déclarée : accès coupé, données MOSOLO effacées à distance.' : 'Perte déclarée : terminal révoqué et effacé.')}>Déclarer une perte</button></div> : null) },
          ]} />
          {sec && <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/equipements/echeancier', {}, 'Échéancier exécuté : données expirées signalées.')}>Exécuter l’expiration des données</button>}
        </Section>
        <Section title="Incidents">
          <DataTable caption="Incidents" rows={d.incidents} rowKey={(i) => i.id} empty={<p className="muted">Aucun incident.</p>} columns={[
            { key: 'a', label: 'Heure', render: (i) => date(i.at) },
            { key: 't', label: 'Terminal', primary: true, render: (i) => i.deviceId },
            { key: 'k', label: 'Nature', render: (i) => i.kind },
            { key: 'd', label: 'Détail', render: (i) => i.detail },
          ]} />
        </Section>
      </>)}
    </Ecran>
  );
}
