# DCE Holdings — Backlog
_Última actualización: 30 abril 2026_

---

## ✅ Cerrado recientemente
- **Earnings calendar automation** — cron Finnhub + alertas email + endpoint `/api/earnings` + widget home
- **Fintel idea generation** — vista "New Buys" en Superinvestors + auth migrada a `x-admin-token`
- **Unify bkng.html / bkng-legacy.html** — borrados (eran idénticos), `/bkng` redirige a `/company.html?ticker=BKNG`
- **`ALERT_EMAIL_TO` + `ALERT_EMAIL_FROM`** configurados en Vercel env (30 abril)
- **Smoke test earnings end-to-end** — Finnhub→Supabase→email validado con evento de prueba (30 abril)

---

## 🔴 Crítico (bloqueantes operativos)

1. **DNS Wix → Cloudflare** + verificar dominio `dceholdings.com` en Resend.
   _Mientras tanto los emails salen desde `onboarding@resend.dev` (sin DKIM propio → riesgo spam)._
   _Tras migrar: cambiar `ALERT_EMAIL_FROM` a `DCE Reporting <reports@dceholdings.com>`._

---

## 🔐 Seguridad

4. Rotar `SUPABASE_SERVICE_ROLE_KEY`.
5. Crear segundo admin user (analista) bcrypted en `admin_users`.

---

## 🎯 CIO Layer — Disciplina de inversión (NUEVO, alta prioridad)

_Lo que diferencia "tener procesos" de "tomar mejores decisiones". Lo más importante después del crítico._

6. **Portfolio Cockpit** (one-pager diario)
   - Vista única en `/` con KPIs en frío en 30 segundos
   - Exposure: % por posición, geografía, moneda (EUR/USD), sector
   - P&L: hoy / semana / mes / YTD / desde inception, vs S&P 500 y MSCI World
   - Drawdown actual vs máximo histórico (por posición y cartera)
   - Action items: alertas activas, earnings <7d, theses stale, news con sentiment fuerte
   - **Test de éxito**: poder justificar la cartera en 10 min ante un comité

7. **Performance tracking real**
   - Time-Weighted Return (TWR) e IRR realizado
   - Attribution por posición (cuánto aportó cada una al retorno total)
   - Tabla de transacciones con cost basis, lotes, holding periods
   - Gains realizadas vs no realizadas
   - Cash management: saldo disponible, dividendos cobrados, FX EUR/USD

8. **Re-underwriting trimestral forzado**
   - Cron cada 90 días marca cada thesis como "stale" en el journal
   - Form obligatorio con 3 preguntas:
     - ¿La tesis original sigue intacta?
     - ¿Qué cambió en el negocio/sector?
     - ¿Comprarías hoy a este precio si no tuvieras la posición?
   - Si no respondes en 14 días → alerta email
   - _Separa convicción real de inercia emocional_

9. **Pre-mortem & kill criteria por posición**
   - Para BKNG y SAP (y futuras): escribir explícitamente
     - 3 condiciones que invalidarían la tesis (no precio — fundamentos)
     - Precio máximo al que añadirías
     - Precio al que recortarías
     - Tiempo máximo sin materialización antes de revisar
   - Vive en `/company.html?ticker=X` o `/journal`
   - _30 min de trabajo, evita decisiones emocionales el día que toca_

10. **Watchlist formal con scoring**
    - Pasar de `price_alerts` (alertas sueltas) a un pipeline real
    - Cada idea con: fase del proceso (raw → researching → modeled → tracked → invested), score Columbia preliminar, fecha primera revisión, próxima acción
    - Dashboard de "ideas en cola" en `/screener` o nueva pestaña

---

## 📦 Funcional pendiente (post-CIO layer)

11. **Slack notifications** — price alerts + earnings + journal reviews al canal
12. **Twitter → Idea Feed v2** — ingestar tweets de cuentas curadas como ideas
13. **Substack forwarding** — reenviar newsletters a un buzón y parsearlas
14. **Cmd+K PDF index** — búsqueda full-text dentro de los PDFs de `/reporting`
15. **Decision Journal UI** — interfaz para escribir/revisar entradas en lugar de solo cron
16. **Responsive mobile** — home, calendar, search (assets `responsive_*` en backlog)
17. **3rd company coverage** — añadir tercera empresa al portafolio cubierto (hoy solo BKNG + SAP)

---

## 📝 Notas de orden

- **Mañana**: cerrar primero el crítico (#1-3) antes de tocar nada más.
- **Después del crítico**: ataca el bloque CIO (#6-10) en este orden — Cockpit → Performance → Re-underwriting → Pre-mortem → Watchlist.
- **#17 (3ra empresa)**: tentación natural pero esperar. _Tener 2 bien analizadas > 10 a medias._
- **No invertir más en**: nuevas fuentes de datos (Finnhub + Fintel + Claude + news es suficiente) ni en frontend extra hasta que el bloque CIO esté en pie.

---

## La pregunta del CIO

> ¿El sistema te está ayudando a **tomar mejores decisiones**, o solo a **tener mejores procesos**?

Si la respuesta hoy es "lo segundo", el bloque CIO (#6-10) es la prioridad real, no más features.
