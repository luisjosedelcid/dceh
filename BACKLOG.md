# DCE Holdings — Backlog
_Última actualización: 30 abril 2026 (PM)_

---

## ✅ Cerrado recientemente
- **Earnings calendar automation** — cron Finnhub + alertas email + endpoint `/api/earnings` + widget home
- **Fintel idea generation** — vista "New Buys" en Superinvestors + auth migrada a `x-admin-token`
- **Unify bkng.html / bkng-legacy.html** — borrados (eran idénticos), `/bkng` redirige a `/company.html?ticker=BKNG`
- **`ALERT_EMAIL_TO` + `ALERT_EMAIL_FROM`** configurados en Vercel env (30 abril)
- **Smoke test earnings end-to-end** — Finnhub→Supabase→email validado con evento de prueba (30 abril)
- **Resend cuenta dedicada DCE** — nueva cuenta con `luis@dceholdings.com`, API key rotada en Vercel, emails llegan al inbox de trabajo (30 abril)

---

## 🔴 Crítico (bloqueantes operativos)

_— Sin items críticos abiertos. Los crons funcionan, los emails llegan. —_

---

## 🔐 Seguridad

1. Rotar `SUPABASE_SERVICE_ROLE_KEY`.
2. Crear segundo admin user (analista) bcrypted en `admin_users`.

---

## 🎯 CIO Layer — Disciplina de inversión (NUEVO, alta prioridad)

_Lo que diferencia "tener procesos" de "tomar mejores decisiones". Lo más importante después del crítico._

3. **Portfolio Cockpit** (one-pager diario)
   - Vista única en `/` con KPIs en frío en 30 segundos
   - Exposure: % por posición, geografía, moneda (EUR/USD), sector
   - P&L: hoy / semana / mes / YTD / desde inception, vs S&P 500 y MSCI World
   - Drawdown actual vs máximo histórico (por posición y cartera)
   - Action items: alertas activas, earnings <7d, theses stale, news con sentiment fuerte
   - **Test de éxito**: poder justificar la cartera en 10 min ante un comité

4. **Performance tracking real**
   - Time-Weighted Return (TWR) e IRR realizado
   - Attribution por posición (cuánto aportó cada una al retorno total)
   - Tabla de transacciones con cost basis, lotes, holding periods
   - Gains realizadas vs no realizadas
   - Cash management: saldo disponible, dividendos cobrados, FX EUR/USD

5. **Re-underwriting trimestral forzado**
   - Cron cada 90 días marca cada thesis como "stale" en el journal
   - Form obligatorio con 3 preguntas:
     - ¿La tesis original sigue intacta?
     - ¿Qué cambió en el negocio/sector?
     - ¿Comprarías hoy a este precio si no tuvieras la posición?
   - Si no respondes en 14 días → alerta email
   - _Separa convicción real de inercia emocional_

6. **Pre-mortem & kill criteria por posición**
   - Para BKNG y SAP (y futuras): escribir explícitamente
     - 3 condiciones que invalidarían la tesis (no precio — fundamentos)
     - Precio máximo al que añadirías
     - Precio al que recortarías
     - Tiempo máximo sin materialización antes de revisar
   - Vive en `/company.html?ticker=X` o `/journal`
   - _30 min de trabajo, evita decisiones emocionales el día que toca_

7. **Watchlist formal con scoring**
    - Pasar de `price_alerts` (alertas sueltas) a un pipeline real
    - Cada idea con: fase del proceso (raw → researching → modeled → tracked → invested), score Columbia preliminar, fecha primera revisión, próxima acción
    - Dashboard de "ideas en cola" en `/screener` o nueva pestaña

---

## 📦 Funcional pendiente (post-CIO layer)

8. **Slack notifications** — price alerts + earnings + journal reviews al canal
9. **Twitter → Idea Feed v2** — ingestar tweets de cuentas curadas como ideas
10. **Substack forwarding** — reenviar newsletters a un buzón y parsearlas
11. **Cmd+K PDF index** — búsqueda full-text dentro de los PDFs de `/reporting`
12. **Decision Journal UI** — interfaz para escribir/revisar entradas en lugar de solo cron
13. **Responsive mobile** — home, calendar, search (assets `responsive_*` en backlog)
14. **3rd company coverage** — añadir tercera empresa al portafolio cubierto (hoy solo BKNG + SAP)

---

## 📝 Notas de orden

- **Próximo**: arrancar con #3 Portfolio Cockpit — mayor impacto inmediato.
- **Bloque CIO** (#3–7) en este orden: Cockpit → Performance → Re-underwriting → Pre-mortem → Watchlist.
- **#14 (3ra empresa)**: tentación natural pero esperar. _Tener 2 bien analizadas > 10 a medias._
- **No invertir más en**: nuevas fuentes de datos (Finnhub + Fintel + Claude + news es suficiente) ni en frontend extra hasta que el bloque CIO esté en pie.

## ⏸️ Diferido conscientemente

- **DNS Wix → Cloudflare/GoDaddy + Resend domain verification**. Wix bloquea MX en subdominios, lo que impide verificar `dceholdings.com` en Resend. Decisión: seguir enviando desde `onboarding@resend.dev` (default Resend, ya verificado). Funcional pero sender no-branded. Reabrir cuando: (a) emails empiecen a caer en spam de forma sistemática, o (b) se contrate analyst y se necesite admin de múltiples buzones.

---

## La pregunta del CIO

> ¿El sistema te está ayudando a **tomar mejores decisiones**, o solo a **tener mejores procesos**?

Si la respuesta hoy es "lo segundo", el bloque CIO (#6-10) es la prioridad real, no más features.
