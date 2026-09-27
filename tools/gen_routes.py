"""Catalogue des routes HTTP du backend (socle et modules d'extension), généré depuis le code source.
Sortie : specs/routes-api.md. Usage : python3 tools/gen_routes.py"""
import os, re, collections
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'backend', 'src')
pat = re.compile(r"app\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*[`'\"]([^`'\"]+)[`'\"]", re.S)
rows = collections.defaultdict(list)
for dp, _, fs in os.walk(SRC):
    for f in fs:
        if not f.endswith('.ts'):
            continue
        p = os.path.join(dp, f)
        rel = os.path.relpath(p, SRC)
        parts = rel.split(os.sep)
        mod = ('module ' + parts[1]) if parts[0] == 'modules' else ('extension ' + parts[1]) if parts[0] == 'plugins' else 'socle'
        text = open(p, encoding='utf-8').read()
        # Routes déclarées dans une boucle : `for (const [x, base] of [['…', '/v1/…'], …])` et `for (const provider of CONNECTOR_IDS)`.
        loops = {}
        for lm in re.finditer(r"for \(const \[\w+, (\w+)\] of \[(.*?)\] as const\)", text, re.S):
            loops[lm.group(1)] = re.findall(r"'(/v1/[^']+)'", lm.group(2))
        if 'of CONNECTOR_IDS' in text:
            types = open(os.path.join(SRC, 'modules', 'payments', 'connectors', 'types.ts'), encoding='utf-8').read()
            loops['provider'] = re.findall(r"'(\w+)'", re.search(r"CONNECTOR_IDS = \[(.*?)\]", types).group(1))
        for m in pat.finditer(text):
            path = m.group(2)
            var = re.search(r"\$\{(\w+)\}", path)
            for v in (loops.get(var.group(1), []) if var else [None]):
                rows[mod].append((m.group(1).upper(), path.replace('${' + var.group(1) + '}', v) if var else path))
        for lm in re.finditer(r"app\.(get|post|put|patch|delete)\((\w+),", text):
            for v in loops.get(lm.group(2), []):
                rows[mod].append((lm.group(1).upper(), v))
total = sum(len(v) for v in rows.values())
out = ['# Catalogue des routes de l\'API KINSHASA MOSOLO', '',
       f'Généré depuis le code source (`tools/gen_routes.py`) : **{total} routes** dans {len(rows)} modules. '
       'Chaque route applique le point de décision des politiques (RBAC + ABAC) ; les erreurs suivent la RFC 9457. '
       'Le contrat détaillé des routes du socle figure dans `specs/openapi.yaml` et `specs/contrat-api.md` ; '
       'les règles d\'accès de chaque module d\'extension sont déclarées dans son fichier `policy.ts`.', '',
       '| Module | Routes |', '|---|---|']
for mod in sorted(rows):
    out.append(f'| {mod} | {len(rows[mod])} |')
for mod in sorted(rows):
    out += ['', f'## {mod[0].upper() + mod[1:]}', '', '| Méthode | Chemin |', '|---|---|']
    for meth, path in sorted(set(rows[mod]), key=lambda x: (x[1], x[0])):
        out.append(f'| {meth} | `{path}` |')
open(os.path.join(ROOT, 'specs', 'routes-api.md'), 'w', encoding='utf-8').write('\n'.join(out) + '\n')
print(total, {k: len(v) for k, v in sorted(rows.items())})
