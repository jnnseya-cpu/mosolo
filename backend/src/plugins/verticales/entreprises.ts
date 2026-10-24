/**
 * Entreprises et établissements (MOSOLO Business, modules 10, 17, 56 — Spécification fonctionnelle, Partie V) :
 * « Détermination des obligations par activité, lieu et catégorie ».
 *
 * Règle propre : « L'existence d'une activité n'emporte pas assujettissement : la règle décide. » La détermination
 * ne crée donc aucune obligation : pour un établissement, elle liste les prélèvements CANDIDATS (critères d'activité,
 * de lieu — rang de localité — et de catégorie du redevable), et pour chacun l'état réel de la règle du registre.
 * Seule une règle ACTIVE rend un prélèvement applicable ; la liquidation reste l'acte d'une personne habilitée.
 */
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { notFound, unprocessable } from '../../core/errors.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { ruleCodeFor, type VerticalesService } from './service.js';

const { always, ownTaxpayer, mandant, sameEntity } = GRANTS;
export const PB = { determine: 'verticales:entreprises.determine' } as const;
export function registerEntreprisesPolicies(): void {
  definePolicy(PB.determine, { R30: ownTaxpayer, R31: mandant, R06: sameEntity, R07: sameEntity, R11: sameEntity, R22: always });
}

/** Activités relevant du module 17 (boissons, alcools, tabac) : critère d'activité, jamais un assujettissement. */
const BOISSONS = /(boisson|bi[èe]re|alcool|spiritueux|tabac|bar\b|d[ée]bit)/i;

export class EntreprisesService {
  constructor(private readonly ctx: AppContext, private readonly vx: VerticalesService) {}

  obligationsFor(user: User, objectId: string) {
    const o = this.ctx.objects.objects.get(objectId);
    if (!o || this.vx.verticalOf(o) !== 'entreprises') throw notFound('ESTABLISHMENT_NOT_FOUND', `Établissement inconnu : ${objectId}`);
    if (!o.taxpayerId) throw unprocessable('OBJECT_WITHOUT_TAXPAYER', 'Établissement sans redevable rattaché.');
    authorize(user, PB.determine, { taxpayerId: o.taxpayerId, entity: 'DGTK', communes: [o.commune] });
    const tp = this.ctx.taxpayers.taxpayers.get(o.taxpayerId);
    const activite = String(o.attributes.activite ?? o.attributes.nom ?? '');
    const categorie = tp?.kind ?? 'PERSONNE_PHYSIQUE';
    const year = String(this.ctx.clock.now().getUTCFullYear());
    const code = ruleCodeFor('entreprises')!;
    const active = this.vx.activeRuleFor('entreprises');
    const latest = this.vx.ruleByCode(code);
    const liquidated = this.ctx.assessment.obligations.findOne((ob) => ob.objectId === o.id && ob.ruleCode === code && ob.status !== 'ANNULEE' && ob.createdAt.startsWith(year));
    const ceased = this.vx.cessations.findOne((c) => c.objectId === o.id);
    const items = [{
      code: 'PATENTE', label: 'Patente — certificat d’exploitation (module 10)', module: 10,
      criteres: { activite: activite || 'non renseignée', lieu: `${o.commune} — rang de localité ${o.localityRank}`, categorie },
      ruleCode: code, ruleStatus: active ? 'ACTIVE' : latest?.status ?? 'ACTE_REQUIS', demo: (active ?? latest)?.demo === true,
      applicable: !!active && !ceased,
      liquidatedObligationId: liquidated?.id ?? null,
      action: ceased ? 'Cessation enregistrée : aucune obligation future.'
        : !active ? 'Aucune règle ACTIVE : aucun montant (la règle décide).'
          : liquidated ? 'Obligation de l’exercice déjà liquidée.' : 'Liquidation par une personne habilitée, sur la règle ACTIVE.',
    }];
    const certificate = this.vx.certificates.find((c) => c.objectId === o.id && c.kind === 'AUTORISATION_ACTIVITE').sort((a, b) => b.issuedAt.localeCompare(a.issuedAt))[0];
    if (BOISSONS.test(activite)) {
      items.push({
        code: 'AUTORISATION_DEBIT_BOISSONS', label: 'Autorisation d’exploitation — débit de boissons (module 10)', module: 10,
        criteres: { activite, lieu: o.commune, categorie }, ruleCode: 'DEMANDE_AUTORISATION', ruleStatus: certificate ? this.vx.certificateStatus(certificate) : 'A_DEMANDER', demo: false,
        applicable: true, liquidatedObligationId: null,
        action: certificate ? `Autorisation ${certificate.code} (${this.vx.certificateStatus(certificate)}) vérifiable par QR.` : 'Démarche « Demander une autorisation d’exploitation » à déposer.',
      });
      // Statut réel lu au registre (clé R72-CONSO-BAT), jamais figé dans le code.
      const bat = this.vx.ruleByCode('R72-CONSO-BAT');
      const batActive = !!bat && bat.status === 'ACTIVE';
      items.push({
        code: 'VOLUMES_BAT', label: 'Taxe de consommation — déclaration mensuelle des volumes (module 17)', module: 17,
        criteres: { activite, lieu: o.commune, categorie }, ruleCode: 'R72-CONSO-BAT', ruleStatus: bat?.status ?? 'ACTE_REQUIS', demo: bat?.demo === true, applicable: batActive && !ceased, liquidatedObligationId: null,
        action: batActive ? 'Règle ACTIVE : déclaration mensuelle des volumes, liquidation par une personne habilitée.' : 'Acte requis (J1, J13) : déclaration des volumes possible, aucun montant.',
      });
    }
    return {
      objectId: o.id, activite: activite || null, commune: o.commune, localityRank: o.localityRank, categorie, items,
      certificate: certificate ? { code: certificate.code, status: this.vx.certificateStatus(certificate), validUntil: certificate.validUntil ?? null } : null,
      notice: 'L’existence d’une activité n’emporte pas assujettissement : la règle décide. Cette détermination ne crée aucune obligation.',
    };
  }
}
