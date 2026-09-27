/**
 * Base de référence auditée (§ 38.1) et recette additionnelle nette vérifiée — RANV (§ 38.2).
 * Import (CSV ou lignes) puis certification par une seconde personne ; la RANV n'est mesurée que sur une base
 * certifiée. Ventilation obligatoire par origine (§ 8.7) : nouvelles, arriérés, rapprochement, reclassement.
 */
import { useState } from 'react';
import type { MoneyJSON } from '@mosolo/shared';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { PageHead } from '../../components/Shell';
import { DataTable } from '../../components/DataTable';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { api } from '../../lib/api';
import { Section } from './shared';
import { Area, Callout, CertBadge, certifyGuard, Choice, Field, hasRole, moneysText, Notice, useRunner } from './planif';
import './pilotage.css';
import { DonutViz, fmtCompact, fmtNombre, KpiTile, StatusDistribution } from '../../components/viz';
import { CERT_STATUS } from './planif';
import { BarresParDevise, etatsDe, nombre, Tuiles, Visuels } from './visuels';

const entier = (v: number) => fmtNombre(v, 0);

/** Visuels de la ventilation par origine (§ 8.7) : paiements par origine, montants par devise. */
export function VisuelsOrigines({ origins }: { origins: Origins }) {
  return (
    <>
      <DonutViz title="Paiements par origine (§ 8.7)" centerLabel="paiements" emptyText="Aucun paiement ventilé" slices={origins.rows.map((r) => ({ key: r.origin, label: r.label, value: r.count }))} />
      <BarresParDevise title="Montants par origine" series={[{ key: 'a', label: 'Montant' }]} rows={origins.rows.map((r) => ({ key: r.origin, label: r.label, values: { a: r.amounts } }))} />
    </>
  );
}

/** Visuels de la base de référence et de la RANV : jamais d'estimation ; non mesuré motivé. */
function VisuelsBase({ ranv, sets }: { ranv: Ranv | null; sets: BaseSet[] | null }) {
  return (
    <>
      <Tuiles label="Base de référence et RANV — synthèse" max={4}>
        {ranv && ranv.certified && ranv.ranv.length > 0 ? ranv.ranv.map((m, i) => (
          <KpiTile key={m.currency} hero={i === 0} label={`RANV — ${m.currency}`} value={nombre(m.amount)} unit={m.currency} format={fmtCompact} state={{ label: ranv.partial ? 'Mesure partielle' : 'Base certifiée', tone: ranv.partial ? 'warning' : 'good' }} sub={`Base ${ranv.base?.period ?? '—'}`} />
        )) : <KpiTile hero label="RANV" value={null} reason={ranv?.note ?? 'Aucune base de référence certifiée (§ 38.1).'} />}
        <KpiTile label="Jeux importés" value={sets?.length ?? null} format={entier} state={{ label: 'Deux personnes', tone: 'info' }} reason="Liste indisponible." />
        <KpiTile label="Jeux certifiés" value={sets ? sets.filter((s) => s.status === 'CERTIFIEE').length : null} format={entier} state={{ label: 'Certifié', tone: 'good' }} reason="Liste indisponible." />
        <KpiTile label="En attente de certification" value={sets ? sets.filter((s) => s.status === 'IMPORTEE').length : null} format={entier} state={{ label: 'Seconde personne', tone: 'warning' }} reason="Liste indisponible." />
      </Tuiles>
      <Visuels label="Base de référence en graphiques">
        <StatusDistribution title="Jeux importés par statut" unitLabel="jeux" emptyText="Aucun jeu importé" items={etatsDe(sets ?? [], (s) => s.status, CERT_STATUS)} />
        {ranv?.certified && (
          <BarresParDevise className="viz-span-2" title="Composantes de la RANV" subtitle="Montants mesurés (signe indiqué dans le libellé)" series={[{ key: 'a', label: 'Montant' }]}
            rows={ranv.components.filter((c) => c.measured).map((c) => ({ key: c.code, label: `${c.sign > 0 ? '+' : '−'} ${c.label}`, values: { a: c.amounts } }))} />
        )}
        {ranv?.origins && <VisuelsOrigines origins={ranv.origins} />}
      </Visuels>
    </>
  );
}

export interface OriginRow { origin: string; label: string; definition: string; count: number; amounts: MoneyJSON[] }
export interface Origins { basis: string; rule: string; reference: { date: string | null; source: string; note: string }; rows: OriginRow[]; total: { count: number; amounts: MoneyJSON[] } }
interface BaseSet { id: string; kind: string; label: string; period: string; status: string; importedBy: string; importedAt: string; entries: unknown[]; source: { document: string; reference: string }; decision?: { by: string; motif: string; approve: boolean } }
interface Ranv {
  certified: boolean; note?: string; period: { from: string; to: string }; formula?: string; partial?: boolean; unmeasured?: string[];
  base?: { id: string; period: string; certifiedBy: string };
  components: { code: string; label: string; sign: number; method: string; measured: boolean; amounts: MoneyJSON[]; note?: string }[];
  ranv: MoneyJSON[]; origins?: Origins;
}

/** Ventilation par origine (§ 8.7) — réutilisée par les tableaux par profil. */
export function OriginsTable({ origins }: { origins: Origins }) {
  return (
    <>
      <DataTable caption="Ventilation par origine" rows={origins.rows} rowKey={(r) => r.origin} columns={[
        { key: 'o', label: 'Origine', primary: true, render: (r) => <><strong>{r.label}</strong><span className="small muted" style={{ display: 'block' }}>{r.definition}</span></> },
        { key: 'n', label: 'Paiements', num: true, render: (r) => r.count },
        { key: 'a', label: 'Montants (devise légale)', num: true, render: (r) => moneysText(r.amounts) },
      ]} />
      <p className="small muted">{origins.rule} {origins.reference.note} Total : {moneysText(origins.total.amounts)}.</p>
    </>
  );
}

const SAMPLE = 'metrique;recette;commune;canal;valeur;devise\nENCAISSEMENTS;*;*;*;0.00;USD\nOBJETS_CONNUS;*;*;*;0;';

export default function BaseReference() {
  const { user } = useApp();
  const sets = useApi(() => api<{ items: BaseSet[]; metrics: Record<string, { label: string; unit: string }> }>('/v1/pilotage/base-reference'), [user?.id]);
  const ranv = useApi(() => api<Ranv>('/v1/pilotage/ranv'), [user?.id]);
  const reload = () => { sets.reload(); ranv.reload(); };
  const r = useRunner(reload);
  const [form, setForm] = useState({ kind: 'BASE_REFERENCE', label: '', period: '', document: '', reference: '', csv: SAMPLE });
  const [motif, setMotif] = useState('');
  const canImport = hasRole(user?.roles, 'R05', 'R06', 'R15', 'R17', 'R18');
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 38.1–38.2" title="Base de référence et RANV" lead="Aucun engagement chiffré ne précède la mesure. La recette additionnelle nette vérifiée n’est calculée que sur une base de référence certifiée par deux personnes." />
      <div className="dash-grid" style={{ marginBottom: 16 }}><VisuelsBase ranv={ranv.data ?? null} sets={sets.data?.items ?? null} /></div>
      {ranv.loading && !ranv.data ? <Loading /> : ranv.error ? <ErrorState error={ranv.error} onRetry={reload} /> : ranv.data && (
        <div className="dash-grid">
          <Section title="Recette additionnelle nette vérifiée (RANV)" sub={`Du ${ranv.data.period.from} au ${ranv.data.period.to}`}>
            {!ranv.data.certified ? <Callout tone="warn"><strong>Non mesurée.</strong> {ranv.data.note}</Callout> : (
              <>
                <div className="pl-figs"><div className="pl-fig" data-testid="ranv-total"><span>RANV</span><strong>{moneysText(ranv.data.ranv)}</strong><span>Base {ranv.data.base?.period} certifiée par {ranv.data.base?.certifiedBy}</span></div></div>
                <DataTable caption="Composantes de la RANV" rows={ranv.data.components} rowKey={(c) => c.code} columns={[
                  { key: 'l', label: 'Composante', primary: true, render: (c) => <><strong>{c.sign > 0 ? '+' : '−'} {c.label}</strong><span className="small muted" style={{ display: 'block' }}>{c.method}</span></> },
                  { key: 'a', label: 'Montants', num: true, render: (c) => (c.measured ? moneysText(c.amounts) : <StatusBadge tone="neutral" label="non mesuré" />) },
                ]} />
                <p className="small muted">{ranv.data.formula}{ranv.data.partial ? ` Non mesuré : ${ranv.data.unmeasured?.join(', ')}.` : ''}</p>
              </>
            )}
          </Section>
          {ranv.data.origins && <Section title="Ventilation par origine (§ 8.7)" sub={ranv.data.origins.basis}><OriginsTable origins={ranv.data.origins} /></Section>}
        </div>
      )}
      <div className="dash-grid">
        <Section title="Jeux importés" sub="Base de référence (par recette, commune, canal et période) et relevés de coûts constatés">
          <Notice msg={r.msg} />
          {sets.loading && !sets.data ? <Loading /> : sets.error ? <ErrorState error={sets.error} onRetry={reload} /> : (
            <DataTable caption="Jeux" rows={sets.data?.items ?? []} rowKey={(s) => s.id} empty={<EmptyState title="Aucun jeu importé" icon="chart">La base de référence est établie avant toute promesse (§ 38.1).</EmptyState>} columns={[
              { key: 'i', label: 'Jeu', primary: true, render: (s) => <><strong>{s.label}</strong><span className="small muted" style={{ display: 'block' }}>{s.id} · {s.kind === 'BASE_REFERENCE' ? 'Base de référence' : 'Coûts constatés'} · {s.period} · {s.entries.length} ligne(s)</span></> },
              { key: 's', label: 'Source', render: (s) => <span className="small">{s.source.document} ({s.source.reference})</span> },
              { key: 't', label: 'Statut', render: (s) => <CertBadge status={s.status} /> },
              { key: 'a', label: 'Certification', render: (s) => {
                const block = certifyGuard(s, user, ['R05', 'R22', 'R23']);
                return block ? <span className="small muted">{s.decision ? `${s.decision.approve ? 'Certifiée' : 'Rejetée'} par ${s.decision.by}` : block}</span> : (
                  <div className="btn-row">
                    <button type="button" className="btn btn-primary btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/pilotage/base-reference/${s.id}/certification`, { approve: true, motif }, 'Jeu certifié.')}>Certifier</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={r.busy || motif.trim().length < 10} onClick={() => void r.run(`/v1/pilotage/base-reference/${s.id}/certification`, { approve: false, motif }, 'Jeu rejeté.')}>Rejeter</button>
                  </div>
                );
              } },
            ]} />
          )}
          <Field label="Motif de certification ou de rejet (10 caractères minimum)" value={motif} onChange={setMotif} />
        </Section>
        {canImport && (
          <Section title="Importer un jeu" sub="CSV séparé par « ; » : metrique;recette;commune;canal;valeur;devise — « * » pour toutes. Rubriques exactes du § 38.1.">
            <div className="form">
              <Choice label="Nature" value={form.kind} onChange={(v) => setForm({ ...form, kind: v })} options={[['BASE_REFERENCE', 'Base de référence (§ 38.1)'], ['COUTS_CONSTATES', 'Relevé des coûts constatés']]} />
              <Field label="Libellé" value={form.label} onChange={(v) => setForm({ ...form, label: v })} />
              <Field label="Période (AAAA, AAAA-Tn ou AAAA-MM)" value={form.period} onChange={(v) => setForm({ ...form, period: v })} placeholder="2025" />
              <Field label="Document source" value={form.document} onChange={(v) => setForm({ ...form, document: v })} />
              <Field label="Référence du document" value={form.reference} onChange={(v) => setForm({ ...form, reference: v })} />
              <Area label="Lignes (CSV)" rows={6} value={form.csv} onChange={(v) => setForm({ ...form, csv: v })} hint={`Rubriques : ${Object.entries(sets.data?.metrics ?? {}).map(([k, m]) => `${k} (${m.label})`).join(', ')}`} />
              <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/pilotage/base-reference', { kind: form.kind, label: form.label, period: form.period, source: { document: form.document, reference: form.reference }, csv: form.csv }, 'Jeu importé : une seconde personne doit le certifier.')}>Importer</button></div>
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
