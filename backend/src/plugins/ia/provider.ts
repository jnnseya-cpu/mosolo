/**
 * Fournisseur DÉTERMINISTE des agents (aucun LLM requis). Chaque agent lit uniquement, via la passerelle,
 * les domaines de sa fiche, cite ses données et produit la sortie standard à 8 rubriques (§ 23.5.7).
 * Un fournisseur fondé sur un modèle pourra implémenter `IaAgentProvider` derrière la même passerelle.
 */
import { Money, ROLES, type CurrencyCode, type MoneyJSON, type RoleCode } from '@mosolo/shared';
import { PROVIDER_MODEL_VERSION, type AgentSheet } from './catalogue.js';
import { KNOWLEDGE_BASE, pseudo, type DataGateway } from './gateway.js';
import type { AgentCode, AgentDraft } from './types.js';

export interface AgentRunOptions {
  mode: 'demande' | 'balayage';
  subject?: { type: string; id: string };
  question?: string;
}

export interface IaAgentProvider {
  readonly modelVersion: string;
  run(sheet: AgentSheet, gw: DataGateway, opts: AgentRunOptions): (AgentDraft & { quiet?: boolean })[];
}

type Draft = AgentDraft & { quiet?: boolean };

export const roleLabel = (r: RoleCode): string => `${r} — ${ROLES[r]}`;
const addDays = (today: string, days: number) => new Date(new Date(today).getTime() + days * 86_400_000).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86_400_000);
const plural = (n: number, s: string, p = `${s}s`) => `${n} ${n > 1 ? p : s}`;
/** Ratio en chaîne décimale (4 décimales) sans nombre flottant. */
const ratio = (num: number, den: number): string => {
  if (den === 0) return '0';
  const scaled = (BigInt(num) * 10_000n) / BigInt(den);
  return `${scaled / 10_000n}.${String(scaled % 10_000n).padStart(4, '0')}`;
};
const pct = (r: string) => `${(Number.parseFloat(r) * 100).toFixed(1).replace('.', ',')} %`;

function sumBy(items: { amount: MoneyJSON }[]): Map<CurrencyCode, Money> {
  const out = new Map<CurrencyCode, Money>();
  for (const i of items) {
    const m = Money.fromJSON(i.amount);
    out.set(m.currency, (out.get(m.currency) ?? Money.zero(m.currency)).add(m));
  }
  return out;
}
const fmtSums = (m: Map<CurrencyCode, Money>) => (m.size === 0 ? '0' : [...m.values()].map((x) => `${x.toDecimalString()} ${x.currency}`).join(' + '));

const UNPAID = ['EMISE', 'EXIGIBLE', 'PARTIELLEMENT_PAYEE', 'EN_RETARD'];

export class DeterministicAgentProvider implements IaAgentProvider {
  readonly modelVersion = PROVIDER_MODEL_VERSION;

  run(sheet: AgentSheet, gw: DataGateway, opts: AgentRunOptions): Draft[] {
    const fn: Record<AgentCode, () => Draft[]> = {
      DECOUVERTE: () => this.discovery(gw),
      ENROLEMENT: () => this.registration(gw),
      APPRENTISSAGE_USAGER: () => this.userLearning(gw, opts.question),
      COPILOTE: () => this.copilot(gw, opts.subject),
      VEILLE_JURIDIQUE: () => this.legalWatch(gw),
      INTELLIGENCE_LOCATIVE: () => this.rental(gw),
      MISSIONS_TERRAIN: () => this.missions(gw),
      RAPPROCHEMENT: () => this.reconciliation(gw),
      FRAUDE: () => this.fraud(gw),
      PREVISION: () => this.forecast(gw),
      DECISION_EXECUTIVE: () => this.executive(gw),
      ALLOCATION: () => this.allocation(gw),
      APPRENTISSAGE_CONTINU: () => this.learning(gw),
      COMMUNICATION: () => this.communication(gw),
    };
    return fn[sheet.code]();
  }

  // 1. Découverte des recettes
  private discovery(gw: DataGateway): Draft[] {
    const objs = gw.objects();
    const leases = gw.leases();
    const units = objs.filter((o) => o.category === 'UNITE_LOCATIVE');
    const unattached = objs.filter((o) => !o.taxpayerId);
    const noLease = units.filter((u) => !leases.some((l) => l.unitObjectId === u.id));
    gw.cite('OBJETS', 'registre:objets', `Registre des objets fiscaux (${objs.length})`);
    gw.cite('BAUX', 'registre:baux', `Déclarations de baux (${leases.length})`);
    const byCommune = new Map<string, number>();
    for (const o of [...unattached, ...noLease]) {
      byCommune.set(o.commune, (byCommune.get(o.commune) ?? 0) + 1);
      gw.cite('OBJETS', o.id, `${o.category} — ${o.commune}`);
    }
    const top = [...byCommune.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const gaps = unattached.length + noLease.length;
    const situation = `${plural(objs.length, 'objet')} au registre ; ${plural(unattached.length, 'objet')} sans redevable rattaché ; ${plural(noLease.length, 'unité locative', 'unités locatives')} sans bail déclaré.`;
    if (gaps === 0) {
      return [{
        quiet: true, key: `DECOUVERTE:${objs.length}:${leases.length}`, autonomy: 'C_RECOMMANDATION', actions: [], citations: [], example: false,
        situation, insight: 'Aucun gisement apparent dans le registre actuel : chaque objet a un redevable et chaque unité un bail.',
        risk: 'Faible sur le périmètre enregistré ; les objets non encore recensés restent invisibles.',
        recommendation: 'Poursuivre l’enrôlement et le recensement terrain ; relancer l’analyse après chaque campagne.',
        nextAction: 'Aucune action immédiate.', owner: roleLabel('R06'), deadline: addDays(gw.today, 30), confidence: 'MEDIUM', sources: ['Registre des objets fiscaux', 'Déclarations de baux'],
      }];
    }
    const commune = top?.[0] ?? '—';
    return [{
      key: `DECOUVERTE:${commune}:${gaps}`, autonomy: 'C_RECOMMANDATION', example: false,
      situation,
      insight: `Le gisement potentiel se concentre à ${commune} (${plural(top?.[1] ?? 0, 'objet')}). Il s’agit d’un signal, pas d’une dette.`,
      risk: 'Sous-enregistrement persistant et iniquité entre redevables ; contestation si l’activation se fait sans vérification.',
      recommendation: `Instruire une fiche d’opportunité pour ${commune} : vérification terrain puis analyse juridique avant tout comité.`,
      nextAction: 'Relire le brouillon de fiche d’opportunité préparé et le soumettre à l’analyste.',
      owner: roleLabel('R06'), deadline: addDays(gw.today, 21), confidence: gaps >= 5 ? 'MEDIUM' : 'LOW',
      sources: ['Registre des objets fiscaux', 'Déclarations de baux'],
      recommendedStep: 'Soumettre la fiche d’opportunité au comité après vérification terrain.',
      decision: {
        bestOption: `Fiche d’opportunité ciblée sur ${commune}, validée par l’analyste et le juriste.`,
        alternativeOption: 'Recensement général sans ciblage (coût plus élevé).',
        riskOfInaction: 'Perte de recettes et iniquité entre redevables enregistrés et non enregistrés.',
        financialImpact: 'Non chiffré : aucun montant n’est exigible sans règle ACTIVE (4 visas).',
        operationalImpact: 'Mobilisation d’une équipe terrain pour la vérification.',
      },
      circuit: 'Fiche d’opportunité → analyste → juriste → comité (§ 8.4) ; l’activation ouvre au mieux une fiche de règle BROUILLON.',
      actions: [{
        type: 'PREPARER_BROUILLON', level: 'A', label: `Préparer la fiche d’opportunité — ${commune}`,
        params: { title: `Fiche d’opportunité (brouillon) — ${commune}`, body: `${situation}\nCommune ciblée : ${commune}.\nStatut : signal à vérifier ; aucune obligation, aucune règle.` },
      }],
      citations: [],
    }];
  }

  // 2. Enrôlement
  private registration(gw: DataGateway): Draft[] {
    const acc = gw.ownAccount();
    if (!acc) {
      return [{
        key: 'ENROLEMENT:sans-compte', autonomy: 'A_AUTO', actions: [], citations: [], example: false,
        situation: 'Aucun compte contribuable n’est rattaché à cette session.', insight: 'L’inscription commence par le numéro de téléphone.',
        risk: 'Faible.', recommendation: 'Créer le compte depuis l’écran d’inscription.', nextAction: 'Ouvrir « Inscription ».',
        owner: roleLabel('R30'), deadline: addDays(gw.today, 7), confidence: 'HIGH', sources: ['Parcours d’inscription'],
      }];
    }
    gw.cite('COMPTE_PROPRE', acc.id, 'Compte unique du contribuable (vue minimisée)');
    const missing: string[] = [];
    if (!acc.hasEmail) missing.push('adresse de courriel (facultative, pour recevoir les avis)');
    if (acc.verificationLevel === 'N0' || acc.verificationLevel === 'N0A') missing.push(`vérification d’identité (niveau actuel ${acc.verificationLevel})`);
    const provisional = acc.objects.filter((o) => o.status === 'PROVISOIRE');
    if (provisional.length) missing.push(`${plural(provisional.length, 'bien')} au statut provisoire à confirmer`);
    for (const o of acc.objects) gw.cite('COMPTE_PROPRE', o.id, `${o.category} — ${o.commune}`);
    const dup = acc.duplicatePhone;
    return [{
      key: `ENROLEMENT:${acc.id}:${missing.length}:${dup}`, autonomy: 'A_AUTO', example: false, taxpayerId: acc.id,
      situation: `Compte au niveau ${acc.verificationLevel} ; ${plural(acc.objects.length, 'bien')} et ${plural(acc.leases.length, 'bail', 'baux')} rattachés.`,
      insight: missing.length ? `Éléments à compléter : ${missing.join(' ; ')}.` : 'Le dossier d’inscription est complet.',
      risk: dup ? 'Un autre compte utilise le même numéro : doublon probable, à traiter au guichet (aucune fusion automatique).' : 'Faible.',
      recommendation: missing.length ? 'Compléter le dossier à partir du brouillon pré-rempli (données déjà vérifiées réutilisées).' : 'Aucune pièce manquante.',
      nextAction: missing.length ? 'Relire le brouillon pré-rempli, puis confirmer vous-même chaque information.' : 'Aucune.',
      owner: `${roleLabel('R30')} (confirmation)`, deadline: addDays(gw.today, 15), confidence: 'HIGH',
      sources: ['Compte unique (vue minimisée)'],
      actions: missing.length ? [{
        type: 'PREPARER_BROUILLON', level: 'A', label: 'Pré-remplir le complément d’inscription',
        params: { title: 'Complément d’inscription (brouillon pré-rempli)', body: `Langue : ${acc.language}\nSituation : ${acc.situation}\nÀ compléter : ${missing.join(' ; ')}\nCe brouillon n’est pas une déclaration : vous devez le confirmer.` },
      }] : [],
      citations: [],
    }];
  }

  // 3. Apprentissage de l'usager
  private userLearning(gw: DataGateway, question?: string): Draft[] {
    const acc = gw.ownAccount();
    const obligations = gw.ownObligations();
    const kb = gw.knowledge();
    const q = (question ?? '').toLowerCase();
    const theme = /quittance|reçu|recu/.test(q) ? 'aide-quittance' : /contest|recours|réclam|reclam/.test(q) ? 'aide-recours'
      : /échéance|echeance|date|retard/.test(q) ? 'aide-echeance' : 'aide-payer';
    const pages = kb.filter((p) => p.id === theme || p.id === 'aide-humain');
    for (const p of pages) gw.cite('BASE_CONNAISSANCES', p.id, `Page d’aide « ${p.title} »`);
    const open = obligations.filter((o) => UNPAID.includes(o.status));
    for (const o of open) gw.cite('OBLIGATIONS_PROPRES', o.id, `${o.label} (règle ${o.ruleCode} v${o.ruleVersion})`);
    const lines = open.map((o) => `• ${o.label} : ${Money.fromJSON(o.amount).toDecimalString()} ${o.amount.currency}, échéance ${o.dueDate}`);
    const answer = `${pages.map((p) => p.text).join(' ')}${lines.length ? `\nVos obligations ouvertes :\n${lines.join('\n')}` : ''}`;
    return [{
      key: `APPRENTISSAGE_USAGER:${acc?.id ?? 'anonyme'}:${theme}:${open.length}`, autonomy: 'A_AUTO', example: false,
      ...(acc ? { taxpayerId: acc.id } : {}),
      situation: `Question reçue (thème : ${pages[0]?.title ?? 'usage'}) ; ${plural(open.length, 'obligation ouverte', 'obligations ouvertes')} sur le compte.`,
      insight: answer,
      risk: 'Une réponse de l’assistant n’a aucun effet juridique : seul le texte officiel et la décision d’un agent font foi.',
      recommendation: open.length ? 'Payer par la référence MOSOLO de chaque obligation, ou déposer une réclamation motivée si vous contestez.' : 'Aucune démarche requise.',
      nextAction: 'Consulter le résumé enregistré ; en cas de doute, contacter le guichet ou le centre d’appel.',
      owner: `${roleLabel('R30')} ; ${roleLabel('R12')} (renvoi humain)`, deadline: open[0]?.dueDate ?? addDays(gw.today, 30), confidence: 'HIGH',
      sources: pages.map((p) => `Page d’aide « ${p.title} »`),
      actions: [{ type: 'RESUMER', level: 'A', label: 'Enregistrer la réponse sourcée', params: { title: `Réponse sourcée — ${pages[0]?.title ?? 'usage'}`, body: answer } }],
      citations: [],
    }];
  }

  // 4. Copilote des agents publics
  private copilot(gw: DataGateway, subject?: { type: string; id: string }): Draft[] {
    const appeals = gw.appeals().filter((a) => a.status === 'DEPOSEE' || a.status === 'PROPOSITION')
      .filter((a) => !subject || subject.type !== 'appeal' || a.id === subject.id);
    const obligations = gw.obligations();
    gw.cite('RECOURS', 'file:recours', `File des réclamations en cours (${appeals.length})`);
    if (appeals.length === 0) {
      return [{
        quiet: true, key: 'COPILOTE:vide', autonomy: 'C_RECOMMANDATION', actions: [], citations: [], example: false,
        situation: 'Aucun dossier de réclamation en attente d’instruction ou de décision.', insight: 'La file du contentieux est vide.',
        risk: 'Faible.', recommendation: 'Aucune.', nextAction: 'Aucune.', owner: roleLabel('R20'), deadline: addDays(gw.today, 7), confidence: 'HIGH',
        sources: ['File des réclamations'],
      }];
    }
    return appeals.slice(0, 10).map((a) => {
      const g = a.grounds.toLowerCase();
      const label = /surface|superficie|m²|m2|assiette/.test(g) ? 'Contestation de l’assiette'
        : /montant|calcul|erreur|taux/.test(g) ? 'Contestation du calcul'
        : /vendu|propriétaire|proprietaire|pas à moi|pas a moi/.test(g) ? 'Contestation de la qualité de redevable'
        : /payé|paye|double|quittance/.test(g) ? 'Paiement déjà effectué' : 'Autre motif';
      const ob = obligations.find((o) => o.id === a.obligationId);
      gw.cite('RECOURS', a.id, `Réclamation ${a.id} (${a.status})`);
      if (ob) gw.cite('OBLIGATIONS', ob.id, `Obligation ${ob.id} — règle ${ob.ruleCode}`);
      const age = daysBetween(a.submittedAt, gw.today);
      const step = a.status === 'DEPOSEE' ? 'instruction par l’agent de contentieux (R20)' : 'décision motivée par l’autorité (R21)';
      const summary = `Réclamation ${a.id} déposée le ${a.submittedAt.slice(0, 10)} (${plural(age, 'jour')}) sur l’obligation ${a.obligationId}${ob ? ` de ${Money.fromJSON(ob.amount).toDecimalString()} ${ob.amount.currency}` : ''}. Motif classé : ${label}. Étape : ${step}.`;
      return {
        key: `COPILOTE:${a.id}:${a.status}`, autonomy: 'C_RECOMMANDATION' as const, example: false, subject: { type: 'appeal', id: a.id },
        situation: summary,
        insight: `Motif détecté par mots-clés : « ${label} » (classement modifiable par l’instructeur).`,
        risk: age > 30 ? 'Délai d’instruction dépassant 30 jours : risque de recours hiérarchique.' : 'Décision non motivée ou pièces manquantes : fragilité juridique.',
        recommendation: a.status === 'DEPOSEE' ? 'Instruire le dossier à partir du résumé et du projet préparés.' : 'Relire la proposition et arrêter la décision motivée.',
        nextAction: `Ouvrir le dossier ${a.id} et vérifier les pièces.`,
        owner: a.status === 'DEPOSEE' ? roleLabel('R20') : roleLabel('R21'), deadline: addDays(a.submittedAt.slice(0, 10), 30), confidence: 'MEDIUM' as const,
        sources: ['Dossier de réclamation', 'Obligation contestée (trace de calcul)'],
        recommendedStep: step,
        circuit: 'POST /v1/appeals/:id/instruct (R20) puis POST /v1/appeals/:id/decide (R21) : l’IA ne clôt jamais un recours.',
        actions: [
          { type: 'RESUMER' as const, level: 'A' as const, label: 'Résumer le dossier', params: { title: `Résumé du dossier ${a.id}`, body: summary, subjectType: 'appeal', subjectId: a.id } },
          { type: 'CLASSER' as const, level: 'A' as const, label: `Classer le motif : ${label}`, params: { title: label, body: `Motif de la réclamation ${a.id}`, subjectType: 'appeal', subjectId: a.id } },
          {
            type: 'PREPARER_BROUILLON' as const, level: 'A' as const, label: 'Préparer le projet de décision motivée',
            params: { title: `Projet de décision motivée — ${a.id} (à signer par R21)`, body: `Vu la réclamation ${a.id} (${label}) ;\nVu l’obligation ${a.obligationId} et sa trace de calcul ;\nConsidérant [motifs à rédiger par l’autorité] ;\nDÉCIDE : [décision à arrêter par l’autorité habilitée].\nProjet préparé avec l’assistance de l’IA — sans effet avant signature.`, subjectType: 'appeal', subjectId: a.id },
          },
        ],
        citations: [],
      };
    });
  }

  // 5. Veille juridique
  private legalWatch(gw: DataGateway): Draft[] {
    const rules = gw.rules();
    const instruments = gw.instruments();
    const inst = new Map(instruments.map((i) => [i.id, i]));
    gw.cite('REGLES', 'registre:regles', `Registre juridique (${rules.length} fiches)`);
    const live = rules.filter((r) => ['ACTIVE', 'PUBLIEE', 'APPROUVEE'].includes(r.status));
    const weakBasis = live.filter((r) => r.legalInstrumentIds.some((id) => ['A_VERIFIER', 'ABROGE'].includes(inst.get(id)?.status ?? 'A_VERIFIER')));
    const expiring = live.filter((r) => r.effectiveTo && daysBetween(gw.today, r.effectiveTo) <= 30);
    const codes = new Map<string, number>();
    for (const r of rules.filter((x) => x.status === 'ACTIVE')) codes.set(r.code, (codes.get(r.code) ?? 0) + 1);
    const conflicts = [...codes.entries()].filter(([, n]) => n > 1).map(([c]) => c);
    const toVerify = rules.filter((r) => r.status === 'A_VERIFIER');
    const pendingInstruments = instruments.filter((i) => i.status === 'A_VERIFIER' && rules.some((r) => r.legalInstrumentIds.includes(i.id)));
    for (const r of [...weakBasis, ...expiring, ...toVerify]) gw.cite('REGLES', r.id, `Règle ${r.code} v${r.version} (${r.status})`);
    for (const i of pendingInstruments) gw.cite('INSTRUMENTS', i.id, i.title);
    const findings = weakBasis.length + expiring.length + conflicts.length;
    const situation = `${plural(rules.length, 'règle')} au registre, dont ${plural(live.filter((r) => r.status === 'ACTIVE').length, 'active')} ; ${plural(toVerify.length, 'fiche modèle', 'fiches modèles')} À VÉRIFIER (non exécutables) ; ${plural(pendingInstruments.length, 'texte')} à certifier.`;
    const problems = [
      ...weakBasis.map((r) => `règle ${r.code} fondée sur un texte à vérifier ou abrogé`),
      ...expiring.map((r) => `règle ${r.code} expirant le ${r.effectiveTo}`),
      ...conflicts.map((c) => `plusieurs versions ACTIVES du code ${c}`),
    ];
    if (findings === 0 && pendingInstruments.length === 0) {
      return [{
        quiet: true, key: `VEILLE:${rules.length}`, autonomy: 'C_RECOMMANDATION', actions: [], citations: [], example: false, situation,
        insight: 'Aucune règle active expirée, en conflit ou fondée sur un texte non certifié.', risk: 'Faible.', recommendation: 'Poursuivre la veille.',
        nextAction: 'Aucune.', owner: roleLabel('R14'), deadline: addDays(gw.today, 30), confidence: 'HIGH', sources: ['Registre juridique'],
      }];
    }
    return [{
      key: `VEILLE:${problems.join('|')}:${pendingInstruments.map((i) => i.id).join(',')}`, autonomy: 'C_RECOMMANDATION', example: false, situation,
      insight: problems.length ? `Points d’attention : ${problems.join(' ; ')}.` : `Les taux des fiches modèles reposent sur des textes non certifiés (${pendingInstruments.map((i) => i.id).join(', ')}) : ils restent « acte requis ».`,
      risk: findings ? 'Liquidation sur une base juridique fragile ou expirée : annulation contentieuse.' : 'Retard d’ouverture des recettes tant que les textes ne sont pas certifiés.',
      recommendation: 'Obtenir les copies certifiées des textes et, le cas échéant, préparer une nouvelle version de fiche par le circuit des 4 visas.',
      nextAction: 'Le juriste vérificateur traite la tâche de certification créée.',
      owner: roleLabel('R14'), deadline: addDays(gw.today, 14), confidence: 'HIGH', sources: ['Registre juridique', 'Registre des instruments'],
      circuit: 'Aucune publication par l’IA : circuit R13 → R14 → R15 → R16.',
      actions: [
        { type: 'PREPARER_BROUILLON', level: 'A', label: 'Préparer la note de veille', params: { title: 'Note de veille juridique (brouillon)', body: `${situation}\n${problems.join('\n') || 'Textes à certifier : ' + pendingInstruments.map((i) => i.title).join(' ; ')}` } },
        ...(pendingInstruments.length ? [{ type: 'CREER_TACHE' as const, level: 'A' as const, label: 'Créer la tâche de certification des textes', params: { title: `Obtenir ${plural(pendingInstruments.length, 'copie certifiée', 'copies certifiées')}`, body: pendingInstruments.map((i) => i.title).join('\n'), assigneeRole: 'R14' } }] : []),
      ],
      citations: [],
    }];
  }

  // 6. Intelligence locative
  private rental(gw: DataGateway): Draft[] {
    const objs = gw.objects();
    const leases = gw.leases();
    const obs = gw.observations();
    const units = objs.filter((o) => o.category === 'UNITE_LOCATIVE');
    gw.cite('OBJETS', 'registre:unites', `Unités locatives (${units.length})`);
    const out: Draft[] = [];
    for (const u of units) {
      if (leases.some((l) => l.unitObjectId === u.id && (!l.end || l.end >= gw.today))) continue;
      const factors: { label: string; weight: string }[] = [{ label: 'Base', weight: '0.05' }, { label: 'Aucun bail en cours déclaré', weight: '0.40' }];
      if (u.localityRank <= 2) factors.push({ label: `Rang de localité ${u.localityRank} (forte demande locative)`, weight: '0.15' });
      const occupied = obs.some((o) => o.objectId === u.id && /occup/i.test(o.field) && (o.value === true || /^(oui|occupe|occupé|true)$/i.test(String(o.value))));
      if (occupied) factors.push({ label: 'Constat terrain : occupation observée', weight: '0.25' });
      const sibling = u.parcelId && units.some((x) => x.id !== u.id && x.parcelId === u.parcelId && leases.some((l) => l.unitObjectId === x.id));
      if (sibling) factors.push({ label: 'Autres unités louées sur la même parcelle', weight: '0.10' });
      const points = factors.reduce((s, f) => s + Math.round(Number.parseFloat(f.weight) * 100), 0);
      const score = Math.min(points, 95);
      if (score < 50) continue;
      const scoreTxt = `0,${String(score).padStart(2, '0')}`;
      gw.cite('OBJETS', u.id, `Unité ${u.id} — ${u.commune}/${u.quartier}`);
      if (occupied) gw.cite('OBSERVATIONS_TERRAIN', `obs:${u.id}`, `Constat d’occupation sur ${u.id}`);
      out.push({
        key: `LOC:${u.id}:${score}`, autonomy: 'B_VALIDATION', example: false, subject: { type: 'object', id: u.id },
        ...(u.taxpayerId ? { taxpayerId: u.taxpayerId } : {}),
        situation: `Unité ${u.id} (${u.commune}, ${u.quartier}) : aucun bail en cours déclaré. Probabilité indicative de location : ${scoreTxt}.`,
        insight: `Facteurs : ${factors.map((f) => `${f.label} (+${f.weight.replace('.', ',')})`).join(' ; ')}. Score indicatif, non opposable.`,
        risk: 'Sous-déclaration possible ; contestation si la preuve est faible. Le score ne prouve ni location ni fraude.',
        recommendation: u.taxpayerId ? 'Demander au bailleur de déclarer le bail ou la vacance, avec pièces justificatives.' : 'Identifier d’abord le redevable (objet sans compte rattaché).',
        nextAction: u.taxpayerId ? 'Valider l’envoi de la demande de pièces (niveau B : un clic de validation).' : 'Affecter la vérification au superviseur.',
        owner: roleLabel('R09'), deadline: addDays(gw.today, 15), confidence: occupied ? 'MEDIUM' : 'LOW',
        sources: ['Registre des objets fiscaux', 'Déclarations de baux', ...(occupied ? ['Constats terrain'] : [])],
        factors,
        actions: u.taxpayerId
          ? [{ type: 'DEMANDER_PIECES', level: 'B', label: 'Envoyer la demande de pièces au bailleur', params: { taxpayerId: u.taxpayerId, objectId: u.id } }]
          : [{ type: 'CREER_TACHE', level: 'A', label: 'Créer une tâche d’identification du redevable', params: { title: `Identifier le redevable de ${u.id}`, body: `${u.commune}, ${u.quartier}`, assigneeRole: 'R09' } }],
        citations: [],
      });
    }
    if (out.length === 0) {
      return [{
        quiet: true, key: `LOC:aucune:${units.length}:${leases.length}`, autonomy: 'B_VALIDATION', actions: [], citations: [], example: false,
        situation: `${plural(units.length, 'unité locative', 'unités locatives')}, ${plural(leases.length, 'bail déclaré', 'baux déclarés')}.`,
        insight: 'Aucune unité n’atteint le seuil de vérification (0,50).', risk: 'Faible.', recommendation: 'Aucune demande de pièces à ce stade.',
        nextAction: 'Aucune.', owner: roleLabel('R09'), deadline: addDays(gw.today, 30), confidence: 'MEDIUM', sources: ['Registre des objets fiscaux', 'Déclarations de baux'],
      }];
    }
    return out;
  }

  // 7. Missions terrain
  private missions(gw: DataGateway): Draft[] {
    const objs = gw.objects();
    const leases = gw.leases();
    const conflicts = gw.conflicts();
    const teams = gw.fieldTeams();
    gw.cite('OBJETS', 'registre:objets', `Registre des objets fiscaux (${objs.length})`);
    gw.cite('CONFLITS_TERRAIN', 'file:conflits', `Conflits terrain à arbitrer (${conflicts.length})`);
    const targets = new Map<string, Set<string>>();
    const add = (commune: string, id: string) => { if (!targets.has(commune)) targets.set(commune, new Set()); targets.get(commune)!.add(id); };
    for (const o of objs) {
      if (o.status === 'PROVISOIRE') add(o.commune, o.id);
      if (o.category === 'UNITE_LOCATIVE' && !leases.some((l) => l.unitObjectId === o.id)) add(o.commune, o.id);
    }
    for (const c of conflicts) { const o = objs.find((x) => x.id === c.objectId); if (o) add(o.commune, o.id); }
    if (targets.size === 0) {
      return [{
        quiet: true, key: 'MISSIONS:aucune', autonomy: 'B_VALIDATION', actions: [], citations: [], example: false,
        situation: 'Aucun objet provisoire, en conflit ou sans bail à visiter.', insight: 'Pas de tournée nécessaire.', risk: 'Faible.',
        recommendation: 'Aucune.', nextAction: 'Aucune.', owner: roleLabel('R09'), deadline: addDays(gw.today, 14), confidence: 'HIGH', sources: ['Registre des objets fiscaux'],
      }];
    }
    return [...targets.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).map(([commune, ids]) => {
      const list = [...ids].sort();
      for (const id of list) gw.cite('OBJETS', id, `Objet à visiter — ${commune}`);
      const agent = teams.filter((t) => t.territory.includes(commune)).sort((a, b) => a.userId.localeCompare(b.userId))[0];
      if (agent) gw.cite('EQUIPES_TERRAIN', pseudo(agent.userId), `Agent habilité sur ${commune} (pseudonymisé)`);
      return {
        key: `MISSIONS:${commune}:${list.join(',')}`, autonomy: 'B_VALIDATION' as const, example: false, subject: { type: 'commune', id: commune },
        situation: `${plural(list.length, 'objet')} à vérifier à ${commune} (provisoires, en conflit ou sans bail).`,
        insight: `Tournée groupée proposée : ${list.join(', ')}.${agent ? ` Agent du périmètre disponible (${pseudo(agent.userId)}).` : ''}`,
        risk: agent ? 'Données de terrain anciennes ; objets restant provisoires sans visite.' : 'Aucun agent habilité sur cette commune : la mission ne peut pas être affectée hors périmètre.',
        recommendation: agent ? `Ouvrir une mission de vérification à ${commune}.` : `Désigner un agent habilité sur ${commune} avant toute mission.`,
        nextAction: agent ? 'Valider l’ouverture de la mission (niveau B).' : 'Le superviseur ajuste les périmètres.',
        owner: roleLabel('R09'), deadline: addDays(gw.today, 10), confidence: 'MEDIUM' as const,
        sources: ['Registre des objets fiscaux', 'Conflits terrain', 'Périmètres des équipes'],
        actions: agent ? [{ type: 'OUVRIR_MISSION' as const, level: 'B' as const, label: `Ouvrir la mission — ${commune}`, params: { commune, agentUserId: agent.userId, objectIds: list.join(',') } }] : [],
        citations: [],
      };
    });
  }

  // 8. Rapprochement
  private reconciliation(gw: DataGateway): Draft[] {
    const ex = gw.exceptions().filter((e) => e.status === 'OUVERTE');
    const pays = gw.payments();
    const waiting = pays.filter((p) => p.status === 'CONFIRME' && p.confirmedAt && daysBetween(p.confirmedAt, gw.today) >= 1);
    gw.cite('EXCEPTIONS_TRESOR', 'file:exceptions', `Files d’exceptions ouvertes (${ex.length})`);
    gw.cite('PAIEMENTS', 'registre:paiements', `Ordres de paiement (${pays.length})`);
    for (const e of ex) gw.cite('EXCEPTIONS_TRESOR', e.id, `Exception ${e.type}`);
    for (const p of waiting) gw.cite('PAIEMENTS', p.reference, `Paiement confirmé sans crédit (${p.reference})`);
    if (ex.length === 0 && waiting.length === 0) {
      return [{
        quiet: true, key: 'RAPPRO:rien', autonomy: 'C_RECOMMANDATION', actions: [], citations: [], example: false,
        situation: 'Aucune exception ouverte ; aucun paiement confirmé en attente de crédit à J+1.', insight: 'Rapprochement à jour.', risk: 'Faible.',
        recommendation: 'Maintenir la clôture quotidienne signée.', nextAction: 'Aucune.', owner: roleLabel('R17'), deadline: addDays(gw.today, 1), confidence: 'HIGH',
        sources: ['Files d’exceptions', 'Paiements'],
      }];
    }
    const byType = new Map<string, number>();
    for (const e of ex) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    const oldest = ex.reduce((m, e) => Math.max(m, daysBetween(e.openedAt, gw.today)), 0);
    const matches = ex.filter((e) => e.paymentReference && pays.some((p) => p.reference === e.paymentReference));
    return [{
      key: `RAPPRO:${ex.map((e) => e.id).join(',')}:${waiting.length}`, autonomy: 'C_RECOMMANDATION', example: false,
      situation: `${plural(ex.length, 'exception ouverte', 'exceptions ouvertes')} (${[...byType.entries()].map(([t, n]) => `${t} : ${n}`).join(', ') || '—'}) ; ${plural(waiting.length, 'paiement confirmé', 'paiements confirmés')} sans crédit depuis plus d’un jour.`,
      insight: matches.length ? `${plural(matches.length, 'exception')} porte${matches.length > 1 ? 'nt' : ''} une référence MOSOLO connue : appariement proposé, à confirmer en quatre yeux au-delà des tolérances.` : 'Les écarts portent sur des crédits sans référence ou des confirmations sans crédit.',
      risk: oldest > 5 ? `Exception la plus ancienne : ${plural(oldest, 'jour')} (délai cible 5 jours ouvrés dépassé).` : 'Accumulation d’exceptions si la file n’est pas traitée quotidiennement.',
      recommendation: 'Traiter les exceptions par ordre d’ancienneté ; confirmer les appariements proposés sans corriger aucune écriture directement.',
      nextAction: 'L’analyste traite la tâche créée ; toute correction passe par contre-écriture validée.',
      owner: roleLabel('R18'), deadline: addDays(gw.today, 5), confidence: 'HIGH', sources: ['Files d’exceptions de rapprochement', 'Paiements confirmés'],
      circuit: 'Appariement confirmé par l’analyste (R18), quatre yeux par le comptable (R17) au-delà des tolérances.',
      actions: [{ type: 'CREER_TACHE', level: 'A', label: 'Affecter la file d’exceptions', params: { title: `Traiter ${plural(ex.length + waiting.length, 'écart')} de rapprochement`, body: [...ex.map((e) => `${e.id} ${e.type}`), ...waiting.map((p) => `${p.reference} confirmé sans crédit`)].join('\n'), assigneeRole: 'R18' } }],
      citations: [],
    }];
  }

  // 9. Détection de fraude
  private fraud(gw: DataGateway): Draft[] {
    const audit = gw.auditMeta();
    const alerts = gw.alerts();
    const devices = gw.devices();
    const agg = gw.taxpayerAggregates();
    const vault = gw.vault();
    gw.cite('JOURNAL_AUDIT', 'journal:audit', `Journal d’audit chaîné (${audit.length} événements, acteurs pseudonymisés)`);
    gw.cite('ALERTES', 'file:alertes', `Alertes de sécurité (${alerts.length})`);
    const signals: { key: string; title: string; detail: string; ref: string; domain: 'JOURNAL_AUDIT' | 'ALERTES' | 'TERMINAUX' | 'CONTRIBUABLES_AGREGES' | 'COFFRE' }[] = [];
    const denied = new Map<string, number>();
    for (const r of audit.filter((x) => x.outcome === 'DENIED' && x.actorKind === 'user')) denied.set(r.actor, (denied.get(r.actor) ?? 0) + 1);
    for (const [actor, n] of denied) if (n >= 3) signals.push({ key: `refus:${actor}`, title: 'Tentatives d’accès refusées répétées', detail: `${plural(n, 'refus')} pour le compte pseudonymisé ${actor}.`, ref: actor, domain: 'JOURNAL_AUDIT' });
    const byType = new Map<string, number>();
    for (const a of alerts) byType.set(a.type, (byType.get(a.type) ?? 0) + 1);
    for (const [type, n] of byType) signals.push({ key: `alerte:${type}`, title: `Alertes de sécurité « ${type} »`, detail: `${plural(n, 'alerte')} de type ${type}.`, ref: `alertes:${type}`, domain: 'ALERTES' });
    const revoked = devices.filter((d) => d.status === 'REVOQUE');
    const deviceAlerts = alerts.filter((a) => /device|terminal|appareil/i.test(a.type));
    if (revoked.length && deviceAlerts.length) signals.push({ key: `terminaux:${deviceAlerts.length}`, title: 'Usage d’un terminal révoqué', detail: `${plural(revoked.length, 'terminal révoqué', 'terminaux révoqués')}, ${plural(deviceAlerts.length, 'alerte associée', 'alertes associées')}.`, ref: revoked.map((d) => d.id).join(','), domain: 'TERMINAUX' });
    if (agg.duplicatePhoneGroups > 0) signals.push({ key: `doublons:${agg.duplicatePhoneGroups}`, title: 'Identités possiblement dupliquées', detail: `${plural(agg.duplicatePhoneGroups, 'groupe')} de comptes partageant un même numéro (${agg.accountsInDuplicateGroups} comptes).`, ref: 'contribuables:doublons', domain: 'CONTRIBUABLES_AGREGES' });
    if (vault.pendingChanges.length) signals.push({ key: `coffre:${vault.pendingChanges.map((c) => c.id).join(',')}`, title: 'Changements de compte bénéficiaire en cours', detail: `${plural(vault.pendingChanges.length, 'demande')} en attente (${vault.pendingChanges.map((c) => `${c.alias} : ${c.status}`).join(', ')}).`, ref: vault.pendingChanges.map((c) => c.id).join(','), domain: 'COFFRE' });
    if (signals.length === 0) {
      return [{
        quiet: true, key: 'FRAUDE:rien', autonomy: 'B_VALIDATION', actions: [], citations: [], example: false,
        situation: `${plural(audit.length, 'événement')} d’audit, ${plural(alerts.length, 'alerte')} analysés : aucun signal.`, insight: 'Aucune anomalie au-dessus des seuils.',
        risk: 'Faible.', recommendation: 'Aucune.', nextAction: 'Aucune.', owner: roleLabel('R24'), deadline: addDays(gw.today, 7), confidence: 'MEDIUM', sources: ['Journal d’audit', 'Alertes'],
      }];
    }
    return signals.map((s) => {
      gw.cite(s.domain, s.ref, s.title);
      return {
        key: `FRAUDE:${s.key}`, autonomy: 'B_VALIDATION' as const, example: false,
        situation: s.detail,
        insight: `Signal « ${s.title} » : il appelle une vérification, il ne désigne aucun responsable.`,
        risk: 'Fraude ou erreur non détectée si le signal n’est pas examiné ; atteinte aux droits si le signal était traité comme une preuve.',
        recommendation: 'Ouvrir un dossier de vérification confidentiel confié à l’enquêteur.',
        nextAction: 'Valider l’ouverture du dossier (niveau B).',
        owner: roleLabel('R24'), deadline: addDays(gw.today, 7), confidence: 'MEDIUM' as const, sources: ['Journal d’audit (pseudonymisé)', 'Alertes de sécurité'],
        actions: [{ type: 'OUVRIR_DOSSIER_VERIFICATION' as const, level: 'B' as const, label: 'Ouvrir un dossier de vérification', params: { title: s.title, body: s.detail, ref: s.ref } }],
        citations: [],
      };
    });
  }

  // 10. Prévision
  private forecast(gw: DataGateway): Draft[] {
    const obligations = gw.obligations().filter((o) => o.status !== 'ANNULEE' && o.status !== 'ADMISE_EN_NON_VALEUR');
    const pays = gw.payments();
    const paidIds = new Set(pays.filter((p) => ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(p.status)).map((p) => p.obligationId));
    const paid = obligations.filter((o) => o.status === 'SOLDEE' || paidIds.has(o.id));
    const horizon = addDays(gw.today, 30);
    const due = obligations.filter((o) => UNPAID.includes(o.status) && !paidIds.has(o.id) && o.dueDate <= horizon);
    gw.cite('OBLIGATIONS', 'obligations:horizon-30j', `Obligations exigibles d’ici le ${horizon} (${due.length})`);
    gw.cite('PAIEMENTS', 'paiements:historique', `Historique de paiement (${paid.length}/${obligations.length})`);
    const rate = ratio(paid.length, obligations.length);
    const dueSums = sumBy(due);
    const scen = (factor: string) => new Map([...dueSums.entries()].map(([c, m]) => {
      const f = Number.parseFloat(rate) * Number.parseFloat(factor);
      return [c, m.multiply(f >= 1 ? '1' : ratio(Math.round(f * 10_000), 10_000))];
    }));
    const insufficient = obligations.length < 10 || paid.length === 0;
    return [{
      key: `PREVISION:${gw.today}:${due.length}:${paid.length}`, autonomy: 'C_RECOMMANDATION', example: false,
      situation: `Montant exigible d’ici 30 jours : ${fmtSums(dueSums)} (${plural(due.length, 'obligation')}). Taux de paiement observé : ${pct(rate)} (${paid.length}/${obligations.length}).`,
      insight: insufficient
        ? 'Historique insuffisant pour un scénario chiffré fiable : les montants ci-dessous sont des bornes, non des prévisions.'
        : `Scénarios : prudent ${fmtSums(scen('0.8'))} ; attendu ${fmtSums(scen('1'))} ; ambitieux ${fmtSums(scen('1.2'))}.`,
      risk: 'Surestimation des encaissements si le taux observé n’est pas représentatif ; aucune assignation ne doit en découler.',
      recommendation: 'Utiliser l’intervalle pour le plan de trésorerie, jamais comme objectif opposable aux agents ou aux contribuables.',
      nextAction: 'La direction financière valide les hypothèses.',
      owner: roleLabel('R05'), deadline: addDays(gw.today, 7), confidence: insufficient ? 'LOW' : 'MEDIUM',
      sources: ['Obligations (échéancier)', 'Historique des paiements'],
      recommendedStep: 'Valider les hypothèses (taux observé ×0,8 / ×1 / ×1,2 — hypothèses de travail, non normatives).',
      decision: {
        bestOption: `Retenir le scénario attendu : ${fmtSums(scen('1'))}.`,
        alternativeOption: `Retenir le scénario prudent : ${fmtSums(scen('0.8'))}.`,
        riskOfInaction: 'Plan de trésorerie sans intervalle de confiance.',
        financialImpact: `Intervalle : ${fmtSums(scen('0.8'))} à ${fmtSums(scen('1.2'))} (hypothèses explicites, non opposable).`,
        operationalImpact: 'Aucun : prévision indicative.',
      },
      circuit: 'Validation par la direction financière ; aucune assignation d’objectif par l’IA.',
      actions: [], citations: [],
    }];
  }

  // 11. Aide à la décision exécutive
  private executive(gw: DataGateway): Draft[] {
    const obligations = gw.obligations();
    const pays = gw.payments();
    const ex = gw.exceptions().filter((e) => e.status === 'OUVERTE');
    const appeals = gw.appeals().filter((a) => a.status === 'DEPOSEE' || a.status === 'PROPOSITION');
    const rules = gw.rules();
    const realActive = rules.filter((r) => r.status === 'ACTIVE' && !r.demo && !r.sample);
    const demoActive = rules.filter((r) => r.status === 'ACTIVE' && r.demo);
    const reconciled = pays.filter((p) => p.status === 'RAPPROCHE').length;
    const confirmed = pays.filter((p) => ['CONFIRME', 'REGLE', 'RAPPROCHE'].includes(p.status)).length;
    for (const [d, ref, label] of [
      ['OBLIGATIONS', 'kpi:obligations', `Obligations (${obligations.length})`], ['PAIEMENTS', 'kpi:paiements', `Paiements confirmés (${confirmed})`],
      ['EXCEPTIONS_TRESOR', 'kpi:exceptions', `Exceptions ouvertes (${ex.length})`], ['RECOURS', 'kpi:recours', `Recours en cours (${appeals.length})`],
      ['REGLES', 'kpi:regles', `Règles actives réelles (${realActive.length})`],
    ] as const) gw.cite(d, ref, label);
    const noRealRule = realActive.length === 0;
    return [{
      key: `EXEC:${obligations.length}:${confirmed}:${reconciled}:${ex.length}:${appeals.length}:${realActive.length}`, autonomy: 'C_RECOMMANDATION', example: false,
      situation: `${plural(obligations.length, 'obligation')}, ${plural(confirmed, 'paiement confirmé', 'paiements confirmés')} dont ${reconciled} rapproché(s) ; ${plural(ex.length, 'exception')} de rapprochement ; ${plural(appeals.length, 'recours', 'recours')} en cours ; ${plural(realActive.length, 'règle réelle active', 'règles réelles actives')} (${demoActive.length} de démonstration).`,
      insight: noRealRule
        ? 'Aucune règle réelle n’est ACTIVE : la plateforme ne peut encore exiger aucun montant réel (seules les règles de démonstration fonctionnent).'
        : 'La chaîne de recette est opérationnelle ; le levier principal est la qualité du rapprochement et le traitement des recours.',
      risk: noRealRule ? 'Ouverture au public sans base juridique certifiée : contestations et annulations.' : 'Accumulation d’exceptions et de recours non traités.',
      recommendation: noRealRule ? 'Prioriser la certification des textes et le circuit des 4 visas pour les premières recettes.' : 'Fixer un délai cible de traitement des exceptions et des recours.',
      nextAction: noRealRule ? 'Demander au Ministère des Finances le calendrier de certification des premières règles.' : 'Demander au Trésor un point hebdomadaire sur les exceptions.',
      owner: `${roleLabel('R01')} (décision) ; ${roleLabel('R05')} (exécution)`, deadline: addDays(gw.today, 14), confidence: 'HIGH',
      sources: ['Obligations', 'Paiements', 'Files d’exceptions', 'Réclamations', 'Registre juridique'],
      recommendedStep: noRealRule ? 'Arrêter la liste des trois premières recettes à certifier.' : 'Adopter un délai cible de 5 jours ouvrés pour les exceptions.',
      decision: {
        bestOption: noRealRule ? 'Certification prioritaire de trois recettes à fort rendement.' : 'Plan de résorption des exceptions et des recours.',
        alternativeOption: noRealRule ? 'Certification de toutes les fiches en une fois (plus long).' : 'Renforcement ponctuel des équipes.',
        riskOfInaction: 'Retard de mobilisation des recettes et perte de confiance.',
        financialImpact: 'Non chiffré : aucun taux n’est présumé avant publication officielle.',
        operationalImpact: 'Mobilisation des juristes (R13–R16) ou des analystes (R17–R18).',
      },
      circuit: 'Note de décision : l’autorité décide ; l’IA n’exécute rien.',
      actions: [], citations: [],
    }];
  }

  // 12. Allocation des investissements
  private allocation(gw: DataGateway): Draft[] {
    const pays = gw.payments().filter((p) => p.status === 'RAPPROCHE');
    const vault = gw.vault();
    const byAlias = new Map<string, { amount: MoneyJSON }[]>();
    for (const p of pays) byAlias.set(p.beneficiaryAlias, [...(byAlias.get(p.beneficiaryAlias) ?? []), p]);
    for (const a of vault.aliases) gw.cite('COFFRE', a.alias, `Compte public ${a.alias} (${a.entity})`);
    gw.cite('PAIEMENTS', 'paiements:rapproches', `Recettes rapprochées (${pays.length})`);
    const lines = [...byAlias.entries()].map(([alias, items]) => `${alias} : ${fmtSums(sumBy(items))}`);
    return [{
      key: `ALLOC:${pays.length}`, autonomy: 'C_RECOMMANDATION', example: false,
      situation: pays.length ? `Recettes réglées et rapprochées : ${lines.join(' ; ')}.` : 'Aucune recette rapprochée disponible : aucun scénario chiffré.',
      insight: 'Les fonds sont sur les comptes publics du coffre ; leur emploi relève du budget voté. Aucune clé de répartition n’est proposée par l’IA (clé 10/10/10/70 écartée).',
      risk: 'Engagement de dépenses sur des recettes non rapprochées ; confusion entre recette encaissée et recette disponible.',
      recommendation: 'Trois scénarios à arbitrer : (1) maintien des affectations légales par compte ; (2) réserve de trésorerie dont la proportion est fixée par l’autorité budgétaire ; (3) programme ciblé sur les communes contributrices, à chiffrer par le budget.',
      nextAction: 'L’autorité budgétaire choisit un scénario et le fait chiffrer par ses services.',
      owner: `${roleLabel('R05')} (autorité budgétaire)`, deadline: addDays(gw.today, 30), confidence: pays.length ? 'MEDIUM' : 'LOW',
      sources: ['Recettes rapprochées', 'Comptes publics du coffre'],
      recommendedStep: 'Inscrire l’arbitrage à l’ordre du jour du comité budgétaire.',
      decision: {
        bestOption: 'Maintien des affectations légales, avec réserve de trésorerie fixée par l’autorité.',
        alternativeOption: 'Programme d’investissement ciblé (à chiffrer).',
        riskOfInaction: 'Fonds disponibles sans emploi planifié.',
        financialImpact: pays.length ? `Base disponible : ${lines.join(' ; ')}.` : 'Aucune base disponible.',
        operationalImpact: 'Aucun mouvement de fonds par l’IA ; tout paiement suit la chaîne de la dépense publique.',
      },
      circuit: 'Arbitrage de l’autorité budgétaire ; jamais de virement ni de changement de bénéficiaire par l’IA.',
      actions: [], citations: [],
    }];
  }

  // 13. Apprentissage continu
  private learning(gw: DataGateway): Draft[] {
    const decisions = gw.aiDecisions();
    const stats = new Map<string, { total: number; accepted: number; rejected: number; modified: number }>();
    for (const d of decisions) {
      if (!['ACCEPTEE', 'REJETEE', 'MODIFIEE', 'ANNULEE'].includes(d.status)) continue;
      const s = stats.get(d.agentCode) ?? { total: 0, accepted: 0, rejected: 0, modified: 0 };
      s.total++;
      if (d.status === 'ACCEPTEE') s.accepted++;
      else if (d.status === 'MODIFIEE') s.modified++;
      else s.rejected++;
      stats.set(d.agentCode, s);
    }
    gw.cite('DECISIONS_IA', 'decisions:humaines', `Décisions humaines sur recommandations (${[...stats.values()].reduce((a, s) => a + s.total, 0)})`);
    const weak = [...stats.entries()].filter(([, s]) => s.total >= 3 && (s.rejected + s.modified) * 2 >= s.total);
    const table = [...stats.entries()].map(([a, s]) => `${a} : ${s.accepted}/${s.total} acceptées`).join(' ; ') || 'aucune décision';
    if (weak.length === 0) {
      return [{
        quiet: true, key: `APPRENT:${table}`, autonomy: 'C_RECOMMANDATION', actions: [], citations: [], example: false,
        situation: `Taux d’acceptation par agent : ${table}.`, insight: 'Aucun agent ne présente un taux de rejet ou de modification élevé (seuil : 50 % sur au moins 3 décisions).',
        risk: 'Faible.', recommendation: 'Aucune version candidate.', nextAction: 'Aucune.', owner: roleLabel('R29'), deadline: addDays(gw.today, 30), confidence: 'MEDIUM', sources: ['Décisions humaines'],
      }];
    }
    return weak.map(([agent, s]) => ({
      key: `APPRENT:${agent}:${s.total}:${s.rejected}:${s.modified}`, autonomy: 'C_RECOMMANDATION' as const, example: false,
      situation: `Agent ${agent} : ${s.rejected} rejet(s) et ${s.modified} modification(s) sur ${s.total} décisions.`,
      insight: 'Les corrections humaines indiquent une règle d’analyse à recalibrer (seuils, facteurs ou libellés).',
      risk: 'Recommandations peu utiles, perte de confiance ; à l’inverse, une mise en service non validée serait une auto-modification interdite.',
      recommendation: `Préparer une version candidate de la fiche ${agent}, évaluée sur un jeu de données approuvé.`,
      nextAction: 'Le gestionnaire des modèles soumet la version candidate au comité des modèles.',
      owner: `${roleLabel('R29')} ; comité des modèles`, deadline: addDays(gw.today, 30), confidence: 'MEDIUM' as const, sources: ['Décisions humaines sur recommandations'],
      circuit: 'Version candidate → évaluation → comité des modèles → mise en service ; aucune auto-modification.',
      actions: [{ type: 'PREPARER_BROUILLON' as const, level: 'A' as const, label: 'Préparer la note de version candidate', params: { title: `Version candidate — ${agent} (statut CANDIDAT)`, body: `Décisions : ${s.accepted} acceptées, ${s.rejected} rejetées, ${s.modified} modifiées.\nÀ évaluer sur jeu approuvé ; mise en service interdite sans comité.` } }],
      citations: [],
    }));
  }

  // 14. Communication
  private communication(gw: DataGateway): Draft[] {
    const c = gw.comms();
    const overdue = gw.obligations().filter((o) => UNPAID.includes(o.status) && o.dueDate < gw.today && !o.appealId);
    gw.cite('COMMUNICATIONS', 'comms:configuration', `Canaux raccordés ${c.channelsWired}/${c.channelsTotal}`);
    const out: Draft[] = [];
    if (c.channelsWired < c.channelsTotal) {
      out.push({
        key: `COMM:canaux:${c.channelsWired}/${c.channelsTotal}`, autonomy: 'B_VALIDATION', example: false,
        situation: `${plural(c.attempted, 'envoi tenté', 'envois tentés')}, dont ${c.sandboxLogged} journalisé(s) en bac à sable ; ${c.channelsWired}/${c.channelsTotal} canaux raccordés.`,
        insight: 'Les canaux sans clé fournisseur fonctionnent en bac à sable : aucun message n’est réellement transmis.',
        risk: 'En production, un avis obligatoire non transmis ne fait pas courir les délais légaux.',
        recommendation: 'Contractualiser et configurer les fournisseurs avant l’ouverture au public.',
        nextAction: 'Relire la note de configuration préparée et la soumettre au comité des changements.',
        owner: `${roleLabel('R08')} ; ${roleLabel('R26')}`, deadline: addDays(gw.today, 30), confidence: 'HIGH', sources: ['Journal de délivrance', 'Configuration des canaux'],
        actions: [{ type: 'PREPARER_BROUILLON', level: 'A', label: 'Préparer la note de configuration des canaux', params: { title: 'Note de configuration des canaux (brouillon)', body: `Canaux raccordés : ${c.channelsWired}/${c.channelsTotal}. Envois en bac à sable : ${c.sandboxLogged}.` } }],
        citations: [],
      });
    }
    for (const o of overdue.slice(0, 20)) {
      gw.cite('OBLIGATIONS', o.id, `Obligation ${o.id} échue le ${o.dueDate}`);
      out.push({
        key: `COMM:relance:${o.id}:${o.dueDate}`, autonomy: 'B_VALIDATION', example: false, subject: { type: 'obligation', id: o.id }, taxpayerId: o.taxpayerId,
        situation: `Obligation ${o.id} (règle ${o.ruleCode}) échue depuis le ${o.dueDate}, non soldée : ${Money.fromJSON(o.amount).toDecimalString()} ${o.amount.currency}.`,
        insight: `Retard de ${plural(daysBetween(o.dueDate, gw.today), 'jour')}. Aucune pénalité n’est calculée par l’IA.`,
        risk: 'Arriéré croissant ; le contribuable peut ignorer l’échéance si aucun rappel n’est adressé.',
        recommendation: 'Envoyer la première relance (rappel du montant, de la référence et des voies de recours).',
        nextAction: 'Valider l’envoi de la relance (niveau B : un clic).',
        owner: roleLabel('R07'), deadline: addDays(gw.today, 3), confidence: 'HIGH', sources: ['Obligation (échéance)', 'Catalogue des événements : recovery.reminder.1'],
        actions: [{ type: 'RELANCE_OBLIGATOIRE', level: 'B', label: 'Envoyer la relance n° 1', params: { obligationId: o.id, taxpayerId: o.taxpayerId } }],
        citations: [],
      });
    }
    if (out.length === 0) {
      out.push({
        quiet: true, key: 'COMM:rien', autonomy: 'B_VALIDATION', actions: [], citations: [], example: false,
        situation: `${c.channelsWired}/${c.channelsTotal} canaux raccordés ; aucune obligation échue non soldée.`, insight: 'Aucun message à préparer.', risk: 'Faible.',
        recommendation: 'Aucune.', nextAction: 'Aucune.', owner: roleLabel('R08'), deadline: addDays(gw.today, 30), confidence: 'HIGH', sources: ['Journal de délivrance'],
      });
    }
    return out;
  }
}

export { KNOWLEDGE_BASE };
