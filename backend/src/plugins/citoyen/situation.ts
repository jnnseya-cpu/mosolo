/**
 * Module 3 — Attestation de situation du contribuable (Spécification fonctionnelle : « exporter une attestation de
 * situation ou un quitus fiscal lorsque les conditions sont réunies »).
 *
 * L'attestation photographie, à l'heure du SERVEUR, la situation du compte : objets et couleur de situation, obligations
 * par statut, restes à payer par devise, contestations en cours, éligibilité au quitus (conditions du module fiscal).
 * Elle est numérotée, signée (HMAC) et vérifiable publiquement sous une forme MINIMALE (authenticité, date, compte
 * masqué, « à jour » ou non) — aucune donnée de tiers ; le quitus reste délivré par son propre circuit.
 */
import { Money, type MoneyJSON } from '@mosolo/shared';
import type { AppContext } from '../../context.js';
import type { User } from '../../core/auth.js';
import { actorOf } from '../../core/audit.js';
import { checkChar, hmacSha256Hex } from '../../core/crypto.js';
import { authorize, definePolicy, GRANTS } from '../../core/policy.js';
import { IdGenerator, InMemoryRepository } from '../../core/repository.js';
import { PAYABLE_STATUSES } from '../../modules/assessment/service.js';
import { situationOf } from '../fiscal/situation.js';
import { fiscalOf } from './common.js';

const { always, ownTaxpayer, mandant } = GRANTS;
definePolicy('citoyen:situation.attester', { R30: ownTaxpayer, R31: mandant, R12: always, R06: always, R07: always, R11: always });

export interface AttestationSituation {
  id: string;
  numero: string;
  taxpayerId: string;
  iucMasque: string;
  emiseLe: string;
  emisePar: string;
  objets: { id: string; igf: string | null; categorie: string; commune: string; couleur: string; libelle: string }[];
  obligations: { total: number; parStatut: Record<string, number>; resteAPayer: MoneyJSON[]; contestees: number };
  aJour: boolean;
  quitus: { eligible: boolean; bloquants: number; mention: string } | null;
  signature: string;
}

export class SituationService {
  readonly attestations = new InMemoryRepository<AttestationSituation>();
  private readonly ids = new IdGenerator();
  private readonly cle: string;

  constructor(private readonly ctx: AppContext) {
    this.cle = hmacSha256Hex(ctx.secrets.auditHmacKey, 'mosolo:attestation-situation:v1');
  }

  private signer(a: Omit<AttestationSituation, 'signature'>) {
    return hmacSha256Hex(this.cle, `${a.id}|${a.numero}|${a.taxpayerId}|${a.emiseLe}|${a.aJour}|${a.obligations.total}`).slice(0, 32);
  }

  emettre(user: User, taxpayerIdIn?: string) {
    const taxpayerId = taxpayerIdIn ?? user.taxpayerId ?? user.mandants?.[0];
    authorize(user, 'citoyen:situation.attester', taxpayerId ? { taxpayerId } : {});
    const tp = this.ctx.taxpayers.get(taxpayerId!);
    const fiscal = fiscalOf(this.ctx);
    const objets = this.ctx.objects.byTaxpayer(tp.id).map((o) => {
      const s = fiscal ? situationOf(fiscal.d, o) : { color: 'grey', label: 'Situation non calculée' };
      return { id: o.id, igf: o.igf?.code ?? null, categorie: o.category, commune: o.commune, couleur: s.color, libelle: s.label };
    });
    const obls = this.ctx.assessment.byTaxpayer(tp.id).filter((o) => o.status !== 'ANNULEE' && !o.supersededBy);
    const parStatut: Record<string, number> = {};
    const reste = new Map<string, Money>();
    for (const o of obls) {
      parStatut[o.status] = (parStatut[o.status] ?? 0) + 1;
      if (PAYABLE_STATUSES.includes(o.status)) {
        const due = Money.fromJSON(o.amount).subtract(this.ctx.payments.paidOn(o.id));
        if (due.minor > 0n) reste.set(due.currency, (reste.get(due.currency) ?? Money.zero(due.currency)).add(due));
      }
    }
    const elig = fiscal?.clearances.eligibility(tp.id);
    const at = this.ctx.clock.now();
    const seq = this.ids.next('ASI', 6).split('-').pop()!;
    const numero = `ASI-${at.getUTCFullYear()}-${seq}-${checkChar(`ASI${at.getUTCFullYear()}${seq}`)}`;
    const base: Omit<AttestationSituation, 'signature'> = {
      id: numero, numero, taxpayerId: tp.id, iucMasque: `${tp.iuc.slice(0, 4)}••••${tp.iuc.slice(-2)}`, emiseLe: at.toISOString(), emisePar: user.id, objets,
      obligations: { total: obls.length, parStatut, resteAPayer: [...reste.values()].map((m) => m.toJSON()), contestees: parStatut['CONTESTEE'] ?? 0 },
      aJour: reste.size === 0 || (elig?.eligible ?? false),
      quitus: elig ? { eligible: elig.eligible, bloquants: elig.blockers.length, mention: elig.notice } : null,
    };
    const a = this.attestations.insert({ ...base, signature: this.signer(base) });
    this.ctx.audit.append({ actor: actorOf(user), action: 'taxpayer.situation.attested', resourceType: 'taxpayer', resourceId: tp.id, details: { numero, aJour: a.aJour } });
    return { ...a, verification: `/v1/public/attestations-situation/${numero}?sig=${a.signature}`, notice: 'Attestation de situation à la date et à l’heure du serveur ; ce n’est pas un quitus. Le quitus est délivré lorsque ses conditions sont réunies.' };
  }

  /** Vérification publique minimale : authenticité, date, compte masqué, à jour ou non. */
  verifier(numero: string, sig?: string) {
    const a = this.attestations.get(numero.trim().toUpperCase());
    this.ctx.audit.append({ actor: { kind: 'public', id: 'verification-publique' }, action: 'taxpayer.situation.checked', resourceType: 'situation_attestation', resourceId: numero });
    if (!a) return { numero, authentique: false, message: 'Aucune attestation ne correspond à ce numéro.' };
    const authentique = !!sig && sig === a.signature;
    return { numero: a.numero, authentique, emiseLe: a.emiseLe, compte: a.iucMasque, ...(authentique ? { aJour: a.aJour } : {}), message: authentique ? (a.aJour ? 'Attestation authentique : compte à jour à la date d’émission.' : 'Attestation authentique : obligations ouvertes à la date d’émission.') : 'Signature absente ou invalide : contenu non confirmé.' };
  }
}
