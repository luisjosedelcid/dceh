# Manual Técnico — Aplicación DCE Holdings

> **Documento**: IT Handbook v1.0
> **Última actualización**: 2026-08-07
> **Deploy actual**: v111
> **Audiencia**: equipo de IT (interno o externo) que recibe la operación técnica de la aplicación. El documento asume nulo contexto previo. Es también consumible por un asistente LLM que necesite orientarse en el sistema.

---

## 0. Cómo leer este documento

Cada sección responde a preguntas concretas de operación. Las afirmaciones sobre archivos, endpoints y variables son verificables directamente contra el código del repositorio en la versión indicada. Cuando una ruta aparece entre backticks (`api/...`), existe físicamente en el repo. Cuando un nombre de tabla aparece entre backticks (`decision_journal`), existe físicamente en la base de datos.

Los runbooks operativos paso-a-paso están en `docs/RUNBOOKS/`. Este manual referencia a los runbooks cuando aplica.

---

## 1. Vista general

**Qué es**: aplicación web privada de una single-tenant family office. Sirve como sistema operativo de inversión — journal de decisiones, portafolio, valoraciones, investigación, base documental. No es SaaS multi-tenant.

**Arquitectura en una frase**: Vercel (frontend estático + serverless API) + Supabase (Postgres + Storage + Auth) + PWA con service worker.

**Diagrama de flujo request → response**:

```
Cliente PWA (browser / iOS PWA)
       │
       │  HTTPS (dceholdings.app)
       ▼
Vercel Edge Network (CDN + TLS termination)
       │
       ├─── static assets (public/*.html, /*.css, /*.js)
       │
       └─── Serverless function (api/*.js, Node 20)
              │
              │  HTTPS con SUPABASE_SERVICE_ROLE_KEY
              ▼
       Supabase (Postgres + Storage + Auth)
              │
              ├─── Postgres (44+ tablas)
              ├─── Storage (5 buckets)
              └─── Auth (no usado — se usa admin_users propio)
```

**Lo que NO tiene**:

- No hay backend en contenedores, no hay Kubernetes, no hay VMs
- No hay CI/CD tests automatizados (por decisión — el equipo es pequeño)
- No hay Redis, no hay message queue — todo va directo a Postgres
- No hay CDN de terceros (Cloudfront, etc.) — Vercel Edge es suficiente
- No hay analítica de producto (Amplitude, PostHog) — no se necesita

**Volumen actual (referencia para dimensionamiento)**:

- Usuarios activos: 2 (ver sección 15)
- Requests/día: bajo miles
- Filas Postgres: bajo cientos de miles
- Storage: bajo 5 GB
- Deploys/día: 0-5

---

## 2. Cuentas y accesos requeridos

**Para operar el sistema, IT necesita acceso a estas cuentas** (los usuarios actuales están en la sección 15; los credenciales se transfieren por canal seguro, nunca están en este documento ni en el repo):

| Plataforma | Cuenta / Proyecto | Rol requerido para IT | Necesario para |
|---|---|---|---|
| Vercel | Team / project `dceh` | Admin | Deploys, env vars, logs, dominios, rollback |
| Supabase | Proyecto `mlmmcciknvydlekztqtj` (eu-west-1, plan Pro) | Owner o Developer | DB, migrations, storage, backups |
| GitHub | Repo `luisjosedelcid/dceh` | Write | Código, PRs, releases |
| GitHub | Repo `luisjosedelcid/dceh-backups` | Write | Backups semanales redundantes |
| Registrar de dominio | `dceholdings.app` | Admin DNS | Renovación, TLS, records |
| Google Workspace | Cuenta `luis@dceholdings.com` | — | Google OAuth y notificaciones email |
| Resend | Cuenta email transaccional | Admin | Alertas por email |
| Slack | Workspace | Admin del webhook | Alertas push a Slack |

Al terminar la transferencia, todos los credenciales del titular actual deben rotarse. Ver `docs/RUNBOOKS/rotate_admin_token_secret.md` y `docs/RUNBOOKS/rotate_secrets.md`.

---

## 3. Infraestructura

### 3.1 Vercel

- **Proyecto**: `dceh`
- **Framework**: "Other" (no Next, no build framework; Vercel detecta las funciones en `api/`)
- **Región de funciones**: por defecto (`iad1`)
- **Plan**: Pro
- **Configuración principal**: `vercel.json` en la raíz del repo. Define crons, `maxDuration` por función, redirects y headers.
- **Dominio**: `dceholdings.app` + `www.dceholdings.app` (canonical: `www`).
- **Auto-deploy**: cada push a rama `main` dispara un deploy nuevo. No hay preview branches en uso.
- **Node runtime**: 20.x (default de Vercel).

### 3.2 Supabase

- **Proyecto**: `mlmmcciknvydlekztqtj`
- **Región**: `eu-west-1` (Irlanda)
- **Plan**: Pro (7 días de snapshots nativos, DB de 8 GB, storage sin límite fuerte)
- **URL API**: `https://mlmmcciknvydlekztqtj.supabase.co` (referenciada por env var `SUPABASE_URL`)
- **PostgREST**: activo, se usa como capa REST principal para la app
- **Auth de Supabase**: NO se usa. La app tiene su propio sistema en la tabla `admin_users` (ver sección 8).

### 3.3 GitHub

- **Repo principal**: `luisjosedelcid/dceh`
- **Rama única de producción**: `main`
- **Estrategia**: commits directos a `main` (equipo de 1 hoy). Cuando IT tome control, migrar a PRs es recomendable pero no obligatorio.
- **Backups repo**: `luisjosedelcid/dceh-backups` — recibe dumps semanales vía GitHub Actions (workflow programado los domingos 04:00 UTC).

### 3.4 DNS y TLS

- **Dominio**: `dceholdings.app`
- **Registrar**: verificar con titular (no está declarado en el repo)
- **TLS**: gestionado automáticamente por Vercel (Let's Encrypt renovación automática)
- **Records críticos**: A/CNAME apuntando a Vercel. Sin subdominios adicionales activos.

---

## 4. Estructura del repositorio

```
dceh/
├── api/                       # 152 endpoints serverless (Node 20, sintaxis CJS)
│   ├── _*.js                  # 28 helpers privados (guion bajo = privado por convención)
│   ├── admin/                 # 32 endpoints administrativos (requieren auth admin)
│   ├── auth/                  # 9 endpoints de autenticación y passkeys
│   ├── cockpit/               # 1 endpoint de UI del cockpit
│   ├── cron/                  # 16 endpoints programados (invocados solo por Vercel Cron)
│   ├── push/                  # 4 endpoints de web push notifications
│   └── *.js                   # 62 endpoints de app (mix de public y auth)
│
├── public/                    # Assets estáticos (24 HTMLs + CSS + JS + PWA)
│   ├── *.html                 # 24 páginas de la app
│   ├── sw.js                  # Service worker (PWA)
│   ├── pwa-shell.css/.js      # Shell común PWA
│   └── search.js              # Buscador global
│
├── scripts/                   # Utilidades locales (backfills, mocks, one-shots)
│
├── supabase/
│   └── migrations/            # Solo 4 migrations en repo — el resto se aplicaron
│                              #   directamente vía Supabase MCP y no están versionadas aquí.
│                              #   Esta es una deuda técnica a resolver (ver sección 16).
│
├── docs/
│   ├── IT_HANDBOOK.md         # Este documento
│   └── RUNBOOKS/              # Runbooks operativos paso-a-paso
│
├── vercel.json                # Config de Vercel (crons, maxDuration, redirects)
├── package.json               # 5 dependencias runtime
├── package-lock.json
├── RUNBOOK_DR.md              # Runbook de disaster recovery
├── BACKLOG.md                 # Backlog de features (no crítico para IT)
└── README ausente             # Deuda técnica: no hay README.md
```

**Convenciones**:

- Archivos con `_` inicial en `api/` son helpers privados no expuestos como endpoints (Vercel los ignora si empiezan con `_` — no, en realidad Vercel SÍ los expone. La convención es solo semántica; el acceso se controla por lógica interna, no por routing).
- Sintaxis CommonJS (`module.exports = async (req, res) => {...}`), no ESM.
- Cada archivo `.js` en `api/` es un endpoint HTTP en la ruta correspondiente (ej. `api/journal.js` → `GET|POST|PATCH /api/journal`).

---

## 5. Deploy pipeline

**Flujo estándar**:

```
1. Editar código local en workspace/dceh/
2. Bump SW_VERSION en public/sw.js (ver 5.1)
3. git add -A && git commit -m "..."
4. git push origin main
5. Vercel detecta el push y arranca build (~60-90s)
6. Al terminar, el deploy es promovido automáticamente a producción
7. Smoke test manual (ver docs/RUNBOOKS/deploy.md)
```

### 5.1 Ritual de bump SW_VERSION

**Importante**: la app es una PWA. Los clientes cachean agresivamente. Si el service worker no cambia, los usuarios no ven cambios nuevos.

Antes de cada push que modifique HTML/CSS/JS del frontend, incrementar la constante `SW_VERSION` en `public/sw.js`:

```javascript
const SW_VERSION = 'dce-v111';  // → 'dce-v112' antes del próximo deploy
```

Y bumpear también los query strings de cache-busting en referencias al SW en cada HTML relevante (`?v=89` → `?v=90`, etc.). Esto último es menos crítico si el SW ya rota.

### 5.2 Rollback

Vercel guarda los últimos 100 deploys. Para revertir:

```
Vercel dashboard → project dceh → Deployments →
  [deploy anterior] → menú (⋯) → "Promote to Production"
```

Ver `docs/RUNBOOKS/rollback.md` para el procedimiento completo.

### 5.3 Sin CI

No hay linter automático, ni tests, ni type-check en el pipeline. La validación es manual (smoke test post-deploy). Migrar a CI con tests es recomendable pero fuera del alcance actual.

---

## 6. Base de datos

### 6.1 Postgres

- Motor: Postgres 15 gestionado por Supabase
- Extensiones activas: `pg_stat_statements`, `pgcrypto`, `uuid-ossp` (default de Supabase)
- Schema principal: `public`

### 6.2 Inventario de tablas críticas (44)

Agrupadas por dominio funcional. La lista canónica está en el array `CRITICAL_TABLES` de `api/cron/backup-nightly.js`.

**Investment process**:
- `decision_journal` — decisiones BUY/SELL/PASS con thesis
- `decision_inputs_packages` — inputs pre-decisión (Munger v4, thesis builder/breaker)
- `premortems` — pre-mortems asociados a BUYs activos
- `premortem_revisions` — historial de versiones de pre-mortem
- `failure_modes` — modos de fallo identificados en pre-mortem
- `reunderwriting_due` — re-underwritings pendientes tras 10-K/10-Q
- `reunderwriting_entries` — cierres firmados de re-underwriting
- `pipeline_cards` — kanban de research (backlog → analysis → decision → invested → closed)
- `pipeline_card_assets` — PDFs adjuntos a cada card
- `trigger_evaluations` — evaluaciones de triggers de kill criteria

**Portfolio**:
- `transactions` — trades y movimientos (compra, venta, dividendo, aporte, retiro)
- `trades` — subset de `transactions` filtrado a operaciones de mercado
- `portfolio_snapshots` — snapshot diario de posiciones + P&L
- `cashflows` — aportes y retiros de capital
- `time_deposits` — depósitos a plazo (fixed income)
- `real_estate_marks` — valuaciones periódicas de inmuebles
- `dividend_schedule` — dividendos pendientes de pago
- `iv_tracking` — tracking de volatilidad implícita

**Documentos y contenido**:
- `dataroom_files` — archivos del Data Room (PDFs, memos, briefs)
- `dataroom_folders` — jerarquía de carpetas
- `dataroom_hidden_files` — marcador de archivos ocultos por usuario
- `study_articles` — artículos guardados en Study
- `study_files` — PDFs subidos a Study
- `source_documents` — 10-K/10-Q/S-1 ingeridos por el pipeline

**Research y screening**:
- `company_dashboards` — JSON de dashboards por ticker (renderizados en `/company.html`)
- `watchlist` — tickers en watchlist con triggers
- `tickers_tracked` — universo de tickers monitoreados
- `radar` — scores de radar por empresa
- `analysts` — cobertura de analistas externos
- `idea_feed_sources` — fuentes RSS/Substack/podcast
- `idea_feed_items` — ítems ingeridos del idea feed
- `user_news_tickers` — tickers de interés para news
- `screener_snapshot` — última corrida del screener v2.5

**Operaciones y gobernanza**:
- `discipline_rules` — reglas de disciplina (posición mínima, MoS, etc.)
- `admin_users` — usuarios administrativos con roles
- `allowed_users` — usuarios permitidos con acceso a la app
- `push_subscriptions` — suscripciones a web push
- `price_alerts` — alertas de precio configuradas
- `earnings_alerts_sent` — histórico de alertas de earnings enviadas
- `earnings_calendar` — calendario de earnings próximos
- `calendar_extras` — eventos manuales del calendario
- `calendar_blocklist` — eventos bloqueados
- `comments` — comentarios generales

**Datos de mercado**:
- `prices_daily` — precios diarios (~10 años de histórico para tickers activos)
- `fx_daily` — tipos de cambio diarios

**Meta / infraestructura**:
- `backup_log` — bitácora de corridas del cron de backup (creada 2026-08-07)
- Y otras tablas de menor criticidad no incluidas en el backup (audit, sesiones efímeras, etc.)

### 6.3 Migrations

**Estado actual (deuda técnica)**: solo 4 migrations están versionadas en `supabase/migrations/`. La mayoría de cambios DDL se aplicaron directamente vía Supabase MCP durante el desarrollo, sin quedar en el repo.

**Recomendación para IT al recibir**:

1. Ejecutar `pg_dump --schema-only` contra producción para obtener el esquema real actual.
2. Guardarlo como `supabase/migrations/2026-08-XX_baseline_schema.sql`.
3. A partir de ese punto, cada cambio DDL debe pasar por una migration en el repo (usar `supabase migration new` o Supabase MCP `apply_migration`).

### 6.4 RLS

**RLS no está activo en la mayoría de tablas**. La seguridad se implementa en la capa de aplicación (middleware `_admin-auth.js` y `_require-role.js`) porque:

- Todos los requests van con `SUPABASE_SERVICE_ROLE_KEY` (que bypasea RLS)
- La app es single-tenant, así que la tabla `admin_users` decide todo el acceso

**Implicación**: cualquier persona con la `SUPABASE_SERVICE_ROLE_KEY` puede leer/escribir cualquier tabla. Rotación de esa key es crítica en cualquier ofboarding (ver `docs/RUNBOOKS/rotate_secrets.md`).

---

## 7. API endpoints — inventario

Total: **~150 endpoints**. Agrupados por prefijo. Cada uno responde a `GET`, `POST`, `PATCH` o `DELETE` según su lógica interna.

### 7.1 `/api/auth/*` (9 endpoints)

- `admin-login.js` — login con email + password (retorna JWT)
- `auth/forgot-password.js` — inicia flujo de reset
- `auth/reset-password.js` — completa reset con token de email
- `auth/passkey-register-begin.js`, `passkey-register-finish.js` — registro de passkeys WebAuthn
- `auth/passkey-auth-begin.js`, `passkey-auth-finish.js` — autenticación por passkey
- `auth/pin-set.js`, `pin-verify.js` — PIN adicional para operaciones sensibles
- `auth/status.js` — estado de sesión actual

**Auth requerido**: público (los endpoints de login) o JWT válido (los demás).

### 7.2 `/api/admin/*` (32 endpoints)

Todos requieren `x-admin-token` header con JWT válido y rol `admin` (verificado por `_admin-auth.js` + `_require-role.js`).

Dominios cubiertos: users, dataroom, journal, premortems, pipeline cards, radar, analysts, idea-feed sources, iv-tracking, screener refresh, backup status, alerts, audit-logins, study, dashboards.

### 7.3 `/api/cron/*` (16 endpoints)

Ver sección 10 (crons) para detalle completo. Todos requieren `Bearer $CRON_SECRET` o header `x-vercel-cron-schedule`.

### 7.4 `/api/push/*` (4 endpoints)

Web push notifications vía VAPID. Endpoints para subscribe, unsubscribe, send, y obtener la clave pública VAPID.

### 7.5 `/api/*.js` top-level (~90 endpoints)

Endpoints de la app usados desde el frontend PWA. Auth mixto (algunos públicos, la mayoría requieren JWT). Cubren:

- Portfolio (transactions, trades, cashflows, time_deposits, performance)
- Journal (create, delete, decision-inputs, decision-pdf)
- Reunderwriting (submit, prefill, pdf, undo)
- Pre-mortems (history, list)
- Dashboards (view, list-versions, upsert-dashboard)
- Research (screener-query, universe-rows, radar)
- Data Room (dataroom-files, dataroom-folders, upload-report)
- Reports (generate-daily/consolidated/crypto/fixed-income/real-estate-report)
- Watchlist, alerts, discipline-rules
- News, idea-feed, source-documents
- Study (articles, files)
- Earnings, IV tracking
- Calendar, team-meetings, slack-inbox
- Utilidades: fintel, claude, finnhub-quote, finnhub-search, crypto-prices

**Nota**: no hay OpenAPI/Swagger spec. Para conocer parámetros exactos de un endpoint, leer el archivo `.js` correspondiente — cada uno documenta sus params en las primeras líneas del handler.

---

## 8. Autenticación

### 8.1 Modelo de auth

- **Storage de usuarios**: tabla `admin_users` (email, password_hash, role, is_active, mfa_enabled, etc.)
- **Password hashing**: `bcryptjs` (10 rounds)
- **Session token**: JWT firmado con `HS256` y `ADMIN_TOKEN_SECRET`
- **TTL del token**: definido en `_admin-auth.js` (constante `TOKEN_TTL_SEC`)
- **Header de auth**: `x-admin-token: <jwt>` en cada request a `/api/admin/*` y otros protegidos

### 8.2 Flujo de login

```
Cliente                                 Servidor
  │                                        │
  │  POST /api/admin-login                 │
  │  { email, password }                   │
  │───────────────────────────────────────▶│
  │                                        │  1. SELECT * FROM admin_users
  │                                        │       WHERE email = $1 AND is_active = true
  │                                        │  2. bcrypt.compare(password, password_hash)
  │                                        │  3. Registrar attempt en admin_audit_log
  │                                        │  4. Firmar JWT con ADMIN_TOKEN_SECRET
  │                                        │
  │  { token, user: { email, role } }      │
  │◀───────────────────────────────────────│
  │                                        │
  │  localStorage.setItem('dce_admin_token', token)
  │                                        │
  │  Requests posteriores:                 │
  │  GET /api/admin/journal                │
  │  Header: x-admin-token: <jwt>          │
  │───────────────────────────────────────▶│
  │                                        │  verifyAdminToken(token, ADMIN_TOKEN_SECRET)
  │                                        │  requireRole(['admin']) opcional
```

### 8.3 Roles

Dos roles definidos en `admin_users.role`:

- `admin` — acceso completo, puede escribir en todas las tablas
- `analyst` — acceso de lectura + escritura limitada (ver `_require-role.js` para reglas específicas por endpoint)

**Estado actual**: RBAC granular (ticket #28 del backlog) está pendiente. Hoy la distinción `admin` vs `analyst` es coarse-grained.

### 8.4 Rate limiting y auditoría

- Cada intento de login se registra en `admin_audit_log` con IP, user agent, outcome (success/failure) y failure reason.
- Login attempts fallidos se purgan a los N días vía cron `purge-login-attempts.js`.
- Rate limiting está implementado en `api/admin-login.js` (bloqueo temporal tras N fallos).

---

## 9. Variables de entorno

**Todas las env vars viven en Vercel** (project settings → Environment Variables). El repo no contiene ningún `.env` (verificar `.gitignore`).

### 9.1 Requeridas (el sistema no arranca sin ellas)

| Variable | Uso | Notas |
|---|---|---|
| `SUPABASE_URL` | Base URL de Supabase | `https://mlmmcciknvydlekztqtj.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Key con permisos completos | Bypasea RLS. Nunca exponer al cliente. |
| `ADMIN_TOKEN_SECRET` | Secreto HMAC para firmar JWTs | 256+ bits aleatorios |
| `CRON_SECRET` | Autoriza invocaciones a `/api/cron/*` | Vercel lo inyecta como Bearer |

### 9.2 Funcionalidades opcionales

| Variable | Uso |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API — usado en `api/claude.js` y en el pipeline de ingest de documentos |
| `FINNHUB_KEY`, `FINNHUB_API_KEY` | Cotizaciones equity y búsqueda de tickers |
| `ROIC_API_KEY`, `CUSTOM_CRED_API_ROIC_AI_TOKEN` | Fetch de fundamentales desde ROIC.ai |
| `COINGECKO_API_KEY` | Precios crypto |
| `FINTEL_API_KEY` | 13F / holdings / insider trading |
| `RESEND_API_KEY` | Envío de emails transaccionales |
| `ALERT_EMAIL_FROM`, `ALERT_EMAIL_TO` | Emails de alertas |
| `SLACK_WEBHOOK_URL`, `SLACK_ALERT_WEBHOOK`, `SLACK_BOT_TOKEN` | Alertas Slack |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push notifications |
| `RP_ID`, `RP_ORIGIN` | WebAuthn / passkeys |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | Google OAuth (uso limitado) |
| `DCE_APP_ORIGIN` | Origen esperado en CORS |

### 9.3 Comportamiento (feature flags)

| Variable | Default | Efecto |
|---|---|---|
| `BACKUP_RETENTION_DAILY_DAYS` | `30` | Días de retención de nightly backups |
| `BACKUP_RETENTION_MONTHLY_MONTHS` | `12` | Meses de retención de monthly backups |
| `ARCHIVE_RETENTION_DAYS` | ver `purge-archive.js` | Retención de versiones antiguas de PDFs |
| `ARCHIVE_MIN_VERSIONS` | ver `purge-archive.js` | Versiones mínimas a conservar aunque expiren |
| `SCREENER_KILL_SWITCH` | — | Si truthy, desactiva el screener |
| `DASHBOARD_PASSWORD` | — | Password legacy para vistas públicas |

### 9.4 Legacy

`ADMIN_TOKEN` (sin sufijo `_SECRET`) aparece en algunos archivos antiguos. Ya no se usa activamente pero puede permanecer definida en Vercel por compatibilidad hasta confirmar que ningún endpoint la referencia.

---

## 10. Crons

16 crons activos, todos en `api/cron/` y declarados en `vercel.json`. Todos los schedules son **UTC**.

| Schedule (UTC) | Endpoint | Qué hace |
|---|---|---|
| `0 */6 * * *` | `refresh-feed` | Refresca fuentes de idea feed cada 6 horas |
| `0 7 * * *` | `discipline-alerts` | Evalúa reglas de disciplina y notifica violaciones |
| `0 13 * * *` | `journal-reviews` | Alerta sobre journal entries que requieren revisión |
| `*/10 13-20 * * 1-5` | `price-alerts` | Cada 10 min durante horas de mercado (L-V) chequea price alerts |
| `0 4 * * 0` | `purge-archive` | Domingos: purga versiones antiguas de PDFs archivados |
| `0 6 * * *` | `earnings-refresh` | Refresca calendario de earnings |
| `0 8 * * *` | `earnings-alerts` | Envía alertas de earnings del día |
| `0 22 * * 1-5` | `prices-refresh` | 22:00 UTC L-V: refresca precios diarios post-close |
| `30 22 * * 1-5` | `portfolio-snapshot` | 22:30 UTC L-V: snapshot del portafolio |
| `45 22 * * 1-5` | `ingest-docs` | 22:45 UTC L-V: ingesta 10-K/10-Q recientes |
| `50 22 * * 1-5` | `watchlist-check` | 22:50 UTC L-V: chequea triggers de watchlist |
| `0 23 * * 1-5` | `premortem-eval` | 23:00 UTC L-V: evalúa pre-mortems activos |
| `0 5 * * *` | `purge-login-attempts` | Purga login attempts antiguos |
| `0 3 * * *` | `screener-refresh` | 03:00 UTC diario: refresca screener v2.5 |
| `15 0 * * *` | `crypto-snapshot` | 00:15 UTC diario: snapshot de crypto |
| `30 3 * * *` | `backup-nightly` | 03:30 UTC diario: backup nightly (44 tablas + mirror dataroom) |

### 10.1 Cómo se autorizan

Cada cron valida uno de estos:

- Header `Authorization: Bearer $CRON_SECRET` (para invocaciones manuales autorizadas)
- Header `x-cron-secret: $CRON_SECRET` (alternativa)
- Header `x-vercel-cron-schedule: ...` (presente automáticamente cuando Vercel Cron dispara)

Sin uno de esos tres, responden 401.

### 10.2 Cómo debugear un cron fallido

Ver `docs/RUNBOOKS/investigate_cron_failure.md`. Resumen:

1. Vercel dashboard → project → Deployments → deploy actual → Functions → `api/cron/<nombre>` → Logs
2. Si el cron escribe a una tabla de log (ej. `backup_log`, `screener_snapshot`), consultarla:
   ```sql
   SELECT * FROM backup_log ORDER BY started_at DESC LIMIT 20;
   ```
3. Reproducir manualmente: `curl -H "Authorization: Bearer $CRON_SECRET" https://www.dceholdings.app/api/cron/<nombre>`

### 10.3 Correr un cron manualmente

Todos los crons aceptan invocación manual con el bearer token. Algunos aceptan flags de query:

- `?dry=1` — modo dry-run (no persiste cambios)
- `?skip_dataroom=1` — en backup, salta el mirror del bucket dataroom
- `?kind=manual` — marca la corrida como manual en logs

Además, el endpoint admin `/api/admin/run-cron.js` permite disparar crons desde la UI admin.

---

## 11. Storage

5 buckets en Supabase Storage:

| Bucket | Público | Uso | Estructura de paths |
|---|---|---|---|
| `dataroom` | Sí | PDFs de research, memos, briefs, monthly closes | `<folder_id>/<epoch>__<filename>.pdf` |
| `pipeline-assets` | No | Assets adjuntos a pipeline cards | `<card_id>/<filename>` |
| `reports` | Sí | Reportes generados (daily, weekly, mensual) | `<yyyy>/<mm>/<filename>` |
| `study` | Sí | PDFs subidos por usuarios en Study | `<user_id>/<filename>` |
| `backups` | No | Backups nightly + monthly (creado 2026-08-07) | `nightly/<yyyy-mm-dd>/...` y `monthly/<yyyy-mm>/...` |

**Nota sobre buckets públicos**: los buckets marcados como públicos permiten lectura anónima si se conoce la URL, pero las URLs contienen paths pseudo-aleatorios (epoch + filename) que dificultan enumeración. No hay index público del bucket. Aun así, no debe almacenarse información confidencial no destinada a compartir en `dataroom`/`reports`/`study`.

**RLS de storage**: no configurado. Escritura solo con `SUPABASE_SERVICE_ROLE_KEY` (que solo el backend tiene).

---

## 12. PWA y service worker

### 12.1 Comportamiento

- La app es instalable como PWA en iOS y Android
- El service worker (`public/sw.js`) implementa cache-first para assets estáticos y network-first para llamadas API
- El SW gestiona push notifications recibidas vía VAPID
- Manifest en `public/manifest.json` (verificar existencia)

### 12.2 Cuándo bumpear SW_VERSION

Siempre que cambie:

- Cualquier `.html` en `public/`
- Cualquier `.css`
- Cualquier `.js` del cliente (excepto `sw.js` mismo, que se detecta por byte diff)
- Cualquier lista de assets en el manifest

Regla simple: **antes de cada push a producción, bumpear**. El costo es una línea; el costo de olvidarlo es que usuarios en iOS vean la versión vieja durante días.

### 12.3 Forzar update en clientes

Si un usuario reporta ver una versión vieja:

1. Cerrar y reabrir la app (iOS: kill app; browser: hard refresh)
2. Si persiste: Settings → clear site data
3. Última opción: bumpear SW_VERSION nuevamente y desplegar

---

## 13. Observabilidad

### 13.1 Logs

- **Vercel logs**: dashboard → deployment → Functions → nombre de la función → Logs. Retención de 3 días en plan Pro. Para retención larga, ver 13.3.
- **Supabase logs**: dashboard → Logs → Postgres / PostgREST / Realtime / Storage. Filtrar por proyecto y timeframe.
- **Logs de crons en app**: varias tablas persisten actividad:
  - `backup_log` — corridas del backup nightly
  - `admin_audit_log` — logins admin
  - `activity_log` — acciones administrativas relevantes (si existe; verificar)

### 13.2 Métricas

Vercel dashboard muestra:
- Requests/día por función
- Duración P50/P95/P99
- Error rate
- Bandwidth

Supabase dashboard muestra:
- CPU, RAM, conexiones activas
- Storage usado
- Tablas más grandes

### 13.3 Alertas

Configuradas hoy:
- Slack webhook para: errores críticos del portafolio, alertas de earnings, alertas de precio
- Email (via Resend): resumen diario si `ALERT_EMAIL_TO` está seteado

No configuradas (recomendable añadir):
- Alerta si un cron falla más de N veces consecutivas
- Alerta si latencia P95 excede X ms
- Alerta si el uso de DB supera 70% del límite del plan

---

## 14. Seguridad

### 14.1 Inventario de secretos

Todos viven en Vercel env vars (ver sección 9). Ninguno debe estar en el repo, en logs, ni en mensajes de Slack.

**Secretos que rotar en cualquier ofboarding**:

1. `ADMIN_TOKEN_SECRET` — rotarlo invalida todos los JWTs vigentes (forzando re-login). Ver `docs/RUNBOOKS/rotate_admin_token_secret.md`.
2. `CRON_SECRET` — rotarlo requiere que todos los crons manuales agendados fuera de Vercel usen el nuevo valor. Los crons de Vercel siguen funcionando (usan header `x-vercel-cron-schedule`).
3. `SUPABASE_SERVICE_ROLE_KEY` — rotable desde Supabase dashboard (Settings → API → Regenerate). Requiere redeploy inmediato con la nueva key.
4. `ANTHROPIC_API_KEY`, `FINNHUB_KEY`, `COINGECKO_API_KEY`, `RESEND_API_KEY`, `FINTEL_API_KEY`, `ROIC_API_KEY` — rotables desde el dashboard del proveedor correspondiente.
5. `VAPID_PRIVATE_KEY` — rotarla invalida push subscriptions existentes (los usuarios re-consentirán).

Runbook completo: `docs/RUNBOOKS/rotate_secrets.md`.

### 14.2 Superficie de ataque

- **Endpoints públicos** (sin auth): `/api/admin-login`, `/api/auth/*` (algunos), `/api/finnhub-search`, `/api/finnhub-quote`, `/api/crypto-prices`. Ninguno permite escritura sin credencial válida.
- **Endpoints protegidos por JWT admin**: todos `/api/admin/*` y la mayoría de `/api/*.js` top-level.
- **Endpoints protegidos por CRON_SECRET**: todos `/api/cron/*`.
- **Storage buckets públicos**: `dataroom`, `reports`, `study`. Contenido accesible con URL pero no enumerable.
- **CORS**: configurado en cada endpoint; en general se permite origen `DCE_APP_ORIGIN`.

### 14.3 Prácticas recomendadas al recibir el sistema

1. Rotar todos los secretos (checklist en `docs/RUNBOOKS/rotate_secrets.md`).
2. Habilitar MFA en Vercel, Supabase, GitHub, registrar de dominio.
3. Revisar accesos en Vercel y Supabase — remover cuentas que no deban seguir.
4. Confirmar que Slack webhooks apuntan a un canal controlado por IT.
5. Cambiar el email de contacto del registrar de dominio si aplica.

---

## 15. Usuarios actuales

Consultado directamente contra la tabla `admin_users` en producción (2026-08-07):

| Email | Rol | Activo | Creado |
|---|---|---|---|
| `luis@dceholdings.com` | admin | sí | 2026-04-28 |
| `info@dceholdings.com` | analyst | sí | 2026-04-30 |

Antes de dar por completada la transferencia:

1. Añadir usuario `admin` para IT (ver `docs/RUNBOOKS/add_admin_user.md`).
2. Confirmar con el titular quién debe permanecer activo.
3. Desactivar cualquier cuenta no requerida (`UPDATE admin_users SET is_active = false WHERE email = ...`) en vez de borrar (preserva referencias en audit log).

---

## 16. Deudas técnicas conocidas

Este manual las documenta explícitamente para que IT decida qué priorizar.

| Deuda | Impacto | Esfuerzo estimado |
|---|---|---|
| No hay `README.md` | Baja | 30 min |
| Solo 4 de N migrations en repo (schema real diverge de repo) | Medio-Alto | 2 h |
| Sin RBAC granular (#28 en backlog) | Medio | 1-2 días |
| Sin CI (linter, tests, type-check) | Medio | 3-5 días |
| Sin monitoring de crons (falla silenciosamente si no notifica) | Medio | 1 día |
| RLS deshabilitado en la mayoría de tablas | Bajo (single-tenant) | 2-3 días |
| Node CJS mixto con algunos ESM patterns | Bajo | — |

---

## 17. Contacto y hand-off

Al recibir la responsabilidad técnica, el nuevo equipo IT debe:

1. Leer este manual completo (~2 horas).
2. Recorrer los runbooks en `docs/RUNBOOKS/` (~1 hora).
3. Ejecutar el checklist de recepción en `docs/RUNBOOKS/handoff_checklist.md`.
4. Confirmar por escrito al titular la finalización de la transferencia.

Cualquier duda debe resolverse **contra el código fuente primero, este manual segundo, y al titular como último recurso** — esa es la razón de ser de este documento.

---

**Fin del manual v1.0**
