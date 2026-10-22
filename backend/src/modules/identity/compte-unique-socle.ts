/**
 * Contributions du SOCLE au compte unique (ch. 9) : objets, baux, obligations, paiements, quittances, recours,
 * notifications. Lecture seule des services existants ; aucune donnée copiée.
 */
import type { CompteElement, CompteUniqueRegistry } from './compte-unique.js';
import type { ObjectService } from '../objects/service.js';
import type { AssessmentService } from '../assessment/service.js';
import type { PaymentService } from '../payments/service.js';
import type { ReceiptService } from '../receipts/service.js';
import type { AppealService } from '../appeals/service.js';
import type { CommunicationService } from '../communications/service.js';

const OBJECT_RUBRIQUE: Record<string, CompteElement['rubrique']> = { VEHICULE: 'VEHICULE', ACTIVITE: 'ENTREPRISE', PANNEAU: 'ENSEIGNE' };
const OBJECT_LABELS: Record<string, string> = {
  PARCELLE: 'Parcelle', BATIMENT: 'Bâtiment', UNITE_LOCATIVE: 'Unité locative', ACTIVITE: 'Activité / établissement', VEHICULE: 'Véhicule', PANNEAU: 'Panneau publicitaire', AUTRE: 'Autre objet',
};

export function registerSocleContributions(reg: CompteUniqueRegistry, s: {
  objects: ObjectService; assessment: AssessmentService; payments: PaymentService; receipts: ReceiptService; appeals: AppealService; comms: CommunicationService;
}): void {
  reg.register({
    module: 'objets', titre: 'Biens et objets fiscaux', lien: '/fiscal/biens',
    collect: (tp) => s.objects.byTaxpayer(tp).map((o) => {
      const plate = o.attributes['immatriculation'] ?? o.attributes['plaque'];
      return {
        rubrique: OBJECT_RUBRIQUE[o.category] ?? 'OBJET', id: o.id, nature: o.category,
        libelle: `${OBJECT_LABELS[o.category] ?? o.category}${typeof plate === 'string' ? ` ${plate}` : ''} — ${o.commune}${o.quartier ? ` · ${o.quartier}` : ''}`,
        statut: o.lifecycle?.state ?? o.status, objectId: o.id, date: o.createdAt,
        lien: o.category === 'VEHICULE' ? '/vehicules/mes-vehicules' : `/chaine/${encodeURIComponent(o.id)}`,
      };
    }),
  });
  reg.register({
    module: 'baux', titre: 'Baux', lien: '/fiscal/baux',
    collect: (tp) => s.objects.leasesOf(tp).map((l) => ({
      rubrique: 'BAIL' as const, id: l.id, nature: l.lessorId === tp ? 'BAILLEUR' : 'LOCATAIRE',
      libelle: `Bail ${l.lessorId === tp ? '(bailleur)' : '(locataire)'} — unité ${l.unitObjectId}`, statut: l.termination ? 'RESILIE' : l.probativeStatus,
      montant: l.rent, date: l.start, ...(l.end ? { echeance: l.end } : {}), objectId: l.unitObjectId, lien: '/fiscal/baux',
    })),
  });
  reg.register({
    module: 'obligations', titre: 'Obligations', lien: '/espace',
    collect: (tp) => s.assessment.byTaxpayer(tp).filter((o) => !o.supersededBy).map((o) => ({
      rubrique: 'OBLIGATION' as const, id: o.id, libelle: o.label, nature: o.revenueCategory, statut: o.status, montant: o.amount,
      echeance: o.dueDate, date: o.createdAt, objectId: o.objectId, lien: `/espace?obligation=${encodeURIComponent(o.id)}`,
    })),
  });
  reg.register({
    module: 'paiements', titre: 'Paiements (références)', lien: '/espace',
    collect: (tp) => s.payments.orders.find((p) => p.taxpayerId === tp).map((p) => ({
      rubrique: 'PAIEMENT' as const, id: p.id, libelle: `Référence ${p.paymentReference}`, statut: p.status, montant: p.amount, date: p.createdAt,
      echeance: p.expiresAt, lien: `/paiement/retour?ref=${encodeURIComponent(p.paymentReference)}`,
      ...(safeObject(s.assessment, p.obligationId) ? { objectId: safeObject(s.assessment, p.obligationId)! } : {}),
    })),
  });
  reg.register({
    module: 'quittances', titre: 'Quittances', lien: '/espace',
    collect: (tp) => s.receipts.byTaxpayer(tp).map((r) => ({
      rubrique: 'QUITTANCE' as const, id: r.id, libelle: `Quittance ${r.number}`, nature: r.revenueCategory, statut: r.status, montant: r.amount,
      date: r.issuedAt, lien: `/verifier/${encodeURIComponent(r.code)}`,
      ...(safeObject(s.assessment, r.obligationId) ? { objectId: safeObject(s.assessment, r.obligationId)! } : {}),
    })),
  });
  reg.register({
    module: 'recours', titre: 'Recours et contestations', lien: '/espace',
    collect: (tp) => s.appeals.appeals.find((a) => a.taxpayerId === tp).map((a) => ({
      rubrique: 'RECOURS' as const, id: a.id, libelle: `Recours sur ${a.obligationId}`, nature: a.type ?? 'RECLAMATION', statut: a.status, date: a.submittedAt,
      lien: `/espace?obligation=${encodeURIComponent(a.obligationId)}`, ...(safeObject(s.assessment, a.obligationId) ? { objectId: safeObject(s.assessment, a.obligationId)! } : {}),
    })),
  });
  reg.register({
    module: 'notifications', titre: 'Notifications', lien: '/espace',
    collect: (tp) => s.comms.inApp.inbox(tp).slice(-50).reverse().map((m, i) => ({
      rubrique: 'NOTIFICATION' as const, id: `${tp}-msg-${i}`, libelle: m.subject, nature: m.eventCode, statut: m.mandatory ? 'OBLIGATOIRE' : 'INFORMATION', date: m.at,
    })),
  });
}

function safeObject(a: AssessmentService, obligationId: string): string | undefined {
  try { return a.get(obligationId).objectId; } catch { return undefined; }
}
