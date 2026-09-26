# Annexe G — Catalogue des événements de communication

Catalogue généré à partir de `specs/evenements-communication.yaml` (outil `tools/gen_evenements.py`). **239 événements** répartis en **23 catégories**, dont **126 avis obligatoires** qui s'appliquent même lorsque le destinataire s'est désinscrit des communications facultatives.

Légende des canaux : E courriel · A dans l'application · S SMS · P notification push · U boîte USSD · V serveur vocal (SVI) · C courrier imprimé · W WhatsApp (sur consentement préalable, contenu non sensible uniquement). Public : C contribuable · G agent public ou interne · X partenaire externe. **M** = obligatoire.

## G.1 Synthèse

| Indicateur | Valeur |
|---|---|
| Événements au catalogue | 239 |
| Catégories | 23 |
| Avis obligatoires | 126 |
| Événements diffusés par défaut sur « email » | 192 |
| Événements diffusés par défaut sur « in-app » | 232 |
| Événements diffusés par défaut sur « sms » | 111 |
| Événements diffusés par défaut sur « push » | 42 |
| Événements diffusés par défaut sur « whatsapp » | 62 |
| Événements diffusés par défaut sur « ussd » | 31 |
| Événements diffusés par défaut sur « svi » | 11 |
| Événements diffusés par défaut sur « courrier » | 23 |

| Catégorie | Événements | Obligatoires |
|---|---|---|
| Identité et compte | 18 | 6 |
| Connexion et sécurité | 17 | 14 |
| Mandats et représentants | 5 | 3 |
| Objets fiscaux et recensement | 10 | 5 |
| Foncier et locatif | 9 | 4 |
| Déclarations et liquidation | 19 | 10 |
| Paiements | 14 | 8 |
| Quittances et quitus | 9 | 6 |
| Titres, autorisations et droits d'accès | 11 | 4 |
| Recouvrement et arriérés | 8 | 6 |
| Missions et contrôle terrain | 9 | 4 |
| Réclamations et recours | 6 | 5 |
| Approbations et workflows (maker-checker) | 12 | 6 |
| Registre juridique et règles | 10 | 4 |
| Trésor, règlement et rapprochement | 9 | 4 |
| Anti-fraude et audit | 11 | 11 |
| Agents d'intelligence artificielle | 9 | 3 |
| Pilotage et tableaux de bord | 8 | 1 |
| Invitations et accès des agents publics | 14 | 5 |
| Apprentissage et certification | 7 | 2 |
| Plateforme et continuité | 8 | 4 |
| Données personnelles et consentement | 7 | 5 |
| Partenaires, contrats et points de paiement | 9 | 6 |

## G.2 Identité et compte

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `account.registration.requested` | Inscription demandée | Bienvenue sur KINSHASA MOSOLO — confirmez votre compte | info | EAS+W |  | C |
| `account.registration.received` | Inscription reçue | Nous avons bien reçu votre inscription | info | EA+W |  | C |
| `account.phone_verification_required` | Vérification du téléphone requise | Votre code de vérification MOSOLO | warning | SA+W |  | C |
| `account.email_verification_required` | Vérification du courriel requise | Confirmez votre adresse électronique | warning | EA+W |  | C |
| `account.verification.level_upgraded` | Niveau de vérification relevé | Votre compte est désormais au niveau {{niveau}} | success | EAS+W |  | C |
| `account.verification.failed` | Vérification non aboutie | La vérification de votre identité n'a pas abouti | warning | EAS+W |  | C |
| `account.verification.documents_requested` | Pièces demandées | Pièces nécessaires pour vérifier votre compte | warning | EASU+W |  | C |
| `account.verification.expired` | Vérification expirée | Votre lien de vérification a expiré | warning | EA+W |  | C |
| `account.registration.abandoned` | Inscription inachevée | Terminez votre inscription MOSOLO | info | EAS+W |  | C |
| `account.duplicate_suspected` | Doublon possible détecté | Un compte similaire existe peut-être | warning | EA+W |  | C |
| `account.merge.proposed` | Rapprochement de comptes proposé | Rapprochement de comptes à confirmer | warning | EAS | M | C |
| `account.merge.completed` | Comptes rapprochés | Vos comptes ont été rapprochés | info | EAS | M | C |
| `account.contact.changed` | Coordonnées modifiées | Vos coordonnées ont été modifiées | warning | EAS | M | C |
| `account.mosolo_card.issued` | Carte MOSOLO délivrée | Votre carte MOSOLO est prête | success | ASV+W |  | C |
| `account.mosolo_card.revoked` | Carte MOSOLO révoquée | Votre carte MOSOLO a été révoquée | warning | ASV | M | C |
| `account.suspended` | Compte suspendu | Votre compte a été suspendu — motif et recours | critical | EASC | M | C |
| `account.reactivated` | Compte réactivé | Votre compte est réactivé | success | EAS+W |  | C |
| `account.closed` | Compte clôturé | Votre compte a été clôturé | info | EAC | M | C |

## G.3 Connexion et sécurité

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `auth.login.success` | Connexion réussie | Nouvelle connexion à votre compte | info | A+W |  | CG |
| `auth.login.failed` | Échec de connexion | Tentative de connexion échouée | warning | A+W |  | CG |
| `auth.login.suspicious` | Connexion suspecte | Connexion inhabituelle détectée | critical | EAS | M | CG |
| `auth.device.new` | Nouvel appareil | Un nouvel appareil s'est connecté | warning | EAS | M | CG |
| `auth.device.revoked` | Appareil révoqué | Un appareil a été révoqué | warning | EA | M | CG |
| `auth.otp_code` | Code à usage unique | Votre code MOSOLO : {{code}} | info | SV | M | CG |
| `auth.recovery.requested` | Récupération de compte demandée | Demande de récupération de votre compte | warning | EAS | M | C |
| `auth.recovery.completed` | Récupération effectuée | Votre accès a été rétabli | success | EAS | M | C |
| `auth.password.changed` | Mot de passe modifié | Votre mot de passe a été modifié | success | EAS | M | CG |
| `auth.mfa.enabled` | Double authentification activée | Double authentification activée | success | EA | M | CG |
| `auth.mfa.disabled` | Double authentification désactivée | Double authentification désactivée | warning | EAS | M | CG |
| `auth.passkey.registered` | Clé d'accès enregistrée | Nouvelle clé d'accès enregistrée | info | EA | M | G |
| `auth.account.locked` | Compte verrouillé | Votre compte a été verrouillé | critical | EAS | M | CG |
| `auth.session.revoked` | Session fermée | Une session a été fermée | warning | EA | M | CG |
| `auth.privileged_access.granted` | Accès privilégié accordé | Accès privilégié temporaire accordé jusqu'à {{fin}} | warning | EAP | M | G |
| `auth.privileged_access.expired` | Accès privilégié expiré | Votre accès privilégié a expiré | info | A |  | G |
| `auth.break_glass.used` | Accès d'urgence utilisé | Accès « bris de glace » utilisé — revue requise | critical | EAS | M | G |

## G.4 Mandats et représentants

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `mandate.requested` | Mandat demandé | {{mandataire}} demande à vous représenter | warning | EAS | M | C |
| `mandate.granted` | Mandat accordé | Mandat accordé à {{mandataire}} | success | EAS | M | C |
| `mandate.revoked` | Mandat révoqué | Mandat révoqué | info | EAS | M | C |
| `mandate.expiring` | Mandat bientôt expiré | Votre mandat expire le {{date}} | warning | EA+W |  | C |
| `mandate.action_performed` | Action d'un mandataire | {{mandataire}} a effectué une action sur votre compte | info | EA+W |  | C |

## G.5 Objets fiscaux et recensement

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `object.declared` | Bien ou activité déclaré | Déclaration enregistrée : {{objet}} | info | EA+W |  | C |
| `object.provisional.created` | Objet recensé | Un bien vous concernant a été recensé : {{objet}} | info | EASU+W |  | C |
| `object.link.requested` | Rattachement demandé | Demande de rattachement de {{objet}} reçue | info | EA+W |  | C |
| `object.link.approved` | Rattachement validé | {{objet}} est rattaché à votre compte | success | EAS | M | C |
| `object.link.rejected` | Rattachement refusé | Rattachement de {{objet}} refusé — motif et recours | warning | EAS | M | C |
| `object.ownership.conflict` | Conflit de propriété | Un conflit concerne {{objet}} | warning | EASC | M | C |
| `object.characteristics.changed` | Caractéristiques modifiées | Les caractéristiques de {{objet}} ont été mises à jour | warning | EA | M | C |
| `object.plate.issued` | Plaque fiscale délivrée | La plaque fiscale de {{objet}} est disponible | info | ASU+W |  | C |
| `object.field_visit.scheduled` | Visite de vérification prévue | Visite de vérification prévue le {{date}} | info | ASU | M | C |
| `object.field_visit.done` | Visite effectuée | Compte rendu de visite pour {{objet}} | info | EA+W |  | C |

## G.6 Foncier et locatif

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `lease.declared` | Bail déclaré | Bail enregistré pour {{unite}} | info | EA+W |  | C |
| `lease.declared_by_tenant` | Bail déclaré par un locataire | Un bail portant sur votre bien a été déclaré | warning | EAS | M | C |
| `lease.expiring` | Bail arrivant à échéance | Le bail de {{unite}} expire le {{date}} | info | EA+W |  | C |
| `lease.ended` | Fin de bail | Fin de bail enregistrée pour {{unite}} | info | EA+W |  | C |
| `rental.withholding.due` | Retenue sur loyer à reverser | Retenue de {{montant}} à reverser avant le {{date}} | warning | EAS | M | C |
| `rental.withholding.certificate` | Attestation de retenue | Attestation de retenue disponible | success | EA+W |  | C |
| `rental.withholding.credited` | Retenue imputée | Une retenue a été imputée sur votre impôt | success | EA+W |  | C |
| `rental.occupancy.inconsistency` | Incohérence d'occupation | Vérification demandée pour {{objet}} | warning | EA | M | C |
| `property.reclassification.proposed` | Requalification proposée | Proposition de requalification de {{objet}} — vos observations | warning | EASC | M | C |

## G.7 Déclarations et liquidation

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `declaration.prefilled_ready` | Déclaration pré-remplie prête | Votre déclaration {{exercice}} est prête | info | EASPU+W |  | C |
| `declaration.due_soon` | Échéance de déclaration proche | Déclaration à déposer avant le {{date}} | warning | EASPUV+W |  | C |
| `declaration.submitted` | Déclaration déposée | Déclaration déposée — accusé de réception | success | EA | M | C |
| `declaration.late` | Déclaration en retard | Déclaration non déposée à l'échéance | warning | EASU | M | C |
| `declaration.deadline_extended` | Échéance prorogée | L'échéance est prorogée au {{date}} | info | EASPUV+W |  | C |
| `assessment.issued` | Avis d'imposition émis | Avis {{reference}} : {{montant}} dû avant le {{date}} | warning | EASUC | M | C |
| `assessment.explained` | Explication du calcul | Comment votre montant a été calculé | info | EA+W |  | C |
| `assessment.rectified` | Avis rectificatif | Avis rectificatif {{reference}} | warning | EASC | M | C |
| `assessment.cancelled` | Avis annulé | Avis {{reference}} annulé — motif | info | EAS | M | C |
| `obligation.due_soon` | Échéance de paiement proche | {{montant}} à payer avant le {{date}} | warning | EASPUV+W |  | C |
| `obligation.due_today` | Échéance aujourd'hui | Dernier jour pour payer {{reference}} | warning | SPUV+W |  | C |
| `obligation.overdue` | Obligation en retard | {{reference}} est en retard | warning | EASU | M | C |
| `exemption.requested` | Exonération demandée | Demande d'exonération reçue | info | EA+W |  | C |
| `exemption.granted` | Exonération accordée | Exonération accordée jusqu'au {{date}} | success | EASC | M | C |
| `exemption.refused` | Exonération refusée | Exonération refusée — motif et recours | warning | EASC | M | C |
| `exemption.expiring` | Exonération bientôt expirée | Votre exonération expire le {{date}} | warning | EA+W |  | C |
| `installment_plan.granted` | Échéancier accordé | Échéancier accordé : {{n}} versements | success | EAS | M | C |
| `installment_plan.installment_due` | Versement d'échéancier dû | Versement {{i}}/{{n}} dû le {{date}} | warning | SPU+W |  | C |
| `installment_plan.defaulted` | Échéancier non respecté | Échéancier non respecté — conséquences | warning | EASC | M | C |

## G.8 Paiements

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `payment.reference.issued` | Référence de paiement émise | Référence {{ref_paiement}} : {{montant}} | info | ASU+W |  | C |
| `payment.initiated` | Paiement initié | Paiement en cours de traitement | info | A+W |  | C |
| `payment.confirmed` | Paiement confirmé | Paiement de {{montant}} confirmé par {{canal}} | success | EASP | M | C |
| `payment.failed` | Paiement échoué | Votre paiement n'a pas abouti | warning | ASP+W |  | C |
| `payment.duplicate_detected` | Paiement en double détecté | Paiement en double détecté — remboursement ou imputation | warning | EAS | M | C |
| `payment.reversed` | Paiement contrepassé | Paiement {{ref_paiement}} contrepassé | warning | EASC | M | C |
| `payment.disputed` | Paiement contesté | Contestation de paiement enregistrée | warning | EA | M | C |
| `payment.partial` | Paiement partiel | Paiement partiel reçu — reste {{solde}} | info | EAS+W |  | C |
| `payment.currency_converted` | Conversion de devise appliquée | Paiement en {{devise_paiement}} converti au taux officiel du {{date}} | info | EA+W |  | C |
| `refund.requested` | Remboursement demandé | Demande de remboursement reçue | info | EA+W |  | C |
| `refund.approved` | Remboursement approuvé | Remboursement de {{montant}} approuvé | success | EAS | M | C |
| `refund.paid` | Remboursement versé | Remboursement de {{montant}} versé | success | EAS | M | C |
| `refund.refused` | Remboursement refusé | Remboursement refusé — motif et recours | warning | EASC | M | C |
| `payment_point.cash_receipt` | Encaissement au point agréé | Reçu provisoire {{ref_paiement}} — quittance à suivre | info | SU | M | C |

## G.9 Quittances et quitus

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `receipt.issued_provisional` | Quittance provisoire émise | Quittance {{numero}} — en attente de règlement | info | EASU | M | C |
| `receipt.finalized` | Quittance définitive | Quittance {{numero}} définitive | success | EA | M | C |
| `receipt.cancelled` | Quittance annulée | Quittance {{numero}} annulée — motif | warning | EASC | M | C |
| `receipt.replaced` | Quittance remplacée | Quittance {{numero}} remplacée par {{nouveau_numero}} | info | EA | M | C |
| `receipt.verification.fraud_suspected` | Vérification : fraude suspectée | Une quittance à votre nom a été signalée | critical | EAS | M | C |
| `clearance.issued` | Quitus fiscal délivré | Votre quitus fiscal est disponible | success | EAS+W |  | C |
| `clearance.expiring` | Quitus bientôt expiré | Votre quitus expire le {{date}} | warning | EA+W |  | C |
| `clearance.revoked` | Quitus suspendu | Votre quitus est suspendu — motif | warning | EASC | M | C |
| `clearance.verified_by_service` | Quitus vérifié par un service | Votre quitus a été vérifié par {{service}} | info | A+W |  | C |

## G.10 Titres, autorisations et droits d'accès

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `permit.application.received` | Demande d'autorisation reçue | Demande {{titre}} reçue | info | EA+W |  | C |
| `permit.issued` | Autorisation délivrée | {{titre}} délivré, valable jusqu'au {{date}} | success | EASU | M | C |
| `permit.refused` | Autorisation refusée | {{titre}} refusé — motif et recours | warning | EASC | M | C |
| `permit.expiring` | Titre bientôt expiré | {{titre}} expire le {{date}} | warning | EASPU+W |  | C |
| `permit.expired` | Titre expiré | {{titre}} a expiré | warning | ASPU+W |  | C |
| `permit.renewed` | Titre renouvelé | {{titre}} renouvelé | success | EAS+W |  | C |
| `permit.suspended` | Titre suspendu | {{titre}} suspendu — motif et recours | critical | EASC | M | C |
| `ticket.purchased` | Ticket acheté | Ticket {{titre}} valable jusqu'à {{heure}} | success | ASPU+W |  | C |
| `ticket.expiring` | Ticket bientôt expiré | Votre ticket expire dans {{minutes}} min | warning | SP+W |  | C |
| `ticket.extended` | Ticket prolongé | Ticket prolongé jusqu'à {{heure}} | success | SP+W |  | C |
| `parking.violation.recorded` | Constat de stationnement | Constat {{reference}} — paiement ou contestation | warning | EASU | M | C |

## G.11 Recouvrement et arriérés

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `recovery.reminder.1` | Première relance | Rappel amiable : {{reference}} impayé | warning | EASUV | M | C |
| `recovery.reminder.2` | Deuxième relance | Second rappel : {{reference}} impayé | warning | EASUV | M | C |
| `recovery.formal_notice` | Mise en demeure | Mise en demeure {{reference}} | critical | EASUC | M | C |
| `recovery.enforcement.proposed` | Mesure d'exécution envisagée | Mesure d'exécution envisagée — vos droits | critical | EASC | M | C |
| `recovery.enforcement.decided` | Mesure d'exécution décidée | Décision de mesure d'exécution {{reference}} | critical | EASC | M | C |
| `recovery.enforcement.lifted` | Mesure levée | Mesure {{reference}} levée | success | EASC | M | C |
| `recovery.regularisation_campaign` | Campagne de régularisation | Régularisez votre situation avant le {{date}} | info | EASPUV+W |  | C |
| `recovery.arrears_statement` | Relevé d'arriérés | Votre relevé d'arriérés | info | EAU+W |  | C |

## G.12 Missions et contrôle terrain

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `mission.assigned` | Mission assignée | Mission {{mission}} assignée | info | AP |  | G |
| `mission.updated` | Mission modifiée | Mission {{mission}} modifiée | info | AP |  | G |
| `mission.expiring_offline_data` | Données hors ligne bientôt expirées | Synchronisez avant {{heure}} | warning | AP | M | G |
| `mission.sync.completed` | Synchronisation terminée | {{n}} constats synchronisés | success | A |  | G |
| `mission.sync.conflict` | Conflit de synchronisation | Conflit sur {{objet}} — arbitrage requis | warning | AP |  | G |
| `mission.geofence.breach` | Sortie de zone | Constat hors zone de mission | warning | AP | M | G |
| `inspection.qa.rejected` | Constat rejeté en contrôle qualité | Constat {{reference}} rejeté — motif | warning | AP |  | G |
| `inspection.report.issued` | Procès-verbal émis | Procès-verbal {{reference}} — vos observations | warning | EASC | M | C |
| `device.lost_reported` | Terminal déclaré perdu | Terminal {{appareil}} révoqué et effacé | critical | EAS | M | G |

## G.13 Réclamations et recours

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `appeal.submitted` | Réclamation déposée | Réclamation {{reference}} — accusé de réception | info | EASC | M | C |
| `appeal.info_requested` | Complément demandé | Pièces complémentaires demandées | warning | EASU | M | C |
| `appeal.deadline_approaching` | Délai de décision proche | Décision attendue avant le {{date}} | info | EA+W |  | CG |
| `appeal.decided` | Décision rendue | Décision sur votre réclamation {{reference}} | warning | EASC | M | C |
| `appeal.escalated` | Recours transmis | Votre recours a été transmis à {{autorite}} | info | EAS | M | C |
| `appeal.sla_breach` | Délai légal dépassé | Réclamation {{reference}} hors délai | critical | EAP | M | G |

## G.14 Approbations et workflows (maker-checker)

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `approval.requested` | Approbation demandée | Approbation requise : {{objet}} | warning | EAP |  | G |
| `approval.reminder` | Relance d'approbation | Rappel : approbation en attente pour {{objet}} | warning | EAP |  | G |
| `approval.approved` | Approuvé | {{objet}} approuvé | success | EAP |  | G |
| `approval.rejected` | Rejeté | {{objet}} rejeté | warning | EAP |  | G |
| `approval.returned` | Renvoyé pour correction | {{objet}} renvoyé pour correction | warning | EAP |  | G |
| `approval.escalated` | Approbation escaladée | Approbation escaladée : {{objet}} | warning | EAP |  | G |
| `approval.sla_breach` | Délai d'approbation dépassé | Délai dépassé : {{objet}} | critical | EAS | M | G |
| `approval.self_approval_blocked` | Auto-approbation bloquée | Tentative d'auto-approbation bloquée | critical | EA | M | G |
| `beneficiary.change.proposed` | Changement de compte bénéficiaire proposé | Proposition de changement de compte public — quorum requis | critical | EASP | M | G |
| `beneficiary.change.cooling_off` | Délai de refroidissement en cours | Changement de compte public effectif le {{date}} sauf opposition | critical | EAS | M | G |
| `beneficiary.change.effective` | Changement de compte bénéficiaire effectif | Compte public modifié | critical | EAS | M | G |
| `beneficiary.change.blocked` | Changement de compte bloqué | Changement de compte public bloqué | critical | EAS | M | G |

## G.15 Registre juridique et règles

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `rule.draft.submitted` | Règle soumise | Règle {{regle}} soumise à revue | info | EA |  | G |
| `rule.legal_review.done` | Visa juridique | Visa juridique : {{regle}} | info | EA |  | G |
| `rule.financial_review.done` | Visa financier | Visa financier : {{regle}} | info | EA |  | G |
| `rule.published` | Règle publiée | Règle {{regle}} publiée, effet au {{date}} | success | EA |  | G |
| `rule.activated` | Règle active | Règle {{regle}} active | success | A |  | G |
| `rule.expiring` | Règle bientôt expirée | Règle {{regle}} expire le {{date}} | warning | EAP | M | G |
| `rule.suspended` | Règle suspendue | Règle {{regle}} suspendue | critical | EAS | M | G |
| `rule.conflict.detected` | Conflit de règles | Double revendication d'un fait générateur | critical | EA | M | G |
| `legal.instrument.abrogated` | Texte abrogé | Le texte {{texte}} est abrogé — règles impactées | critical | EA | M | G |
| `legal.change.public_notice` | Information réglementaire | Changement de règle vous concernant | info | EASU+W |  | C |

## G.16 Trésor, règlement et rapprochement

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `settlement.received` | Règlement reçu | Relevé {{banque}} du {{date}} intégré | info | A |  | G |
| `settlement.delayed` | Règlement en retard | Règlement {{canal}} en retard de {{heures}} h | warning | EAP | M | G |
| `reconciliation.daily_completed` | Rapprochement journalier terminé | Rapprochement du {{date}} : {{taux}} % | info | EA |  | G |
| `reconciliation.exception.opened` | Exception de rapprochement | Exception {{reference}} ouverte | warning | AP |  | G |
| `reconciliation.exception.aged` | Exception ancienne | Exception {{reference}} ouverte depuis {{jours}} j | critical | EAS | M | G |
| `ledger.day_closed` | Journée comptable clôturée | Clôture du {{date}} signée | success | A |  | G |
| `ledger.imbalance` | Déséquilibre du grand livre | Déséquilibre détecté | critical | EAS | M | G |
| `fx.rate.published` | Taux de change officiel intégré | Taux officiel du {{date}} intégré | info | A |  | G |
| `fx.rate.missing` | Taux de change manquant | Taux officiel du {{date}} absent | critical | EAS | M | G |

## G.17 Anti-fraude et audit

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `fraud.alert.raised` | Alerte de fraude | Alerte {{reference}} — score {{score}} | critical | EAP | M | G |
| `fraud.case.opened` | Dossier d'enquête ouvert | Enquête {{reference}} ouverte | warning | EA | M | G |
| `fraud.case.closed` | Dossier d'enquête clos | Enquête {{reference}} close | info | EA | M | G |
| `fraud.exemption_concentration` | Concentration d'exonérations | Concentration anormale d'exonérations | critical | EA | M | G |
| `fraud.cancellation_spike` | Pic d'annulations | Pic d'annulations sur {{perimetre}} | critical | EA | M | G |
| `fraud.fake_agent_reported` | Faux agent signalé | Signalement de faux agent à {{lieu}} | critical | EAS | M | G |
| `fraud.cash_request_reported` | Demande d'espèces signalée | Signalement de demande d'espèces | critical | EAS | M | G |
| `audit.log.integrity_failure` | Rupture de la chaîne d'audit | Rupture d'intégrité du journal | critical | EAS | M | G |
| `audit.policy_violation` | Violation de politique | Violation de politique détectée | critical | EAS | M | G |
| `audit.access_review.due` | Revue d'accès due | Revue trimestrielle des accès à réaliser | warning | EA | M | G |
| `whistleblower.report.received` | Signalement reçu | Votre signalement {{reference}} est enregistré | info | SUV | M | C |

## G.18 Agents d'intelligence artificielle

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `ai.insight_generated` | Analyse produite | Nouvelle analyse de {{agent}} | info | AP |  | G |
| `ai.recommendation_available` | Recommandation disponible | Recommandation à examiner | info | AP |  | G |
| `ai.opportunity_identified` | Gisement identifié | Gisement de recettes identifié | success | EA |  | G |
| `ai.risk_detected` | Risque détecté | Alerte de risque | warning | EAP |  | G |
| `ai.forecast.updated` | Prévision mise à jour | Prévision {{periode}} mise à jour | info | A |  | G |
| `ai.human_intervention_required` | Décision humaine requise | Action requise : {{objet}} | critical | EAP | M | G |
| `ai.model.drift_detected` | Dérive de modèle | Dérive détectée sur {{modele}} | warning | EA | M | G |
| `ai.model.rollback` | Retour arrière de modèle | Modèle {{modele}} rétabli en version {{version}} | warning | EA | M | G |
| `ai.workflow_failed` | Traitement IA échoué | Traitement {{objet}} échoué | warning | EA |  | G |

## G.19 Pilotage et tableaux de bord

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `report.generated` | Rapport produit | Rapport disponible : {{rapport}} | info | A |  | G |
| `report.scheduled_ready` | Rapport périodique prêt | Votre rapport {{periode}} est prêt | info | EA |  | G |
| `kpi.threshold_breached` | Seuil d'indicateur franchi | Alerte indicateur : {{kpi}} | warning | EAP |  | G |
| `kpi.recovered` | Indicateur rétabli | Indicateur rétabli : {{kpi}} | success | A |  | G |
| `executive.alert` | Alerte exécutive | Alerte exécutive : {{objet}} | critical | EAS | M | G |
| `executive.daily_brief` | Note quotidienne | Note quotidienne des recettes du {{date}} | info | EAP |  | G |
| `decision.follow_up_due` | Suivi de décision | Décision {{reference}} : échéance de mise en œuvre | warning | EA |  | G |
| `transparency.published` | Publication de transparence | Tableau de transparence {{periode}} publié | info | EA+W |  | CG |

## G.20 Invitations et accès des agents publics

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `invitation.sent` | Invitation envoyée | {{acteur}} vous invite à rejoindre {{entite}} sur MOSOLO | info | EAS |  | G |
| `invitation.reminder` | Rappel d'invitation | Rappel : invitation à {{entite}} | info | EA |  | G |
| `invitation.accepted` | Invitation acceptée | {{nom}} a accepté votre invitation | success | A |  | G |
| `invitation.declined` | Invitation déclinée | {{nom}} a décliné l'invitation | info | A |  | G |
| `invitation.expired` | Invitation expirée | Votre invitation a expiré | info | EA |  | G |
| `role.assigned` | Rôle attribué | Rôle {{role}} attribué jusqu'au {{date}} | info | EA | M | G |
| `role.removed` | Rôle retiré | Rôle {{role}} retiré | info | EA | M | G |
| `delegation.granted` | Délégation accordée | Délégation de {{delegant}} jusqu'au {{date}} | warning | EA | M | G |
| `delegation.expired` | Délégation expirée | Délégation expirée | info | A |  | G |
| `access.expiring` | Accès bientôt expiré | Votre accès expire le {{date}} | warning | EA |  | G |
| `access.suspended_inactivity` | Accès suspendu (inactivité) | Accès suspendu après 60 jours d'inactivité | warning | EA | M | G |
| `conflict_of_interest.detected` | Conflit d'intérêts détecté | Dossier réaffecté pour conflit d'intérêts | warning | EA | M | G |
| `entity.space.activated` | Espace d'entité activé | L'espace {{entite}} est actif | success | EA |  | G |
| `entity.module.attached` | Module rattaché | Module {{module}} rattaché à {{entite}} | info | EA |  | G |

## G.21 Apprentissage et certification

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `training.assigned` | Formation assignée | Formation assignée : {{formation}} | info | EAP |  | G |
| `training.due_soon` | Formation à terminer | Terminez {{formation}} avant le {{date}} | warning | AP |  | G |
| `training.completed` | Formation terminée | Formation terminée : {{formation}} | success | A |  | G |
| `certification.achieved` | Certification obtenue | Certification obtenue : {{certification}} | success | EA |  | G |
| `certification.expiring` | Certification bientôt expirée | Recyclage requis avant le {{date}} | warning | EA | M | G |
| `procedure.changed` | Procédure modifiée | La procédure {{procedure}} a changé | info | AP | M | G |
| `taxpayer.guide.available` | Guide pratique disponible | Guide : {{sujet}} | info | AU+W |  | C |

## G.22 Plateforme et continuité

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `system.maintenance_scheduled` | Maintenance programmée | Maintenance le {{date}} | info | EA+W |  | CG |
| `system.maintenance_emergency` | Maintenance d'urgence | Maintenance d'urgence en cours | warning | EAS | M | G |
| `system.outage` | Interruption de service | Interruption de service — solutions de repli | critical | EAS | M | CG |
| `system.service_restored` | Service rétabli | Service rétabli | success | EA+W |  | CG |
| `system.channel_degraded` | Canal dégradé | Canal {{canal}} dégradé — utilisez {{alternative}} | warning | A+W |  | CG |
| `system.deadline_protection` | Protection d'échéance | Échéance prorogée en raison d'une interruption | info | EASU | M | C |
| `release.deployed` | Version déployée | Version {{version}} déployée | info | A |  | G |
| `backup.restore_test.failed` | Test de restauration échoué | Test de restauration échoué | critical | EAS | M | G |

## G.23 Données personnelles et consentement

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `privacy.consent_request` | Demande de consentement | Nous avons besoin de votre accord | info | EA | M | C |
| `privacy.consent_updated` | Consentement mis à jour | Vos préférences ont été mises à jour | info | EA+W |  | C |
| `privacy.access_request.received` | Demande d'accès reçue | Votre demande d'accès à vos données est enregistrée | info | EA | M | C |
| `privacy.data_export_ready` | Export de données prêt | Votre export de données est prêt | success | EA+W |  | C |
| `privacy.rectification.done` | Rectification effectuée | Vos données ont été rectifiées | success | EA | M | C |
| `privacy.data_shared_with_partner` | Partage de données | Vos données ont été communiquées à {{destinataire}} ({{base_legale}}) | info | EA | M | C |
| `privacy.breach_notification` | Violation de données | Information sur un incident de données | critical | EASC | M | C |

## G.24 Partenaires, contrats et points de paiement

| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |
|---|---|---|---|---|---|---|
| `partner.api_key.expiring` | Clé d'API bientôt expirée | Clé d'API {{partenaire}} expire le {{date}} | warning | EA | M | X |
| `partner.callback.signature_invalid` | Signature de rappel invalide | Rappel rejeté : signature invalide | critical | EA | M | GX |
| `partner.sla_breach` | Engagement de service non tenu | SLA non respecté par {{partenaire}} | warning | EA | M | G |
| `payment_point.accredited` | Point de paiement agréé | Point {{point}} agréé | success | EA |  | X |
| `payment_point.settlement_overdue` | Reversement en retard | Reversement du point {{point}} en retard | critical | EAS | M | GX |
| `payment_point.suspended` | Point de paiement suspendu | Point {{point}} suspendu | critical | EAS | M | X |
| `contract.expiring` | Contrat bientôt échu | Contrat {{contrat}} échu le {{date}} | warning | EA |  | G |
| `subcontractor.agent.accredited` | Agent accrédité | Agent {{agent}} accrédité | success | EA |  | X |
| `subcontractor.agent.revoked` | Accréditation révoquée | Accréditation de {{agent}} révoquée | warning | EA | M | X |
