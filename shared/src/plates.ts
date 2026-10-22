/**
 * Clé de comparaison d'une plaque d'immatriculation : majuscules, lettres et chiffres seuls (espaces, tirets et
 * ponctuation retirés) ; « kn-1234 ab » et « KN1234AB » désignent la même plaque. Distincte, volontairement, de la
 * forme stockée par le stationnement (tirets conservés, `normalizeParkingPlate`) et de la lecture OCR du navigateur
 * (`normalizePlateReading`, qui reconstitue la forme « KN-0000-XX » pour l'affichage).
 */
export function normalizePlate(p: string): string {
  return p.toUpperCase().replace(/[^0-9A-Z]/g, '');
}
