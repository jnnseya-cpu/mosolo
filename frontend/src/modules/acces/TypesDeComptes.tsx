/**
 * Référentiel des types de comptes (27/09/2026) : les 37 rôles, leur famille, leur parcours de création réel, qui peut
 * inviter, la seconde validation, le niveau de second facteur, les natures d'entité (indicatives) et le décompte vivant
 * des comptes par état — avec les graphiques de la trousse de visualisation (charte : docs/document-maitre/charte-visualisation.md).
 */
import { useMemo, useState } from 'react';
import { PageHead } from '../../components/Shell';
import { Chip } from '../../components/StatusBadge';
import { ErrorState, ExampleNotice, Loading } from '../../components/States';
import { Icon } from '../../components/Icon';
import { ChartGrid, KpiGrid, KpiTile, StackedBarViz, fmtNombre } from '../../components/viz';
import { useApp } from '../../context';
import { useApi } from '../../hooks/useApi';
import { api } from '../../lib/api';
import { Status } from './common';
import './acces.css';
import './departements.css';

export interface AccountType {
  code: string; label: string; family: string; familyLabel: string; creationPath: string; creationPathLabel: string;
  invitableBy: { code: string; label: string }[]; inviteNote: string; level: string | null; levelLabel: string; sensitive: boolean;
  secondValidation: { code: string; label: string } | null; mfa: { code: string; label: string };
  entityKinds: { code: string; label: string }[]; entityKindsStatus: string; count: number; byStatus: Record<string, number>;
  exemples: { id: string; name: string; tag: string }[];
}
export interface AccountTypesRef {
  types: AccountType[]; families: { code: string; label: string; count: number }[]; total: number; scope: 'TOUT' | 'SOUS_ARBRE'; note: string;
}

/** États des comptes, dans l'ordre de lecture (séries disjointes : un compte n'a qu'un état). */
export const ACCOUNT_STATUS_SERIES = [
  { key: 'ACTIF', label: 'Actif' },
  { key: 'ATTENTE_VALIDATION', label: 'Seconde validation attendue' },
  { key: 'ATTENTE_SECRETS', label: 'Secrets à définir' },
  { key: 'SUSPENDU', label: 'Suspendu' },
  { key: 'REVOQUE', label: 'Révoqué' },
  { key: 'EXPIRE', label: 'Expiré' },
] as const;

/** Lignes « famille × état » pour une pile (valeurs nulles si aucun compte : jamais inventées). */
export function familyStatusRows(ref: AccountTypesRef) {
  return ref.families.map((f) => {
    const values: Record<string, number | null> = {};
    for (const s of ACCOUNT_STATUS_SERIES) values[s.key] = ref.types.filter((t) => t.family === f.code).reduce((n, t) => n + (t.byStatus[s.key] ?? 0), 0);
    return { key: f.code, label: f.label, values };
  });
}

const PATH_ICON: Record<string, string> = {
  INVITATION: 'users', INSCRIPTION_PUBLIQUE: 'user', INSCRIPTION_MANDATAIRE: 'scale', CONTRAT_PARTENAIRE: 'file',
  ACCREDITATION_SOUS_TRAITANT: 'shieldCheck', DESIGNATION_OBSERVATEUR: 'globe', SERVICE_VERIFICATEUR: 'check',
};

export default function TypesDeComptes() {
  const { user } = useApp();
  const ref = useApi(() => api<AccountTypesRef>('/v1/acces/types-de-comptes'), [user?.id]);
  const [family, setFamily] = useState<string>('TOUTES');
  const [q, setQ] = useState('');
  const d = ref.data;
  const list = useMemo(() => (d?.types ?? []).filter((t) => (family === 'TOUTES' || t.family === family)
    && (!q.trim() || `${t.code} ${t.label}`.toLowerCase().includes(q.trim().toLowerCase()))), [d, family, q]);
  const active = d ? d.types.reduce((n, t) => n + (t.byStatus.ACTIF ?? 0), 0) : null;
  const pending = d ? d.types.reduce((n, t) => n + (t.byStatus.ATTENTE_VALIDATION ?? 0) + (t.byStatus.ATTENTE_SECRETS ?? 0), 0) : null;
  const created = d ? d.types.filter((t) => t.count > 0).length : null;

  return (
    <div className="page dp-page">
      <PageHead eyebrow="Accès (§ 12, § 12A)" title="Types de comptes"
        lead="Les 37 rôles de la plateforme : comment chaque compte est créé, qui peut l’inviter, quelle seconde validation et quel second facteur il exige." />
      {ref.error !== null && <ErrorState error={ref.error} onRetry={ref.reload} />}
      {ref.loading && <Loading />}
      {d && (
        <div className="stack">
          <KpiGrid max={4} label="Comptes par état">
            <KpiTile hero label="Comptes (tous rôles)" value={d.total} format={fmtNombre} sub={d.scope === 'SOUS_ARBRE' ? 'Votre entité et ses sous-entités' : 'Toute la plateforme'} />
            <KpiTile label="Comptes actifs" value={active} format={fmtNombre} state={{ label: 'Actif', tone: 'good' }} />
            <KpiTile label="En attente (validation ou secrets)" value={pending} format={fmtNombre} state={{ label: 'En attente', tone: 'warning' }} />
            <KpiTile label="Types de comptes créés" value={created} unit="/ 37" format={fmtNombre} sub="Au moins un compte existant" />
          </KpiGrid>
          <ChartGrid min={300}>
            <StackedBarViz className="viz-span-all" title="Comptes par famille et par état" subtitle={d.note} orientation="horizontal" mode="absolute" format={fmtNombre}
              series={ACCOUNT_STATUS_SERIES} rows={familyStatusRows(d)} />
          </ChartGrid>
          <ExampleNotice text="Comptes de démonstration marqués [EXEMPLE] : fictifs, non contractuels. Natures d’entité indicatives — par défaut, à confirmer par le maître d’ouvrage." />

          <section className="panel" aria-labelledby="tc-list">
            <header className="panel-head">
              <div><h2 className="panel-title" id="tc-list">Référentiel des 37 rôles</h2><p className="panel-sub">Filtrer par famille ou rechercher un rôle</p></div>
              <span className="count">{list.length}</span>
            </header>
            <div className="dp-filters">
              <div className="field dp-search">
                <label className="label" htmlFor="tc-q">Rechercher</label>
                <input id="tc-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="R17, comptable, mandataire…" />
              </div>
              <div className="field">
                <label className="label" htmlFor="tc-f">Famille</label>
                <select id="tc-f" value={family} onChange={(e) => setFamily(e.target.value)}>
                  <option value="TOUTES">Toutes les familles</option>
                  {d.families.map((f) => <option key={f.code} value={f.code}>{f.label} ({f.count})</option>)}
                </select>
              </div>
            </div>
            <ul className="dp-types" aria-label="Types de comptes">
              {list.map((t) => (
                <li key={t.code} className="ac-card dp-type">
                  <div className="ac-card-head">
                    <div className="min0">
                      <p className="ac-card-title"><span className="mono">{t.code}</span> {t.label}</p>
                      <div className="ac-meta"><span>{t.familyLabel}</span><span>{t.levelLabel}</span>{t.sensitive && <span>Rôle sensible</span>}</div>
                    </div>
                    <span className="dp-count" aria-label={`${t.count} compte(s)`}>{t.count}</span>
                  </div>
                  <dl className="dp-dl">
                    <div><dt><Icon name={PATH_ICON[t.creationPath] ?? 'users'} size={14} /> Création</dt><dd>{t.creationPathLabel}</dd></div>
                    <div><dt>Qui peut inviter</dt><dd>{t.invitableBy.length ? <span className="chips">{t.invitableBy.map((r) => <Chip key={r.code} title={r.label}>{r.code}</Chip>)}</span> : 'Personne (inscription publique)'}<br /><span className="small muted">{t.inviteNote}</span></dd></div>
                    <div><dt>Seconde validation</dt><dd>{t.secondValidation ? t.secondValidation.label : 'Non requise'}</dd></div>
                    <div><dt>Second facteur</dt><dd>{t.mfa.label}</dd></div>
                    <div><dt>Natures d’entité</dt><dd><span className="chips">{t.entityKinds.map((k) => <Chip key={k.code}>{k.label}</Chip>)}</span></dd></div>
                    <div><dt>Comptes par état</dt><dd>{Object.keys(t.byStatus).length ? <span className="chips">{Object.entries(t.byStatus).map(([s, n]) => <span key={s} className="dp-st"><Status s={s} /> {n}</span>)}</span> : 'Aucun compte'}</dd></div>
                    {t.exemples.length > 0 && <div><dt>Démonstration</dt><dd className="small">{t.exemples.map((e) => `${e.tag} ${e.name}`).join(' · ')}</dd></div>}
                  </dl>
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
