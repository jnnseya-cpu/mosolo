/**
 * Module 9 — Intelligence foncière et locative (Spécification fonctionnelle ; § 16.2, § 16.6).
 *
 * Compléments au registre des unités et des baux (objets, baux, attestations, anomalies, élargissement 2026 et carte
 * à deux couches sont servis par le module « fiscal ») :
 *  - calcul de la retenue et de l'IRL annuel À PARTIR DES BAUX VÉRIFIÉS, avec le taux et la retenue de la fiche IRL du
 *    rang de localité (arrêté de référence cité) : montant INDICATIF sur règle ACTIVE, ILLUSTRATION NON OPPOSABLE sur
 *    fiche « À VÉRIFIER » — aucune dette n'est créée ici ;
 *  - couverture locative par avenue, quartier et commune ;
 *  - loyer et identité du locataire visibles uniquement des rôles habilités (masqués sinon).
 */
import { isRuleExecutable, Money, type MoneyJSON, type RuleSheet } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { authorize, definePolicy, evaluate, GRANTS } from '../../core/policy.js';
import type { Lease } from '../../modules/objects/service.js';
import { pct } from './common.js';

const { always, inTerritory } = GRANTS;
definePolicy('citoyen:locatif.read', { R01: always, R05: always, R06: always, R07: always, R11: always, R22: always, R24: always, R09: inTerritory('minimal') });
/** Loyer et identité du locataire : rôles habilités seulement (§ 16, module 9 « contrôles propres »). */
definePolicy('citoyen:locatif.loyer', { R06: always, R07: always, R11: always, R22: always, R24: always });

const FACTEUR: Record<Lease['periodicity'], number> = { MENSUELLE: 12, TRIMESTRIELLE: 4, SEMESTRIELLE: 2, ANNUELLE: 1 };

export class LocatifService {
  constructor(private readonly ctx: AppContext) {}

  /** Fiche IRL applicable au rang : version exécutable d'abord, sinon la plus récente (illustration non opposable). */
  regleIrl(rang: number): RuleSheet | undefined {
    const code = rang === 1 ? 'IRL-KIN-R1' : 'IRL-KIN-R234';
    const versions = this.ctx.rules.list().filter((r) => r.code === code && !['ABROGEE', 'ARCHIVEE', 'BROUILLON'].includes(r.status));
    const exec = versions.filter((r) => isRuleExecutable(r, this.ctx.clock.now()).ok).sort((a, b) => b.version - a.version);
    return exec[0] ?? versions.sort((a, b) => b.version - a.version)[0];
  }

  calcul(user: User, filtre: { commune?: string; verifiesSeulement?: boolean } = {}) {
    authorize(user, 'citoyen:locatif.read', filtre.commune ? { communes: [filtre.commune] } : {});
    const voitLoyer = !!evaluate(user, 'citoyen:locatif.loyer');
    const lignes = this.ctx.objects.leases.all().flatMap((l) => {
      const unit = this.ctx.objects.objects.get(l.unitObjectId);
      if (!unit || (filtre.commune && unit.commune !== filtre.commune)) return [];
      if (!evaluate(user, 'citoyen:locatif.read', { communes: [unit.commune] })) return [];
      const verifie = l.probativeStatus === 'VERIFIE';
      if (filtre.verifiesSeulement !== false && !verifie) return [];
      const annuel = Money.fromJSON(l.rent).multiply(String(FACTEUR[l.periodicity]));
      const regle = this.regleIrl(unit.localityRank);
      let retenue: MoneyJSON | null = null;
      let irl: MoneyJSON | null = null;
      let nature: 'INDICATIF' | 'ILLUSTRATION_NON_OPPOSABLE' | 'SANS_REGLE' = 'SANS_REGLE';
      let mention = 'Aucune fiche IRL au registre pour ce rang : aucun calcul.';
      if (regle) {
        nature = isRuleExecutable(regle, this.ctx.clock.now()).ok ? 'INDICATIF' : 'ILLUSTRATION_NON_OPPOSABLE';
        const tauxRetenue = regle.rateTable['taux_retenue'];
        if (tauxRetenue !== undefined) retenue = annuel.percent(tauxRetenue, regle.rounding).toJSON();
        const ev = this.ctx.rules.evaluate(regle, { loyers_percus: annuel.toDecimalString(), retenues_imputees: retenue?.amount ?? '0' }, unit.localityRank);
        // L'IRL porte sur les loyers : exprimé dans la devise du bail (le taux est sans unité).
        irl = Money.of(ev.value, annuel.currency, regle.rounding).toJSON();
        mention = nature === 'INDICATIF'
          ? `Montant indicatif sur la règle ACTIVE ${regle.code} v${regle.version} (aucune dette tant qu’une liquidation n’est pas décidée).`
          : `Illustration NON OPPOSABLE : fiche ${regle.code} v${regle.version} au statut ${regle.status} (taux ${regle.rateTable['taux'] ?? '—'} %, retenue ${tauxRetenue ?? '—'} %, à vérifier).`;
      }
      return [{
        bail: l.id, unite: unit.id, igf: unit.igf?.code ?? null, commune: unit.commune, quartier: unit.quartier, avenue: unit.avenue ?? null, rang: unit.localityRank,
        statutProbant: l.probativeStatus, periodicite: l.periodicity,
        loyer: voitLoyer ? l.rent : null, loyerAnnuel: voitLoyer ? annuel.toJSON() : null, locataire: voitLoyer ? l.lesseeId ?? null : null,
        retenue: voitLoyer ? retenue : null, irlAnnuel: voitLoyer ? irl : null,
        regle: regle ? { code: regle.code, version: regle.version, statut: regle.status, articles: regle.articles, instruments: regle.legalInstrumentIds } : null,
        nature, mention,
      }];
    });
    return {
      lignes, masque: !voitLoyer,
      notice: voitLoyer ? 'Calcul sur baux vérifiés : proposition de liquidation, jamais une dette automatique.' : 'Loyer, locataire et montants masqués pour votre rôle.',
    };
  }

  couverture(user: User, niveau: 'commune' | 'quartier' | 'avenue', commune?: string) {
    authorize(user, 'citoyen:locatif.read', commune ? { communes: [commune] } : {});
    const units = this.ctx.objects.objects.find((o) => o.category === 'UNITE_LOCATIVE' && (!commune || o.commune === commune) && !!evaluate(user, 'citoyen:locatif.read', { communes: [o.commune] }));
    const leases = this.ctx.objects.leases.all();
    const keyOf = (o: (typeof units)[number]) => niveau === 'commune' ? o.commune : niveau === 'quartier' ? `${o.commune} › ${o.quartier}` : `${o.commune} › ${o.quartier} › ${o.avenue ?? 'avenue non renseignée'}`;
    const groups = new Map<string, typeof units>();
    for (const u of units) groups.set(keyOf(u), [...(groups.get(keyOf(u)) ?? []), u]);
    return {
      niveau,
      lignes: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'fr')).map(([zone, us]) => {
        const avecBail = us.filter((u) => leases.some((l) => l.unitObjectId === u.id));
        const verifies = us.filter((u) => leases.some((l) => l.unitObjectId === u.id && l.probativeStatus === 'VERIFIE'));
        return { zone, unites: us.length, avecBail: avecBail.length, bauxVerifies: verifies.length, couverture: pct(avecBail.length, us.length), couvertureVerifiee: pct(verifies.length, us.length) };
      }),
    };
  }

  indicateurs() {
    const leases = this.ctx.objects.leases.all();
    const units = this.ctx.objects.objects.find((o) => o.category === 'UNITE_LOCATIVE');
    const leased = new Set(leases.map((l) => l.unitObjectId));
    const verifies = leases.filter((l) => l.probativeStatus === 'VERIFIE');
    const assiette = new Map<string, Money>();
    for (const l of verifies) {
      const a = Money.fromJSON(l.rent).multiply(String(FACTEUR[l.periodicity]));
      assiette.set(a.currency, (assiette.get(a.currency) ?? Money.zero(a.currency)).add(a));
    }
    const irlObls = this.ctx.assessment.obligations.find((o) => o.ruleCode.startsWith('IRL') && !o.supersededBy && o.status !== 'ANNULEE');
    const conformes = irlObls.filter((o) => o.status === 'SOLDEE');
    return {
      bauxEnregistres: { valeur: leases.length, verifies: verifies.length },
      couvertureLocative: { valeur: pct(units.filter((u) => leased.has(u.id)).length, units.length), numerateur: units.filter((u) => leased.has(u.id)).length, denominateur: units.length, ...(units.length ? {} : { raison: 'Aucune unité locative recensée.' }) },
      assietteIrlVerifiee: { valeur: [...assiette.values()].map((m) => m.toJSON()), definition: 'Loyers annuels des baux au statut VERIFIE (par devise).' },
      tauxConformite: irlObls.length
        ? { valeur: pct(conformes.length, irlObls.length), numerateur: conformes.length, denominateur: irlObls.length, definition: 'Obligations IRL soldées / obligations IRL émises.' }
        : { valeur: null, raison: 'Aucune obligation IRL émise (aucune règle IRL ACTIVE) : conformité non mesurée.' },
    };
  }
}
