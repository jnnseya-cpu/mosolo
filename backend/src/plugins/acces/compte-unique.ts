/**
 * Module « acces » — branchements du compte unique (ch. 9, ajout du 28/09/2026) :
 *  - garde anti-doublon par NIF à toute création de compte (inscription, canaux, enrôlement) ;
 *  - NIF déclaré à l'inscription ⇒ preuve DÉCLARÉE (contrôlée ensuite par une personne distincte) ;
 *  - portes d'accès de la vue « Mon compte unique » : mandat actif (CONSULTER), consultation motivée ;
 *  - identité enrichie : preuves masquées, niveau N0–N3 et ce que chaque niveau ouvre, prochaines étapes, organisations ;
 *  - contributions : mandats donnés, organisations (compte de la personne morale, rôle de représentant), pièces.
 */
import type { AppContext } from '../../context.js';
import { sha256Hex } from '../../core/crypto.js';
import { kinshasaDate } from '../../core/clock.js';
import type { CompteElement } from '../../modules/identity/compte-unique.js';
import { LEVEL_ORDER, LEVEL_RIGHTS } from './model.js';
import type { AccesService } from './service.js';

const maskRef = (ref: string) => (ref.length > 3 ? `•••${ref.slice(-3)}` : '•••');

export function branchCompteUnique(ctx: AppContext, svc: AccesService): void {
  // Garde anti-doublon : même NIF qu'un autre compte actif ⇒ refus + récupération (jamais un second compte).
  ctx.taxpayers.hooks.duplicateGuards.push(({ nif }) => {
    if (nif) svc.assertIdentifierFree('NIF', nif);
  });
  // NIF saisi à l'inscription : preuve déclarée, contrôlée par une personne distincte (circuit existant).
  ctx.taxpayers.hooks.registered.push((t, input) => {
    const nif = typeof input.nif === 'string' ? input.nif.trim() : '';
    if (!nif) return;
    const at = ctx.clock.now().toISOString();
    svc.proofs.insert({
      id: `PRV-INS-${t.id}`, taxpayerId: t.id, type: 'NIF', referenceMasked: maskRef(nif), referenceHash: sha256Hex(`NIF:${nif.toUpperCase()}`),
      status: 'DECLAREE', declaredBy: 'inscription', declaredAt: at, note: 'NIF déclaré à l’inscription (statut probant : déclaré)',
    });
  });

  const reg = ctx.compteUnique;
  reg.gates.mandate = (userId, taxpayerId) => {
    svc.sweep();
    const today = kinshasaDate(ctx.clock.now());
    const m = svc.mandates.findOne((x) => x.mandataireUserId === userId && x.mandantTaxpayerId === taxpayerId && x.status === 'ACTIF'
      && x.scope.includes('CONSULTER') && x.validFrom <= today && x.validTo >= today);
    return m ? { mandateId: m.id, objectIds: [...m.objectIds] } : null;
  };
  reg.gates.consultation = (userId, taxpayerId, consultationId) => {
    const c = svc.consultations.get(consultationId);
    if (!c || c.userId !== userId || c.taxpayerId !== taxpayerId) return false;
    if (c.expiresAt < ctx.clock.now().toISOString()) return false;
    svc.consultations.update({ ...c, reads: c.reads + 1 });
    ctx.audit.append({ actor: { kind: 'user', id: userId, roles: ctx.users.get(userId)?.roles ?? [] }, action: 'consultation.read', resourceType: 'taxpayer', resourceId: taxpayerId, details: { consultationId, mode: c.mode, purpose: c.purpose, vue: 'compte_unique' } });
    return true;
  };
  reg.gates.identite = (taxpayerId, viewer) => {
    const id = svc.identity(taxpayerId, viewer === 'self' ? 'self' : 'agent');
    const level = LEVEL_ORDER[id.taxpayer.verificationLevel];
    const niveaux = (['N0', 'N0A', 'N1', 'N2', 'N3'] as const).map((n) => ({
      code: n, ...LEVEL_RIGHTS[n], atteint: n === 'N0A' ? id.taxpayer.verificationLevel === 'N0A' : LEVEL_ORDER[n] <= level && (n !== 'N0' || id.taxpayer.verificationLevel !== 'N0A'),
    }));
    const representeAupres = svc.organisations.find((o) => o.representatives.some((r) => r.taxpayerId === taxpayerId)).map((o) => ({
      organisationId: o.id, taxpayerId: o.taxpayerId, raisonSociale: o.raisonSociale,
      fonction: o.representatives.find((r) => r.taxpayerId === taxpayerId)!.fonction, habilitation: o.representatives.find((r) => r.taxpayerId === taxpayerId)!.habilitation,
      mandatActif: !!svc.mandates.findOne((m) => m.mandantTaxpayerId === o.taxpayerId && m.status === 'ACTIF' && ctx.users.get(m.mandataireUserId)?.taxpayerId === taxpayerId),
    }));
    return {
      niveau: id.taxpayer.verificationLevel,
      niveaux,
      prochainesEtapes: viewer === 'mandataire' ? [] : id.nextSteps,
      preuves: viewer === 'mandataire' ? [] : id.proofs.map((p) => ({ id: p.id, type: p.type, reference: p.referenceMasked, statut: p.status, declareeLe: p.declaredAt })),
      organisation: viewer === 'mandataire' || !id.organisation ? null : {
        id: id.organisation.id, raisonSociale: id.organisation.raisonSociale, forme: id.organisation.forme,
        representants: id.organisation.representatives.map((r) => ({ nom: r.fullName, fonction: r.fonction, habilitation: r.habilitation, compteRattache: !!r.taxpayerId })),
      },
      representeAupres: viewer === 'mandataire' ? [] : representeAupres,
      reutilisation: 'Les informations vérifiées (identité, téléphone, NIF, adresse, organisation, mandats) sont reprises par chaque module sans nouvelle saisie.',
    };
  };

  reg.register({
    module: 'acces', titre: 'Identité, mandats et organisations', lien: '/acces/identite',
    collect: (tp) => {
      const out: CompteElement[] = [];
      for (const m of svc.mandates.find((x) => x.mandantTaxpayerId === tp)) {
        const u = ctx.users.get(m.mandataireUserId);
        out.push({ rubrique: 'MANDAT_DONNE', id: m.id, libelle: `Mandat ${m.kind === 'PROFESSIONNEL' ? 'professionnel' : 'de confiance'} à ${u?.name ?? m.mandataireUserId} (${m.scope.join(', ')})`, statut: m.status, date: m.validFrom, echeance: m.validTo, nature: m.kind, lien: '/acces/mandats' });
      }
      // Mandats reçus : le compte de travail ou de mandataire d'une même personne (lien explicite du compte de travail).
      for (const a of svc.accounts.find((x) => x.linkedTaxpayerIds.includes(tp))) {
        for (const m of svc.mandates.find((x) => x.mandataireUserId === a.id)) {
          out.push({ rubrique: 'MANDAT_RECU', id: m.id, libelle: `Mandat reçu (${m.scope.join(', ')})`, statut: m.status, date: m.validFrom, echeance: m.validTo, nature: m.kind, lien: '/acces/mandats' });
        }
      }
      for (const o of svc.organisations.find((x) => x.taxpayerId === tp)) {
        out.push({ rubrique: 'ORGANISATION', id: o.id, libelle: `${o.raisonSociale} (${o.forme}) — compte de la personne morale`, statut: 'TITULAIRE', nature: o.forme, date: o.createdAt, lien: '/espace' });
      }
      for (const o of svc.organisations.find((x) => x.representatives.some((r) => r.taxpayerId === tp))) {
        const r = o.representatives.find((x) => x.taxpayerId === tp)!;
        out.push({ rubrique: 'ROLE', id: `${o.id}:${tp}`, libelle: `${r.fonction} — ${o.raisonSociale}`, statut: r.habilitation, nature: 'REPRESENTANT', date: o.createdAt, lien: '/acces/mandats' });
      }
      for (const p of svc.proofs.find((x) => x.taxpayerId === tp)) {
        out.push({ rubrique: 'DOCUMENT', id: p.id, libelle: `Pièce ${p.type} (${p.referenceMasked})`, statut: p.status, nature: p.type, date: p.declaredAt, lien: '/acces/identite' });
      }
      return out;
    },
  });
}
