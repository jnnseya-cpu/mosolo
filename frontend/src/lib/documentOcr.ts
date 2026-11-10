/**
 * Lecture automatique d'une pièce d'identité (module 2) : le texte est lu SUR L'APPAREIL (OCR Tesseract servi par
 * MOSOLO, /ocr/ — aucune image envoyée) ; ce module en extrait la zone MRZ des passeports (norme OACI 9303, deux
 * lignes de 44 caractères), le nom et un numéro candidat. La machine PROPOSE ; la personne corrige et confirme ; le
 * serveur contrôle la cohérence et calcule le score de confiance.
 */
export interface LectureDocument { texte: string; mrzLigne2?: string; nom?: string; numero?: string }

export function analyserTexteDocument(brut: string): LectureDocument {
  const texte = brut.replace(/\r/g, '');
  const lignes = texte.split('\n').map((l) => l.replace(/\s/g, '').toUpperCase()).filter(Boolean);
  const mrz = lignes.filter((l) => /^[A-Z0-9<]{44}$/.test(l));
  const out: LectureDocument = { texte };
  if (mrz.length >= 2 && mrz[mrz.length - 2]!.startsWith('P')) {
    const l1 = mrz[mrz.length - 2]!;
    const l2 = mrz[mrz.length - 1]!;
    out.mrzLigne2 = l2;
    out.numero = l2.slice(0, 9).replace(/</g, '');
    const [nom, prenoms] = l1.slice(5).split('<<');
    out.nom = [nom, prenoms].filter(Boolean).map((s) => s!.replace(/</g, ' ').trim()).join(' ').trim();
    return out;
  }
  const candidats = texte.toUpperCase().match(/\b[A-Z0-9]{6,20}\b/g) ?? [];
  const num = candidats.filter((c) => /\d/.test(c)).sort((a, b) => b.length - a.length)[0];
  if (num) out.numero = num;
  const nomLigne = texte.split('\n').map((l) => l.trim()).find((l) => /^(NOM|NAME|NOMS)\s*[:/]/i.test(l));
  if (nomLigne) out.nom = nomLigne.replace(/^(NOM|NAME|NOMS)\s*[:/]\s*/i, '').trim();
  return out;
}

type Recognize = (img: Blob) => Promise<string>;
let moteur: Promise<Recognize> | null = null;

/** Moteur OCR chargé une seule fois (mêmes fichiers que la lecture de plaque). */
export function lireImage(img: Blob): Promise<string> {
  moteur ??= (async () => {
    const T = await import('tesseract.js');
    const worker = await T.createWorker('eng', T.OEM.LSTM_ONLY, { workerPath: '/ocr/worker.min.js', corePath: '/ocr/', langPath: '/ocr', gzip: true, workerBlobURL: false });
    return async (b: Blob) => (await worker.recognize(b)).data.text;
  })();
  moteur.catch(() => { moteur = null; });
  return moteur.then((r) => r(img));
}
