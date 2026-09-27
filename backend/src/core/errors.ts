/**
 * Erreurs applicatives au format RFC 9457 (application/problem+json).
 * Chaque erreur porte un `code` stable, consommé par le frontend.
 */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  instance?: string;
  [extension: string]: unknown;
}

const TITLES: Record<number, string> = {
  400: 'Requête invalide',
  401: 'Authentification requise',
  403: 'Accès refusé',
  404: 'Ressource introuvable',
  405: 'Méthode non autorisée',
  409: 'Conflit',
  422: 'Traitement impossible',
  429: 'Trop de requêtes',
  500: 'Erreur interne',
  502: 'Prestataire indisponible',
  503: 'Service momentanément indisponible',
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(detail);
    this.name = 'ApiError';
  }

  toProblem(instance?: string): ProblemDetails {
    return {
      // URN neutre : aucun nom de domaine n'est présumé tant que la Ville n'a pas désigné le sien.
      type: `urn:mosolo:probleme:${this.code.toLowerCase().replace(/_/g, '-')}`,
      title: TITLES[this.status] ?? 'Erreur',
      status: this.status,
      detail: this.message,
      code: this.code,
      ...(instance ? { instance } : {}),
      ...this.extensions,
    };
  }
}

export const badRequest = (code: string, detail: string, ext?: Record<string, unknown>) => new ApiError(400, code, detail, ext);
export const unauthorized = (code: string, detail: string) => new ApiError(401, code, detail);
export const forbidden = (code: string, detail: string, ext?: Record<string, unknown>) => new ApiError(403, code, detail, ext);
export const notFound = (code: string, detail: string) => new ApiError(404, code, detail);
export const conflict = (code: string, detail: string, ext?: Record<string, unknown>) => new ApiError(409, code, detail, ext);
export const unprocessable = (code: string, detail: string, ext?: Record<string, unknown>) => new ApiError(422, code, detail, ext);
