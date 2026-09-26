#!/usr/bin/env python3
"""Assemble le document maître (Markdown) et produit la version Word aux couleurs de la charte.

Étapes :
 1. concatène docs/document-maitre/NN-*.md dans l'ordre ;
 2. rend chaque bloc Mermaid en PNG (thème de marque) via mermaid-cli (mmdc) ;
 3. convertit en .docx avec pandoc (pypandoc) et un modèle de styles de marque ;
 4. met en forme les tableaux (en-tête teal, lignes alternées), ajoute le logo en en-tête et le pied de page.

Prérequis : pip install pypandoc_binary python-docx ; mermaid-cli (variable d'environnement MMDC
pointant vers l'exécutable mmdc, et PUPPETEER_CONFIG vers un fichier {"executablePath": "...chrome"}).
"""
import hashlib, json, os, re, subprocess, sys, tempfile

import pypandoc
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt, RGBColor, Mm

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "document-maitre")
FIG = os.path.join(SRC, "figures", "mermaid")
OUT_MD = os.path.join(ROOT, "docs", "KINSHASA_MOSOLO_Document_Maitre_v3.0.md")
OUT_DOCX = os.path.join(ROOT, "docs", "KINSHASA_MOSOLO_Document_Maitre_v3.0.docx")
LOGO_VILLE = os.path.join(ROOT, "docs", "assets", "logo-ville-de-kinshasa.png")
LOGO_NSEYA = os.path.join(ROOT, "docs", "assets", "logo-groupe-nseya.png")
LOGO = LOGO_VILLE if os.path.exists(LOGO_VILLE) else None

# Charte Ville de Kinshasa (noms historiques conservés) : TEAL = bleu drapeau, TEAL_DARK = marine de l'écu
TEAL, TEAL_DARK, INK, INK2, PALE, LIGHT = "1E9BD7", "232C6B", "111111", "4A4F5C", "E9EDF7", "F5F7FB"
HEADER_FILL = "232C6B"

MERMAID_CONFIG = {
    "theme": "base",
    "themeVariables": {
        "primaryColor": "#E9EDF7", "primaryBorderColor": "#232C6B", "primaryTextColor": "#111111",
        "secondaryColor": "#FFF6D1", "tertiaryColor": "#F5F7FB", "lineColor": "#232C6B",
        "fontFamily": "DejaVu Sans, Arial, sans-serif", "fontSize": "15px",
        "clusterBkg": "#F5F7FB", "clusterBorder": "#1E9BD7", "edgeLabelBackground": "#FFFFFF",
        "actorBkg": "#E9EDF7", "actorBorder": "#232C6B", "signalColor": "#232C6B", "noteBkgColor": "#FFF6D1",
    },
}


def concat() -> str:
    files = sorted(f for f in os.listdir(SRC) if re.match(r"^\d\d[a-z]?-.*\.md$", f))
    parts = []
    for f in files:
        txt = open(os.path.join(SRC, f), encoding="utf-8").read()
        if f.startswith("00-"):
            txt = re.sub(r"^---\n.*?\n---\n", "", txt, flags=re.S)  # front matter géré par pandoc
        parts.append(txt.strip())
    return "\n\n".join(parts) + "\n"


def render_mermaid(md: str) -> str:
    os.makedirs(FIG, exist_ok=True)
    mmdc = os.environ.get("MMDC", "mmdc")
    cfg = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
    json.dump(MERMAID_CONFIG, cfg)
    cfg.close()
    pconf = os.environ.get("PUPPETEER_CONFIG")

    def repl(m: re.Match) -> str:
        code = m.group(1)
        h = hashlib.sha1(code.encode()).hexdigest()[:12]
        png = os.path.join(FIG, f"mmd-{h}.png")
        if not os.path.exists(png):
            with tempfile.NamedTemporaryFile("w", suffix=".mmd", delete=False) as t:
                t.write(code)
            cmd = [mmdc, "-i", t.name, "-o", png, "-s", "2", "-b", "white", "-c", cfg.name]
            if pconf:
                cmd += ["-p", pconf]
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0 or not os.path.exists(png):
                print("Échec Mermaid :", r.stderr[:400], file=sys.stderr)
                return m.group(0)
        return f"![](figures/mermaid/{os.path.basename(png)})"

    return re.sub(r"```mermaid\n(.*?)```", repl, md, flags=re.S)


def reference_docx(path: str) -> None:
    data = subprocess.run([pypandoc.get_pandoc_path(), "--print-default-data-file", "reference.docx"],
                          capture_output=True, check=True).stdout
    open(path, "wb").write(data)
    d = Document(path)
    st = d.styles
    for name in ("Normal", "Body Text", "First Paragraph", "Compact"):
        if name in [s.name for s in st]:
            s = st[name]
            s.font.name = "Calibri"
            s.font.size = Pt(10.5)
            s.font.color.rgb = RGBColor.from_string(INK)
    for lvl, (size, color) in {1: (20, TEAL_DARK), 2: (15, TEAL), 3: (12.5, TEAL_DARK), 4: (11.5, INK)}.items():
        s = st[f"Heading {lvl}"]
        s.font.name = "Calibri"
        s.font.size = Pt(size)
        s.font.bold = True
        s.font.color.rgb = RGBColor.from_string(color)
    for name in ("Title",):
        s = st[name]
        s.font.color.rgb = RGBColor.from_string(TEAL_DARK)
        s.font.size = Pt(30)
    for name in ("Subtitle",):
        s = st[name]
        s.font.color.rgb = RGBColor.from_string(TEAL)
    if "Block Text" in [s.name for s in st]:
        st["Block Text"].font.color.rgb = RGBColor.from_string(TEAL_DARK)
    for sec in d.sections:
        sec.page_width, sec.page_height = Mm(210), Mm(297)
        sec.left_margin = sec.right_margin = Mm(20)
    d.save(path)


def shade(cell, hexcolor: str) -> None:
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hexcolor)
    # ordre du schéma OOXML : w:shd précède noWrap, tcMar, textDirection, tcFitText, vAlign, hideMark
    for old in tcPr.findall(qn("w:shd")):
        tcPr.remove(old)
    after = [tcPr.find(qn(f"w:{t}")) for t in ("noWrap", "tcMar", "textDirection", "tcFitText", "vAlign", "hideMark")]
    after = [e for e in after if e is not None]
    if after:
        after[0].addprevious(shd)
    else:
        tcPr.append(shd)


def borders(table) -> None:
    tblPr = table._tbl.tblPr
    b = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        e = OxmlElement(f"w:{edge}")
        e.set(qn("w:val"), "single")
        e.set(qn("w:sz"), "4")
        e.set(qn("w:color"), "CFE9E4")
        b.append(e)
    # ordre du schéma : tblBorders précède shd, tblLayout, tblCellMar, tblLook, tblCaption, tblDescription
    for old in tblPr.findall(qn("w:tblBorders")):
        tblPr.remove(old)
    after = [tblPr.find(qn(f"w:{t}")) for t in ("shd", "tblLayout", "tblCellMar", "tblLook", "tblCaption", "tblDescription")]
    after = [e for e in after if e is not None]
    if after:
        after[0].addprevious(b)
    else:
        tblPr.append(b)


def post_process(path: str) -> None:
    d = Document(path)
    for table in d.tables:
        borders(table)
        for i, row in enumerate(table.rows):
            for cell in row.cells:
                if i == 0:
                    shade(cell, HEADER_FILL)
                    for p in cell.paragraphs:
                        for r in p.runs:
                            r.font.bold = True
                            r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
                elif i % 2 == 0:
                    shade(cell, LIGHT)
                for p in cell.paragraphs:
                    for r in p.runs:
                        r.font.size = Pt(8.5)
    for sec in d.sections:
        hp = sec.header.paragraphs[0] if sec.header.paragraphs else sec.header.add_paragraph()
        hp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
        if LOGO:
            hp.add_run().add_picture(LOGO, height=Mm(11))  # logo officiel inchangé, simplement mis à l'échelle
        rr = hp.add_run("   KINSHASA MOSOLO — Document maître v3.0")
        rr.font.size = Pt(8)
        rr.font.color.rgb = RGBColor.from_string(TEAL_DARK)
        fp = sec.footer.paragraphs[0] if sec.footer.paragraphs else sec.footer.add_paragraph()
        fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = fp.add_run("« Une ville, un contribuable, une donnée, une quittance. » — Document de travail soumis à validation juridique — page ")
        r.font.size = Pt(7.5)
        r.font.color.rgb = RGBColor.from_string(INK2)
        for tag, text in (("begin", None), (None, "PAGE"), ("end", None)):
            run = fp.add_run()
            run.font.size = Pt(7.5)
            if tag:
                fc = OxmlElement("w:fldChar")
                fc.set(qn("w:fldCharType"), tag)
                run._r.append(fc)
            else:
                it = OxmlElement("w:instrText")
                it.set(qn("xml:space"), "preserve")
                it.text = text
                run._r.append(it)
    d.save(path)


def main() -> None:
    md = concat()
    open(OUT_MD, "w", encoding="utf-8").write(md)
    md_img = render_mermaid(md)
    with tempfile.TemporaryDirectory() as tmp:
        ref = os.path.join(tmp, "reference.docx")
        reference_docx(ref)
        src = os.path.join(SRC, "_build.md")
        open(src, "w", encoding="utf-8").write(md_img)
        try:
            pypandoc.convert_file(
                src, "docx", outputfile=OUT_DOCX,
                extra_args=[f"--reference-doc={ref}", f"--resource-path={SRC}:{ROOT}/docs", "--toc", "--toc-depth=2",
                            "-M", "title=KINSHASA MOSOLO — Document maître unique",
                            "-M", "subtitle=Système d'exploitation souverain de maximisation des recettes de la Ville Province de Kinshasa",
                            "-M", "lang=fr-FR", "-M", "toc-title=Table des matières"],
            )
        finally:
            os.remove(src)
    post_process(OUT_DOCX)
    print(OUT_DOCX, os.path.getsize(OUT_DOCX) // 1024, "Ko")


if __name__ == "__main__":
    main()
