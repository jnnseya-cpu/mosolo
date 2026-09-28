# Kinshasa Mosolo — Property and Occupancy Linkage

Developer specification · Version 1.0 · 28 September 2026 — reçue du maître d'ouvrage le 28/09/2026 (texte intégral).

## 1. Objective and scope

Link independently registered people to the correct plot, building and unit, and record their ownership or occupancy over time. One authenticated person has one platform account, but can hold multiple roles across multiple properties. This feature must work regardless of whether an owner, tenant, field agent or business user registers first. No match alone establishes legal ownership, tenancy, tax liability or a right to view another person's data.

The first release covers residential properties, including multi-unit buildings, joint ownership, co-tenancy, subletting and moves. Commercial occupancy uses the same relationship model with a different use_type. Tax assessment and payment are downstream consumers; they must use verified relationships and an independently configured legal/tariff rule set.

## 2. Non-negotiable decisions

- account_id identifies the authenticated person; property_id and unit_id identify physical objects; relationship_id identifies a dated person's claim to an object. Never use a free-text address or telephone number as a primary key.
- Registration answers are self-declarations. A selected OWNER or TENANT role creates a claim in DRAFT or SUBMITTED, never VERIFIED.
- Every unit must belong to a building; every building belongs to a plot. A single-family home has an explicit unit (for example MAIN) so both scenarios use the same logic.
- Matching generates candidates for the claimant or authorised reviewer. It does not merge records, reveal other occupants, establish a relationship, or trigger a charge.
- A relationship has valid_from, optional valid_to, verification_status, verification_method and an auditable reviewer decision. Historic occupancy remains queryable after a move.
- Account deduplication, property deduplication and relationship verification are three separate workflows. Never silently merge person accounts or properties.
- Consent or invitation acceptance confirms an association between accounts. It does not, by itself, prove title, a legally valid lease or tax liability. Local legal and evidence rules must be configured and approved before those labels are used.

## 3. Data model

Use UUID primary keys, UTC timestamps and immutable audit events. Normalise address components; retain the original entered address. Encrypt sensitive identity and evidence fields; store documents in a protected object store with hashes and access logs.

| Entity | Required fields | Constraints |
|---|---|---|
| accounts | id, person_type, display_name, status, created_at | One person identity resolution process; do not deduplicate solely by name/phone. |
| plots | id, official_plot_ref?, commune, quartier?, avenue?, number?, geometry?, record_status | Unique verified official reference within its issuing namespace; provisional records allowed. |
| buildings | id, plot_id, building_label, record_status | FK to plot; labels unique per plot where supplied. |
| units | id, building_id, unit_label, floor?, use_type, record_status | Canonical unit label unique within building; MAIN for a single-unit building. |
| property_claims | id, account_id, target_type, target_id, role, status, valid_from?, valid_to?, created_at, version | target_type = PLOT, BUILDING, UNIT; role enum includes OWNER, TENANT, SUBTENANT, OCCUPANT, MANAGER; ownership normally attaches to plot/building/unit as evidenced, tenancy to unit. |
| claim_evidence | id, claim_id, evidence_type, object_key, sha256, submitted_by, review_status, retention_class | No publicly accessible URL; evidence cannot be overwritten. |
| invitations | id, claim_id, target_account_id?, delivery_channel, token_hash, expires_at, status | Single use, time limited; never store raw token. |
| match_candidates | id, claim_id, target_id, signals, score, created_at, expires_at | Internal only; no personal details in claimant response. |
| review_cases | id, claim_id, reason_code, assignee_id?, status, decision?, decided_at? | Conflicts and uncertain evidence reviewed by authorised staff. |
| audit_events | id, actor_id, action, entity_type, entity_id, before_hash?, after_hash?, occurred_at, reason? | Append only. |

Add indexes on normalised commune/quartier/avenue/number, official plot reference, geospatial geometry, (building_id, unit_label), (account_id, status), (target_type, target_id, status), and claim date ranges. Model many-to-many person/property links; do not store owner_id or tenant_id as a sole field on a unit.

## 4. Registration and claim flow

Registration asks for current role(s), address components, commune, property or plot reference if known, building and unit label, move-in or acquisition date if known, and whether the address is residential or commercial. The user can skip an unknown official reference. Do not require the owner's name, tenant's name, phone number or a document to create an account. Allow multiple roles and properties in the same account.

1. Save the account and a DRAFT claim. If the location cannot be resolved, create provisional plot/building/unit records with provenance SELF_REPORTED and no official identifier.
2. Run candidate search on normalised reference and location. Return only neutral address and unit labels the person has supplied or is authorised to see; mask third-party data.
3. The person selects a candidate or chooses My address is missing / None of these. Record the selected target_id and submit the claim. Selection does not verify it.
4. Request only the evidence required by the configured policy for that role. An owner/tenant may invite the other party using a contact they already possess. Send an opaque, expiring invitation; the recipient signs into their own account and can accept, decline or report a wrong property.
5. Apply the verification policy. Set VERIFIED only if an authorised reviewer or approved authoritative integration validates the required evidence and target. An invitation may be supporting evidence. Otherwise leave PENDING_REVIEW or NEEDS_EVIDENCE.
6. On a new verified occupancy, flag overlapping verified exclusive tenancy intervals for human review. Do not erase or automatically invalidate either claim. A unit may have joint tenants and additional occupants.

### Registration order scenarios

| Scenario | Required behaviour |
|---|---|
| Owner first | Owner creates plot/building/units and submits ownership claim. Later tenant selects a unit or submits a provisional one. The two claims converge on the canonical unit after verification. |
| Tenant first | Tenant creates provisional address/unit and submits occupancy claim. Later owner creates/claims the building. Candidate duplicate is queued for property review; neither record merges automatically. |
| Both first use different spellings | Address normalisation proposes a candidate; official reference or field verification resolves ambiguity. |
| Separate reasons for registration | An existing account entering a tax, parking or business module may add a property claim without creating a second account. |
| Tenant moves | Close old occupancy at its verified end date and submit a new claim for the new unit. Keep history. |
| Ownership transfer | End the prior owner's verified relationship and verify the new one with evidence; preserve both. |

## 5. Matching rules and merge control

Candidate retrieval priority: verified official plot reference in the correct namespace; then exact normalised address plus building/unit; then geospatial proximity plus address components. The identifier's issuer and namespace must be stored. GPS alone, fuzzy names, phone number, IP address, or matching surname cannot verify a relationship. Candidate scoring may rank results, but no numeric score promotes a claim to VERIFIED.

Before merging provisional property records, a reviewer sees both hierarchy trees, official identifiers, location, claim count and conflicts. Merge requires an explicit canonical target, reason, reviewer identity and audit event; remap foreign keys transactionally, retain aliases and old IDs, and never discard claims or evidence. If verified official references conflict, block merge and escalate. Concurrent edits use optimistic version checks.

## 6. State machine

DRAFT -> SUBMITTED -> MATCHED_PENDING_VERIFICATION -> VERIFIED

Alternative paths: SUBMITTED/MATCHED_PENDING_VERIFICATION -> NEEDS_EVIDENCE -> MATCHED_PENDING_VERIFICATION; SUBMITTED/MATCHED_PENDING_VERIFICATION/VERIFIED -> DISPUTED -> UNDER_REVIEW -> VERIFIED | REJECTED | SUPERSEDED; VERIFIED -> ENDED when relationship dates close. Only an authorised reviewer can reverse a verified decision, and every reversal needs a reason and audit event. A rejected claim remains in history and can be appealed through a new review case. Use separate status for property record (PROVISIONAL, CANONICAL, ARCHIVED_ALIAS).

## 7. API contract (illustrative REST v1)

All mutations require authentication, role-based authorisation, Idempotency-Key, structured error codes and audit logging. Use cursor pagination for lists; all timestamps ISO 8601 UTC.

| Endpoint | Purpose | Key response |
|---|---|---|
| POST /v1/property-claims | Submit role, target/address, dates | claim_id, status, property_record_status |
| GET /v1/property-candidates?claim_id=... | Claimant's masked candidate choices | candidate_id, safe address labels, expiry |
| POST /v1/property-claims/{id}/select-candidate | Attach candidate to claim | Updated claim status |
| POST /v1/property-claims/{id}/evidence | Request signed upload then attach hash/type | Evidence ID, review status |
| POST /v1/property-claims/{id}/invitations | Invite a known party | Invitation ID, expiry; no account discovery |
| POST /v1/invitations/{token}/respond | Accept, decline or report incorrect | Response state; no automatic verification |
| POST /v1/property-claims/{id}/disputes | Open review | Case ID |
| POST /v1/review-cases/{id}/decision | Authorised verification/rejection | Decision, reviewer, reason, effective dates |
| POST /v1/property-claims/{id}/end | Close a dated relationship | Ended claim and date |
| GET /v1/me/property-relationships | Own current and historic roles | Properties and relationship states |

Example request: POST /v1/property-claims with `{ "role":"TENANT", "target_type":"UNIT", "address":{"commune":"Gombe","avenue":"...","number":"...","building_label":"B","unit_label":"2"}, "valid_from":"2026-06-01", "use_type":"RESIDENTIAL" }`. Server derives account_id from the session, never from request body. Return 409 for stale version or conflicting idempotency payload, 422 for invalid dates, and 403 for unauthorised actions. Do not include other parties' account identifiers in claimant responses.

## 8. Access and downstream use

An individual sees their own claims, evidence and property labels; after verification, they see only relationship details necessary for the service. Owners do not automatically see occupant identity, household members, income, documents or other unit occupants. Tenants do not see title evidence or other tenants. Field agents see only assigned territory and time-limited case data. Reviewers see the minimum evidence required; platform administrators may operate infrastructure but cannot approve financial or legal changes through admin privileges. Every sensitive read is logged.

Downstream modules query an effective-dated relationship view with status=VERIFIED, requested date and permitted role. Unverified records may inform outreach or investigation but cannot create a final tax assessment, penalty, entitlement or official statement without the module's independently approved rules. Display provenance and confidence of the property record separately from the person's relationship status.

## 9. Acceptance criteria

1. Two separately registered users can submit owner and tenant claims to one canonical unit in either order without duplicate accounts or automatic verification.
2. A tenant-first provisional unit can be linked to a later owner-created canonical unit only after an audited review; all original IDs, evidence and claims remain traceable.
3. The same account can simultaneously own one unit and rent another; joint ownership and multiple occupants do not violate database constraints.
4. No API response to an unverified claimant reveals the other party's name, phone, account ID or uploaded evidence.
5. Invalid/expired/reused invitation tokens fail; declining an invitation leaves the claim unverified and does not reveal an account's existence.
6. A move preserves prior occupancy dates; a date-specific downstream query returns the correct verified relationship for that date.
7. Conflicting verified exclusive tenancy claims generate a review case; neither is silently removed.
8. A verified official reference conflict prevents property merge; retrying a merge or submission with the same idempotency key does not duplicate work.
9. Every verification, rejection, dispute, relationship end and property merge records actor, timestamp, reason and before/after references.

## 10. Configuration decisions before production

Product owner and authorised provincial legal/data officers must approve: accepted proof by role; authoritative property identifier namespace and source; who may verify title/occupancy; grounds for tax liability by effective date; evidence retention and appeal process; field-agent mandate; and disclosure rules between parties. Until approved, implement self-declaration, candidate matching and review queues, but do not present claims as legally validated or feed them into final assessments.
