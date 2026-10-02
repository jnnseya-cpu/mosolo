/** Types des réponses de l'API du module fiscal (backend/src/plugins/fiscal). */
import type { MapStatusColor, MoneyJSON } from '@mosolo/shared';

export interface ColorResult { color: MapStatusColor; label: string; reason: string }

export interface Proof { type: string; reference: string; addedAt?: string; addedBy?: string }

export interface RelationView {
  id?: string;
  taxpayerId?: string;
  objectId?: string;
  role: string;
  roleLabel: string;
  share: string | null;
  from: string;
  to?: string | null;
  proofs?: Proof[];
  probativeStatus?: string;
  status: string;
  own: boolean;
  declaredBy?: string;
  validatedBy?: string;
  decisionReason?: string;
  disputeId?: string;
  history?: { at: string; by: string; action: string; reason?: string }[];
  taxpayerName?: string;
}

export interface PlateQr { plateId: string; nfiu: string; shortCode: string; status: string; verifyPath: string }

export interface FiscalObjectView {
  id: string;
  category: string;
  categoryLabel: string;
  commune: string;
  quartier: string;
  avenue: string | null;
  localityRank: number;
  status: 'PROVISOIRE' | 'VALIDE';
  probativeStatus: string;
  /** Cycle de vie (§ 30 du Document maître FR 2) : provisoire, actif, suspendu, clos. */
  lifecycle?: ObjectLifecycle;
  igf: { code: string; uuid: string; assignedAt: string; cahierCode?: string | null } | null;
  holder: string | null;
  highValue: boolean;
  attributes: Record<string, unknown>;
  situation: ColorResult;
  coverage: ColorResult;
  occupancy: { code: string; label: string };
  tree: { geo: { level: string; name: string; code: string }[]; objects: { id: string; category: string; label: string; igf: string | null }[]; children: { id: string; category: string; label: string; igf: string | null }[] };
  plate: PlateQr | null;
  relations: RelationView[];
  leases: { id: string; periodicity: string; start: string; end: string | null; role: string | null }[];
  example: boolean;
}

export interface Reference {
  communes: string[];
  relationRoles: { code: string; label: string }[];
  proofTypes: string[];
  closeReasons: string[];
  declarationKinds: { code: string; label: string }[];
  legalBases: { id: string; title: string; demo: boolean }[];
}

export interface QueueResponse {
  relations: (RelationView & { object: FiscalObjectView })[];
  disputes: { id: string; objectId: string; openedAt: string; openedReason: string; relations: RelationView[] }[];
  objectsToValidate: { id: string; category: string; commune: string; quartier: string; createdBy: string; probativeStatus: string }[];
}

export interface PrefilledField { name: string; label: string; value: string | null; source: string; probativeStatus: string | null; editable: boolean }

/** Calcul affiché (Document maître FR 2, ch. 43) : taux, retenue et arrêté lus dans la fiche de règle. */
export interface CalculAffiche { formule: string; base: string; taux: string | null; tauxRetenue: string | null; bareme: Record<string, string>; arretes: { id: string; titre: string; statut: string }[]; mention: string }

export interface Prefill {
  objectId: string; igf: string | null; kind: string; kindLabel: string; period: string; localityRank: number;
  rule: { id: string; code: string; version: number; label: string; status: string; executable: boolean; reason?: string; demo: boolean };
  fields: PrefilledField[];
  notice: string;
  calcul?: CalculAffiche;
}

export interface Trace {
  ruleCode: string; ruleVersion: number; formula: string; inputs: Record<string, string>; rates: Record<string, string>;
  result: MoneyJSON; nonOpposable: boolean; executable: boolean; executabilityReason?: string;
  grossResult?: MoneyJSON; adjustments?: { sourceId: string; label: string; rate: string; reduction: MoneyJSON; legalBasis: { title: string; article: string } }[];
}

export interface Declaration {
  id: string; version: number; supersedes?: string; supersededBy?: string; taxpayerId: string; objectId: string; kind: string; period: string;
  ruleCode: string; ruleVersion: number; prefilled: PrefilledField[]; inputs: Record<string, string>;
  changes: { field: string; prefilled: string | null; declared: string; source: string; lowered: boolean }[];
  verificationRequired: boolean; status: string;
  acknowledgement: { number: string; receivedAt: string; contentHash: string };
  filedBy: string; filedByRole: string;
  liquidation: { mode: string; obligationId?: string; trace?: Trace; message: string };
  calcul?: CalculAffiche;
  piece?: { name: string; mediaType: string; sha256: string; sizeBytes?: number };
  correctionReason?: string;
  instruction?: { decision: string; reason: string; decidedBy: string; at: string; rectifiedObligationId?: string };
}

export interface ExemptionStep { step: string; userId: string; roles: string[]; decision: string; reason: string; at: string }

export interface Exemption {
  id: string; kind: 'EXONERATION' | 'REMISE'; taxpayerId: string; taxpayerName?: string; objectId?: string; ruleCode?: string; revenueCategory?: string;
  obligationId?: string; amount?: MoneyJSON; rate?: string; grounds: string; proofs: { type: string; reference: string }[];
  legalBasis?: { instrumentId: string; article: string; title: string; instrumentStatus: string; demo: boolean };
  validFrom: string; validTo?: string; status: string; effectiveStatus: string; requestedBy: string; requestedAt: string;
  steps: ExemptionStep[]; retroactivity?: { decisionReference: string; reason: string }; rectifiedObligationId?: string;
}

export interface Clearance {
  id: string; number: string; shortCode: string; shortCodeDisplay: string; signature: string; taxpayerId: string;
  issuedAt: string; validFrom: string; validUntil: string; status: string; check: string; informative: boolean;
  verificationLevel: string; basis: { obligationsExamined: number; settledOnDefinitiveReceipt: string[]; contestedExcluded: string[]; notYetDue: string[] };
  revocation?: { reason: string; by: string; at: string }; verifyPath: string; notice: string; reused?: boolean;
}

export interface Eligibility {
  eligible: boolean;
  blockers: { obligationId: string; label: string; dueDate: string; reason: string }[];
  basis: Clearance['basis'];
  verificationLevel: string; levelNote: string | null; informative: boolean; notice: string; checkedAt: string;
}

export interface LeaseAttestationView {
  id: string; number: string; shortCodeDisplay: string; issuedToRole: string; issuedAt: string; status: string; verifyPath: string;
  lease: { id: string; unitIgf: string; unitLabel: string; commune: string; quartier: string; lessor: string; lessee: string; rent: MoneyJSON; periodicity: string; start: string; end: string | null; probativeStatus: string };
  legalNote: string;
}

export interface LeaseRow {
  id: string; role: 'BAILLEUR' | 'LOCATAIRE'; unitIgf: string; commune: string | null; quartier: string | null; rent: MoneyJSON;
  periodicity: string; start: string; end: string | null; probativeStatus: string; attestation: LeaseAttestationView | null;
  /** État du bail (§ 30 du Document maître FR 2) : déclaré, vérifié, résilié, contesté. */
  state?: 'DECLARE' | 'OBSERVE' | 'VERIFIE' | 'RESILIE' | 'CONTESTE'; stateLabel?: string;
  termination?: { endDate: string; reason: string; by: string; byRole: string; at: string } | null;
}

export interface MapResponse {
  layer: 'situation' | 'couverture';
  scope: 'PUBLIC' | 'CONTRIBUABLE' | 'AGENT';
  legend: { color: MapStatusColor; label: string }[];
  threshold: number;
  communes: { commune: string; code: string; total: number | null; byColor: Record<MapStatusColor, number> | null; dominant: MapStatusColor; masked: boolean }[];
  objects: { id: string; igf: string | null; category: string; categoryLabel: string; commune: string; quartier: string; lat: number; lon: number; color: MapStatusColor; label: string; reason: string; demo: boolean }[];
  notice: string;
  example: boolean;
}

/** Cycle de vie d'un objet fiscal (§ 30, § 17.3 du Document maître FR 2, nouvelle version). */
export interface ObjectLifecycle {
  state: 'PROVISOIRE' | 'ACTIF' | 'SUSPENDU' | 'CLOS'; label: string; since: string | null; motif: string | null; reason: string | null;
  pendingClosureId: string | null; liquidationAllowed: boolean;
}
