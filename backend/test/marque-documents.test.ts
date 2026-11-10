/**
 * Marque des documents générés (30/09/2026, consigne du maître d'ouvrage : « tout document généré, imprimé, PDF… est à
 * l'image de la plateforme ») : PDF (quittance, rapports) avec logo de la Ville, « Ville-Province de Kinshasa »,
 * « KINSHASA MOSOLO », filet tricolore et pied « réalisée par Groupe Nseya » ; pages HTML générées par le serveur idem.
 */
import { describe, expect, it } from 'vitest';
import { buildPdf } from '../src/modules/receipts/pdf.js';
import { brandFooterHtml, brandHeaderHtml } from '../src/core/brand.js';
import { page } from '../src/plugins/preuves/lite.js';

describe('Marque des documents générés', () => {
  it('PDF : logos incorporés (Ville de Kinshasa, Groupe Nseya) et mentions de marque sur chaque page', () => {
    const pdf = buildPdf({ title: 'Essai', subject: 'Essai', blocks: Array.from({ length: 80 }, (_, i) => ({ text: `Ligne ${i}` })) }).toString('latin1');
    expect(pdf).toContain('/LogoVille');
    expect(pdf).toContain('/LogoNseya');
    expect(pdf).toContain('/Filter /DCTDecode');
    expect(pdf.match(/\(Ville-Province de Kinshasa\) Tj/g)?.length).toBe(2); // deux pages, en-tête sur chacune
    expect(pdf).toContain('Groupe Nseya');
    // Sans marque (usage technique explicite) : aucun logo.
    expect(buildPdf({ title: 'T', subject: 'S', blocks: [{ text: 'x' }], brand: false }).toString('latin1')).not.toContain('/LogoVille');
  });

  it('pages HTML du serveur (version légère, exports) : en-tête et pied de marque avec logos en data:', () => {
    const html = page('Vérifier', '<p>corps</p>');
    expect(html).toContain('data:image/jpeg;base64,');
    expect(html).toContain('Ville-Province de Kinshasa');
    expect(html).toContain('réalisée par Groupe Nseya');
    expect(brandHeaderHtml('X')).toContain('KINSHASA MOSOLO · X');
    expect(brandFooterHtml()).toContain('Groupe Nseya');
  });
});
