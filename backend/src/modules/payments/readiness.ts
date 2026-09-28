/**
 * « Prestataires de paiement — état de raccordement » (Trésor R17, administration de la plateforme R26, sécurité R28).
 * Par prestataire : variables configurées ou manquantes (NOMS et PRÉSENCE seulement — jamais une valeur secrète, pas même
 * masquée), mode (bac à sable / réel), URL exacte du webhook à communiquer (construite depuis MOSOLO_PUBLIC_URL),
 * schéma de signature attendu, dernier webhook reçu et résultat de sa vérification, dernière interrogation serveur à
 * serveur, opérateurs, alias de règlement (coffre), disjoncteur, hypothèses à confirmer avec le prestataire.
 */
import type { AppContext } from '../../context.js';
import { PROVIDER_ASSUMPTIONS } from './connectors/a-confirmer.js';
import type { CircuitSnapshot } from './connectors/http-client.js';
import { CONNECTOR_IDS, type ConnectorId } from './connectors/types.js';

const MODE_LABEL = {
  SANDBOX_LOCAL: 'Bac à sable local (aucun appel au prestataire)',
  TEST: 'Bac à sable du prestataire (clé de test)',
  LIVE: 'Réel (production)',
} as const;

const CONFIG_LABEL = {
  NON_CONFIGURE: 'Non configuré : aucun webhook accepté',
  BAC_A_SABLE_DEMO: 'Bac à sable de démonstration (secret public de démonstration)',
  PARTIELLE: 'Configuration partielle : secret de webhook sans clé API — aucun paiement réel, aucune quittance',
  COMPLETE: 'Clé API et secret de webhook présents',
} as const;

/** Adresse publique de la plateforme : https exigé pour une adresse communicable à un prestataire. */
export function publicBaseUrl(env: Record<string, string | undefined> = process.env): { value: string | null; valid: boolean; note: string } {
  const raw = env.MOSOLO_PUBLIC_URL?.trim();
  if (!raw) return { value: null, valid: false, note: 'MOSOLO_PUBLIC_URL absente : l’adresse des webhooks ne peut pas être communiquée aux prestataires.' };
  try {
    const u = new URL(raw);
    const value = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    if (u.protocol !== 'https:') return { value, valid: false, note: 'MOSOLO_PUBLIC_URL doit être en https pour recevoir des webhooks de prestataires.' };
    return { value, valid: true, note: 'Adresse publique définie.' };
  } catch {
    return { value: null, valid: false, note: 'MOSOLO_PUBLIC_URL n’est pas une URL valide.' };
  }
}

export function webhookUrlFor(base: string | null, provider: ConnectorId): string {
  return `${base ?? 'https://<domaine>'}/v1/providers/${provider}/webhooks`;
}

function count<T>(items: T[], key: (x: T) => string): { key: string; count: number }[] {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return [...m.entries()].map(([k, c]) => ({ key: k, count: c })).sort((a, b) => b.count - a.count);
}

export function buildReadiness(ctx: AppContext, env: Record<string, string | undefined> = process.env) {
  const base = publicBaseUrl(env);
  const p = ctx.payments;
  const providers = CONNECTOR_IDS.map((id) => {
    const setup = ctx.connectors.setup.find((s) => s.id === id);
    const connector = ctx.connectors.get(id);
    const receptions = p.webhookReceptions.find((r) => r.provider === id);
    const queries = p.statusQueries.find((q) => q.provider === id);
    const orders = p.orders.find((o) => o.provider === id);
    const lastReception = receptions.at(-1) ?? null;
    const lastQuery = queries.at(-1) ?? null;
    const alias = connector?.settlementAccountAlias ?? setup?.publicValues[`${id.toUpperCase()}_SETTLEMENT_ACCOUNT_ALIAS`] ?? null;
    const account = alias ? ctx.vault.current(alias) : undefined;
    const withCircuit = connector as unknown as { circuitSnapshot?: () => CircuitSnapshot | null } | undefined;
    const variables = setup?.variables ?? [];
    return {
      id,
      label: setup?.label ?? id,
      registered: !!connector,
      configuration: setup?.configuration ?? 'NON_CONFIGURE',
      configurationLabel: CONFIG_LABEL[setup?.configuration ?? 'NON_CONFIGURE'],
      mode: connector?.mode ?? null,
      modeLabel: connector ? MODE_LABEL[connector.mode] : 'Non enregistré',
      // Noms et présence SEULEMENT (jamais une valeur, même masquée, pour les secrets).
      variables: variables.map((v) => ({ name: v.name, present: v.present, secret: v.secret, requiredForReal: v.requiredForReal, role: v.role })),
      missingForReal: variables.filter((v) => v.requiredForReal && !v.present).map((v) => v.name),
      webhookUrl: webhookUrlFor(base.value, id),
      webhookUrlReady: base.valid,
      signatureScheme: connector?.signatureScheme ?? (id === 'koda'
        ? 'HMAC-SHA256 hexadécimal du corps brut (x-koda-signature)'
        : 'HMAC-SHA256 « t=<unix>,v1=<hex> » (BitriPay-Signature) ± Ed25519 (BitriPay-Signature-Ed25519)'),
      baseUrl: connector ? (connector.describe().baseUrl as string) : null,
      operators: connector?.operators ?? [],
      settlementAccount: {
        alias,
        inVault: !!account,
        // Compte verrouillé : toute modification passe par proposition, quorum, vérification hors bande et refroidissement.
        locked: !!account,
        version: account?.version ?? null,
        entity: account?.entity ?? null,
        holderName: account?.holderName ?? null,
        effectiveSince: account?.effectiveSince ?? null,
      },
      lastWebhook: lastReception,
      lastStatusQuery: lastQuery,
      lastConnectionTest: p.connectionTests.find((t) => t.provider === id).at(-1) ?? null,
      circuit: withCircuit?.circuitSnapshot?.() ?? null,
      webhooksByResult: count(receptions, (r) => (r.verification !== 'VALIDE' ? r.verification : r.httpStatus >= 400 ? `REFUSE_${r.outcome}` : 'ACCEPTE')),
      ordersByStatus: count(orders, (o) => o.status),
      suspense: p.providerSuspense.find((x) => x.provider === id).length,
      assumptions: PROVIDER_ASSUMPTIONS[id],
    };
  });
  return {
    generatedAt: ctx.clock.now().toISOString(),
    demoMode: ctx.connectors.demoMode,
    publicUrl: base,
    providers,
    doctrine: [
      'Aucune valeur secrète n’est jamais affichée : seuls les noms des variables et leur présence.',
      'Quittance provisoire seulement après webhook signé ET confirmation serveur à serveur de l’état de l’intention ; quittance définitive au rapprochement avec le relevé du compte public.',
      'Le règlement va au compte public inscrit au coffre (alias verrouillé) ; aucun compte lu dans un webhook n’est jamais utilisé.',
      'Les agents de terrain ne reçoivent jamais d’espèces : paiements numériques vers le compte public uniquement.',
    ],
  };
}
