/**
 * Pages légères MOSOLO (« /l ») — pour les téléphones basiques (KaiOS, Opera Mini), l'Internet lent (2G/EDGE) et les
 * forfaits de quelques Mo : HTML rendu par le serveur, SANS JavaScript, sans police ni image externe, < 10 Ko par page,
 * formulaires GET/POST simples. Même résolveur que l'application, l'USSD, le SMS et WhatsApp : même réponse partout.
 */
import { BRAND_CSS, brandFooterHtml, brandHeaderHtml } from '../../core/brand.js';
import QRCode from 'qrcode';
import { formatValidityDuration } from '@mosolo/shared';
import type { ProofResult } from './service.js';
import { kinDate } from './service.js';
import { PILOT_COMMUNES, USSD_CODE_LABEL, IVR_NUMBER_LABEL } from '../canaux/model.js';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const BAND: Record<string, { bg: string; fg: string; word: string; mark: string }> = {
  VERT: { bg: '#0b7a0b', fg: '#fff', word: 'VALIDE', mark: '✓' },
  AMBRE: { bg: '#b27600', fg: '#fff', word: 'VALIDE', mark: '!' },
  ROUGE: { bg: '#b3261e', fg: '#fff', word: 'VALIDE — EXPIRE BIENTÔT', mark: '!' },
  EXPIRE: { bg: '#b3261e', fg: '#fff', word: 'EXPIRÉ', mark: '✗' },
  PAS_ACTIF: { bg: '#555', fg: '#fff', word: 'PAS ENCORE ACTIF', mark: '…' },
  PERMANENT: { bg: '#0f5a82', fg: '#fff', word: 'AUTHENTIQUE', mark: '✓' },
  NOIR: { bg: '#1b1d24', fg: '#fff', word: 'NON VALABLE', mark: '✗' },
  INCONNU: { bg: '#555', fg: '#fff', word: 'CODE INCONNU', mark: '?' },
};

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — MOSOLO</title><style>
body{margin:0;font:16px/1.45 system-ui,Arial,sans-serif;background:#fff;color:#111}
header{background:#1f2a6b;color:#fff;padding:8px 12px;border-bottom:4px solid #1E9BD7}
header b{letter-spacing:.08em}header small{display:block;opacity:.85}
main{padding:12px;max-width:640px}a{color:#0f3d91}
input,button,select{font:inherit;padding:8px;max-width:100%}button{background:#1f2a6b;color:#fff;border:0;border-radius:4px}
.r{padding:12px;border-radius:6px;margin:10px 0}.w{font-size:22px;font-weight:800}.bar{font-family:monospace;font-size:18px;letter-spacing:-1px}
dl{margin:8px 0}dt{font-size:13px;color:#444}dd{margin:0 0 6px;font-weight:600}
.n{background:#fff7e3;border:1px solid #e0b64a;padding:8px;border-radius:4px;font-size:14px}
nav a{display:inline-block;margin:0 10px 6px 0}footer{padding:12px;font-size:12px;color:#555;border-top:1px solid #ddd}
@media print{header{background:#fff;color:#000;border-bottom:2px solid #000}nav,form,.np{display:none}}
header .mb-head{padding:4px 0 2px}header .mb-head b,header .mb-head span{color:#fff}header .mb-head img{background:#fff;border-radius:3px;padding:2px}
@media print{header .mb-head b,header .mb-head span{color:#000}}
${BRAND_CSS}
</style></head><body><header>${brandHeaderHtml('version légère', true)}<b>VILLE DE KINSHASA — MOSOLO</b><small>Version légère officielle · sans application · faible débit</small></header><main>${body}</main>
<footer>Aucun agent ne reçoit d’espèces ni ne demande de code secret. USSD gratuit ${esc(USSD_CODE_LABEL)} · SVI ${esc(IVR_NUMBER_LABEL)} · Données de démonstration non opposables.${brandFooterHtml(true)}</footer></body></html>`;
}

const nav = `<nav class="np"><a href="/l">Accueil</a><a href="/l/v">Vérifier</a><a href="/l/points">Où payer</a><a href="/l/payer">Comment payer</a><a href="/l/signaler">Signaler</a></nav>`;

export function home(): string {
  return page('Accueil', `${nav}
<h1 style="font-size:20px">Vérifier une preuve</h1>
<p>Ticket, place de parking, place au marché, pass wewa, certificat, quitus, quittance, badge d’agent, plaque : saisissez le code imprimé sous le QR.</p>
${codeForm('')}
<p class="n">Sans Internet : composez <b>${esc(USSD_CODE_LABEL)}</b> (gratuit) ou envoyez un SMS <b>V</b> suivi du code au numéro court officiel. Sur WhatsApp : écrivez <b>MENU</b> au compte certifié MOSOLO.</p>`);
}

function codeForm(v: string): string {
  return `<form method="get" action="/l/v"><label for="c">Code</label><br><input id="c" name="c" value="${esc(v)}" autocomplete="off" autocapitalize="characters" size="22" required> <button>Vérifier</button></form>`;
}

/** Barre de validité en caractères (lisible sur tout écran, même monochrome). */
function textBar(pct: number): string {
  const n = Math.round(Math.max(0, Math.min(100, pct)) / 10);
  return `${'█'.repeat(n)}${'░'.repeat(10 - n)}`;
}

export function result(r: ProofResult): string {
  const band = !r.found ? 'INCONNU' : r.validity ? r.validity.band : r.state === 'VALIDE' ? 'PERMANENT' : 'NOIR';
  const b = BAND[band] ?? BAND.NOIR!;
  const v = r.validity;
  const word = !r.found ? b.word : !v ? (r.state === 'VALIDE' ? b.word : r.stateLabel.toUpperCase()) : b.word;
  let timing = '';
  if (v && v.remainingSeconds !== null && v.band !== 'PERMANENT') {
    const d = formatValidityDuration(v.remainingSeconds * 1000, false);
    timing = v.band === 'EXPIRE' ? `depuis ${d}` : v.band === 'PAS_ACTIF' ? `début le ${kinDate(v.from!)}` : `encore ${d}`;
  }
  const facts = r.facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('');
  const dates = v && v.from && v.until ? `<dt>Validité</dt><dd>du ${esc(kinDate(v.from))} au ${esc(kinDate(v.until))} (heure de Kinshasa)</dd>` : '';
  return page(r.found ? r.kindLabel : 'Code inconnu', `${nav}
<p style="margin:0;color:#444">${esc(r.kindLabel)} · <b>${esc(r.code)}</b></p>
<div class="r" style="background:${b.bg};color:${b.fg}" role="status">
<div class="w">${b.mark} ${esc(word)}</div>
${timing ? `<div style="font-size:18px">${esc(timing)}</div>` : ''}
${v && v.pct !== null && v.band !== 'EXPIRE' && v.band !== 'PAS_ACTIF' ? `<div class="bar" aria-label="${Math.floor(v.pct)} % de validité restante">${textBar(v.pct)} ${Math.floor(v.pct)} %</div>` : ''}
${r.found && !r.authentic ? '<div><b>SIGNATURE NON AUTHENTIQUE</b></div>' : ''}
</div>
${r.found ? `<p><b>${esc(r.title)}</b></p><dl>${facts}${dates}${r.situation ? `<dt>Situation</dt><dd>${esc(r.situation.label)}</dd>` : ''}</dl>` : ''}
<p>${esc(r.message)}</p>
<p style="font-size:13px">Vert : 50 % ou plus de validité restante · Orange : 1 à 50 % · Rouge : moins de 1 %. Vérifié le ${esc(kinDate(r.checkedAt))} (heure du serveur).</p>
<p class="np"><a href="/l/v?c=${encodeURIComponent(r.code)}">Actualiser</a>${r.found ? ` · <a href="/l/imprimer?c=${encodeURIComponent(r.code)}">Version imprimable</a>` : ''}</p>
<p class="n">${esc(r.advice)}</p>
${codeForm('')}`);
}

/** Version imprimable légère : grand code, QR (SVG en ligne), dates en gros caractères. */
export async function printable(r: ProofResult, verifyBase: string): Promise<string> {
  const url = `${verifyBase}/l/v?c=${encodeURIComponent(r.code)}`;
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, width: 180 });
  const v = r.validity;
  return page(`Preuve ${r.code}`, `
<p style="margin:0;font-size:13px">${esc(r.kindLabel)}</p>
<h1 style="font-size:20px;margin:4px 0">${esc(r.title)}</h1>
<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
<div style="width:180px">${svg}</div>
<div><div style="font-family:monospace;font-size:26px;font-weight:800;letter-spacing:.06em">${esc(r.code)}</div>
${v && v.from && v.until ? `<div style="font-size:18px">Du <b>${esc(kinDate(v.from))}</b><br>au <b>${esc(kinDate(v.until))}</b></div>` : ''}
</div></div>
<dl>${r.facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl>
<p style="font-size:13px">Vérifiez ce document : scannez le QR, ou <b>${esc(USSD_CODE_LABEL)}</b>, ou SMS « V ${esc(r.code)} », ou WhatsApp MOSOLO. Seule la vérification en ligne fait foi : une copie d’un titre expiré s’affiche EXPIRÉ.</p>
<p style="font-size:12px">Imprimé le ${esc(kinDate(r.checkedAt))} · ${esc(url)}</p>
<p class="np"><a href="/l/v?c=${encodeURIComponent(r.code)}">Retour</a></p>`);
}

export function points(commune: string | undefined, list: { name: string; address: string; hours: string; type: string }[]): string {
  const opts = PILOT_COMMUNES.map((c) => `<option${c === commune ? ' selected' : ''}>${esc(c)}</option>`).join('');
  const rows = commune ? (list.length ? `<ul>${list.map((p) => `<li><b>${esc(p.name)}</b><br>${esc(p.address)} · ${esc(p.hours)}</li>`).join('')}</ul>` : '<p>Aucun point actif référencé dans cette commune.</p>') : '';
  return page('Où payer', `${nav}<h1 style="font-size:20px">Points de paiement agréés</h1>
<form method="get" action="/l/points"><select name="commune">${opts}</select> <button>Afficher</button></form>${rows}
<p class="n">Seuls les points référencés et actifs encaissent et délivrent une preuve valable. Aucun agent public ne reçoit d’argent.</p>`);
}

export function howToPay(): string {
  return page('Comment payer', `${nav}<h1 style="font-size:20px">Comment payer</h1>
<ol><li>Obtenez votre <b>référence de paiement</b> : USSD <b>${esc(USSD_CODE_LABEL)}</b> (gratuit), application, guichet MOSOLO ou avis imprimé.</li>
<li>Payez avec cette référence : monnaie mobile, banque, ou point agréé. Le montant est fixé par le système : il ne se négocie pas.</li>
<li>Votre quittance et votre titre (ticket, place…) sont émis après confirmation. Vérifiez-les ici avec leur code.</li></ol>
<p class="n">MOSOLO n’envoie jamais de lien de paiement par SMS ni WhatsApp. Aucun agent ne reçoit d’espèces.</p>`);
}

export function reportForm(done?: { reference: string; trackingCode: string } | null, error?: string): string {
  return page('Signaler', `${nav}<h1 style="font-size:20px">Signaler un faux agent ou une demande d’espèces</h1>
${done ? `<p class="n">Signalement <b>${esc(done.reference)}</b> enregistré. Code de suivi : <b>${esc(done.trackingCode)}</b>.</p>` : ''}
${error ? `<p class="n">${esc(error)}</p>` : ''}
<form method="post" action="/l/signaler"><label for="t">Que s’est-il passé ? (lieu, heure)</label><br>
<textarea id="t" name="t" rows="4" cols="30" required minlength="5" maxlength="600"></textarea><br>
<label><input type="checkbox" name="anonyme" value="1"> Rester anonyme</label><br><button>Envoyer</button></form>`);
}
