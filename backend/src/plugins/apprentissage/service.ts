/**
 * Service d'apprentissage intégré au poste de travail (§ 24) :
 *  - fiches d'aide contextuelle (clé d'écran ou d'action) et modules, versionnés, publiés à deux personnes ;
 *  - épreuves des modules (seuil PAR DÉFAUT), évaluations humaines par public, certificats datés ;
 *  - `certificationValide(userId, profil)` : garde réutilisable (habilitation des agents de terrain) ;
 *  - indicateur de compréhension des contribuables (dossiers complets du premier coup) ;
 *  - garde de confidentialité : seuls des actes professionnels sont enregistrés, jamais de surveillance continue.
 * Aucune sanction automatique : un résultat insuffisant ouvre une proposition de reprise, décidée par une personne.
 */
import { randomInt } from 'node:crypto';
import type { AppContext } from '../../context.js';
import { actorOf } from '../../core/audit.js';
import type { User } from '../../core/auth.js';
import { kinshasaDate, kinshasaDay } from '../../core/clock.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../core/errors.js';
import { assertDistinctPerson, authorize, evaluate } from '../../core/policy.js';
import { IdGenerator, InMemoryAppendOnlyRepository, InMemoryRepository } from '../../core/repository.js';
import { pct } from '../../core/percent.js';
import {
  ACTES_FINANCES, CONFIDENTIALITE, ECHANTILLON_CONFORMITE_MIN_PCT, ECHANTILLON_TAILLE, EVALUATEURS, EVALUATION_CONTINUE_INTERVALLE_JOURS,
  EVALUATION_EXIGEE, LIENS_INDICATEURS, MODE_VALIDATION, PROFIL_LIBELLE, PROFILS, PROFILS_CERTIFIES, profilsDe, SEUIL_REUSSITE_EPREUVE_PCT,
  STATUT_PARAMETRE, VALIDITE_CERTIFICAT_JOURS,
  type Certificat, type Contenu, type Epreuve, type Evaluation, type Profil, type ProfilCertifie, type Question, type TypeContenu,
  type VersionContenu,
} from './model.js';
import { APPRENTISSAGE_ACTIONS as A } from './policy.js';

export interface ContenuInput {
  titre: string; corps: string; lingala?: { titre: string; corps: string };
  lecons?: string[]; epreuve?: Question[]; controlePratique?: string;
}
export interface EvaluationInput {
  userId: string; profil: ProfilCertifie; resultat?: 'CONFORME' | 'NON_CONFORME'; observations: string; references?: string[];
  echantillon?: { taille: number; conformes: number };
}
export interface Exigence { code: string; libelle: string; satisfaite: boolean; detail?: string }
export interface EtatCertification {
  /** Faux si le module n'est pas chargé (garde inactive) — toujours vrai ici. */
  applicable: boolean;
  valide: boolean;
  profil: ProfilCertifie;
  certificat: Certificat | null;
  manquants: string[];
  exigences: Exigence[];
  /** Évaluation continue défavorable depuis la délivrance : reprise proposée, aucune sanction automatique. */
  aRevoir?: string;
}

const DAY_MS = 86_400_000;

export class ApprentissageService {
  readonly contenus = new InMemoryRepository<Contenu>();
  readonly epreuves = new InMemoryAppendOnlyRepository<Epreuve>();
  readonly evaluations = new InMemoryAppendOnlyRepository<Evaluation>();
  readonly certificats = new InMemoryRepository<Certificat>();
  private readonly ids = new IdGenerator();

  constructor(private readonly ctx: AppContext) {}

  private now(): string {
    return this.ctx.clock.now().toISOString();
  }
  private today(): string {
    return kinshasaDate(this.ctx.clock.now());
  }
  private plusJours(n: number): string {
    return kinshasaDate(new Date(this.ctx.clock.now().getTime() + n * DAY_MS));
  }
  private audit(u: User, action: string, resourceType: string, resourceId: string, details: Record<string, unknown> = {}): void {
    this.ctx.audit.append({ actor: actorOf(u), action, resourceType, resourceId, details });
  }

  // ─────────────────────────────────────────── contenus versionnés ───────────────────────────────────────────

  private mustContenu(id: string): Contenu {
    const c = this.contenus.get(id);
    if (!c) throw notFound('CONTENU_NOT_FOUND', `Contenu inconnu : ${id}`);
    return c;
  }
  private validerModule(type: TypeContenu, input: ContenuInput): void {
    if (type !== 'MODULE') return;
    const ep = input.epreuve ?? [];
    if (ep.length === 0) throw badRequest('EPREUVE_REQUISE', 'Un module comporte une épreuve (au moins une question).');
    for (const q of ep) if (q.bonne < 0 || q.bonne >= q.choix.length) throw badRequest('EPREUVE_INVALIDE', `Question ${q.id} : bonne réponse hors des choix.`);
  }
  private version(u: User, n: number, input: ContenuInput): VersionContenu {
    return {
      version: n, titre: input.titre, corps: input.corps, statut: 'BROUILLON', auteur: u.id, creeLe: this.now(),
      ...(input.lingala ? { lingala: { ...input.lingala, statut: 'BROUILLON' as const } } : {}),
      ...(input.lecons ? { lecons: input.lecons } : {}), ...(input.epreuve ? { epreuve: input.epreuve } : {}),
      ...(input.controlePratique ? { controlePratique: input.controlePratique } : {}),
    };
  }

  creerContenu(u: User, input: ContenuInput & { type: TypeContenu; cle: string; publics: Profil[] }, opts: { id?: string; demo?: boolean } = {}): Contenu {
    authorize(u, A.contenuWrite);
    if (this.contenus.findOne((c) => c.type === input.type && c.cle === input.cle)) throw conflict('CLE_DEJA_UTILISEE', `Un contenu « ${input.cle} » existe déjà : créez-en une nouvelle version.`);
    this.validerModule(input.type, input);
    const c = this.contenus.insert({
      id: opts.id ?? this.ids.next(input.type === 'FICHE' ? 'FICHE' : 'MOD', 4), type: input.type, cle: input.cle, publics: [...new Set(input.publics)],
      versions: [this.version(u, 1, input)], ...(opts.demo ? { demo: true } : {}),
    });
    this.audit(u, 'apprentissage.contenu.cree', 'apprentissage_contenu', c.id, { cle: c.cle, type: c.type });
    return c;
  }

  nouvelleVersion(u: User, id: string, input: ContenuInput): Contenu {
    authorize(u, A.contenuWrite);
    const c = this.mustContenu(id);
    if (c.versions.some((v) => v.statut === 'BROUILLON' || v.statut === 'PROPOSEE')) throw conflict('VERSION_EN_COURS', 'Une version est déjà en brouillon ou en attente de publication.');
    this.validerModule(c.type, input);
    const updated = this.contenus.update({ ...c, versions: [...c.versions, this.version(u, c.versions.length + 1, input)] });
    this.audit(u, 'apprentissage.contenu.version_creee', 'apprentissage_contenu', id, { version: c.versions.length + 1 });
    return updated;
  }

  proposerPublication(u: User, id: string): Contenu {
    authorize(u, A.contenuWrite);
    const c = this.mustContenu(id);
    const v = c.versions.find((x) => x.statut === 'BROUILLON');
    if (!v) throw conflict('AUCUN_BROUILLON', 'Aucune version en brouillon à proposer.');
    const updated = this.contenus.update({ ...c, versions: c.versions.map((x) => (x === v ? { ...x, statut: 'PROPOSEE' as const, proposition: { par: u.id, le: this.now() } } : x)) });
    this.audit(u, 'apprentissage.contenu.publication_proposee', 'apprentissage_contenu', id, { version: v.version, cle: c.cle });
    return updated;
  }

  /** Décision de publication : seconde personne, distincte de l'auteur ET du proposant (quatre yeux). */
  deciderPublication(u: User, id: string, input: { approve: boolean; motif: string }): Contenu {
    authorize(u, A.contenuApprove);
    const c = this.mustContenu(id);
    const v = c.versions.find((x) => x.statut === 'PROPOSEE');
    if (!v?.proposition) throw conflict('AUCUNE_PROPOSITION', 'Aucune version en attente de publication.');
    assertDistinctPerson(u.id, [v.auteur, v.proposition.par], 'Quatre yeux : la publication revient à une personne distincte de l’auteur et du proposant.');
    const decision = { par: u.id, le: this.now(), approuve: input.approve, motif: input.motif };
    const versions = c.versions.map((x): VersionContenu => {
      if (x === v) return { ...x, statut: input.approve ? 'PUBLIEE' : 'REFUSEE', decision };
      if (input.approve && x.statut === 'PUBLIEE') return { ...x, statut: 'REMPLACEE' };
      return x;
    });
    const updated = this.contenus.update({ ...c, versions });
    this.audit(u, input.approve ? 'apprentissage.contenu.publie' : 'apprentissage.contenu.publication_refusee', 'apprentissage_contenu', id,
      { version: v.version, cle: c.cle, proposedBy: v.proposition.par, motif: input.motif });
    return updated;
  }

  private publiee(c: Contenu): VersionContenu | undefined {
    return c.versions.find((v) => v.statut === 'PUBLIEE');
  }

  /** Vue d'une version pour l'apprenant : jamais la bonne réponse de l'épreuve. */
  private vueApprenant(c: Contenu, v: VersionContenu) {
    const { epreuve, ...rest } = v;
    return {
      id: c.id, type: c.type, cle: c.cle, publics: c.publics, ...(c.demo ? { demo: true } : {}), ...rest,
      ...(epreuve ? { epreuve: epreuve.map(({ id, enonce, choix }) => ({ id, enonce, choix })) } : {}),
      ...(v.lingala ? { lingalaNote: 'Traduction lingala : brouillon à relire par un locuteur — le texte français fait foi.' } : {}),
    };
  }

  /** Aide contextuelle publiée d'un écran ou d'une action (lecture libre : aucune donnée personnelle). */
  aide(cle: string) {
    const c = this.contenus.findOne((x) => x.type === 'FICHE' && x.cle === cle);
    const v = c ? this.publiee(c) : undefined;
    if (!c || !v) throw notFound('AIDE_INTROUVABLE', `Aucune aide publiée pour « ${cle} ».`);
    return this.vueApprenant(c, v);
  }

  /** Liste de gestion des contenus (toutes versions, bonnes réponses comprises). */
  listeContenus(u: User) {
    if (!evaluate(u, A.contenuWrite) && !evaluate(u, A.certificationRead)) authorize(u, A.contenuWrite);
    return this.contenus.all();
  }

  // ─────────────────────────────────────────── espace de l'apprenant ───────────────────────────────────────────

  espace(u: User) {
    authorize(u, A.espaceRead);
    const profils = profilsDe(u.roles);
    const pour = (c: Contenu) => c.publics.some((p) => profils.includes(p));
    const publies = this.contenus.all().filter(pour).map((c) => ({ c, v: this.publiee(c) })).filter((x): x is { c: Contenu; v: VersionContenu } => !!x.v);
    const mesEpreuves = this.epreuves.find((e) => e.userId === u.id);
    return {
      profils: profils.map((p) => ({ profil: p, nom: PROFIL_LIBELLE[p], ...MODE_VALIDATION[p] })),
      fiches: publies.filter((x) => x.c.type === 'FICHE').map((x) => this.vueApprenant(x.c, x.v)),
      modules: publies.filter((x) => x.c.type === 'MODULE').map((x) => {
        const derniere = mesEpreuves.filter((e) => e.moduleId === x.c.id).sort((a, b) => b.le.localeCompare(a.le))[0];
        return { ...this.vueApprenant(x.c, x.v), derniereEpreuve: derniere ?? null };
      }),
      certifications: profils.filter((p): p is ProfilCertifie => p !== 'CONTRIBUABLE').map((p) => this.certificationValide(u.id, p)),
      seuilReussitePct: SEUIL_REUSSITE_EPREUVE_PCT, statutSeuil: STATUT_PARAMETRE,
      confidentialite: CONFIDENTIALITE,
    };
  }

  /** Épreuve d'un module : score calculé par le serveur, seul le résultat est conservé (acte volontaire). */
  soumettreEpreuve(u: User, moduleId: string, reponses: Record<string, number>) {
    authorize(u, A.epreuveSubmit);
    const c = this.mustContenu(moduleId);
    const v = this.publiee(c);
    if (c.type !== 'MODULE' || !v?.epreuve) throw unprocessable('MODULE_NON_PUBLIE', 'Module sans version publiée : épreuve impossible.');
    if (!c.publics.some((p) => profilsDe(u.roles).includes(p))) throw forbidden('HORS_PUBLIC', 'Ce module ne concerne pas vos fonctions.');
    const bonnes = v.epreuve.filter((q) => reponses[q.id] === q.bonne).length;
    const scorePct = Math.floor((bonnes * 100) / v.epreuve.length);
    const e = this.epreuves.append({ id: this.ids.next('EPR'), userId: u.id, moduleId, version: v.version, scorePct, reussie: scorePct >= SEUIL_REUSSITE_EPREUVE_PCT, le: this.now() });
    this.audit(u, 'apprentissage.epreuve.soumise', 'apprentissage_epreuve', e.id, { moduleId, version: v.version, scorePct, reussie: e.reussie });
    return {
      epreuve: e, seuilPct: SEUIL_REUSSITE_EPREUVE_PCT, statutSeuil: STATUT_PARAMETRE,
      corrections: v.epreuve.map((q) => ({ id: q.id, correcte: reponses[q.id] === q.bonne })),
      note: e.reussie ? 'Épreuve réussie.' : 'Épreuve non réussie : relisez les micro-leçons et recommencez quand vous le souhaitez (aucune sanction).',
    };
  }

  // ─────────────────────────────────────────── évaluations et certificats ───────────────────────────────────────────

  private assertEvaluateur(u: User, profil: ProfilCertifie, userId: string): void {
    authorize(u, A.certificationManage);
    if (!u.roles.some((r) => EVALUATEURS[profil].includes(r))) throw forbidden('EVALUATEUR_NON_HABILITE', `Évaluation ou certification « ${PROFIL_LIBELLE[profil]} » réservée aux rôles ${EVALUATEURS[profil].join(', ')}.`);
    assertDistinctPerson(u.id, [userId], 'Nul ne s’évalue ni ne se certifie lui-même.');
  }

  enregistrerEvaluation(u: User, input: EvaluationInput, opts: { demo?: boolean } = {}): Evaluation {
    this.assertEvaluateur(u, input.profil, input.userId);
    const { type } = EVALUATION_EXIGEE[input.profil];
    const references = input.references ?? [];
    let resultat = input.resultat;
    let echantillon: Evaluation['echantillon'];
    if (type === 'RESULTATS_VERIFIES' && references.length === 0) {
      throw badRequest('REFERENCES_REQUISES', 'Évaluation par résultats vérifiés : citez au moins un indicateur existant ou un dossier vérifié (aucune mesure intrusive).');
    }
    if (type === 'ECHANTILLON') {
      const s = input.echantillon;
      if (!s || s.taille < 1 || s.conformes < 0 || s.conformes > s.taille) throw badRequest('ECHANTILLON_REQUIS', 'Contrôle par échantillon : taille et nombre d’actes conformes requis.');
      const conformitePct = Math.floor((s.conformes * 100) / s.taille);
      echantillon = { taille: s.taille, conformes: s.conformes, conformitePct, seuilPct: ECHANTILLON_CONFORMITE_MIN_PCT };
      resultat = conformitePct >= ECHANTILLON_CONFORMITE_MIN_PCT ? 'CONFORME' : 'NON_CONFORME';
    }
    if (!resultat) throw badRequest('RESULTAT_REQUIS', 'Résultat de l’évaluation requis (conforme ou non conforme).');
    const ev = this.evaluations.append({
      id: this.ids.next('EVA'), userId: input.userId, profil: input.profil, type, resultat, observations: input.observations, references,
      ...(echantillon ? { echantillon } : {}), evaluateur: u.id, le: this.now(), ...(opts.demo ? { demo: true } : {}),
    });
    this.audit(u, 'apprentissage.evaluation.enregistree', 'apprentissage_evaluation', ev.id, { userId: ev.userId, profil: ev.profil, type, resultat });
    return ev;
  }

  /** Échantillon d'actes professionnels (journal d'audit) d'un agent des finances — jamais de mesure d'activité. */
  echantillon(u: User, userId: string) {
    this.assertEvaluateur(u, 'FINANCES', userId);
    const actes = this.ctx.audit.list({ limit: 1_000_000 }).items
      .filter((r) => r.actor.kind === 'user' && r.actor.id === userId && r.outcome === 'SUCCESS' && ACTES_FINANCES.some((p) => r.action.startsWith(p)));
    const tires: typeof actes = [];
    const pool = [...actes];
    while (tires.length < ECHANTILLON_TAILLE && pool.length > 0) tires.push(pool.splice(randomInt(pool.length), 1)[0]!);
    return {
      userId, taille: ECHANTILLON_TAILLE, seuilConformitePct: ECHANTILLON_CONFORMITE_MIN_PCT, statutSeuil: STATUT_PARAMETRE, disponibles: actes.length,
      actes: tires.map((r) => ({ auditId: r.id, action: r.action, ressource: `${r.resourceType}:${r.resourceId}`, le: r.at })),
      note: 'Tirage aléatoire parmi les actes professionnels journalisés (rapprochement, imputation, écarts). L’évaluateur vérifie chaque acte puis saisit le nombre d’actes conformes.',
    };
  }

  private dernierCertificat(userId: string, profil: ProfilCertifie): Certificat | undefined {
    return this.certificats.find((c) => c.userId === userId && c.profil === profil).sort((a, b) => b.delivreLe.localeCompare(a.delivreLe))[0];
  }

  /** Exigences d'un public pour une (re)certification : épreuves réussies et évaluation conforme POSTÉRIEURES au dernier certificat. */
  exigences(userId: string, profil: ProfilCertifie): { exigences: Exigence[]; epreuves: string[]; evaluations: string[] } {
    const depuis = this.dernierCertificat(userId, profil)?.delivreLe ?? '';
    const modules = this.contenus.all().filter((c) => c.type === 'MODULE' && c.publics.includes(profil) && this.publiee(c));
    const out: Exigence[] = [];
    const epreuves: string[] = [];
    for (const m of modules) {
      const ok = this.epreuves.find((e) => e.userId === userId && e.moduleId === m.id && e.reussie && e.le > depuis).sort((a, b) => b.le.localeCompare(a.le))[0];
      if (ok) epreuves.push(ok.id);
      out.push({ code: `MODULE:${m.id}`, libelle: `Épreuve du module « ${this.publiee(m)!.titre} » réussie (seuil ${SEUIL_REUSSITE_EPREUVE_PCT} % — ${STATUT_PARAMETRE})`, satisfaite: !!ok, ...(ok ? { detail: `${ok.scorePct} % le ${kinshasaDay(ok.le)}` } : {}) });
    }
    if (modules.length === 0) out.push({ code: 'MODULE:AUCUN', libelle: `Aucun module publié pour « ${PROFIL_LIBELLE[profil]} » : publier au moins un module (quatre yeux)`, satisfaite: false });
    const exig = EVALUATION_EXIGEE[profil];
    const plancher = profil === 'GUICHET' ? `${this.plusJours(-EVALUATION_CONTINUE_INTERVALLE_JOURS)}T00:00:00.000Z` : '';
    const ev = this.evaluations.find((e) => e.userId === userId && e.profil === profil && e.type === exig.type && e.le > depuis && e.le >= plancher)
      .sort((a, b) => b.le.localeCompare(a.le))[0];
    const evaluations = ev?.resultat === 'CONFORME' ? [ev.id] : [];
    out.push({
      code: `EVALUATION:${exig.type}`, libelle: `${exig.libelle} — conforme${profil === 'GUICHET' ? ` (moins de ${EVALUATION_CONTINUE_INTERVALLE_JOURS} jours — ${STATUT_PARAMETRE})` : ''}`,
      satisfaite: ev?.resultat === 'CONFORME', ...(ev ? { detail: `${ev.resultat === 'CONFORME' ? 'Conforme' : 'Non conforme'} le ${kinshasaDay(ev.le)}` } : {}),
    });
    return { exigences: out, epreuves, evaluations };
  }

  /**
   * Garde réutilisable : le compte détient-il un certificat en vigueur pour ce public ? Sinon, liste de ce qui manque.
   * Utilisée par l'habilitation des agents de terrain (certification AVANT affectation).
   */
  certificationValide(userId: string, profil: ProfilCertifie): EtatCertification {
    const today = this.today();
    const cert = this.dernierCertificat(userId, profil);
    const { exigences } = this.exigences(userId, profil);
    const base = { applicable: true, profil, exigences };
    if (cert && cert.statut === 'DELIVRE' && cert.valableJusquau >= today) {
      const defav = this.evaluations.find((e) => e.userId === userId && e.profil === profil && e.le > cert.delivreLe && e.resultat === 'NON_CONFORME')[0];
      return { ...base, valide: true, certificat: cert, manquants: [], ...(defav ? { aRevoir: `Évaluation non conforme le ${kinshasaDay(defav.le)} : reprise de formation proposée — décision humaine, aucune sanction automatique.` } : {}) };
    }
    const manquants: string[] = [];
    if (!cert) manquants.push(`Aucun certificat « ${PROFIL_LIBELLE[profil]} » délivré`);
    else if (cert.statut === 'RETIRE') manquants.push(`Certificat ${cert.id} retiré le ${kinshasaDay(cert.retrait!.le)} (${cert.retrait!.motif})`);
    else manquants.push(`Certificat ${cert.id} expiré le ${cert.valableJusquau} : ${profil === 'CONTROLEUR' ? 'recertification annuelle' : 'renouvellement'} requis`);
    for (const e of exigences) if (!e.satisfaite) manquants.push(e.libelle);
    return { ...base, valide: false, certificat: cert ?? null, manquants };
  }

  /** Vue d'une certification pour un gestionnaire (lecture). */
  etat(u: User, userId: string, profil: ProfilCertifie): EtatCertification {
    if (u.id !== userId) authorize(u, A.certificationRead);
    else authorize(u, A.espaceRead);
    return this.certificationValide(userId, profil);
  }

  delivrerCertificat(u: User, userId: string, profil: ProfilCertifie): Certificat {
    this.assertEvaluateur(u, profil, userId);
    if (!this.ctx.users.get(userId)) throw notFound('USER_NOT_FOUND', `Compte inconnu : ${userId}`);
    const { exigences, epreuves, evaluations } = this.exigences(userId, profil);
    const manquants = exigences.filter((e) => !e.satisfaite).map((e) => e.libelle);
    if (manquants.length > 0) throw unprocessable('CERTIFICATION_INCOMPLETE', `Certification impossible : ${manquants.join(' ; ')}.`, { manquants });
    const cert = this.certificats.insert({
      id: this.ids.next('CERT'), userId, profil, delivreLe: this.now(), valableJusquau: this.plusJours(VALIDITE_CERTIFICAT_JOURS[profil]),
      delivrePar: u.id, fondement: { epreuves, evaluations }, statut: 'DELIVRE',
    });
    this.audit(u, 'apprentissage.certificat.delivre', 'apprentissage_certificat', cert.id, { userId, profil, valableJusquau: cert.valableJusquau });
    return cert;
  }

  /** Retrait motivé (décision humaine, tracée) — jamais automatique. */
  retirerCertificat(u: User, id: string, motif: string): Certificat {
    const c = this.certificats.get(id);
    if (!c) throw notFound('CERTIFICAT_NOT_FOUND', `Certificat inconnu : ${id}`);
    this.assertEvaluateur(u, c.profil, c.userId);
    if (c.statut === 'RETIRE') throw conflict('DEJA_RETIRE', 'Certificat déjà retiré.');
    const updated = this.certificats.update({ ...c, statut: 'RETIRE', retrait: { par: u.id, le: this.now(), motif } });
    this.audit(u, 'apprentissage.certificat.retire', 'apprentissage_certificat', id, { userId: c.userId, profil: c.profil, motif });
    return updated;
  }

  mesCertificats(u: User) {
    authorize(u, A.espaceRead);
    const today = this.today();
    return this.certificats.find((c) => c.userId === u.id).sort((a, b) => b.delivreLe.localeCompare(a.delivreLe))
      .map((c) => ({ ...c, libelleProfil: PROFIL_LIBELLE[c.profil], enVigueur: c.statut === 'DELIVRE' && c.valableJusquau >= today }));
  }

  /** Registre des certifications (gestion) : par compte et par public, sans aucun classement. */
  registre(u: User) {
    authorize(u, A.certificationRead);
    const today = this.today();
    const comptes = this.ctx.users.all().filter((x) => x.roles.some((r) => PROFILS_CERTIFIES.some((p) => profilsDe([r]).includes(p))));
    const lignes = comptes.flatMap((x) => profilsDe(x.roles).filter((p): p is ProfilCertifie => p !== 'CONTRIBUABLE').map((p) => {
      const e = this.certificationValide(x.id, p);
      return { userId: x.id, nom: x.name, profil: p, libelleProfil: PROFIL_LIBELLE[p], valide: e.valide, certificat: e.certificat, manquants: e.manquants, ...(e.aRevoir ? { aRevoir: e.aRevoir } : {}) };
    }));
    return {
      lignes: lignes.sort((a, b) => a.profil.localeCompare(b.profil) || a.userId.localeCompare(b.userId)),
      evaluations: this.evaluations.all().sort((a, b) => b.le.localeCompare(a.le)).slice(0, 200),
      today, parametres: this.parametres(), liensIndicateurs: LIENS_INDICATEURS, evaluateurs: EVALUATEURS, evaluationExigee: EVALUATION_EXIGEE,
    };
  }

  parametres() {
    return {
      statut: STATUT_PARAMETRE,
      seuilReussiteEpreuvePct: SEUIL_REUSSITE_EPREUVE_PCT,
      validiteCertificatJours: VALIDITE_CERTIFICAT_JOURS,
      evaluationContinueIntervalleJours: EVALUATION_CONTINUE_INTERVALLE_JOURS,
      echantillonTaille: ECHANTILLON_TAILLE,
      echantillonConformiteMinPct: ECHANTILLON_CONFORMITE_MIN_PCT,
      note: 'Valeurs par défaut — à confirmer par le maître d’ouvrage (registre des seuils). Seule la périodicité annuelle des contrôleurs est fixée par le Cahier (§ 24).',
    };
  }

  // ─────────────────────────────────────────── indicateurs agrégés ───────────────────────────────────────────

  /**
   * Compréhension des contribuables : taux de dossiers complets du premier coup (aucun complément demandé), sur les
   * dossiers déjà examinés des démarches (verticales) et des autorisations de publicité. Sans donnée : « non mesuré ».
   */
  comprehension() {
    type Dossier = { status: string; history: { status?: string; action?: string }[] };
    const src = (nom: string, dossiers: Dossier[] | undefined, deposes: string[]) => {
      if (!dossiers) return { source: nom, disponible: false, examines: 0, completsDuPremierCoup: 0, tauxPct: null as string | null };
      const examines = dossiers.filter((d) => !deposes.includes(d.status) || d.history.some((h) => h.status === 'COMPLEMENT_DEMANDE' || h.action === 'COMPLEMENT_DEMANDE'));
      const complets = examines.filter((d) => !d.history.some((h) => h.status === 'COMPLEMENT_DEMANDE' || h.action === 'COMPLEMENT_DEMANDE'));
      return { source: nom, disponible: true, examines: examines.length, completsDuPremierCoup: complets.length, tauxPct: examines.length ? pct(complets.length, examines.length) : null };
    };
    const vx = this.ctx.ext.verticales as { cases?: { all(): Dossier[] } } | undefined;
    const pub = this.ctx.ext.publicite as { requests?: { all(): Dossier[] } } | undefined;
    const sources = [
      src('Démarches administratives (verticales)', vx?.cases?.all(), ['DEPOSE']),
      src('Autorisations de publicité', pub?.requests?.all(), ['DEPOSEE']),
    ];
    const examines = sources.reduce((s, x) => s + x.examines, 0);
    const complets = sources.reduce((s, x) => s + x.completsDuPremierCoup, 0);
    return {
      definition: 'Part des dossiers examinés qui n’ont fait l’objet d’aucune demande de complément (dossiers complets du premier coup).',
      statut: examines > 0 ? 'MESURE' as const : 'NON_MESURE' as const,
      tauxPct: examines > 0 ? pct(complets, examines) : null,
      libelle: examines > 0 ? `${pct(complets, examines)} %` : 'non mesuré',
      examines, completsDuPremierCoup: complets, sources,
      note: 'Indicateur agrégé, jamais nominatif. Les données de démonstration sont non contractuelles [EXEMPLE].',
    };
  }

  indicateurs(u: User) {
    authorize(u, A.indicateursRead);
    const today = this.today();
    const couverture = PROFILS_CERTIFIES.map((p) => {
      const certs = this.certificats.find((c) => c.profil === p);
      const parCompte = new Map<string, Certificat>();
      for (const c of certs.sort((a, b) => a.delivreLe.localeCompare(b.delivreLe))) parCompte.set(c.userId, c);
      const derniers = [...parCompte.values()];
      return {
        profil: p, libelle: PROFIL_LIBELLE[p], mode: MODE_VALIDATION[p].libelle,
        enVigueur: derniers.filter((c) => c.statut === 'DELIVRE' && c.valableJusquau >= today).length,
        expires: derniers.filter((c) => c.statut === 'DELIVRE' && c.valableJusquau < today).length,
        retires: derniers.filter((c) => c.statut === 'RETIRE').length,
        echeanceSous30j: derniers.filter((c) => c.statut === 'DELIVRE' && c.valableJusquau >= today && c.valableJusquau <= this.plusJours(30)).length,
      };
    });
    return {
      comprehension: this.comprehension(), couverture, confidentialite: CONFIDENTIALITE,
      publics: PROFILS.map((p) => ({ profil: p, nom: PROFIL_LIBELLE[p], ...MODE_VALIDATION[p] })),
    };
  }
}
