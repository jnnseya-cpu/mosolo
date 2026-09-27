/**
 * Gestion documentaire (spécification fonctionnelle, module 38) : dépôt de pièces chiffrées au repos, versions et
 * empreintes, sceau ; lecture automatique (texte natif lu par le serveur ; image lue par l'OCR embarqué du terminal,
 * aucun service externe) ; classification PROPOSÉE par règles explicables et CONFIRMÉE par une personne ; conservation
 * par catégorie, purge à échéance proposée puis approuvée par deux personnes (jamais les preuves d'audit) ; exports
 * filigranés et expirables ; contrôle d'intégrité ; indicateurs (volume stocké, intégrité vérifiée).
 */
import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useApp } from '../../context';
import { PageHead } from '../../components/Shell';
import { StatusBadge } from '../../components/StatusBadge';
import { EmptyState, ErrorState, Loading } from '../../components/States';
import { useApi } from '../../hooks/useApi';
import { api, describeError } from '../../lib/api';
import { ReasonAction } from '../fiscal/common';

interface Version { id: string; version: number; fileName: string; contentType: string; size: number; sha256: string; seal: string; encrypted: boolean; ocr: { source: string; chars: number; excerpt: string }; uploadedAt: string }
export interface DocView {
  id: string; title: string; category: string; categoryLabel: string; status: string; auditProof: boolean; currentVersion: number; taxpayerId?: string; createdBy: string;
  classification: { status: string; proposal: { category: string; confidence: string; matched: string[]; method: string } };
  retention: { status: string; detail: string; until: string | null }; legalHold?: { motif: string };
  versions: Version[];
}
interface Category { code: string; label: string; auditProof: boolean }
interface Indicators {
  volume: { documents: number; actifs: number; purges: number; versions: number; octets: number; byCategory: Record<string, { documents: number; bytes: number }> };
  classification: { proposees: number; confirmees: number };
  integrite: { statut: string; derniereVerification?: string; verifiees?: number; conformes?: number; ecarts?: number; motif?: string };
  chiffrement: { algorithme: string; raccordement: string };
}

const OCR_SOURCE: Record<string, string> = { TEXTE_NATIF: 'texte lu par le serveur', OCR_TERMINAL: 'OCR du terminal', AUCUN: 'aucun texte' };
const kb = (n: number) => (n < 1024 ? `${n} o` : n < 1_048_576 ? `${(n / 1024).toFixed(1)} Ko` : `${(n / 1_048_576).toFixed(1)} Mo`);

/** OCR embarqué (même moteur que la lecture des plaques, servi par MOSOLO) : l'image n'est jamais envoyée à un tiers. */
async function ocrImage(file: File): Promise<string> {
  const T = await import('tesseract.js');
  const worker = await T.createWorker('eng', T.OEM.LSTM_ONLY, { workerPath: '/ocr/worker.min.js', corePath: '/ocr/', langPath: '/ocr', gzip: true, workerBlobURL: false });
  try { return (await worker.recognize(file)).data.text; } finally { await worker.terminate(); }
}
function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    r.readAsDataURL(file);
  });
}

function UploadForm({ onDone, categories }: { onDone: () => void; categories: Category[] }) {
  const { user } = useApp();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [ocr, setOcr] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true); setErr(null);
    try {
      const contentBase64 = await toBase64(file);
      const ocrText = ocr && file.type.startsWith('image/') ? await ocrImage(file).catch(() => '') : undefined;
      await api('/v1/documents', { method: 'POST', body: { title, fileName: file.name, contentType: file.type || 'application/octet-stream', contentBase64, ...(ocrText ? { ocrText } : {}), ...(category ? { category } : {}), ...(user?.taxpayerId ? { taxpayerId: user.taxpayerId } : {}) } });
      setFile(null); setTitle(''); onDone();
    } catch (x) { setErr(describeError(x).message); } finally { setBusy(false); }
  }
  return (
    <form className="panel stack-sm" onSubmit={(e) => void go(e)} aria-label="Déposer une pièce">
      <h2 className="h-sub">Déposer une pièce</h2>
      <div className="field-row">
        <div className="field"><label className="label" htmlFor="doc-title">Intitulé</label><input id="doc-title" required minLength={3} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        <div className="field"><label className="label" htmlFor="doc-file">Fichier</label><input id="doc-file" type="file" required aria-describedby="doc-file-aide" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.csv,.docx,.xlsx,.odt,.ods,.doc,.xls,application/pdf,image/jpeg,image/png,image/webp,text/plain,text/csv" onChange={(e: ChangeEvent<HTMLInputElement>) => setFile(e.target.files?.[0] ?? null)} /><small id="doc-file-aide" className="muted">Types admis : PDF, images JPEG / PNG / WebP, texte, CSV, Word, Excel, OpenDocument. Les fichiers exécutables, HTML et SVG sont refusés.</small></div>
        <div className="field"><label className="label" htmlFor="doc-cat">Catégorie</label>
          <select id="doc-cat" value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Proposée par la lecture automatique</option>{categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></div>
      </div>
      <label className="small"><input type="checkbox" checked={ocr} onChange={(e) => setOcr(e.target.checked)} /> Lire le texte d’une image sur ce terminal (OCR embarqué)</label>
      {err && <p className="notice notice-err" role="alert">{err}</p>}
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !file}>{busy ? 'Chiffrement et scellement…' : 'Déposer (chiffré, scellé)'}</button>
    </form>
  );
}

function DocCard({ d, categories, onChanged }: { d: DocView; categories: Category[]; onChanged: () => void }) {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const [err, setErr] = useState<string | null>(null);
  const [exp, setExp] = useState<{ token: string; expiresAt: string; watermark: string } | null>(null);
  const [cat, setCat] = useState(d.classification.proposal.category);
  const classifier = roles.some((r) => ['R06', 'R07', 'R11', 'R12', 'R25'].includes(r));
  const holder = roles.some((r) => r === 'R22' || r === 'R24');
  const last = d.versions.at(-1);
  async function download(token: string) {
    try {
      const r = await api<{ fileName: string; contentType: string; contentBase64: string }>(`/v1/documents/exports/${token}`);
      const a = document.createElement('a');
      a.href = `data:${r.contentType};base64,${r.contentBase64}`; a.download = r.fileName; a.click();
    } catch (x) { setErr(describeError(x).message); }
  }
  return (
    <li className="panel stack-sm">
      <div className="panel-head">
        <div className="min0"><p className="panel-title">{d.title}</p><p className="panel-sub"><span className="mono">{d.id}</span> · {d.categoryLabel} · v{d.currentVersion}{d.auditProof ? ' · preuve d’audit' : ''}</p></div>
        <StatusBadge tone={d.status === 'ACTIF' ? 'good' : 'neutral'} label={d.status === 'ACTIF' ? 'Actif, chiffré' : 'Purgé (empreinte conservée)'} />
      </div>
      <p className="small">Classification {d.classification.status === 'PROPOSEE' ? 'PROPOSÉE' : 'confirmée'} : {d.classification.proposal.category} (confiance {d.classification.proposal.confidence.toLowerCase()}{d.classification.proposal.matched.length ? ` ; mots reconnus : ${d.classification.proposal.matched.join(', ')}` : ''}) — {d.classification.proposal.method}</p>
      <p className="small">Conservation : {d.retention.detail}{d.retention.until ? ` (jusqu’au ${d.retention.until.slice(0, 10)})` : ''}</p>
      <ul className="plain-list small">{d.versions.map((v) => <li key={v.id}>v{v.version} · {v.fileName} · {kb(v.size)} · empreinte <span className="mono">{v.sha256.slice(0, 12)}…</span> · sceau <span className="mono">{v.seal.slice(0, 8)}…</span> · {v.encrypted ? 'chiffré' : 'contenu purgé'} · {OCR_SOURCE[v.ocr.source] ?? v.ocr.source}{v.ocr.excerpt ? ` : « ${v.ocr.excerpt.slice(0, 80)}… »` : ''}</li>)}</ul>
      {classifier && d.classification.status === 'PROPOSEE' && (
        <div className="btn-row">
          <label className="small" htmlFor={`cat-${d.id}`}>Catégorie</label>
          <select id={`cat-${d.id}`} value={cat} onChange={(e) => setCat(e.target.value)}>{categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select>
          <ReasonAction label="Confirmer la classification" confirmLabel="Confirmer" onSubmit={(motif) => api(`/v1/documents/${d.id}/classification`, { method: 'POST', body: { category: cat, motif } }).then(onChanged)} />
        </div>
      )}
      <div className="btn-row">
        {d.status === 'ACTIF' && <ReasonAction label="Exporter (filigrané, expirable)" confirmLabel="Préparer l’export" minLength={5} onSubmit={(motif) => api<{ token: string; expiresAt: string; watermark: string }>(`/v1/documents/${d.id}/exports`, { method: 'POST', body: { motif } }).then(setExp)} />}
        {holder && !d.legalHold && d.status === 'ACTIF' && <ReasonAction label="Gel juridique" confirmLabel="Geler (aucune purge)" tone="secondary" onSubmit={(motif) => api(`/v1/documents/${d.id}/gel-juridique`, { method: 'POST', body: { motif } }).then(onChanged)} />}
        {last && d.status === 'ACTIF' && <span className="small muted">Dernier dépôt : {new Date(last.uploadedAt).toLocaleString('fr-FR')}</span>}
      </div>
      {exp && <div className="notice small" role="status"><p>{exp.watermark}</p><button type="button" className="btn btn-secondary btn-sm" onClick={() => void download(exp.token)}>Télécharger avant le {new Date(exp.expiresAt).toLocaleString('fr-FR')}</button></div>}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
    </li>
  );
}

function Governance({ onChanged }: { onChanged: () => void }) {
  const { user } = useApp();
  const roles = user?.roles ?? [];
  const [preview, setPreview] = useState<{ id: string; title: string; retention: { detail: string } }[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [purgeId, setPurgeId] = useState('');
  const run = async (fn: () => Promise<string>) => { setErr(null); setMsg(null); try { setMsg(await fn()); onChanged(); } catch (x) { setErr(describeError(x).message); } };
  return (
    <section className="panel stack-sm" aria-label="Conservation et intégrité">
      <h2 className="h-sub">Conservation et intégrité</h2>
      <div className="btn-row">
        {roles.some((r) => ['R22', 'R23', 'R26', 'R27', 'R28'].includes(r)) && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void run(async () => { const r = await api<{ checked: number; ok: number; failures: unknown[] }>('/v1/documents/integrite/verification', { method: 'POST' }); return `${r.checked} version(s) vérifiée(s), ${r.ok} conforme(s), ${r.failures.length} écart(s).`; })}>Vérifier l’intégrité</button>}
        {roles.includes('R25') && <button type="button" className="btn btn-secondary btn-sm" onClick={() => void api<typeof preview>('/v1/documents/purges/apercu').then(setPreview).catch((x) => setErr(describeError(x).message))}>Aperçu des pièces à échéance</button>}
      </div>
      {preview && (preview.length === 0 ? <p className="small">Aucune pièce à échéance (durées non fixées, preuves d’audit et gels exclus).</p> : (
        <div className="stack-sm">
          <ul className="plain-list small">{preview.map((p) => <li key={p.id}><span className="mono">{p.id}</span> · {p.title} · {p.retention.detail}</li>)}</ul>
          <ReasonAction label="Proposer la purge" confirmLabel="Proposer (approbation par une seconde personne)" onSubmit={(motif) => api<{ id: string }>('/v1/documents/purges', { method: 'POST', body: { documentIds: preview.map((p) => p.id), motif } }).then((r) => { setMsg(`Demande ${r.id} proposée.`); setPreview(null); })} />
        </div>
      ))}
      {roles.some((r) => r === 'R22' || r === 'R28') && (
        <div className="btn-row">
          <label className="small" htmlFor="purge-id">Demande de purge</label><input id="purge-id" value={purgeId} onChange={(e) => setPurgeId(e.target.value)} placeholder="PURG-…" />
          <ReasonAction label="Approuver la purge" confirmLabel="Approuver" onSubmit={(motif) => api(`/v1/documents/purges/${purgeId}/decision`, { method: 'POST', body: { approve: true, motif } }).then(onChanged)} />
          <ReasonAction label="Rejeter" confirmLabel="Rejeter" tone="secondary" onSubmit={(motif) => api(`/v1/documents/purges/${purgeId}/decision`, { method: 'POST', body: { approve: false, motif } }).then(onChanged)} />
        </div>
      )}
      {msg && <p className="notice notice-ok" role="status">{msg}</p>}
      {err && <p className="notice notice-err" role="alert">{err}</p>}
    </section>
  );
}

export default function Documents() {
  const { user } = useApp();
  const docs = useApi(() => api<DocView[]>('/v1/documents'), [user?.id]);
  const cats = useApi(() => api<Category[]>('/v1/documents/categories'), [user?.id]);
  const ind = useApi(() => api<Indicators>('/v1/documents/indicateurs'), [user?.id]);
  const reload = () => { docs.reload(); ind.reload(); };
  const staff = (user?.roles ?? []).some((r) => !['R30', 'R31'].includes(r));
  return (
    <div className="page page-wide">
      <PageHead eyebrow="Documents et preuves" title="Gestion documentaire"
        lead="Chaque pièce est chiffrée au repos, versionnée, scellée (empreinte et sceau inscrits au journal). La lecture automatique propose une catégorie ; une personne la confirme. Les exports sont filigranés et expirent. Les preuves d’audit ne sont jamais purgées." />
      {ind.data && (
        <section className="panel stack-sm" aria-label="Indicateurs de la gestion documentaire">
          <p className="small">Volume stocké : <strong>{ind.data.volume.documents}</strong> document(s), {ind.data.volume.versions} version(s), <strong>{kb(ind.data.volume.octets)}</strong> chiffrés · {ind.data.volume.purges} purgé(s) · classification : {ind.data.classification.proposees} proposée(s), {ind.data.classification.confirmees} confirmée(s)</p>
          <p className="small">Intégrité vérifiée : {ind.data.integrite.statut === 'MESURE' ? <><strong>{ind.data.integrite.conformes}/{ind.data.integrite.verifiees}</strong> conforme(s), {ind.data.integrite.ecarts} écart(s) — {new Date(ind.data.integrite.derniereVerification!).toLocaleString('fr-FR')}</> : `non mesurée — ${ind.data.integrite.motif}`}</p>
          <p className="small muted">Chiffrement {ind.data.chiffrement.algorithme} — {ind.data.chiffrement.raccordement}</p>
        </section>
      )}
      <UploadForm onDone={reload} categories={cats.data ?? []} />
      {docs.loading && <Loading />}
      {docs.error !== null && <ErrorState error={docs.error} onRetry={reload} />}
      {docs.data && docs.data.length === 0 && <EmptyState title="Aucune pièce." />}
      <ul className="stack">{(docs.data ?? []).map((d) => <DocCard key={d.id} d={d} categories={cats.data ?? []} onChanged={reload} />)}</ul>
      {staff && <Governance onChanged={reload} />}
    </div>
  );
}
