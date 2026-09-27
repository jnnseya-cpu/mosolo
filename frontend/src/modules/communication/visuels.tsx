/**
 * Notifications et communication — visuels (trousse de visualisation, 27/09/2026). Taux de délivrance, délai et
 * ouverture tels que servis par /v1/communication/indicateurs : « non mesuré » avec son motif tant qu'aucun
 * fournisseur ne renvoie d'accusé (aucun taux inventé) ; modèles et avis sur plaque tirés des listes de l'écran.
 */
import { countBy } from '../../lib/aggregate';
import { ChartGrid, GaugeMeter, KpiGrid, KpiTile } from '../../components/viz';
import { ActiviteParJour, Barres, barresDe, Etats, etatsDe, nombreDe, Parts } from '../plateforme/visuels';
import '../plateforme/visuels.css';

interface Mesure { statut: string; taux?: string | null; motif?: string; medianeMinutes?: number; delivres?: number; mesurables?: number }
interface Ind { delivrance: Mesure; delai: Mesure; ouverture: { messages: Mesure; avisLegaux: Mesure }; bacASable: number; avisPlaque: { aApposer: number; apposes: number }; modeles: { actifs: number; brouillons: number }; raccordement: string }

const val = (m: Mesure) => (m.statut === 'MESURE' ? nombreDe(m.taux ?? null) : null);

export function CommunicationVisuels({ d }: { d: Ind }) {
  return (
    <div className="vz-bloc" data-testid="communication-visuels">
      <KpiGrid max={4} label="Notifications — chiffres clés">
        <KpiTile hero label="Taux de délivrance" value={val(d.delivrance)} unit="%" reason={d.delivrance.motif ?? 'Non mesuré.'}
          sub={d.delivrance.statut === 'MESURE' ? `${d.delivrance.delivres}/${d.delivrance.mesurables} envoi(s) mesurable(s)` : undefined} />
        <KpiTile label="Délai de délivrance (médiane)" value={d.delai.statut === 'MESURE' ? d.delai.medianeMinutes ?? null : null} unit="min" reason={d.delai.motif ?? 'Non mesuré.'} />
        <KpiTile label="Envois journalisés (bac à sable)" value={d.bacASable} sub={d.raccordement} />
        <KpiTile label="Avis sur plaque à apposer" value={d.avisPlaque.aApposer} state={{ label: `${d.avisPlaque.apposes} apposé(s)`, tone: d.avisPlaque.aApposer ? 'warning' : 'good' }} />
      </KpiGrid>
      <ChartGrid min={260} label="Notifications — graphiques">
        <GaugeMeter title="Ouverture des messages" value={val(d.ouverture.messages)} unit="%" reason={d.ouverture.messages.motif ?? 'Non mesurée.'} />
        <GaugeMeter title="Ouverture des avis légaux" value={val(d.ouverture.avisLegaux)} unit="%" reason={d.ouverture.avisLegaux.motif ?? 'Non mesurée.'} />
        <Parts title="Avis imprimés sur plaque" centerLabel="avis" emptyText="Aucun avis sur plaque"
          slices={[{ key: 'a', label: 'À apposer', value: d.avisPlaque.aApposer }, { key: 'p', label: 'Apposés (preuve de remise)', value: d.avisPlaque.apposes }]} />
        <Parts title="Modèles de message" centerLabel="modèles" emptyText="Aucun modèle : texte par défaut du catalogue"
          slices={[{ key: 'a', label: 'Actifs', value: d.modeles.actifs }, { key: 'b', label: 'Brouillons (seconde personne)', value: d.modeles.brouillons }]} />
      </ChartGrid>
    </div>
  );
}

const LANGUES: Record<string, string> = { fr: 'Français', ln: 'Lingala', sw: 'Swahili', kg: 'Kikongo', lua: 'Tshiluba', en: 'Anglais (English)' };

export function ModelesVisuels({ items, statuts }: { items: { status: string; lang: string }[]; statuts: Record<string, { label: string; tone: 'good' | 'warning' | 'neutral' | 'critical' }> }) {
  return (
    <ChartGrid min={260} className="vz-bloc" label="Modèles — graphiques">
      <Etats title="Modèles par état" unitLabel="modèles" items={etatsDe(items, (t) => t.status, statuts, ['BROUILLON', 'ACTIF', 'ARCHIVE', 'REJETE'])} emptyText="Aucun modèle" />
      <Barres title="Modèles par langue" serie="Modèles" rows={barresDe(countBy(items, (t) => t.lang), LANGUES)} emptyText="Aucun modèle" />
    </ChartGrid>
  );
}

export function AvisPlaqueVisuels({ items }: { items: { posting?: unknown; origin: string; createdAt: string }[] }) {
  return (
    <ChartGrid min={260} className="vz-bloc" label="Avis sur plaque — graphiques">
      <Etats title="Avis sur plaque par état" unitLabel="avis" emptyText="Aucun avis"
        items={etatsDe(items, (n) => (n.posting ? 'P' : 'A'), { A: { label: 'À apposer', tone: 'warning' }, P: { label: 'Apposé (position et photo)', tone: 'good' } }, ['A', 'P'])} />
      <Parts title="Origine des avis" centerLabel="avis" emptyText="Aucun avis"
        slices={[{ key: 'e', label: 'Canaux épuisés', value: items.filter((n) => n.origin === 'ECHEC_CANAUX').length }, { key: 'm', label: 'Émis manuellement', value: items.filter((n) => n.origin !== 'ECHEC_CANAUX').length }]} />
      <ActiviteParJour className="viz-span-2" title="Avis sur plaque émis" series={[{ key: 'a', label: 'Avis', items: items.map((n) => ({ at: n.createdAt })) }]} />
    </ChartGrid>
  );
}

/** Mes préférences : canaux autorisés / refusés / préféré (état du formulaire), historique des modifications. */
export function PreferencesVisuels({ channels, disabled, preferred, history }: { channels: Record<string, string>; disabled: string[]; preferred: string; history: { at: string }[] }) {
  const etat = (k: string) => (k === preferred ? 'PREF' : disabled.includes(k) ? 'OFF' : 'ON');
  return (
    <ChartGrid min={260} className="vz-bloc" label="Mes préférences — graphiques">
      <Etats title="Mes canaux" unitLabel="canaux" items={etatsDe(Object.keys(channels), etat, { PREF: { label: 'Canal préféré', tone: 'info' }, ON: { label: 'Autorisé', tone: 'good' }, OFF: { label: 'Refusé (messages facultatifs)', tone: 'neutral' } }, ['PREF', 'ON', 'OFF'])}
        note={`Préféré : ${channels[preferred] ?? 'aucun (canaux par défaut)'} · refusés : ${disabled.map((k) => channels[k] ?? k).join(', ') || 'aucun'}. Les avis obligatoires restent toujours envoyés.`} />
      <ActiviteParJour title="Modifications de mes préférences" jours={90} series={[{ key: 'h', label: 'Modifications', items: history }]} />
    </ChartGrid>
  );
}

