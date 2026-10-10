# python3 build-pdf.py: pilot-services-agreement.md → pilot-services-agreement.pdf (reportlab), a FICTIONAL contract
# for the contract-review demonstration. Every page carries the FICTIONAL label and "Page N of M".
# python3 build-pdf.py <ref> <out.pdf>: a copy whose first page carries "Agreement reference: <ref>" (a per-run scan marker).
import pathlib, re, sys
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

here = pathlib.Path(__file__).parent
src, out = here / "pilot-services-agreement.md", pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else here / "pilot-services-agreement.pdf"
ss = getSampleStyleSheet()

def story():
    s = []
    for block in src.read_text().strip().split("\n\n"):
        if block.startswith("# "): s += [Paragraph(block[2:], ss["Title"])] + ([Paragraph(f"Agreement reference: {sys.argv[1]}", ss["BodyText"])] if len(sys.argv) > 1 else [])
        elif block.startswith("## "): s += [Spacer(0, 6), Paragraph(block[3:], ss["Heading3"])]
        else: s += [Paragraph(re.sub(r"&", "&amp;", block), ss["BodyText"]), Spacer(0, 3)]
    return s

def build(total):
    def page(c, d):
        c.saveState(); c.setFont("Helvetica-Bold", 9)
        c.drawCentredString(letter[0] / 2, letter[1] - 40, "FICTIONAL DOCUMENT FOR DEMONSTRATION ONLY. Not a real agreement; all parties and addresses are invented.")
        c.setFont("Helvetica", 9); c.drawCentredString(letter[0] / 2, 30, f"Page {d.page} of {total}"); c.restoreState()
    doc = SimpleDocTemplate(str(out), pagesize=letter, topMargin=64, bottomMargin=54, title="Pilot Services Agreement (FICTIONAL)")
    doc.build(story(), onFirstPage=page, onLaterPages=page)
    return doc.page

n = build(0)
assert build(n) == n
print(f"{out.name}: {n} pages")
