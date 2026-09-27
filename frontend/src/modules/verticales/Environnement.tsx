/**
 * Environnement (MOSOLO Environment, modules 18 et 19 — Partie V) : registre des assujettis (metteurs en marché et
 * tonnages déclarés), simulation d'impact sur une hypothèse explicite, datée et sourcée (sans effet), état de
 * l'activation (règle ACTIVE = édit publié). Désactivé tant qu'aucun édit n'est publié.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { PageHead } from '../../components/Shell';
import { Icon } from '../../components/Icon';
import { MoneyText } from '../../components/MoneyText';
import { StatusBadge } from '../../components/StatusBadge';
import { DataTable } from '../../components/DataTable';
import { ErrorState, ExampleNotice, Loading } from '../../components/States';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';

interface Registry { rule: { code: string; status: string; demo?: boolean }; activated: boolean; notice: string; items: { objectId: string; raisonSociale: string; categorie: string | null; commune: string; tonnage: { tonnes: string; periode: string | null } | null; obligations: number }[] }
interface Simulation { id: string; estimate: MoneyJSON; declaredTonnes: string; registrants: number; effect: 'AUCUN' }

export default function Environnement() {
  const { user } = useApp();
  const q = useApi(() => api<Registry>('/v1/verticales/environnement/registre'), [user?.id]);
  const [h, setH] = useState({ label: '', value: '', source: '', date: '' });
  const [sim, setSim] = useState<Simulation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Environnement (MOSOLO Environment) · modules 18 · 19" title="Registre des assujettis et simulation d’impact"
        lead="Registre des metteurs en marché et tonnages déclarés ; simulation sans effet sur une hypothèse sourcée ; activation seulement après l’édit (règle ACTIVE)." />
      <ExampleNotice text="Hypothèses et montants de simulation : non opposables, aucune valeur par défaut." />
      {q.loading && <Loading />}
      {!!q.error && <ErrorState error={q.error} onRetry={q.reload} />}
      {q.data && (
        <div className="stack">
          <section className="panel">
            <h2 className="panel-title"><Icon name="leaf" size={18} /> Registre des assujettis</h2>
            <StatusBadge tone={q.data.activated ? 'good' : 'neutral'} label={q.data.activated ? `Édit publié — règle ${q.data.rule.code}${q.data.rule.demo ? ' [EXEMPLE]' : ''}` : 'Désactivé : aucun édit publié'} />
            <p className="small muted">{q.data.notice}</p>
            <DataTable caption="Metteurs en marché" rows={q.data.items} rowKey={(r) => r.objectId} columns={[
              { key: 'n', label: 'Raison sociale', render: (r) => r.raisonSociale },
              { key: 'c', label: 'Catégorie', render: (r) => r.categorie ?? '—' },
              { key: 'm', label: 'Commune', render: (r) => r.commune },
              { key: 't', label: 'Tonnage déclaré', num: true, render: (r) => (r.tonnage ? `${r.tonnage.tonnes} t${r.tonnage.periode ? ` (${r.tonnage.periode})` : ''}` : '—') },
              { key: 'o', label: 'Obligations', num: true, render: (r) => r.obligations },
            ]} />
          </section>
          <section className="panel">
            <h2 className="panel-title"><Icon name="analysis" size={18} /> Simulation d’impact (sans effet)</h2>
            <form className="row-wrap" onSubmit={(e) => { e.preventDefault(); setErr(null); void api<Simulation>('/v1/verticales/environnement/simulations', { method: 'POST', body: { label: h.label, valuePerTonne: { amount: h.value, currency: 'USD' }, source: h.source, date: h.date } }).then(setSim).catch((x) => setErr(describeError(x).message)); }}>
              <input value={h.label} onChange={(e) => setH({ ...h, label: e.target.value })} placeholder="Hypothèse" aria-label="Hypothèse" />
              <input value={h.value} onChange={(e) => setH({ ...h, value: e.target.value })} placeholder="Valeur par tonne (USD)" aria-label="Valeur par tonne" inputMode="decimal" />
              <input value={h.source} onChange={(e) => setH({ ...h, source: e.target.value })} placeholder="Source" aria-label="Source" />
              <input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} aria-label="Date de l’hypothèse" />
              <button type="submit" className="btn btn-secondary btn-sm">Simuler</button>
            </form>
            {err && <p className="notice notice-err" role="alert">{err}</p>}
            {sim && <p className="small">{sim.registrants} assujetti(s), {sim.declaredTonnes} t déclarées → estimation <MoneyText money={sim.estimate} /> — aucun effet (ni obligation, ni avis).</p>}
          </section>
        </div>
      )}
    </div>
  );
}
