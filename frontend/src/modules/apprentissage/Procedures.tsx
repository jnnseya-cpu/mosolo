/**
 * Base de procédures versionnée — module 50 : chaque procédure garde toutes ses versions (auteur, date, décision de
 * publication à quatre yeux) ; l'agent lit la version publiée de son public. Indicateurs : agents certifiés, taux de réussite.
 */
import { useState } from 'react';
import { useApp } from '../../context';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { Section } from '../pilotage/shared';
import { hasRole } from '../pilotage/planif';
import { date, Ecran, Indicateurs, useVue, type Indicator } from '../decision/commun';
import { ProceduresVisuel } from './visuels';

interface Proc {
  id: string; cle: string; publics: string[]; demo: boolean;
  publiee: { version: number; titre: string; corps: string; lingala?: { titre: string; corps: string; statut: string }; publieeLe: string | null } | null;
  historique: { version: number; titre: string; statut: string; auteur: string; creeLe: string; decision?: { par: string; le: string; approuve: boolean; motif: string } }[];
}

export default function Procedures() {
  const { user } = useApp();
  const q = useVue<{ items: Proc[] }>('/v1/apprentissage/procedures');
  const ind = useVue<{ indicators: Indicator[] }>(hasRole(user?.roles, 'R01', 'R02', 'R03', 'R05', 'R06', 'R07', 'R08', 'R09', 'R17', 'R22', 'R23', 'R26', 'R28') ? '/v1/apprentissage/indicateurs' : null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Ecran eyebrow="IA et apprentissage · module 50" title="Base de procédures" lead="Procédures versionnées, publiées à quatre yeux ; seule la version publiée est opposable, l’historique reste consultable. Suivi des résultats, pas surveillance intrusive." q={q}>
      {(d) => (<>
        {ind.data && <Section title="Indicateurs"><Indicateurs items={ind.data.indicators} /></Section>}
        {/* Visuels (27/09/2026) : publication et versions, depuis la même liste. */}
        <ProceduresVisuel items={d.items} />
        <Section title="Procédures" sub="La rédaction et la publication se font dans « Certifications et contenus d’apprentissage » (type Procédure).">
          <DataTable caption="Procédures" rows={d.items} rowKey={(p) => p.id} empty={<p className="muted">Aucune procédure pour votre public.</p>} columns={[
            { key: 't', label: 'Procédure', primary: true, render: (p) => <>{p.publiee?.titre ?? p.cle}{p.demo && <span className="small muted"> [EXEMPLE]</span>}</> },
            { key: 'v', label: 'Version publiée', render: (p) => (p.publiee ? <StatusBadge tone="good" label={`v${p.publiee.version} — ${date(p.publiee.publieeLe)}`} /> : <StatusBadge tone="neutral" label="Non publiée" />) },
            { key: 'h', label: 'Versions', num: true, render: (p) => p.historique.length },
            { key: 'a', label: 'Lire', render: (p) => <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Fermer' : 'Lire'}</button> },
          ]} />
        </Section>
        {d.items.filter((p) => p.id === open).map((p) => (
          <Section key={p.id} title={p.publiee?.titre ?? p.cle} sub={`Publics : ${p.publics.join(', ')}`}>
            {p.publiee ? <p style={{ whiteSpace: 'pre-wrap' }}>{p.publiee.corps}</p> : <p className="muted">Aucune version publiée.</p>}
            {p.publiee?.lingala && <p className="small"><strong>Lingala (brouillon à relire) :</strong> {p.publiee.lingala.corps}</p>}
            <DataTable caption="Historique" rows={p.historique} rowKey={(h) => String(h.version)} columns={[
              { key: 'v', label: 'Version', primary: true, render: (h) => `v${h.version} — ${h.titre}` },
              { key: 's', label: 'Statut', render: (h) => h.statut },
              { key: 'a', label: 'Auteur / date', render: (h) => `${h.auteur} — ${date(h.creeLe)}` },
              { key: 'd', label: 'Décision', render: (h) => (h.decision ? `${h.decision.approuve ? 'Publiée' : 'Refusée'} par ${h.decision.par} — ${h.decision.motif}` : '—') },
            ]} />
          </Section>
        ))}
      </>)}
    </Ecran>
  );
}
