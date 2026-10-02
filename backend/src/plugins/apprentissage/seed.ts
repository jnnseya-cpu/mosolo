/**
 * Données de démonstration du module d'apprentissage [EXEMPLE] — non contractuelles.
 * Contenus rédigés, proposés puis publiés à deux personnes (circuit réel) ; traductions lingala en BROUILLON, à relire
 * par un locuteur. Certificats de démonstration pour les agents déjà habilités des données de démonstration, afin que
 * la garde « certification avant affectation » ne bloque aucun parcours existant.
 */
import type { AppContext } from '../../context.js';
import { kinshasaDate } from '../../core/clock.js';
import type { Profil, ProfilCertifie, Question } from './model.js';
import { VALIDITE_CERTIFICAT_JOURS } from './model.js';
import type { ApprentissageService } from './service.js';

interface Fiche { cle: string; publics: Profil[]; titre: string; corps: string; ln?: { titre: string; corps: string } }
interface Mod { code: string; publics: Profil[]; titre: string; corps: string; lecons: string[]; controlePratique: string; epreuve: Question[] }

const FICHES: Fiche[] = [
  { cle: 'contribuable.payer', publics: ['CONTRIBUABLE', 'GUICHET'], titre: 'Comment payer',
    corps: 'Payez uniquement par monnaie mobile, par banque ou dans un point agréé, vers le compte public. Aucun agent ne peut recevoir d’espèces. Gardez votre quittance : elle se vérifie par son code.',
    ln: { titre: 'Ndenge ya kofuta', corps: 'Futá kaka na mobile money, na banki to na esika endimami, na kɔ́ntɔ ya Leta. Mosali moko te azwaka mbongo na lobɔkɔ. Bómba kitánsi na yo : ekoki kotalelama na kódi na yango.' } },
  { cle: 'contribuable.recours', publics: ['CONTRIBUABLE'], titre: 'Vos droits et recours',
    corps: 'Vous pouvez contester un montant : déposez une réclamation motivée depuis votre espace. Une personne distincte examine votre dossier ; aucune sanction n’est automatique.',
    ln: { titre: 'Makoki na yo', corps: 'Okoki koboya motuya moko : tinda likambo na yo na esika na yo. Moto mosusu akotala likambo na yo ; etumbu ekozala na yango te na ndenge ya makasi.' } },
  { cle: 'preuves.verifier', publics: ['CONTRIBUABLE', 'CONTROLEUR', 'GUICHET'], titre: 'Vérifier une quittance ou une preuve',
    corps: 'Saisissez le code imprimé ou lisez le code QR. Le résultat indique si la preuve est authentique, son objet et sa validité. Une preuve non reconnue n’est jamais acceptée.',
    ln: { titre: 'Kotala kitánsi', corps: 'Kotá kódi to tánga QR. Eyano ekolakisa soki kitánsi ezali ya solo. Kitánsi oyo eyebani te endimamaka te.' } },
  { cle: 'terrain.habilitation', publics: ['CADRE', 'RECENSEUR'], titre: 'Habiliter un agent de terrain',
    corps: 'Un agent n’est habilité qu’avec une identité vérifiée, un engagement déontologique signé et une certification « agent recenseur » en vigueur (épreuves réussies et vérification pratique conforme). L’écran indique ce qui manque.' },
  { cle: 'terrain.protocole', publics: ['RECENSEUR'], titre: 'Protocole de recensement',
    corps: 'Présentez votre badge. Photographiez la façade, enregistrez la position GPS sur place et décrivez ce que vous observez. Ne demandez jamais d’argent : le paiement se fait uniquement vers le compte public.',
    ln: { titre: 'Mibeko ya kotánga bato', corps: 'Lakisá badge na yo. Zwá fɔ́tɔ ya ndáko, bómba esika GPS mpe komá oyo ozali komona. Kosɛnga mbongo te.' } },
  { cle: 'controle.constat', publics: ['CONTROLEUR'], titre: 'Rédiger un constat',
    corps: 'Un constat décrit des faits vérifiables, cite ses preuves (photo, position, pièces) et rappelle au contribuable ses droits. Il ne crée jamais seul une obligation : un réviseur distinct le valide.' },
  { cle: 'fiscal.corrections', publics: ['CONTROLEUR', 'CADRE'], titre: 'Proposer une correction d’objet',
    corps: 'Indiquez l’ancienne et la nouvelle valeur, justifiez et joignez les pièces. Une seconde personne approuve ; l’historique n’est jamais effacé.' },
  { cle: 'guichet.assistance', publics: ['GUICHET'], titre: 'Assister un paiement sans toucher d’espèces',
    corps: 'Aidez le contribuable à payer depuis son propre téléphone ou orientez-le vers un point agréé. Vous ne recevez jamais d’argent, même pour rendre service.' },
  { cle: 'cadre.exceptions', publics: ['CADRE'], titre: 'Traiter une exception',
    corps: 'Une exception se traite par une décision motivée et tracée, avec quatre yeux lorsque le circuit l’exige. Les indicateurs individuels portent sur des résultats vérifiés, jamais sur une surveillance des personnes.' },
  { cle: 'finances.rapprochement', publics: ['FINANCES'], titre: 'Rapprocher et imputer',
    corps: 'Chaque encaissement est rapproché du relevé du prestataire ou de la banque. Un écart ouvre une exception, résolue par proposition puis approbation d’une autre personne.' },
  { cle: 'admin.acces', publics: ['ADMINISTRATEUR'], titre: 'Gérer les accès et les incidents',
    corps: 'Attribuez le moindre privilège, révisez les accès périodiquement, retirez immédiatement un accès inutile et déclarez tout incident de sécurité.' },
];

const q = (id: string, enonce: string, choix: string[], bonne: number): Question => ({ id, enonce, choix, bonne });

const MODULES: Mod[] = [
  { code: 'RECENSEMENT-BASE', publics: ['RECENSEUR'], titre: 'Recensement : protocole, photo, position, déontologie', corps: 'Module de base de l’agent recenseur (démonstration).',
    lecons: ['terrain.protocole', 'contribuable.payer'], controlePratique: 'Un constat réel réalisé sous le regard du superviseur : badge présenté, photo, position GPS sur place.',
    epreuve: [
      q('q1', 'Un habitant vous tend de l’argent pour « régler tout de suite ». Que faites-vous ?', ['Je l’accepte et je fais un reçu', 'Je refuse et je lui indique les moyens de paiement vers le compte public', 'Je le garde pour le guichet'], 1),
      q('q2', 'Où la position GPS d’un constat est-elle enregistrée ?', ['Sur place, au moment du constat', 'Au bureau, de mémoire', 'Elle est facultative'], 0),
      q('q3', 'Un constat crée-t-il à lui seul une dette ?', ['Oui', 'Non : il est vérifié par un réviseur distinct'], 1),
    ] },
  { code: 'CONTROLE-CONSTAT', publics: ['CONTROLEUR'], titre: 'Contrôle : constat, rédaction, droits, preuve', corps: 'Module du contrôleur (démonstration).',
    lecons: ['controle.constat', 'preuves.verifier', 'contribuable.recours'], controlePratique: 'Rédaction d’un constat complet relu par un chef de service.',
    epreuve: [
      q('q1', 'Que doit citer un constat ?', ['Ses preuves vérifiables', 'Une impression générale', 'Le montant à payer décidé par le contrôleur'], 0),
      q('q2', 'Le contribuable peut-il contester ?', ['Non', 'Oui, par une réclamation motivée examinée par une autre personne'], 1),
    ] },
  { code: 'GUICHET-ACCOMPAGNEMENT', publics: ['GUICHET'], titre: 'Guichet : accompagnement sans espèces', corps: 'Module de l’agent de guichet (démonstration).',
    lecons: ['guichet.assistance', 'contribuable.payer', 'preuves.verifier'], controlePratique: 'Observation d’accompagnements au guichet (évaluation continue).',
    epreuve: [
      q('q1', 'Un contribuable n’a pas de téléphone. Que faites-vous ?', ['J’encaisse ses espèces', 'Je l’oriente vers un point de paiement agréé', 'Je paie à sa place'], 1),
      q('q2', 'Comment vérifier une quittance présentée ?', ['Par son code ou son QR', 'À son apparence'], 0),
    ] },
  { code: 'CADRE-PILOTAGE', publics: ['CADRE'], titre: 'Pilotage par indicateurs, exceptions, éthique', corps: 'Module des cadres et superviseurs (démonstration).',
    lecons: ['cadre.exceptions', 'terrain.habilitation', 'fiscal.corrections'], controlePratique: 'Évaluation sur résultats vérifiés (indicateurs existants).',
    epreuve: [
      q('q1', 'Sur quoi portent les indicateurs individuels ?', ['Sur des résultats vérifiables', 'Sur le temps passé devant l’écran'], 0),
      q('q2', 'Une proposition que vous avez faite peut-elle être approuvée par vous ?', ['Oui', 'Non : quatre yeux'], 1),
    ] },
  { code: 'FINANCES-RAPPROCHEMENT', publics: ['FINANCES'], titre: 'Rapprochement, imputation, écarts', corps: 'Module des équipes finances et trésorerie (démonstration).',
    lecons: ['finances.rapprochement'], controlePratique: 'Contrôle d’un échantillon d’actes de rapprochement et d’imputation.',
    epreuve: [
      q('q1', 'Un écart de rapprochement apparaît. Que faites-vous ?', ['Je corrige directement le montant', 'J’ouvre une exception, résolue à deux personnes'], 1),
      q('q2', 'Vers quel compte vont les paiements ?', ['Le compte public', 'Le compte de l’agent'], 0),
    ] },
  { code: 'ADMIN-SECURITE', publics: ['ADMINISTRATEUR'], titre: 'Sécurité, accès, incidents', corps: 'Module des administrateurs (démonstration).',
    lecons: ['admin.acces'], controlePratique: 'Vérification de l’habilitation par le responsable sécurité.',
    epreuve: [
      q('q1', 'Quel principe guide l’attribution des accès ?', ['Le moindre privilège', 'Tous les accès par défaut'], 0),
      q('q2', 'Un accès n’est plus utile. Que faites-vous ?', ['Je le laisse', 'Je le retire immédiatement et je le trace'], 1),
    ] },
];

/** Auteur puis approbateur distinct, selon le public visé. */
function circuit(publics: Profil[]): [string, string] {
  if (publics.includes('FINANCES')) return ['u-tresor', 'u-dg-dgipk'];
  if (publics.includes('ADMINISTRATEUR')) return ['u-rssi', 'u-admin-entite'];
  return ['u-admin-entite', 'u-dg-dgipk'];
}

export function seedApprentissage(ctx: AppContext, svc: ApprentissageService): void {
  const user = (id: string) => ctx.users.get(id);
  const publier = (id: string, publics: Profil[]) => {
    const [a, b] = circuit(publics);
    svc.proposerPublication(user(a)!, id);
    svc.deciderPublication(user(b)!, id, { approve: true, motif: 'Relu et conforme (démonstration) [EXEMPLE]' });
  };
  for (const f of FICHES) {
    const c = svc.creerContenu(user(circuit(f.publics)[0])!, { type: 'FICHE', cle: f.cle, publics: f.publics, titre: f.titre, corps: f.corps, ...(f.ln ? { lingala: f.ln } : {}) }, { demo: true });
    publier(c.id, f.publics);
  }
  for (const m of MODULES) {
    const c = svc.creerContenu(user(circuit(m.publics)[0])!, {
      type: 'MODULE', cle: m.code, publics: m.publics, titre: m.titre, corps: m.corps, lecons: m.lecons, epreuve: m.epreuve, controlePratique: m.controlePratique,
    }, { demo: true });
    publier(c.id, m.publics);
  }
  // Base de procédures versionnée (module 50) : une procédure publiée en deux versions successives [EXEMPLE].
  const proc = svc.creerContenu(user(circuit(['RECENSEUR', 'CONTROLEUR'])[0])!, {
    type: 'PROCEDURE', cle: 'procedure.constat-terrain', publics: ['RECENSEUR', 'CONTROLEUR'], titre: 'Procédure du constat sur le terrain',
    corps: '1. Présenter son badge. 2. Photographier l’objet et relever la position. 3. Informer la personne de ses droits. Aucun paiement n’est encaissé sur place. [EXEMPLE — démonstration]',
  }, { demo: true });
  publier(proc.id, ['RECENSEUR', 'CONTROLEUR']);
  svc.nouvelleVersion(user(circuit(['RECENSEUR', 'CONTROLEUR'])[0])!, proc.id, {
    titre: 'Procédure du constat sur le terrain',
    corps: '1. Présenter son badge et proposer sa vérification (QR). 2. Photographier l’objet et relever la position. 3. Informer la personne de ses droits et du délai de réclamation. Aucun paiement n’est encaissé sur place. [EXEMPLE — démonstration, version 2]',
  });
  publier(proc.id, ['RECENSEUR', 'CONTROLEUR']);

  // Une fiche en attente de publication : illustre le circuit à deux personnes.
  const attente = svc.creerContenu(user('u-admin-entite')!, {
    type: 'FICHE', cle: 'canaux.enrolement', publics: ['GUICHET', 'RECENSEUR'], titre: 'Enrôler un contribuable accompagné',
    corps: 'Vérifiez la pièce d’identité, saisissez les informations avec le contribuable et remettez-lui son numéro. Aucun paiement n’est encaissé lors de l’enrôlement.',
    lingala: { titre: 'Kokomisa mofuti mpako', corps: 'Talá káti ya ndéngé, komá makambo elongo na ye mpe pesá ye nimero na ye. Mbongo ezwamaka te.' },
  }, { demo: true });
  svc.proposerPublication(user('u-admin-entite')!, attente.id);

  // Certificats de démonstration [EXEMPLE] : agents déjà habilités et un titulaire par public (un certificat expiré).
  const now = ctx.clock.now().getTime();
  const d = (n: number) => kinshasaDate(new Date(now + n * 86_400_000));
  const certifier = (userId: string, profil: ProfilCertifie, ilYa = 30, validite = VALIDITE_CERTIFICAT_JOURS[profil]) => {
    svc.certificats.insert({
      id: `CERT-DEMO-${profil}-${userId}`, userId, profil, delivreLe: new Date(now - ilYa * 86_400_000).toISOString(), valableJusquau: d(validite - ilYa),
      delivrePar: 'u-dg-dgipk', fondement: { epreuves: [], evaluations: [], note: 'Certificat de démonstration [EXEMPLE] — non contractuel, aucun parcours réel.' }, statut: 'DELIVRE', demo: true,
    });
  };
  for (const id of ['u-agent-terrain', 'u-agent-terrain-2', 'u-agent-gombe', 'terrain-agent-regie-qc', 'terrain-st-agent-1']) certifier(id, 'RECENSEUR');
  certifier('u-controleur', 'CONTROLEUR', 340);
  certifier('u-guichet', 'GUICHET');
  certifier('u-superviseur', 'CADRE');
  certifier('u-dg-dgipk', 'CADRE');
  certifier('u-tresor', 'FINANCES');
  certifier('u-analyste-rappro', 'FINANCES', 400);
  certifier('u-rssi', 'ADMINISTRATEUR');
  const guichet = user('u-guichet');
  if (guichet) {
    svc.enregistrerEvaluation(user('u-admin-entite')!, {
      userId: 'u-guichet', profil: 'GUICHET', resultat: 'CONFORME', observations: 'Accompagnement observé : orientation vers le paiement numérique, aucune espèce (démonstration) [EXEMPLE].',
    }, { demo: true });
  }
}
