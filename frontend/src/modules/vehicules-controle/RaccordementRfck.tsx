/**
 * Régie des Fourrières et de Contrôle Technique (RFCK) : fiche de l'entité, interfaces RFCK ↔ MOSOLO (dix flux, porte
 * « convention requise »), séquence d'intégration en sept étapes, domaine officiel de vérification (six exigences),
 * chiffres publiés par la RFCK conservés « À VÉRIFIER » (jamais une base de référence).
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from '../pilotage/shared';
import { Callout, Notice, useRunner } from '../pilotage/planif';
import { hasRole, StateBadge } from './common';
import { RfckVisuels } from './visuels';

interface Entite {
  entity: { name: string; shortName: string; nature: string; tutelle: string };
  arrete: { title: string; status: string; scope: string[] };
  contacts: { adresse: string; telephone: string; courriel: string };
  modules: { numero: number; numeroMaitreOuvrage: number; label: string; note: string }[];
  numerotation: { note: string; aArbitrer: string };
}
interface Flow { code: string; label: string; direction: string; cadence: string; status: string; statusLabel: string; exchanges: number; connector: string }
interface Step { rank: number; code: string; label: string; status: string; conditions: { label: string; met: boolean }[] }
interface Req { code: string; label: string; status: string; detail: string }
interface Figure { code: string; label: string; value: string; status: string; usage: string }

export default function RaccordementRfck() {
  const { user } = useApp();
  const ent = useApi(() => api<Entite>('/v1/rfck/entite'), [user?.id]);
  const flows = useApi(() => api<{ items: Flow[] }>('/v1/rfck/flux'), [user?.id]);
  const steps = useApi(() => api<{ steps: Step[] }>('/v1/rfck/integration'), [user?.id]);
  const dom = useApi(() => api<{ requirements: Req[]; domain: { host: string; status: string; ownedBy: string }; sampleQr: string }>('/v1/rfck/domaine'), [user?.id]);
  const figs = useApi(() => api<{ items: Figure[] }>('/v1/rfck/chiffres-publies'), [user?.id]);
  const reload = () => { ent.reload(); flows.reload(); steps.reload(); dom.reload(); figs.reload(); };
  const r = useRunner(reload);
  const [contacts, setContacts] = useState({ adresse: '', telephone: '', courriel: '' });

  if (!user) return <div className="page"><PageHead title="Raccordement RFCK" /><p className="notice">Connectez-vous.</p></div>;
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Chaîne véhicule · modules 82 à 84" title="Raccordement RFCK et domaine officiel" lead="Interfaces avec la Régie des Fourrières et de Contrôle Technique des Véhicules de Kinshasa, séquence d’intégration et vérification publique." />
      <Notice msg={r.msg} />
      <RfckVisuels flows={flows.data?.items} steps={steps.data?.steps} reqs={dom.data?.requirements} loading={flows.loading || steps.loading || dom.loading} />
      {ent.loading && !ent.data ? <Loading /> : ent.error ? <ErrorState error={ent.error} onRetry={reload} /> : ent.data && (
        <div className="dash-grid">
          <Section title={ent.data.entity.name} sub={`${ent.data.entity.nature} — tutelle : ${ent.data.entity.tutelle}`}>
            <p><StateBadge state={ent.data.arrete.status} /> {ent.data.arrete.title}</p>
            <p className="small">Champ : {ent.data.arrete.scope.join(' ; ')}.</p>
            <ul>{ent.data.modules.map((m) => <li key={m.numero}><strong>{m.numero}.</strong> {m.label} <span className="small muted">({m.note})</span></li>)}</ul>
            <Callout tone="warn">{ent.data.numerotation.aArbitrer}</Callout>
            <p className="small">Contacts : {ent.data.contacts.adresse || 'non renseigné'} · {ent.data.contacts.telephone || 'non renseigné'} · {ent.data.contacts.courriel || 'non renseigné'} (modifiables par l’administrateur de l’entité seulement).</p>
            {hasRole(user.roles, 'R08', 'R26') && (
              <div className="vc-form">
                {(['adresse', 'telephone', 'courriel'] as const).map((k) => <label key={k}><span>{{ adresse: 'Adresse', telephone: 'Téléphone', courriel: 'Courriel' }[k]}</span><input value={contacts[k]} onChange={(e) => setContacts({ ...contacts, [k]: e.target.value })} /></label>)}
                <button type="button" className="btn btn-secondary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/rfck/entite/contacts', Object.fromEntries(Object.entries(contacts).filter(([, v]) => v)), 'Contacts mis à jour.')}>Enregistrer les contacts</button>
              </div>
            )}
          </Section>
          <Section title="Interfaces RFCK ↔ MOSOLO (dix flux)" sub="Chaque flux est ouvert par une convention signée, déclarée conforme par une seconde personne. Adaptateur bac à sable en attendant.">
            <DataTable caption="Flux" rows={flows.data?.items ?? []} rowKey={(f) => f.code} columns={[
              { key: 'l', label: 'Flux', primary: true, render: (f) => <><strong>{f.label}</strong><span className="small muted" style={{ display: 'block' }}>{f.direction === 'BIDIRECTIONNEL' ? 'Dans les deux sens' : f.direction === 'RFCK_VERS_MOSOLO' ? 'RFCK → MOSOLO' : 'MOSOLO → RFCK'} · {f.cadence}</span></> },
              { key: 's', label: 'Statut', render: (f) => <StateBadge state={f.status} label={f.statusLabel} /> },
              { key: 'e', label: 'Échanges', num: true, render: (f) => f.exchanges },
            ]} />
          </Section>
          <Section title="Séquence d’intégration (sept étapes)">
            <ol className="vc-steps">{(steps.data?.steps ?? []).map((s) => (
              <li key={s.code}>
                <div className="vc-row"><strong>{s.rank}. {s.label}</strong> <StateBadge state={s.status} />
                  {hasRole(user.roles, 'R06') && s.status === 'PRETE_A_VALIDER' && <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy} onClick={() => void r.run(`/v1/rfck/integration/${s.code}/validation`, { motif: 'Conditions de passage vérifiées' }, 'Étape franchie.')}>Valider le passage</button>}
                </div>
                <ul>{s.conditions.map((c) => <li key={c.label} className="small">{c.met ? '✓' : '✗'} {c.label}</li>)}</ul>
              </li>
            ))}</ol>
          </Section>
          <Section title="Domaine officiel de vérification — six exigences" sub={dom.data ? `${dom.data.domain.host} (${dom.data.domain.ownedBy}) — exemple de QR : ${dom.data.sampleQr}` : undefined}>
            <DataTable caption="Exigences" rows={dom.data?.requirements ?? []} rowKey={(x) => x.code} columns={[
              { key: 'l', label: 'Exigence', primary: true, render: (x) => <><strong>{x.code}</strong> {x.label}</> },
              { key: 's', label: 'Statut', render: (x) => <StateBadge state={x.status} /> },
              { key: 'd', label: 'Détail', render: (x) => <span className="small">{x.detail}</span> },
            ]} />
          </Section>
          <Section title="Chiffres publiés par la RFCK" sub="Sources conservées « À VÉRIFIER » : jamais une base de référence ni un objectif.">
            <DataTable caption="Chiffres publiés" rows={figs.data?.items ?? []} rowKey={(x) => x.code} columns={[
              { key: 'l', label: 'Chiffre', primary: true, render: (x) => x.label },
              { key: 'v', label: 'Valeur publiée', render: (x) => x.value },
              { key: 's', label: 'Statut', render: (x) => <StateBadge state={x.status} /> },
            ]} />
          </Section>
        </div>
      )}
    </div>
  );
}
