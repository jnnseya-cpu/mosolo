"""Logos de la Ville de Kinshasa et de Groupe Nseya pour les documents générés par le serveur (PDF, pages légères,
exports HTML) : MISE À L'ÉCHELLE SEULE (logos non modifiés), JPEG sur fond blanc, encodés en base64.
Sortie : backend/src/core/brand-assets.ts. Usage : python3 tools/gen_brand_assets.py"""
import base64, io, os
from PIL import Image
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def jpeg(path, width, quality=88):
    im = Image.open(os.path.join(ROOT, path)).convert('RGB')
    h = round(im.height * width / im.width)
    im = im.resize((width, h), Image.LANCZOS)
    buf = io.BytesIO(); im.save(buf, 'JPEG', quality=quality, optimize=True)
    return width, h, base64.b64encode(buf.getvalue()).decode()
city = jpeg('frontend/public/logo-ville-de-kinshasa.png', 480)
nseya = jpeg('frontend/public/logo-groupe-nseya.png', 96)
# Variante légère (pages « faible débit ») : quelques kilo-octets seulement.
petit = jpeg('frontend/public/logo-ville-de-kinshasa.png', 150)
nseya_petit = jpeg('frontend/public/logo-groupe-nseya.png', 40)
# Variante minimale (pages « version légère » limitées à 10 Ko).
mini = jpeg('frontend/public/logo-ville-de-kinshasa.png', 84, 70)
out = f'''/**
 * Logos officiels pour les documents générés par le serveur (PDF, pages légères, exports HTML) — FICHIER GÉNÉRÉ par
 * tools/gen_brand_assets.py depuis frontend/public (mise à l'échelle seule : les logos ne sont jamais modifiés).
 */
export interface BrandImage {{ width: number; height: number; jpegBase64: string }}
export const LOGO_VILLE: BrandImage = {{ width: {city[0]}, height: {city[1]}, jpegBase64: '{city[2]}' }};
export const LOGO_NSEYA: BrandImage = {{ width: {nseya[0]}, height: {nseya[1]}, jpegBase64: '{nseya[2]}' }};
/** Variantes légères pour les pages « faible débit » et les exports HTML. */
export const LOGO_VILLE_PETIT: BrandImage = {{ width: {petit[0]}, height: {petit[1]}, jpegBase64: '{petit[2]}' }};
export const LOGO_VILLE_MINI: BrandImage = {{ width: {mini[0]}, height: {mini[1]}, jpegBase64: '{mini[2]}' }};
export const LOGO_NSEYA_PETIT: BrandImage = {{ width: {nseya_petit[0]}, height: {nseya_petit[1]}, jpegBase64: '{nseya_petit[2]}' }};
/** Mentions de marque communes à tous les documents générés. */
export const BRAND_TEXT = {{
  institution: 'Ville-Province de Kinshasa',
  plateforme: 'KINSHASA MOSOLO',
  realisation: 'Plateforme KINSHASA MOSOLO — réalisée par Groupe Nseya',
}} as const;
/** Adresse « data: » d'un logo (pages servies avec une politique de sécurité n'autorisant que les images data:). */
export const dataUri = (img: BrandImage) => `data:image/jpeg;base64,${{img.jpegBase64}}`;
'''
open(os.path.join(ROOT, 'backend/src/core/brand-assets.ts'), 'w').write(out)
print(city[:2], len(city[2]), nseya[:2], len(nseya[2]), len(petit[2]), len(nseya_petit[2]), len(mini[2]))
