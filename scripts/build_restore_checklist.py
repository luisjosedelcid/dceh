#!/usr/bin/env python3
"""Build RESTORE-CHECKLIST.pdf — 2-page printable disaster recovery quick reference.

DCE Brandbook: NAVY #1B2642, GOLD #B88B47, Helvetica, español.
"""
from reportlab.lib.pagesizes import letter
from reportlab.lib.colors import HexColor
from reportlab.pdfgen import canvas
from reportlab.lib.units import inch, mm

NAVY = HexColor("#1B2642")
GOLD = HexColor("#B88B47")
INK  = HexColor("#333333")
GRAY = HexColor("#666666")
LIGHT = HexColor("#f5f6fa")

W, H = letter  # 8.5 x 11 in

OUT = "/home/user/workspace/dceh/public/RESTORE-CHECKLIST.pdf"

def draw_header(c, title, subtitle, page_num, total):
    # Navy band top
    c.setFillColor(NAVY)
    c.rect(0, H - 0.85*inch, W, 0.85*inch, fill=1, stroke=0)
    # Gold rule under band
    c.setFillColor(GOLD)
    c.rect(0, H - 0.9*inch, W, 0.05*inch, fill=1, stroke=0)
    # Title
    c.setFillColor(HexColor("#FFFFFF"))
    c.setFont("Helvetica-Bold", 18)
    c.drawString(0.6*inch, H - 0.45*inch, title)
    c.setFont("Helvetica", 10)
    c.drawString(0.6*inch, H - 0.65*inch, subtitle)
    # Right-side wordmark
    c.setFont("Helvetica-Bold", 10)
    c.drawRightString(W - 0.6*inch, H - 0.45*inch, "DCE HOLDINGS")
    c.setFont("Helvetica", 8)
    c.drawRightString(W - 0.6*inch, H - 0.62*inch, "Disaster Recovery")
    c.setFont("Helvetica", 7)
    c.drawRightString(W - 0.6*inch, H - 0.75*inch, f"pág. {page_num}/{total}  ·  v1.0 · 2026-08-08")

def draw_footer(c):
    c.setStrokeColor(GOLD)
    c.setLineWidth(0.5)
    c.line(0.6*inch, 0.5*inch, W - 0.6*inch, 0.5*inch)
    c.setFillColor(GRAY)
    c.setFont("Helvetica", 7)
    c.drawString(0.6*inch, 0.35*inch, "DCE HOLDINGS — DISASTER RECOVERY CHECKLIST")
    c.drawRightString(W - 0.6*inch, 0.35*inch, "Runbook completo: dceh/RESTORE.md")

def section_header(c, x, y, text):
    """Draw gold-underlined section header."""
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(x, y, text.upper())
    c.setStrokeColor(GOLD)
    c.setLineWidth(1)
    c.line(x, y - 4, x + 1.8*inch, y - 4)

def checkbox_line(c, x, y, num, text_lines, code=None):
    """Draw a checkbox + text block starting at top y. Returns the y after drawing."""
    # Checkbox
    c.setStrokeColor(NAVY)
    c.setLineWidth(0.8)
    c.rect(x, y - 8, 9, 9, fill=0, stroke=1)
    # Step number chip
    c.setFillColor(GOLD)
    c.circle(x + 26, y - 4, 8, fill=1, stroke=0)
    c.setFillColor(HexColor("#FFFFFF"))
    c.setFont("Helvetica-Bold", 8)
    c.drawCentredString(x + 26, y - 7, str(num))
    # Text lines — draw each line with proper spacing
    text_x = x + 42
    cursor_y = y - 2  # baseline for first line
    c.setFillColor(INK)
    for (font, size, txt) in text_lines:
        c.setFont(font, size)
        c.drawString(text_x, cursor_y, txt)
        cursor_y -= size + 3
    # Code block below text
    if code:
        cursor_y -= 3
        c.setFillColor(LIGHT)
        c.rect(text_x, cursor_y - 10, W - text_x - 0.6*inch, 13, fill=1, stroke=0)
        c.setFillColor(INK)
        c.setFont("Courier", 7.5)
        c.drawString(text_x + 3, cursor_y - 7, code)
        cursor_y -= 14
    return cursor_y

def build():
    c = canvas.Canvas(OUT, pagesize=letter)
    c.setTitle("DCE Holdings - Disaster Recovery Checklist")
    c.setAuthor("Luis del Cid — DCE Holdings")

    # ─── Page 1 ─────────────────────────────────────────────────────────
    draw_header(c, "Restore end-to-end", "Guía imprimible · pega en la pared del escritorio · español", 1, 2)

    y = H - 1.25*inch

    # Overview strip
    c.setFillColor(LIGHT)
    c.rect(0.6*inch, y - 0.7*inch, W - 1.2*inch, 0.7*inch, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(0.75*inch, y - 0.15*inch, "SI PIERDES EL SITIO, SIGUE ESTOS 9 PASOS EN ORDEN")
    c.setFillColor(INK)
    c.setFont("Helvetica", 8.5)
    c.drawString(0.75*inch, y - 0.32*inch, "Tiempo total estimado: 2 a 4 horas la primera vez.")
    c.drawString(0.75*inch, y - 0.47*inch, "Necesitas: Mac, Terminal, cuentas de GitHub / Supabase / Vercel / GoDaddy, archivo GPG con passphrase.")
    c.drawString(0.75*inch, y - 0.62*inch, "En cualquier momento puedes leer el runbook completo en dceh/RESTORE.md")

    y -= 1.0*inch

    section_header(c, 0.6*inch, y, "Recursos previos")
    y -= 0.25*inch
    c.setFillColor(INK)
    c.setFont("Helvetica", 9)
    for line in [
        "•  Mac con Terminal, node, git, curl, jq, tar.",
        "•  Cuenta Vercel (vercel.com/luisjosedelcid) — puedes reusar el proyecto existente o crear uno nuevo.",
        "•  Cuenta Supabase (supabase.com) — proyecto original o uno nuevo en eu-west-1 · plan Pro.",
        "•  Cuenta GoDaddy — para actualizar DNS de dceholdings.app.",
        "•  Archivo GPG: ~/dce-secrets/secrets.env.gpg  +  passphrase (password manager).",
    ]:
        c.drawString(0.75*inch, y, line)
        y -= 0.16*inch

    y -= 0.1*inch

    section_header(c, 0.6*inch, y, "Los 9 pasos")
    y -= 0.32*inch

    steps = [
        (1, [("Helvetica-Bold", 9, "Descargar el snapshot más reciente"),
             ("Helvetica", 8, "Clonar dceh-backups, extraer el .tar.gz más nuevo en ~/dce-restore/restore-work/")],
         "git clone https://github.com/luisjosedelcid/dceh-backups && tar -xzf snapshots/YYYY-MM-DD/dr-*.tar.gz"),

        (2, [("Helvetica-Bold", 9, "Crear proyecto Supabase nuevo (si el actual está muerto)"),
             ("Helvetica", 8, "supabase.com → New Project → region eu-west-1 → plan Pro → guardar URL + service key + DB URI")],
         None),

        (3, [("Helvetica-Bold", 9, "Aplicar schema (migrations)"),
             ("Helvetica", 8, "Correr todos los .sql en dceh/supabase/migrations/ contra el nuevo TARGET_DB_URL")],
         "for f in dceh/supabase/migrations/*.sql; do psql \"$TARGET_DB_URL\" -f \"$f\"; done"),

        (4, [("Helvetica-Bold", 9, "Restaurar datos y archivos"),
             ("Helvetica", 8, "Correr dr-restore-full.sh con --execute apuntando al nuevo Supabase")],
         "./dceh/scripts/dr-restore-full.sh --snapshot ./dr-snapshot-... --skip-schema --execute"),

        (5, [("Helvetica-Bold", 9, "Restaurar secretos desde GPG"),
             ("Helvetica", 8, "Desencriptar secrets.env.gpg y pegar variables en Vercel. Borrar el .env sin cifrar al terminar.")],
         "gpg --decrypt ~/dce-secrets/secrets.env.gpg > /tmp/secrets.env  # BORRAR después"),

        (6, [("Helvetica-Bold", 9, "Redeploy en Vercel"),
             ("Helvetica", 8, "git push origin main O importar el repo desde vercel.com/new si el proyecto no existe")],
         "vercel --prod   (o solo git push main)"),

        (7, [("Helvetica-Bold", 9, "DNS en GoDaddy"),
             ("Helvetica", 8, "godaddy.com → Domains → dceholdings.app → DNS → apuntar a Vercel")],
         "A @ = 76.76.21.21   ·   CNAME www = cname.vercel-dns.com"),

        (8, [("Helvetica-Bold", 9, "Smoke tests"),
             ("Helvetica", 8, "Verificar que endpoints y páginas responden, luego login y verificar datos.")],
         "curl -sI https://www.dceholdings.app/   →  200"),

        (9, [("Helvetica-Bold", 9, "Post-restore"),
             ("Helvetica", 8, "Generar snapshot inmediato del nuevo entorno + actualizar RESTORE.md.")],
         None),
    ]

    for step_num, lines, code in steps:
        y = checkbox_line(c, 0.6*inch, y, step_num, lines, code=code)
        y -= 6

    draw_footer(c)
    c.showPage()

    # ─── Page 2 ─────────────────────────────────────────────────────────
    draw_header(c, "Anatomía y contingencias", "Componentes · escenarios parciales · contactos", 2, 2)

    y = H - 1.25*inch

    section_header(c, 0.6*inch, y, "5 componentes del sitio")
    y -= 0.30*inch

    components = [
        ("1", "CÓDIGO",     "GitHub luisjosedelcid/dceh",       "Restore: git clone. Ya está en GitHub, no puedes perderlo (excepto que GitHub caiga)."),
        ("2", "BASE DE DATOS", "Supabase Postgres",              "Restore: automático desde snapshot."),
        ("3", "ARCHIVOS",   "Supabase Storage · bucket dataroom","Restore: automático desde snapshot."),
        ("4", "SECRETOS",   "Vercel env vars",                   "Restore: MANUAL desde ~/dce-secrets/secrets.env.gpg (único paso humano)."),
        ("5", "DOMINIO",    "GoDaddy · dceholdings.app",         "Restore: actualizar DNS. Renovar cada año."),
    ]

    for num, name, home, note in components:
        # Number chip
        c.setFillColor(GOLD)
        c.circle(0.75*inch, y + 4, 9, fill=1, stroke=0)
        c.setFillColor(HexColor("#FFFFFF"))
        c.setFont("Helvetica-Bold", 9)
        c.drawCentredString(0.75*inch, y + 1, num)
        # Name
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 9.5)
        c.drawString(1.0*inch, y + 3, name)
        # Home
        c.setFillColor(INK)
        c.setFont("Helvetica-Oblique", 8.5)
        c.drawString(2.4*inch, y + 3, home)
        # Note
        c.setFillColor(GRAY)
        c.setFont("Helvetica", 8)
        c.drawString(1.0*inch, y - 9, note)
        y -= 0.42*inch

    y -= 0.1*inch

    section_header(c, 0.6*inch, y, "Escenarios parciales")
    y -= 0.30*inch

    scenarios = [
        ("A", "Solo se perdió la DB",         "Corre pasos 1, 2, 3, 4 (con --skip-storage), 6, 8. Tiempo: 30-60 min."),
        ("B", "Solo se perdieron los archivos","Corre pasos 1, 4 (con --skip-schema), 8. Tiempo: 15 min."),
        ("C", "Catástrofe total",             "Corre los 9 pasos completos. Tiempo: 2-4 h."),
        ("D", "Perdiste el dominio",          "GoDaddy soporte 24/7. Si es catastrófico: comprar en otro registrar."),
    ]

    for letter_id, title, action in scenarios:
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 9.5)
        c.drawString(0.75*inch, y, f"[{letter_id}]  {title}")
        c.setFillColor(GRAY)
        c.setFont("Helvetica", 8.5)
        c.drawString(1.05*inch, y - 12, action)
        y -= 0.35*inch

    y -= 0.1*inch

    section_header(c, 0.6*inch, y, "Fire drill · simulacro trimestral")
    y -= 0.28*inch

    c.setFillColor(INK)
    c.setFont("Helvetica", 8.5)
    c.drawString(0.75*inch, y, "1.  Abrir dceholdings.app/settings.html → Sistema → Disaster Recovery.")
    y -= 0.16*inch
    c.drawString(0.75*inch, y, "2.  Botón \"Correr simulacro (fire drill)\".")
    y -= 0.16*inch
    c.drawString(0.75*inch, y, "3.  Confirmar. Espera 30-60s. Verifica que el resultado sea 'success' o 'partial' sin errores.")
    y -= 0.16*inch
    c.drawString(0.75*inch, y, "4.  Si el simulacro falla, NO ES OPCIONAL arreglarlo antes de seguir. Es tu única señal.")
    y -= 0.24*inch

    section_header(c, 0.6*inch, y, "Contactos de emergencia")
    y -= 0.28*inch

    c.setFillColor(INK)
    c.setFont("Helvetica", 8.5)
    contacts = [
        "Supabase soporte:    support@supabase.io  ·  status.supabase.com",
        "Vercel soporte:      vercel.com/help  ·  status.vercel.com",
        "GoDaddy soporte:     godaddy.com/help  ·  24/7 chat + phone",
        "GitHub soporte:      github.com/support",
    ]
    for line in contacts:
        c.drawString(0.75*inch, y, line)
        y -= 0.16*inch

    y -= 0.15*inch

    # Bottom warning box
    c.setFillColor(GOLD)
    c.rect(0.6*inch, y - 0.6*inch, W - 1.2*inch, 0.6*inch, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 10)
    c.drawString(0.75*inch, y - 0.18*inch, "REGLA DE ORO")
    c.setFont("Helvetica", 9)
    c.drawString(0.75*inch, y - 0.34*inch, "Un backup que nunca has restaurado NO ES UN BACKUP — es una esperanza.")
    c.drawString(0.75*inch, y - 0.48*inch, "El fire drill trimestral es la única evidencia de que este runbook funciona.")

    draw_footer(c)
    c.showPage()

    c.save()
    print(f"Wrote {OUT}")

if __name__ == "__main__":
    build()
