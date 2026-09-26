#!/usr/bin/env python3
"""Génère le catalogue des événements de communication KINSHASA MOSOLO.

Sorties :
  specs/evenements-communication.yaml   (source machine, consommée par le moteur de notifications)
  docs/document-maitre/95-annexe-g-catalogue-evenements.md (annexe du document maître)

Canaux : E=email, A=in-app, S=SMS, P=push, W=WhatsApp (opt-in), U=boîte USSD, V=SVI vocal, C=courrier imprimé.
Gravité : info | success | warning | critical.
Obligatoire (M) : avis qui contourne les préférences de désinscription (avis légaux, sécurité).
Public : C=contribuable, G=agent public / interne, X=partenaire externe.
"""
import os, json
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# (code, libellé, objet du message, gravité, canaux, obligatoire, public)
CATS = [
("identite", "Identité et compte", [
 ("account.registration.requested","Inscription demandée","Bienvenue sur KINSHASA MOSOLO — confirmez votre compte","info","EAS",False,"C"),
 ("account.registration.received","Inscription reçue","Nous avons bien reçu votre inscription","info","EA",False,"C"),
 ("account.phone_verification_required","Vérification du téléphone requise","Votre code de vérification MOSOLO","warning","SA",False,"C"),
 ("account.email_verification_required","Vérification du courriel requise","Confirmez votre adresse électronique","warning","EA",False,"C"),
 ("account.verification.level_upgraded","Niveau de vérification relevé","Votre compte est désormais au niveau {{niveau}}","success","EAS",False,"C"),
 ("account.verification.failed","Vérification non aboutie","La vérification de votre identité n'a pas abouti","warning","EAS",False,"C"),
 ("account.verification.documents_requested","Pièces demandées","Pièces nécessaires pour vérifier votre compte","warning","EASU",False,"C"),
 ("account.verification.expired","Vérification expirée","Votre lien de vérification a expiré","warning","EA",False,"C"),
 ("account.registration.abandoned","Inscription inachevée","Terminez votre inscription MOSOLO","info","EAS",False,"C"),
 ("account.duplicate_suspected","Doublon possible détecté","Un compte similaire existe peut-être","warning","EA",False,"C"),
 ("account.merge.proposed","Rapprochement de comptes proposé","Rapprochement de comptes à confirmer","warning","EAS",True,"C"),
 ("account.merge.completed","Comptes rapprochés","Vos comptes ont été rapprochés","info","EAS",True,"C"),
 ("account.contact.changed","Coordonnées modifiées","Vos coordonnées ont été modifiées","warning","EAS",True,"C"),
 ("account.mosolo_card.issued","Carte MOSOLO délivrée","Votre carte MOSOLO est prête","success","ASV",False,"C"),
 ("account.mosolo_card.revoked","Carte MOSOLO révoquée","Votre carte MOSOLO a été révoquée","warning","ASV",True,"C"),
 ("account.suspended","Compte suspendu","Votre compte a été suspendu — motif et recours","critical","EASC",True,"C"),
 ("account.reactivated","Compte réactivé","Votre compte est réactivé","success","EAS",False,"C"),
 ("account.closed","Compte clôturé","Votre compte a été clôturé","info","EAC",True,"C"),
]),
("securite", "Connexion et sécurité", [
 ("auth.login.success","Connexion réussie","Nouvelle connexion à votre compte","info","A",False,"CG"),
 ("auth.login.failed","Échec de connexion","Tentative de connexion échouée","warning","A",False,"CG"),
 ("auth.login.suspicious","Connexion suspecte","Connexion inhabituelle détectée","critical","EAS",True,"CG"),
 ("auth.device.new","Nouvel appareil","Un nouvel appareil s'est connecté","warning","EAS",True,"CG"),
 ("auth.device.revoked","Appareil révoqué","Un appareil a été révoqué","warning","EA",True,"CG"),
 ("auth.otp_code","Code à usage unique","Votre code MOSOLO : {{code}}","info","SV",True,"CG"),
 ("auth.recovery.requested","Récupération de compte demandée","Demande de récupération de votre compte","warning","EAS",True,"C"),
 ("auth.recovery.completed","Récupération effectuée","Votre accès a été rétabli","success","EAS",True,"C"),
 ("auth.password.changed","Mot de passe modifié","Votre mot de passe a été modifié","success","EAS",True,"CG"),
 ("auth.mfa.enabled","Double authentification activée","Double authentification activée","success","EA",True,"CG"),
 ("auth.mfa.disabled","Double authentification désactivée","Double authentification désactivée","warning","EAS",True,"CG"),
 ("auth.passkey.registered","Clé d'accès enregistrée","Nouvelle clé d'accès enregistrée","info","EA",True,"G"),
 ("auth.account.locked","Compte verrouillé","Votre compte a été verrouillé","critical","EAS",True,"CG"),
 ("auth.session.revoked","Session fermée","Une session a été fermée","warning","EA",True,"CG"),
 ("auth.privileged_access.granted","Accès privilégié accordé","Accès privilégié temporaire accordé jusqu'à {{fin}}","warning","EAP",True,"G"),
 ("auth.privileged_access.expired","Accès privilégié expiré","Votre accès privilégié a expiré","info","A",False,"G"),
 ("auth.break_glass.used","Accès d'urgence utilisé","Accès « bris de glace » utilisé — revue requise","critical","EAS",True,"G"),
]),
("mandats", "Mandats et représentants", [
 ("mandate.requested","Mandat demandé","{{mandataire}} demande à vous représenter","warning","EAS",True,"C"),
 ("mandate.granted","Mandat accordé","Mandat accordé à {{mandataire}}","success","EAS",True,"C"),
 ("mandate.revoked","Mandat révoqué","Mandat révoqué","info","EAS",True,"C"),
 ("mandate.expiring","Mandat bientôt expiré","Votre mandat expire le {{date}}","warning","EA",False,"C"),
 ("mandate.action_performed","Action d'un mandataire","{{mandataire}} a effectué une action sur votre compte","info","EA",False,"C"),
]),
("objets", "Objets fiscaux et recensement", [
 ("object.declared","Bien ou activité déclaré","Déclaration enregistrée : {{objet}}","info","EA",False,"C"),
 ("object.provisional.created","Objet recensé","Un bien vous concernant a été recensé : {{objet}}","info","EASU",False,"C"),
 ("object.link.requested","Rattachement demandé","Demande de rattachement de {{objet}} reçue","info","EA",False,"C"),
 ("object.link.approved","Rattachement validé","{{objet}} est rattaché à votre compte","success","EAS",True,"C"),
 ("object.link.rejected","Rattachement refusé","Rattachement de {{objet}} refusé — motif et recours","warning","EAS",True,"C"),
 ("object.ownership.conflict","Conflit de propriété","Un conflit concerne {{objet}}","warning","EASC",True,"C"),
 ("object.characteristics.changed","Caractéristiques modifiées","Les caractéristiques de {{objet}} ont été mises à jour","warning","EA",True,"C"),
 ("object.plate.issued","Plaque fiscale délivrée","La plaque fiscale de {{objet}} est disponible","info","ASU",False,"C"),
 ("object.field_visit.scheduled","Visite de vérification prévue","Visite de vérification prévue le {{date}}","info","ASU",True,"C"),
 ("object.field_visit.done","Visite effectuée","Compte rendu de visite pour {{objet}}","info","EA",False,"C"),
]),
("locatif", "Foncier et locatif", [
 ("lease.declared","Bail déclaré","Bail enregistré pour {{unite}}","info","EA",False,"C"),
 ("lease.declared_by_tenant","Bail déclaré par un locataire","Un bail portant sur votre bien a été déclaré","warning","EAS",True,"C"),
 ("lease.expiring","Bail arrivant à échéance","Le bail de {{unite}} expire le {{date}}","info","EA",False,"C"),
 ("lease.ended","Fin de bail","Fin de bail enregistrée pour {{unite}}","info","EA",False,"C"),
 ("rental.withholding.due","Retenue sur loyer à reverser","Retenue de {{montant}} à reverser avant le {{date}}","warning","EAS",True,"C"),
 ("rental.withholding.certificate","Attestation de retenue","Attestation de retenue disponible","success","EA",False,"C"),
 ("rental.withholding.credited","Retenue imputée","Une retenue a été imputée sur votre impôt","success","EA",False,"C"),
 ("rental.occupancy.inconsistency","Incohérence d'occupation","Vérification demandée pour {{objet}}","warning","EA",True,"C"),
 ("property.reclassification.proposed","Requalification proposée","Proposition de requalification de {{objet}} — vos observations","warning","EASC",True,"C"),
]),
("obligations", "Déclarations et liquidation", [
 ("declaration.prefilled_ready","Déclaration pré-remplie prête","Votre déclaration {{exercice}} est prête","info","EASPU",False,"C"),
 ("declaration.due_soon","Échéance de déclaration proche","Déclaration à déposer avant le {{date}}","warning","EASPUV",False,"C"),
 ("declaration.submitted","Déclaration déposée","Déclaration déposée — accusé de réception","success","EA",True,"C"),
 ("declaration.late","Déclaration en retard","Déclaration non déposée à l'échéance","warning","EASU",True,"C"),
 ("declaration.deadline_extended","Échéance prorogée","L'échéance est prorogée au {{date}}","info","EASPUV",False,"C"),
 ("assessment.issued","Avis d'imposition émis","Avis {{reference}} : {{montant}} dû avant le {{date}}","warning","EASUC",True,"C"),
 ("assessment.explained","Explication du calcul","Comment votre montant a été calculé","info","EA",False,"C"),
 ("assessment.rectified","Avis rectificatif","Avis rectificatif {{reference}}","warning","EASC",True,"C"),
 ("assessment.cancelled","Avis annulé","Avis {{reference}} annulé — motif","info","EAS",True,"C"),
 ("obligation.due_soon","Échéance de paiement proche","{{montant}} à payer avant le {{date}}","warning","EASPUV",False,"C"),
 ("obligation.due_today","Échéance aujourd'hui","Dernier jour pour payer {{reference}}","warning","SPUV",False,"C"),
 ("obligation.overdue","Obligation en retard","{{reference}} est en retard","warning","EASU",True,"C"),
 ("exemption.requested","Exonération demandée","Demande d'exonération reçue","info","EA",False,"C"),
 ("exemption.granted","Exonération accordée","Exonération accordée jusqu'au {{date}}","success","EASC",True,"C"),
 ("exemption.refused","Exonération refusée","Exonération refusée — motif et recours","warning","EASC",True,"C"),
 ("exemption.expiring","Exonération bientôt expirée","Votre exonération expire le {{date}}","warning","EA",False,"C"),
 ("installment_plan.granted","Échéancier accordé","Échéancier accordé : {{n}} versements","success","EAS",True,"C"),
 ("installment_plan.installment_due","Versement d'échéancier dû","Versement {{i}}/{{n}} dû le {{date}}","warning","SPU",False,"C"),
 ("installment_plan.defaulted","Échéancier non respecté","Échéancier non respecté — conséquences","warning","EASC",True,"C"),
]),
("paiements", "Paiements", [
 ("payment.reference.issued","Référence de paiement émise","Référence {{ref_paiement}} : {{montant}}","info","ASU",False,"C"),
 ("payment.initiated","Paiement initié","Paiement en cours de traitement","info","A",False,"C"),
 ("payment.confirmed","Paiement confirmé","Paiement de {{montant}} confirmé par {{canal}}","success","EASP",True,"C"),
 ("payment.failed","Paiement échoué","Votre paiement n'a pas abouti","warning","ASP",False,"C"),
 ("payment.duplicate_detected","Paiement en double détecté","Paiement en double détecté — remboursement ou imputation","warning","EAS",True,"C"),
 ("payment.reversed","Paiement contrepassé","Paiement {{ref_paiement}} contrepassé","warning","EASC",True,"C"),
 ("payment.disputed","Paiement contesté","Contestation de paiement enregistrée","warning","EA",True,"C"),
 ("payment.partial","Paiement partiel","Paiement partiel reçu — reste {{solde}}","info","EAS",False,"C"),
 ("payment.currency_converted","Conversion de devise appliquée","Paiement en {{devise_paiement}} converti au taux officiel du {{date}}","info","EA",False,"C"),
 ("refund.requested","Remboursement demandé","Demande de remboursement reçue","info","EA",False,"C"),
 ("refund.approved","Remboursement approuvé","Remboursement de {{montant}} approuvé","success","EAS",True,"C"),
 ("refund.paid","Remboursement versé","Remboursement de {{montant}} versé","success","EAS",True,"C"),
 ("refund.refused","Remboursement refusé","Remboursement refusé — motif et recours","warning","EASC",True,"C"),
 ("payment_point.cash_receipt","Encaissement au point agréé","Reçu provisoire {{ref_paiement}} — quittance à suivre","info","SU",True,"C"),
]),
("quittances", "Quittances et quitus", [
 ("receipt.issued_provisional","Quittance provisoire émise","Quittance {{numero}} — en attente de règlement","info","EASU",True,"C"),
 ("receipt.finalized","Quittance définitive","Quittance {{numero}} définitive","success","EA",True,"C"),
 ("receipt.cancelled","Quittance annulée","Quittance {{numero}} annulée — motif","warning","EASC",True,"C"),
 ("receipt.replaced","Quittance remplacée","Quittance {{numero}} remplacée par {{nouveau_numero}}","info","EA",True,"C"),
 ("receipt.verification.fraud_suspected","Vérification : fraude suspectée","Une quittance à votre nom a été signalée","critical","EAS",True,"C"),
 ("clearance.issued","Quitus fiscal délivré","Votre quitus fiscal est disponible","success","EAS",False,"C"),
 ("clearance.expiring","Quitus bientôt expiré","Votre quitus expire le {{date}}","warning","EA",False,"C"),
 ("clearance.revoked","Quitus suspendu","Votre quitus est suspendu — motif","warning","EASC",True,"C"),
 ("clearance.verified_by_service","Quitus vérifié par un service","Votre quitus a été vérifié par {{service}}","info","A",False,"C"),
]),
("titres", "Titres, autorisations et droits d'accès", [
 ("permit.application.received","Demande d'autorisation reçue","Demande {{titre}} reçue","info","EA",False,"C"),
 ("permit.issued","Autorisation délivrée","{{titre}} délivré, valable jusqu'au {{date}}","success","EASU",True,"C"),
 ("permit.refused","Autorisation refusée","{{titre}} refusé — motif et recours","warning","EASC",True,"C"),
 ("permit.expiring","Titre bientôt expiré","{{titre}} expire le {{date}}","warning","EASPU",False,"C"),
 ("permit.expired","Titre expiré","{{titre}} a expiré","warning","ASPU",False,"C"),
 ("permit.renewed","Titre renouvelé","{{titre}} renouvelé","success","EAS",False,"C"),
 ("permit.suspended","Titre suspendu","{{titre}} suspendu — motif et recours","critical","EASC",True,"C"),
 ("ticket.purchased","Ticket acheté","Ticket {{titre}} valable jusqu'à {{heure}}","success","ASPU",False,"C"),
 ("ticket.expiring","Ticket bientôt expiré","Votre ticket expire dans {{minutes}} min","warning","SP",False,"C"),
 ("ticket.extended","Ticket prolongé","Ticket prolongé jusqu'à {{heure}}","success","SP",False,"C"),
 ("parking.violation.recorded","Constat de stationnement","Constat {{reference}} — paiement ou contestation","warning","EASU",True,"C"),
]),
("recouvrement", "Recouvrement et arriérés", [
 ("recovery.reminder.1","Première relance","Rappel amiable : {{reference}} impayé","warning","EASUV",True,"C"),
 ("recovery.reminder.2","Deuxième relance","Second rappel : {{reference}} impayé","warning","EASUV",True,"C"),
 ("recovery.formal_notice","Mise en demeure","Mise en demeure {{reference}}","critical","EASUC",True,"C"),
 ("recovery.enforcement.proposed","Mesure d'exécution envisagée","Mesure d'exécution envisagée — vos droits","critical","EASC",True,"C"),
 ("recovery.enforcement.decided","Mesure d'exécution décidée","Décision de mesure d'exécution {{reference}}","critical","EASC",True,"C"),
 ("recovery.enforcement.lifted","Mesure levée","Mesure {{reference}} levée","success","EASC",True,"C"),
 ("recovery.regularisation_campaign","Campagne de régularisation","Régularisez votre situation avant le {{date}}","info","EASPUV",False,"C"),
 ("recovery.arrears_statement","Relevé d'arriérés","Votre relevé d'arriérés","info","EAU",False,"C"),
]),
("terrain", "Missions et contrôle terrain", [
 ("mission.assigned","Mission assignée","Mission {{mission}} assignée","info","AP",False,"G"),
 ("mission.updated","Mission modifiée","Mission {{mission}} modifiée","info","AP",False,"G"),
 ("mission.expiring_offline_data","Données hors ligne bientôt expirées","Synchronisez avant {{heure}}","warning","AP",True,"G"),
 ("mission.sync.completed","Synchronisation terminée","{{n}} constats synchronisés","success","A",False,"G"),
 ("mission.sync.conflict","Conflit de synchronisation","Conflit sur {{objet}} — arbitrage requis","warning","AP",False,"G"),
 ("mission.geofence.breach","Sortie de zone","Constat hors zone de mission","warning","AP",True,"G"),
 ("inspection.qa.rejected","Constat rejeté en contrôle qualité","Constat {{reference}} rejeté — motif","warning","AP",False,"G"),
 ("inspection.report.issued","Procès-verbal émis","Procès-verbal {{reference}} — vos observations","warning","EASC",True,"C"),
 ("device.lost_reported","Terminal déclaré perdu","Terminal {{appareil}} révoqué et effacé","critical","EAS",True,"G"),
]),
("recours", "Réclamations et recours", [
 ("appeal.submitted","Réclamation déposée","Réclamation {{reference}} — accusé de réception","info","EASC",True,"C"),
 ("appeal.info_requested","Complément demandé","Pièces complémentaires demandées","warning","EASU",True,"C"),
 ("appeal.deadline_approaching","Délai de décision proche","Décision attendue avant le {{date}}","info","EA",False,"CG"),
 ("appeal.decided","Décision rendue","Décision sur votre réclamation {{reference}}","warning","EASC",True,"C"),
 ("appeal.escalated","Recours transmis","Votre recours a été transmis à {{autorite}}","info","EAS",True,"C"),
 ("appeal.sla_breach","Délai légal dépassé","Réclamation {{reference}} hors délai","critical","EAP",True,"G"),
]),
("approbations", "Approbations et workflows (maker-checker)", [
 ("approval.requested","Approbation demandée","Approbation requise : {{objet}}","warning","EAP",False,"G"),
 ("approval.reminder","Relance d'approbation","Rappel : approbation en attente pour {{objet}}","warning","EAP",False,"G"),
 ("approval.approved","Approuvé","{{objet}} approuvé","success","EAP",False,"G"),
 ("approval.rejected","Rejeté","{{objet}} rejeté","warning","EAP",False,"G"),
 ("approval.returned","Renvoyé pour correction","{{objet}} renvoyé pour correction","warning","EAP",False,"G"),
 ("approval.escalated","Approbation escaladée","Approbation escaladée : {{objet}}","warning","EAP",False,"G"),
 ("approval.sla_breach","Délai d'approbation dépassé","Délai dépassé : {{objet}}","critical","EAS",True,"G"),
 ("approval.self_approval_blocked","Auto-approbation bloquée","Tentative d'auto-approbation bloquée","critical","EA",True,"G"),
 ("beneficiary.change.proposed","Changement de compte bénéficiaire proposé","Proposition de changement de compte public — quorum requis","critical","EASP",True,"G"),
 ("beneficiary.change.cooling_off","Délai de refroidissement en cours","Changement de compte public effectif le {{date}} sauf opposition","critical","EAS",True,"G"),
 ("beneficiary.change.effective","Changement de compte bénéficiaire effectif","Compte public modifié","critical","EAS",True,"G"),
 ("beneficiary.change.blocked","Changement de compte bloqué","Changement de compte public bloqué","critical","EAS",True,"G"),
]),
("juridique", "Registre juridique et règles", [
 ("rule.draft.submitted","Règle soumise","Règle {{regle}} soumise à revue","info","EA",False,"G"),
 ("rule.legal_review.done","Visa juridique","Visa juridique : {{regle}}","info","EA",False,"G"),
 ("rule.financial_review.done","Visa financier","Visa financier : {{regle}}","info","EA",False,"G"),
 ("rule.published","Règle publiée","Règle {{regle}} publiée, effet au {{date}}","success","EA",False,"G"),
 ("rule.activated","Règle active","Règle {{regle}} active","success","A",False,"G"),
 ("rule.expiring","Règle bientôt expirée","Règle {{regle}} expire le {{date}}","warning","EAP",True,"G"),
 ("rule.suspended","Règle suspendue","Règle {{regle}} suspendue","critical","EAS",True,"G"),
 ("rule.conflict.detected","Conflit de règles","Double revendication d'un fait générateur","critical","EA",True,"G"),
 ("legal.instrument.abrogated","Texte abrogé","Le texte {{texte}} est abrogé — règles impactées","critical","EA",True,"G"),
 ("legal.change.public_notice","Information réglementaire","Changement de règle vous concernant","info","EASU",False,"C"),
]),
("tresor", "Trésor, règlement et rapprochement", [
 ("settlement.received","Règlement reçu","Relevé {{banque}} du {{date}} intégré","info","A",False,"G"),
 ("settlement.delayed","Règlement en retard","Règlement {{canal}} en retard de {{heures}} h","warning","EAP",True,"G"),
 ("reconciliation.daily_completed","Rapprochement journalier terminé","Rapprochement du {{date}} : {{taux}} %","info","EA",False,"G"),
 ("reconciliation.exception.opened","Exception de rapprochement","Exception {{reference}} ouverte","warning","AP",False,"G"),
 ("reconciliation.exception.aged","Exception ancienne","Exception {{reference}} ouverte depuis {{jours}} j","critical","EAS",True,"G"),
 ("ledger.day_closed","Journée comptable clôturée","Clôture du {{date}} signée","success","A",False,"G"),
 ("ledger.imbalance","Déséquilibre du grand livre","Déséquilibre détecté","critical","EAS",True,"G"),
 ("fx.rate.published","Taux de change officiel intégré","Taux officiel du {{date}} intégré","info","A",False,"G"),
 ("fx.rate.missing","Taux de change manquant","Taux officiel du {{date}} absent","critical","EAS",True,"G"),
]),
("fraude", "Anti-fraude et audit", [
 ("fraud.alert.raised","Alerte de fraude","Alerte {{reference}} — score {{score}}","critical","EAP",True,"G"),
 ("fraud.case.opened","Dossier d'enquête ouvert","Enquête {{reference}} ouverte","warning","EA",True,"G"),
 ("fraud.case.closed","Dossier d'enquête clos","Enquête {{reference}} close","info","EA",True,"G"),
 ("fraud.exemption_concentration","Concentration d'exonérations","Concentration anormale d'exonérations","critical","EA",True,"G"),
 ("fraud.cancellation_spike","Pic d'annulations","Pic d'annulations sur {{perimetre}}","critical","EA",True,"G"),
 ("fraud.fake_agent_reported","Faux agent signalé","Signalement de faux agent à {{lieu}}","critical","EAS",True,"G"),
 ("fraud.cash_request_reported","Demande d'espèces signalée","Signalement de demande d'espèces","critical","EAS",True,"G"),
 ("audit.log.integrity_failure","Rupture de la chaîne d'audit","Rupture d'intégrité du journal","critical","EAS",True,"G"),
 ("audit.policy_violation","Violation de politique","Violation de politique détectée","critical","EAS",True,"G"),
 ("audit.access_review.due","Revue d'accès due","Revue trimestrielle des accès à réaliser","warning","EA",True,"G"),
 ("whistleblower.report.received","Signalement reçu","Votre signalement {{reference}} est enregistré","info","SUV",True,"C"),
]),
("ia", "Agents d'intelligence artificielle", [
 ("ai.insight_generated","Analyse produite","Nouvelle analyse de {{agent}}","info","AP",False,"G"),
 ("ai.recommendation_available","Recommandation disponible","Recommandation à examiner","info","AP",False,"G"),
 ("ai.opportunity_identified","Gisement identifié","Gisement de recettes identifié","success","EA",False,"G"),
 ("ai.risk_detected","Risque détecté","Alerte de risque","warning","EAP",False,"G"),
 ("ai.forecast.updated","Prévision mise à jour","Prévision {{periode}} mise à jour","info","A",False,"G"),
 ("ai.human_intervention_required","Décision humaine requise","Action requise : {{objet}}","critical","EAP",True,"G"),
 ("ai.model.drift_detected","Dérive de modèle","Dérive détectée sur {{modele}}","warning","EA",True,"G"),
 ("ai.model.rollback","Retour arrière de modèle","Modèle {{modele}} rétabli en version {{version}}","warning","EA",True,"G"),
 ("ai.workflow_failed","Traitement IA échoué","Traitement {{objet}} échoué","warning","EA",False,"G"),
]),
("pilotage", "Pilotage et tableaux de bord", [
 ("report.generated","Rapport produit","Rapport disponible : {{rapport}}","info","A",False,"G"),
 ("report.scheduled_ready","Rapport périodique prêt","Votre rapport {{periode}} est prêt","info","EA",False,"G"),
 ("kpi.threshold_breached","Seuil d'indicateur franchi","Alerte indicateur : {{kpi}}","warning","EAP",False,"G"),
 ("kpi.recovered","Indicateur rétabli","Indicateur rétabli : {{kpi}}","success","A",False,"G"),
 ("executive.alert","Alerte exécutive","Alerte exécutive : {{objet}}","critical","EAS",True,"G"),
 ("executive.daily_brief","Note quotidienne","Note quotidienne des recettes du {{date}}","info","EAP",False,"G"),
 ("decision.follow_up_due","Suivi de décision","Décision {{reference}} : échéance de mise en œuvre","warning","EA",False,"G"),
 ("transparency.published","Publication de transparence","Tableau de transparence {{periode}} publié","info","EA",False,"CG"),
]),
("acces", "Invitations et accès des agents publics", [
 ("invitation.sent","Invitation envoyée","{{acteur}} vous invite à rejoindre {{entite}} sur MOSOLO","info","EAS",False,"G"),
 ("invitation.reminder","Rappel d'invitation","Rappel : invitation à {{entite}}","info","EA",False,"G"),
 ("invitation.accepted","Invitation acceptée","{{nom}} a accepté votre invitation","success","A",False,"G"),
 ("invitation.declined","Invitation déclinée","{{nom}} a décliné l'invitation","info","A",False,"G"),
 ("invitation.expired","Invitation expirée","Votre invitation a expiré","info","EA",False,"G"),
 ("role.assigned","Rôle attribué","Rôle {{role}} attribué jusqu'au {{date}}","info","EA",True,"G"),
 ("role.removed","Rôle retiré","Rôle {{role}} retiré","info","EA",True,"G"),
 ("delegation.granted","Délégation accordée","Délégation de {{delegant}} jusqu'au {{date}}","warning","EA",True,"G"),
 ("delegation.expired","Délégation expirée","Délégation expirée","info","A",False,"G"),
 ("access.expiring","Accès bientôt expiré","Votre accès expire le {{date}}","warning","EA",False,"G"),
 ("access.suspended_inactivity","Accès suspendu (inactivité)","Accès suspendu après 60 jours d'inactivité","warning","EA",True,"G"),
 ("conflict_of_interest.detected","Conflit d'intérêts détecté","Dossier réaffecté pour conflit d'intérêts","warning","EA",True,"G"),
 ("entity.space.activated","Espace d'entité activé","L'espace {{entite}} est actif","success","EA",False,"G"),
 ("entity.module.attached","Module rattaché","Module {{module}} rattaché à {{entite}}","info","EA",False,"G"),
]),
("apprentissage", "Apprentissage et certification", [
 ("training.assigned","Formation assignée","Formation assignée : {{formation}}","info","EAP",False,"G"),
 ("training.due_soon","Formation à terminer","Terminez {{formation}} avant le {{date}}","warning","AP",False,"G"),
 ("training.completed","Formation terminée","Formation terminée : {{formation}}","success","A",False,"G"),
 ("certification.achieved","Certification obtenue","Certification obtenue : {{certification}}","success","EA",False,"G"),
 ("certification.expiring","Certification bientôt expirée","Recyclage requis avant le {{date}}","warning","EA",True,"G"),
 ("procedure.changed","Procédure modifiée","La procédure {{procedure}} a changé","info","AP",True,"G"),
 ("taxpayer.guide.available","Guide pratique disponible","Guide : {{sujet}}","info","AU",False,"C"),
]),
("plateforme", "Plateforme et continuité", [
 ("system.maintenance_scheduled","Maintenance programmée","Maintenance le {{date}}","info","EA",False,"CG"),
 ("system.maintenance_emergency","Maintenance d'urgence","Maintenance d'urgence en cours","warning","EAS",True,"G"),
 ("system.outage","Interruption de service","Interruption de service — solutions de repli","critical","EAS",True,"CG"),
 ("system.service_restored","Service rétabli","Service rétabli","success","EA",False,"CG"),
 ("system.channel_degraded","Canal dégradé","Canal {{canal}} dégradé — utilisez {{alternative}}","warning","A",False,"CG"),
 ("system.deadline_protection","Protection d'échéance","Échéance prorogée en raison d'une interruption","info","EASU",True,"C"),
 ("release.deployed","Version déployée","Version {{version}} déployée","info","A",False,"G"),
 ("backup.restore_test.failed","Test de restauration échoué","Test de restauration échoué","critical","EAS",True,"G"),
]),
("donnees", "Données personnelles et consentement", [
 ("privacy.consent_request","Demande de consentement","Nous avons besoin de votre accord","info","EA",True,"C"),
 ("privacy.consent_updated","Consentement mis à jour","Vos préférences ont été mises à jour","info","EA",False,"C"),
 ("privacy.access_request.received","Demande d'accès reçue","Votre demande d'accès à vos données est enregistrée","info","EA",True,"C"),
 ("privacy.data_export_ready","Export de données prêt","Votre export de données est prêt","success","EA",False,"C"),
 ("privacy.rectification.done","Rectification effectuée","Vos données ont été rectifiées","success","EA",True,"C"),
 ("privacy.data_shared_with_partner","Partage de données","Vos données ont été communiquées à {{destinataire}} ({{base_legale}})","info","EA",True,"C"),
 ("privacy.breach_notification","Violation de données","Information sur un incident de données","critical","EASC",True,"C"),
]),
("partenaires", "Partenaires, contrats et points de paiement", [
 ("partner.api_key.expiring","Clé d'API bientôt expirée","Clé d'API {{partenaire}} expire le {{date}}","warning","EA",True,"X"),
 ("partner.callback.signature_invalid","Signature de rappel invalide","Rappel rejeté : signature invalide","critical","EA",True,"GX"),
 ("partner.sla_breach","Engagement de service non tenu","SLA non respecté par {{partenaire}}","warning","EA",True,"G"),
 ("payment_point.accredited","Point de paiement agréé","Point {{point}} agréé","success","EA",False,"X"),
 ("payment_point.settlement_overdue","Reversement en retard","Reversement du point {{point}} en retard","critical","EAS",True,"GX"),
 ("payment_point.suspended","Point de paiement suspendu","Point {{point}} suspendu","critical","EAS",True,"X"),
 ("contract.expiring","Contrat bientôt échu","Contrat {{contrat}} échu le {{date}}","warning","EA",False,"G"),
 ("subcontractor.agent.accredited","Agent accrédité","Agent {{agent}} accrédité","success","EA",False,"X"),
 ("subcontractor.agent.revoked","Accréditation révoquée","Accréditation de {{agent}} révoquée","warning","EA",True,"X"),
]),
]

CH = {"E":"email","A":"in-app","S":"sms","P":"push","W":"whatsapp","U":"ussd","V":"svi","C":"courrier"}

def main():
    events=[]
    for key,label,evs in CATS:
        for code,lib,subj,sev,chs,mand,pub in evs:
            chans=[CH[c] for c in chs]
            # WhatsApp : canal d'opt-in pour tout événement contribuable non critique à contenu non sensible
            wa = ("C" in pub) and not mand and sev!="critical"
            events.append(dict(code=code,categorie=key,libelle=lib,objet=subj,gravite=sev,
                               canaux_defaut=chans,whatsapp_optin=wa,obligatoire=mand,public=list(pub)))
    codes=[e["code"] for e in events]; assert len(codes)==len(set(codes)), "codes dupliqués"
    # YAML (écrit à la main pour éviter une dépendance)
    y=["# Catalogue des événements de communication KINSHASA MOSOLO — généré par tools/gen_evenements.py","version: 1","langues: [fr, ln, sw, kg, lua, en]","evenements:"]
    for e in events:
        y.append(f"  - code: {e['code']}")
        for k in ("categorie","libelle","objet","gravite"):
            y.append(f"    {k}: {json.dumps(e[k],ensure_ascii=False)}")
        y.append(f"    canaux_defaut: [{', '.join(e['canaux_defaut'])}]")
        y.append(f"    whatsapp_optin: {str(e['whatsapp_optin']).lower()}")
        y.append(f"    obligatoire: {str(e['obligatoire']).lower()}")
        y.append(f"    public: [{', '.join(e['public'])}]")
    open(os.path.join(ROOT,"specs/evenements-communication.yaml"),"w").write("\n".join(y)+"\n")
    os.makedirs(os.path.join(ROOT,"shared/src/events"),exist_ok=True)
    cats=[dict(code=k,libelle=l) for k,l,_ in CATS]
    json.dump(dict(version=1,categories=cats,evenements=events),open(os.path.join(ROOT,"shared/src/events/catalogue.json"),"w"),ensure_ascii=False,indent=1)
    # Statistiques
    n=len(events); nm=sum(e["obligatoire"] for e in events)
    cov={c:sum(c in e["canaux_defaut"] for e in events) for c in CH.values()}
    cov["whatsapp"]=sum(e["whatsapp_optin"] for e in events)
    md=["# Annexe G — Catalogue des événements de communication","",
        f"Catalogue généré à partir de `specs/evenements-communication.yaml` (outil `tools/gen_evenements.py`). **{n} événements** répartis en **{len(CATS)} catégories**, dont **{nm} avis obligatoires** qui s'appliquent même lorsque le destinataire s'est désinscrit des communications facultatives.","",
        "Légende des canaux : E courriel · A dans l'application · S SMS · P notification push · U boîte USSD · V serveur vocal (SVI) · C courrier imprimé · W WhatsApp (sur consentement préalable, contenu non sensible uniquement). Public : C contribuable · G agent public ou interne · X partenaire externe. **M** = obligatoire.","",
        "## G.1 Synthèse","","| Indicateur | Valeur |","|---|---|",
        f"| Événements au catalogue | {n} |",f"| Catégories | {len(CATS)} |",f"| Avis obligatoires | {nm} |"]
    for c,v in cov.items(): md.append(f"| Événements diffusés par défaut sur « {c} » | {v} |")
    md+=["","| Catégorie | Événements | Obligatoires |","|---|---|---|"]
    for key,label,evs in CATS:
        md.append(f"| {label} | {len(evs)} | {sum(1 for x in evs if x[5])} |")
    for i,(key,label,evs) in enumerate(CATS,1):
        md+=["",f"## G.{i+1} {label}","","| Code | Événement | Objet du message (fr) | Gravité | Canaux | M | Public |","|---|---|---|---|---|---|---|"]
        for code,lib,subj,sev,chs,mand,pub in evs:
            wa = ("C" in pub) and not mand and sev!="critical"
            md.append(f"| `{code}` | {lib} | {subj} | {sev} | {chs}{'+W' if wa else ''} | {'M' if mand else ''} | {pub} |")
    open(os.path.join(ROOT,"docs/document-maitre/95-annexe-g-catalogue-evenements.md"),"w").write("\n".join(md)+"\n")
    print(json.dumps(dict(evenements=n,categories=len(CATS),obligatoires=nm,couverture=cov),ensure_ascii=False))

if __name__=="__main__": main()
