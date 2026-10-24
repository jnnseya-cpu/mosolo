/**
 * Partage légal des recettes (§ 27.1, § 30.6) — distinct de la clé du § 37A. Clés entre province, ETD et pouvoir
 * central : fiches du registre juridique (A_VERIFIER tant que non certifiées) ; parts calculées sur le rapproché et
 * le comptabilisé ; chaque entité voit sa part ; aucune entité ne modifie une clé ; aucun virement.
 * Registre des cadres d'incitation de performance : aucun calcul ni versement.
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
import { currentQuarter, Section } from './shared';
import { Callout, Field, hasRole, moneysText, moneyText, Notice, useRunner } from './planif';
import './pilotage.css';
import { fmtNombre, KpiTile, StatusDistribution } from '../../components/viz';
import { BarresParDevise, etatsDe, Tuiles, Visuels } from './visuels';

const CLE_ETAT = { ACTIVE: { label: 'Active (certifiée)', tone: 'good' as const }, A_VERIFIER: { label: 'À vérifier', tone: 'warning' as const } };

/** Visuels du partage légal : statut des clés, parts par entité (rapproché / comptabilisé), cadres d'incitation. */
export function VisuelsPartage({ keys, last, incitations }: { keys: KeyRow[]; last: Calc | undefined; incitations: Incentive[] }) {
  const entier = (v: number) => fmtNombre(v, 0);
  return (
    <>
      <Tuiles label="Partage légal — synthèse" max={4}>
        <KpiTile hero label="Clés légales" value={keys.length} format={entier} state={{ label: `${keys.filter((k) => k.status === 'ACTIVE').length} active(s)`, tone: keys.some((k) => k.status === 'ACTIVE') ? 'good' : 'warning' }} sub="Distinctes de la clé du § 37A" />
        <KpiTile label="Entités bénéficiaires" value={new Set(keys.flatMap((k) => k.beneficiaries.map((b) => b.beneficiary))).size} format={entier} state={{ label: 'Province, ETD, pouvoir central', tone: 'info' }} />
        <KpiTile label="Dernier calcul" value={last ? last.period : null} reason="Aucun calcul enregistré." state={last ? { label: 'Aucun virement', tone: 'neutral' } : undefined} />
        <KpiTile label="Cadres d’incitation" value={incitations.length} format={entier} state={{ label: 'Registre seulement', tone: 'neutral' }} />
      </Tuiles>
      <Visuels label="Partage légal en graphiques">
        <StatusDistribution title="Clés légales par statut" unitLabel="clés" items={etatsDe(keys, (k) => (k.status === 'ACTIVE' ? 'ACTIVE' : 'A_VERIFIER'), CLE_ETAT)} />
        <BarresParDevise className="viz-span-2" title="Parts par entité" subtitle={last ? `Calcul ${last.id} (${last.period}) — clés certifiées seulement` : undefined} emptyText="Aucune part calculée (clés non certifiées : assiette seulement)"
          series={[{ key: 'r', label: 'Sur le rapproché' }, { key: 'k', label: 'Sur le comptabilisé' }]}
          rows={(last?.byEntity ?? []).map((b) => ({ key: `${b.entity}-${b.currency}`, label: b.entity, values: { r: b.calculatedOnReconciled, k: b.calculatedOnRecorded } }))} />
        {last && last.notCalculable.length > 0 && (
          <BarresParDevise title="Assiette des clés non calculables" subtitle="Clés à vérifier : assiette seulement, aucune part" series={[{ key: 'b', label: 'Assiette' }]}
            rows={last.notCalculable.map((n) => ({ key: n.code, label: n.code, values: { b: n.base } }))} />
        )}
      </Visuels>
    </>
  );
}

interface KeyRow { code: string; label: string; status: string; reason?: string; legalReference: string; categories: string[]; beneficiaries: { beneficiary: string; label: string; rateKey: string; remainder: boolean }[]; versions: { id: string; version: number; status: string; executable: boolean }[] }
interface Calc { id: string; period: string; calculatedAt: string; scope: string; notice: string; notCalculable: { code: string; reason: string; base: MoneyJSON[] }[]; byEntity: { entity: string; label: string; currency: string; calculatedOnReconciled: MoneyJSON; calculatedOnRecorded: MoneyJSON }[] }
interface Incentive { id: string; code: string; label: string; legalBasis: string; cap: string; status: string; payout: string }

export default function PartageLegal() {
  const { user } = useApp();
  const keys = useApi(() => api<{ notice: string; keys: KeyRow[] }>('/v1/legal-shares/keys'), [user?.id]);
  const calcs = useApi(() => api<{ items: Calc[] }>('/v1/legal-shares'), [user?.id]);
  const inc = useApi(() => api<{ notice: string; required: string[]; items: Incentive[] }>('/v1/legal-shares/incitations'), [user?.id]);
  const reload = () => { keys.reload(); calcs.reload(); inc.reload(); };
  const r = useRunner(reload);
  const [period, setPeriod] = useState(currentQuarter());
  const last = calcs.data?.items[0];
  const [f, setF] = useState({ code: '', label: '', legalBasis: '', approvedFormula: '', conditions: '', cap: '', antiGamingControl: '', taxTreatment: '', approvalCircuit: '', accounting: '' });
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Pilotage · § 27.1 et § 30.6" title="Partage légal des recettes" lead="Clés légales entre la province, les entités territoriales décentralisées et le pouvoir central, versionnées au registre juridique. Distinct de la clé du § 37A." />
      <Notice msg={r.msg} />
      {keys.loading && !keys.data ? <Loading /> : keys.error ? <ErrorState error={keys.error} onRetry={reload} /> : keys.data && (
        <div className="dash-grid">
          <div className="span-12"><Callout tone="warn">{keys.data.notice}</Callout></div>
          <VisuelsPartage keys={keys.data.keys} last={last} incitations={inc.data?.items ?? []} />
          <Section title="Clés légales">
            <DataTable caption="Clés" rows={keys.data.keys} rowKey={(k) => k.code} columns={[
              { key: 'c', label: 'Clé', primary: true, render: (k) => <><strong>{k.label}</strong><span className="small muted" style={{ display: 'block' }}>{k.code} · {k.legalReference}</span></> },
              { key: 'b', label: 'Bénéficiaires', render: (k) => <span className="small">{k.beneficiaries.map((b) => `${b.label}${b.remainder ? ' (solde)' : ''}`).join(' ; ')}</span> },
              { key: 's', label: 'Statut', render: (k) => <><StatusBadge tone={k.status === 'ACTIVE' ? 'good' : 'warning'} label={k.status === 'ACTIVE' ? 'Active (certifiée)' : 'À vérifier'} />{k.reason && <span className="small muted" style={{ display: 'block' }}>{k.reason}</span>}</> },
              { key: 'v', label: 'Versions', render: (k) => <span className="small">{k.versions.map((v) => `v${v.version} ${v.status}`).join(' · ')}</span> },
            ]} />
          </Section>
          <Section title="Parts par entité" sub={last ? `Calcul ${last.id} (${last.period}) — ${last.scope}` : 'Aucun calcul'} tools={hasRole(user?.roles, 'R05', 'R15', 'R17', 'R18') ? (
            <span className="btn-row"><label className="pl-filter"><span>Période</span><input value={period} onChange={(e) => setPeriod(e.target.value)} /></label>
              <button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/legal-shares/calculate', { period }, 'Calcul enregistré (aucun virement).')}>Calculer</button></span>) : undefined}>
            {last ? (
              <>
                <DataTable caption="Parts par entité" rows={last.byEntity} rowKey={(b) => `${b.entity}-${b.currency}`} empty={<EmptyState title="Aucune part calculée" icon="scale">Clés non certifiées : assiette seulement.</EmptyState>} columns={[
                  { key: 'e', label: 'Entité', primary: true, render: (b) => <><strong>{b.entity}</strong><span className="small muted" style={{ display: 'block' }}>{b.label}</span></> },
                  { key: 'r', label: 'Calculée sur le rapproché', num: true, render: (b) => moneyText(b.calculatedOnReconciled) },
                  { key: 'k', label: 'Calculée sur le comptabilisé', num: true, render: (b) => moneyText(b.calculatedOnRecorded) },
                ]} />
                {last.notCalculable.map((n) => <p key={n.code} className="small muted">{n.code} : {n.reason} Assiette : {moneysText(n.base)}.</p>)}
                <p className="small muted">{last.notice}</p>
              </>
            ) : <EmptyState title="Aucun calcul" icon="scale" />}
          </Section>
          <Section title="Cadres d’incitation de performance (§ 27.1)" sub={inc.data?.notice}>
            <DataTable caption="Incitations" rows={inc.data?.items ?? []} rowKey={(x) => x.id} empty={<EmptyState title="Aucun cadre enregistré" icon="scale" />} columns={[
              { key: 'l', label: 'Cadre', primary: true, render: (x) => <><strong>{x.label}</strong><span className="small muted" style={{ display: 'block' }}>{x.code} · {x.legalBasis} · plafond {x.cap}</span></> },
              { key: 's', label: 'Statut', render: (x) => <StatusBadge tone={x.status === 'ACTE_ENREGISTRE' ? 'good' : 'warning'} label={x.status === 'ACTE_ENREGISTRE' ? 'Acte enregistré' : 'À vérifier'} /> },
              { key: 'p', label: 'Versement', render: () => 'Aucun' },
            ]} />
            {hasRole(user?.roles, 'R05', 'R15', 'R13') && (
              <div className="form">
                {([['code', 'Code'], ['label', 'Intitulé'], ['legalBasis', 'Base légale'], ['approvedFormula', 'Formule approuvée'], ['conditions', 'Conditions'], ['cap', 'Plafond'], ['antiGamingControl', 'Contrôle anti-optimisation'], ['taxTreatment', 'Traitement fiscal'], ['approvalCircuit', 'Circuit d’approbation'], ['accounting', 'Comptabilisation']] as [keyof typeof f, string][]).map(([k, l]) => (
                  <Field key={k} label={l} value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} />
                ))}
                <div className="btn-row"><button type="button" className="btn btn-primary btn-sm" disabled={r.busy} onClick={() => void r.run('/v1/legal-shares/incitations', f, 'Cadre enregistré (à vérifier, aucun versement).')}>Enregistrer le cadre</button></div>
              </div>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}
