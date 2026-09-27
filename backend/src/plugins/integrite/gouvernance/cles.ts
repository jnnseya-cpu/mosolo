/**
 * Contrôle de santé des clés de signature et HMAC — LECTURE SEULE, sans jamais révéler un secret.
 *
 * Pour chaque clé : configurée ou non (variable d'environnement), empreinte (8 premiers caractères hexadécimaux du
 * SHA-256 : de la clé publique SPKI pour une clé asymétrique, de la valeur pour une clé symétrique), âge si la date
 * de mise en service est déclarée (MOSOLO_KEY_DATES=« MOSOLO_AUDIT_HMAC_KEY=2026-01-15,… »), et avertissements :
 * absente hors démonstration, clé éphémère (générée au démarrage), valeur de démonstration, trop courte, même clé
 * réutilisée pour deux usages, repli sur une autre clé, âge dépassé.
 *
 * Les valeurs sont lues dans le contexte déjà chargé (`ctx.secrets`, clés publiques des services) et dans
 * l'environnement ; rien n'est modifié, rien n'est journalisé en clair.
 */
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import type { AppContext } from '../../../context.js';
import { isDemoMode } from '../../../core/auth.js';
import { sha256Hex } from '../../../core/crypto.js';

export type KeyKind = 'HMAC' | 'ED25519' | 'SYMETRIQUE' | 'CHEMIN';
export type KeyWarningCode =
  | 'ABSENTE_HORS_DEMONSTRATION' | 'ABSENTE' | 'EPHEMERE' | 'VALEUR_DEMONSTRATION' | 'TROP_COURTE'
  | 'REUTILISEE' | 'REPLI_SUR_AUTRE_CLE' | 'AGE_DEPASSE' | 'ILLISIBLE';

export interface KeyWarning { code: KeyWarningCode; severity: 'INFO' | 'ATTENTION' | 'CRITIQUE'; message: string }

export interface KeyReport {
  id: string;
  purpose: string;
  env: string;
  kind: KeyKind;
  configured: boolean;
  /** 8 premiers caractères hexadécimaux du SHA-256 (jamais la valeur). Null : aucune clé. */
  fingerprint: string | null;
  length?: number;
  since?: string;
  ageDays?: number;
  warnings: KeyWarning[];
}

export interface KeyHealth {
  generatedAt: string;
  mode: 'DEMONSTRATION' | 'EXPLOITATION';
  keys: KeyReport[];
  summary: { total: number; configured: number; critical: number; attention: number };
  note: string;
}

interface Material {
  id: string; purpose: string; env: string; kind: KeyKind; required: boolean;
  /** Empreinte complète (comparaison des réutilisations) ; jamais exposée entière. */
  full: string | null; length?: number; configured: boolean; ephemeral?: boolean; demo?: boolean; fallbackOf?: string; unreadable?: boolean;
  symmetric: boolean;
}

const spkiHash = (k: KeyObject): string => sha256Hex(createPublicKey(k).export({ type: 'spki', format: 'der' }) as Buffer);
const isDemoValue = (v: string) => /^demo-/i.test(v.trim()) || /^test-/i.test(v.trim());

function asymmetricFromEnv(raw: string | undefined): { full: string | null; unreadable: boolean } {
  const v = raw?.trim();
  if (!v) return { full: null, unreadable: false };
  try {
    const key = v.includes('-----BEGIN') ? createPrivateKey(v.replace(/\\n/g, '\n')) : createPrivateKey({ key: Buffer.from(v, 'base64'), format: 'der', type: 'pkcs8' });
    return { full: spkiHash(key), unreadable: false };
  } catch {
    return { full: null, unreadable: true };
  }
}

/** Dates de mise en service déclarées : MOSOLO_KEY_DATES=« VAR=AAAA-MM-JJ,VAR=AAAA-MM-JJ ». */
export function keyDatesFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (env.MOSOLO_KEY_DATES ?? '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean)) {
    const [k, d] = item.split('=').map((s) => s?.trim());
    if (k && d && /^\d{4}-\d{2}-\d{2}$/.test(d)) out[k] = d;
  }
  return out;
}

export function keyHealth(ctx: AppContext, opts: { env?: NodeJS.ProcessEnv; minLength: number; maxAgeDays: number }): KeyHealth {
  const env = opts.env ?? process.env;
  const demo = isDemoMode(env);
  const now = ctx.clock.now();
  const mats: Material[] = [];
  const sym = (id: string, purpose: string, name: string, value: string | undefined, over: Partial<Material> = {}) => {
    const v = value?.trim();
    mats.push({
      id, purpose, env: name, kind: 'HMAC', required: true, symmetric: true, configured: !!env[name]?.trim(),
      full: v ? sha256Hex(v) : null, ...(v ? { length: v.length, demo: isDemoValue(v) } : {}), ...over,
    });
  };

  // Journal d'audit : clé HMAC (sans variable : clé aléatoire générée au démarrage).
  sym('audit-hmac', 'Signature HMAC du journal d’audit chaîné et de son ancre', 'MOSOLO_AUDIT_HMAC_KEY', ctx.secrets.auditHmacKey, { ephemeral: !env.MOSOLO_AUDIT_HMAC_KEY?.trim() });
  // Quittances : clé Ed25519 (publique du service en place).
  const receiptEnv = !!env.MOSOLO_RECEIPT_SIGNING_KEY?.trim();
  mats.push({
    id: 'quittances', purpose: 'Signature Ed25519 des quittances', env: 'MOSOLO_RECEIPT_SIGNING_KEY', kind: 'ED25519', required: true, symmetric: false,
    configured: receiptEnv || !!ctx.secrets.receiptSigningKey, full: sha256Hex(ctx.receipts.publicKey.export({ type: 'spki', format: 'der' }) as Buffer),
    ephemeral: !receiptEnv && !ctx.secrets.receiptSigningKey,
  });
  // Clôtures du Trésor : clé Ed25519 (publique du module trésor s'il est chargé, sinon lue de l'environnement).
  const tresor = ctx.ext.tresor as { publicKey?: KeyObject } | undefined;
  const closure = asymmetricFromEnv(env.MOSOLO_CLOSURE_SIGNING_KEY);
  mats.push({
    id: 'clotures', purpose: 'Signature Ed25519 des clôtures et exports du Trésor', env: 'MOSOLO_CLOSURE_SIGNING_KEY', kind: 'ED25519', required: true, symmetric: false,
    configured: !!env.MOSOLO_CLOSURE_SIGNING_KEY?.trim(),
    full: closure.full ?? (tresor?.publicKey ? sha256Hex(tresor.publicKey.export({ type: 'spki', format: 'der' }) as Buffer) : null),
    ephemeral: !closure.full && !closure.unreadable, unreadable: closure.unreadable,
  });
  // Jetons d'accès : clé Ed25519.
  const jwt = asymmetricFromEnv(env.MOSOLO_JWT_PRIVATE_KEY);
  mats.push({
    id: 'jetons', purpose: 'Signature Ed25519 des jetons d’accès', env: 'MOSOLO_JWT_PRIVATE_KEY', kind: 'ED25519', required: true, symmetric: false,
    configured: !!env.MOSOLO_JWT_PRIVATE_KEY?.trim(), full: jwt.full, ephemeral: !jwt.full && !jwt.unreadable, unreadable: jwt.unreadable,
  });
  // Sauvegardes signées.
  sym('sauvegardes', 'Signature des sauvegardes', 'MOSOLO_BACKUP_KEY', env.MOSOLO_BACKUP_KEY, { kind: 'SYMETRIQUE' });
  // Intégrité : identité des signalants (repli sur la clé d'audit si absente).
  if (env.MOSOLO_INTEGRITE_KEY?.trim()) sym('integrite', 'Scellement de l’identité des signalants et codes de suivi', 'MOSOLO_INTEGRITE_KEY', env.MOSOLO_INTEGRITE_KEY, { kind: 'SYMETRIQUE' });
  else mats.push({ id: 'integrite', purpose: 'Scellement de l’identité des signalants et codes de suivi', env: 'MOSOLO_INTEGRITE_KEY', kind: 'SYMETRIQUE', required: true, symmetric: true, configured: false, full: null, fallbackOf: 'MOSOLO_AUDIT_HMAC_KEY' });
  // Points de paiement : clé maîtresse (aléatoire au démarrage si absente).
  sym('points-maitresse', 'Clé maîtresse des points de paiement agréés', 'MOSOLO_PAYMENT_POINT_MASTER_KEY', env.MOSOLO_PAYMENT_POINT_MASTER_KEY, { kind: 'SYMETRIQUE', ephemeral: !env.MOSOLO_PAYMENT_POINT_MASTER_KEY?.trim() });
  // Prestataires de paiement : secrets HMAC des rappels.
  for (const [p, v] of Object.entries(ctx.secrets.providerSecrets)) {
    const name = `MOSOLO_PROVIDER_SECRET_${p.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    sym(`prestataire:${p}`, `HMAC des rappels du prestataire ${p}`, name, v, { configured: !!env[name]?.trim() });
  }
  // Terminaux : une ligne par terminal (empreinte seulement).
  for (const [d, v] of Object.entries(ctx.secrets.deviceKeys)) {
    sym(`terminal:${d}`, `HMAC du terminal ${d}`, 'MOSOLO_DEVICE_KEYS', v, { configured: (env.MOSOLO_DEVICE_KEYS ?? '').includes(`${d}=`), required: false });
  }
  // Ancre externe du journal d'audit (chemin, pas un secret).
  mats.push({
    id: 'ancre-audit', purpose: 'Ancre externe de la chaîne d’audit (fichier hors base)', env: 'MOSOLO_AUDIT_ANCHOR_PATH', kind: 'CHEMIN', symmetric: false,
    required: !!env.DATABASE_URL?.trim(), configured: !!env.MOSOLO_AUDIT_ANCHOR_PATH?.trim(), full: null,
  });

  const dates = keyDatesFromEnv(env);
  const byHash = new Map<string, Material[]>();
  for (const m of mats) if (m.full) byHash.set(m.full, [...(byHash.get(m.full) ?? []), m]);

  const keys: KeyReport[] = mats.map((m) => {
    const w: KeyWarning[] = [];
    const hasKey = !!m.full || m.configured;
    if (m.unreadable) w.push({ code: 'ILLISIBLE', severity: 'CRITIQUE', message: `${m.env} est fournie mais illisible (clé privée Ed25519 PKCS#8 attendue).` });
    if (m.kind === 'CHEMIN') {
      if (!m.configured) w.push(m.required && !demo
        ? { code: 'ABSENTE_HORS_DEMONSTRATION', severity: 'CRITIQUE', message: 'Ancre externe absente : une troncature ou une réécriture de la chaîne d’audit persistée passerait inaperçue.' }
        : { code: 'ABSENTE', severity: 'INFO', message: 'Ancre externe non configurée (requise avec DATABASE_URL hors démonstration).' });
    } else if (m.fallbackOf) {
      w.push({ code: 'REPLI_SUR_AUTRE_CLE', severity: demo ? 'INFO' : 'ATTENTION', message: `${m.env} absente : clés dérivées de ${m.fallbackOf} (séparation des clés non assurée).` });
    } else if (m.ephemeral) {
      w.push({ code: 'EPHEMERE', severity: demo ? 'INFO' : 'CRITIQUE', message: `${m.env} absente : clé générée au démarrage — les signatures antérieures deviennent invérifiables après redémarrage.` });
    } else if (!m.configured && m.required && !m.full) {
      w.push({ code: demo ? 'ABSENTE' : 'ABSENTE_HORS_DEMONSTRATION', severity: demo ? 'INFO' : 'CRITIQUE', message: `${m.env} absente.` });
    }
    if (m.demo) w.push({ code: 'VALEUR_DEMONSTRATION', severity: demo ? 'INFO' : 'CRITIQUE', message: 'Valeur publique de démonstration ou de test : ne vaut jamais secret en exploitation.' });
    if (m.symmetric && m.length !== undefined && m.length < opts.minLength) {
      w.push({ code: 'TROP_COURTE', severity: demo ? 'ATTENTION' : 'CRITIQUE', message: `${m.length} caractères (minimum du registre : ${opts.minLength}).` });
    }
    if (m.full) {
      const others = (byHash.get(m.full) ?? []).filter((o) => o !== m);
      if (others.length) w.push({ code: 'REUTILISEE', severity: 'CRITIQUE', message: `Même clé que : ${others.map((o) => o.purpose).join(' ; ')}. Une clé = un usage.` });
    }
    const since = dates[m.env];
    let ageDays: number | undefined;
    if (since) {
      ageDays = Math.floor((now.getTime() - Date.parse(`${since}T00:00:00Z`)) / 86_400_000);
      if (ageDays > opts.maxAgeDays) w.push({ code: 'AGE_DEPASSE', severity: 'ATTENTION', message: `Clé en service depuis ${ageDays} jours (rotation recommandée au-delà de ${opts.maxAgeDays}).` });
    }
    return {
      id: m.id, purpose: m.purpose, env: m.env, kind: m.kind, configured: m.configured,
      fingerprint: hasKey && m.full ? m.full.slice(0, 8) : null,
      ...(m.length !== undefined ? { length: m.length } : {}),
      ...(since ? { since, ageDays: ageDays! } : {}),
      warnings: w,
    };
  });
  const all = keys.flatMap((k) => k.warnings);
  return {
    generatedAt: now.toISOString(),
    mode: demo ? 'DEMONSTRATION' : 'EXPLOITATION',
    keys,
    summary: { total: keys.length, configured: keys.filter((k) => k.configured).length, critical: all.filter((w) => w.severity === 'CRITIQUE').length, attention: all.filter((w) => w.severity === 'ATTENTION').length },
    note: 'Aucune valeur secrète n’est exposée : seule une empreinte courte (SHA-256, 8 caractères) permet de vérifier qu’une clé a changé. Production : clés en HSM, détenues par la Ville.',
  };
}
