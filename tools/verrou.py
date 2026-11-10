#!/usr/bin/env python3
"""KINSHASA MOSOLO — verrou de non-régression (règle n° 1 de CLAUDE.md : on ajoute, on ne retire jamais).

Inventaire de tout ce qui a été construit (routes d'API, écrans, menus, modules, contrôles = codes d'erreur, tests,
agents d'IA, articles, rôles, décisions, sections du document maître, fichiers suivis) comparé au relevé de
référence `verrou/inventaire.json`. Un élément de référence absent arrête le contrôle : rien ne disparaît en silence.

  python3 tools/verrou.py              contrôle (défaut ; utilisé par `npm test` et la CI)
  python3 tools/verrou.py --ajouter    ajoute au relevé les nouveaux éléments (n'en retire JAMAIS aucun)
  python3 tools/verrou.py --retirer CATEGORIE ELEMENT --motif "..." --decision "..."
                                       retrait explicite d'un élément, décidé par le maître d'ouvrage : retiré du
                                       relevé ET consigné dans verrou/retraits.md (qui, quand, pourquoi)

Un renommage est un retrait suivi d'un ajout : il passe donc par --retirer (avec motif), jamais en silence.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
from pathlib import Path

RACINE = Path(__file__).resolve().parent.parent
RELEVE = RACINE / 'verrou' / 'inventaire.json'
RETRAITS = RACINE / 'verrou' / 'retraits.md'


def lire(chemin: str | Path) -> str:
    return (RACINE / chemin).read_text(encoding='utf-8')


def fichiers(motif: str) -> list[Path]:
    return sorted(p for p in RACINE.glob(motif) if 'node_modules' not in p.parts and 'dist' not in p.parts)


def fichiers_suivis() -> list[str]:
    sortie = subprocess.run(['git', 'ls-files'], cwd=RACINE, capture_output=True, text=True, check=True).stdout
    return sorted(l for l in sortie.splitlines() if l and l != 'verrou/inventaire.json')


def routes_api() -> set[str]:
    # Catalogue généré depuis le code (tools/gen_routes.py, contrôlé à jour par la CI).
    return set(f'{m} {p}' for m, p in re.findall(r'^\| (GET|POST|PUT|PATCH|DELETE) \| `([^`]+)` \|', lire('specs/routes-api.md'), re.M))


def ecrans() -> set[str]:
    reg = lire('frontend/src/modules/registry.tsx')
    app = lire('frontend/src/App.tsx')
    return set(re.findall(r"\bpath: '([^']+)'", reg)) | set(re.findall(r'\bpath="([^"]+)"', app))


def menus() -> set[str]:
    reg = lire('frontend/src/modules/registry.tsx')
    return set(re.findall(r"nav: \{ label: '((?:[^'\\]|\\.)*)'", reg))


def modules_serveur() -> set[str]:
    index = lire('backend/src/plugins/index.ts')
    bloc = index.split('export const DEFAULT_PLUGINS', 1)[1].split('];', 1)[0]
    bloc = re.sub(r'//[^\n]*', '', bloc)
    return set(re.findall(r'\b([a-z]\w*Plugin)\b', bloc))


def codes_controle() -> set[str]:
    # Chaque code d'erreur porte un contrôle (anti-fraude, droits, règles) : il ne doit pas disparaître.
    codes: set[str] = set()
    for f in fichiers('backend/src/**/*.ts'):
        codes |= set(re.findall(r'\b(?:badRequest|unauthorized|forbidden|notFound|conflict|unprocessable)\(\s*\'([A-Z0-9_]+)\'', f.read_text(encoding='utf-8')))
    return codes


def tests() -> set[str]:
    titres: set[str] = set()
    for motif in ('backend/test/**/*.test.ts', 'frontend/test/**/*.test.ts*', 'shared/test/**/*.test.ts', 'shared/src/**/*.test.ts'):
        for f in fichiers(motif):
            rel = f.relative_to(RACINE).as_posix()
            for _, titre in re.findall(r'\b(?:it|test)(?:\.each\([^)]*\))?\(\s*([\'"`])(.*?)\1\s*,', f.read_text(encoding='utf-8')):
                titres.add(f'{rel} :: {titre}')
    return titres


def agents_ia() -> set[str]:
    codes = set(re.findall(r"code: '([A-Z_]+)'", lire('backend/src/plugins/ia/catalogue.ts')))
    return codes | set(re.findall(r"code: '([A-Z_]+)'", lire('backend/src/plugins/agents-recettes/model.ts')))


def articles_blog() -> set[str]:
    return set(re.findall(r"\bslug: '([^']+)'", lire('frontend/src/pages/blog/articles.ts')))


def roles() -> set[str]:
    return set(re.findall(r'\b(R\d\d): ', lire('shared/src/domain.ts')))


def actions_ia_interdites() -> set[str]:
    return set(re.findall(r"'([A-Z][A-Z_]{4,})'", lire('shared/src/ai.ts')))


def variables_console() -> set[str]:
    texte = lire('backend/src/modules/integrations/inventory.ts')
    return set(re.findall(r"\bname: '([A-Z][A-Z0-9_]+)'", texte)) | set(re.findall(r"\benv\('([A-Z][A-Z0-9_]+)'", texte))


def sections_document_maitre() -> set[str]:
    titres: set[str] = set()
    for f in fichiers('docs/document-maitre/*.md'):
        for t in re.findall(r'^#{1,4} (.+?)\s*$', f.read_text(encoding='utf-8'), re.M):
            titres.add(f'{f.name} :: {t}')
    return titres


def decisions() -> set[str]:
    return set(re.findall(r'^\s*- \*\*(.+?)\*\*', lire('CLAUDE.md'), re.M))


CATEGORIES = {
    'routes_api': routes_api,
    'ecrans': ecrans,
    'menus': menus,
    'modules_serveur': modules_serveur,
    'codes_controle': codes_controle,
    'tests': tests,
    'agents_ia': agents_ia,
    'actions_ia_interdites': actions_ia_interdites,
    'articles_blog': articles_blog,
    'roles': roles,
    'variables_console': variables_console,
    'sections_document_maitre': sections_document_maitre,
    'decisions_claude_md': decisions,
    'fichiers': lambda: set(fichiers_suivis()),
}


def inventaire() -> dict[str, set[str]]:
    return {nom: fonction() for nom, fonction in CATEGORIES.items()}


def charger() -> dict[str, list[str]]:
    if not RELEVE.exists():
        return {}
    return json.loads(RELEVE.read_text(encoding='utf-8'))['categories']


def ecrire(categories: dict[str, set[str] | list[str]]) -> None:
    RELEVE.parent.mkdir(exist_ok=True)
    doc = {
        'regle': "Règle n° 1 (CLAUDE.md) : on ajoute, on ne retire jamais. Relevé maintenu par tools/verrou.py ; "
                 "aucun élément n'en sort sans --retirer, motif et décision, consignés dans verrou/retraits.md.",
        'totaux': {k: len(v) for k, v in sorted(categories.items())},
        'categories': {k: sorted(v) for k, v in sorted(categories.items())},
    }
    RELEVE.write_text(json.dumps(doc, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')


def controler() -> int:
    reference = charger()
    if not reference:
        print('verrou : aucun relevé de référence (verrou/inventaire.json) — lancer « python3 tools/verrou.py --ajouter ».')
        return 1
    actuel = inventaire()
    manquants = {k: sorted(set(v) - actuel.get(k, set())) for k, v in reference.items()}
    manquants = {k: v for k, v in manquants.items() if v}
    nouveaux = sum(len(v - set(reference.get(k, []))) for k, v in actuel.items())
    if manquants:
        print('VERROU : des éléments existants ont disparu (règle n° 1 : rien ne se retire en silence).')
        for k, v in manquants.items():
            print(f'\n  {k} — {len(v)} manquant(s) :')
            for e in v[:50]:
                print(f'    - {e}')
            if len(v) > 50:
                print(f'    … et {len(v) - 50} autre(s)')
        print('\nRétablir ces éléments, ou, sur décision du maître d\'ouvrage seulement :')
        print('  python3 tools/verrou.py --retirer CATEGORIE "ELEMENT" --motif "…" --decision "…"')
        return 1
    total = sum(len(v) for v in reference.values())
    print(f'verrou : {total} éléments de référence tous présents ({len(reference)} catégories).')
    if nouveaux:
        print(f'verrou : {nouveaux} élément(s) nouveau(x) hors relevé — « python3 tools/verrou.py --ajouter » pour les verrouiller.')
    return 0


def ajouter() -> int:
    reference = {k: set(v) for k, v in charger().items()}
    actuel = inventaire()
    fusion = {k: reference.get(k, set()) | actuel.get(k, set()) for k in set(reference) | set(actuel)}
    ajoutes = sum(len(fusion[k]) - len(reference.get(k, set())) for k in fusion)
    ecrire(fusion)
    print(f'verrou : {ajoutes} élément(s) ajouté(s) au relevé ; aucun retiré.')
    return controler()


def retirer(categorie: str, element: str, motif: str, decision: str) -> int:
    if len(motif.strip()) < 10 or len(decision.strip()) < 5:
        print('verrou : un retrait exige un motif (10 caractères au moins) et la référence de la décision du maître d\'ouvrage.')
        return 1
    reference = {k: set(v) for k, v in charger().items()}
    if element not in reference.get(categorie, set()):
        print(f'verrou : « {element} » ne figure pas dans la catégorie {categorie}.')
        return 1
    reference[categorie].discard(element)
    ecrire(reference)
    if not RETRAITS.exists():
        RETRAITS.write_text('# Retraits explicites du verrou de non-régression\n\nChaque ligne : date, catégorie, élément, motif, décision.\n\n'
                            '| Date | Catégorie | Élément | Motif | Décision |\n|---|---|---|---|---|\n', encoding='utf-8')
    with RETRAITS.open('a', encoding='utf-8') as f:
        f.write(f'| {dt.date.today().isoformat()} | {categorie} | {element.replace("|", "/")} | {motif.replace("|", "/")} | {decision.replace("|", "/")} |\n')
    print(f'verrou : « {element} » retiré de {categorie} et consigné dans verrou/retraits.md.')
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--ajouter', action='store_true')
    p.add_argument('--retirer', nargs=2, metavar=('CATEGORIE', 'ELEMENT'))
    p.add_argument('--motif', default='')
    p.add_argument('--decision', default='')
    a = p.parse_args()
    if a.retirer:
        return retirer(a.retirer[0], a.retirer[1], a.motif, a.decision)
    return ajouter() if a.ajouter else controler()


if __name__ == '__main__':
    sys.exit(main())
