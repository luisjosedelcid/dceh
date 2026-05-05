# DCE Holdings — Disaster Recovery Runbook

Última actualización: 2026-05-05

Este documento describe cómo recuperar el sistema ante distintos escenarios de desastre. Está pensado para ser leído **bajo presión** — secciones cortas, comandos copy-paste.

---

## Inventario de capas de respaldo

| Capa | Qué cubre | Frecuencia | Retención | Dónde |
|------|-----------|------------|-----------|-------|
| 1. Supabase Pro nativo | DB completa (snapshots) | Diario | 7 días | Dashboard Supabase |
| 2. GitHub Actions backup | DB + Storage + migrations | Semanal (domingo 04:00 UTC) | 8 semanas | Repo `luisjosedelcid/dceh-backups` |
| 3. Repo principal | Código fuente | Cada commit | Permanente | Repo `luisjosedelcid/dceh` |
| 4. Vercel deployments | Builds anteriores | Cada deploy | 100 deploys | Vercel dashboard |

---

## Información crítica de contacto/acceso

- **Supabase project**: `mlmmcciknvydlekztqtj` (DCE Holdings org, eu-west-1, plan Pro)
- **Vercel project**: `dceh` (org Luis del Cid)
- **GitHub repos**: `luisjosedelcid/dceh` (código), `luisjosedelcid/dceh-backups` (snapshots)
- **Dominio**: `dceholdings.app` (registrar y DNS — verificar quién lo gestiona)
- **Admin email**: `luis@dceholdings.com`

---

## Escenario A — Borrado accidental de filas/tabla

**Síntoma**: faltan datos en una tabla, o una tabla fue dropeada por error.

**Procedimiento**:

1. **NO escribir nada más en la tabla afectada** (cada escritura aleja del estado bueno).
2. Identificar el momento aproximado del incidente.
3. Si fue dentro de las últimas 24h:
   - Supabase Dashboard → Database → Backups → seleccionar último backup diario
   - Restaurar a una **branch nueva** (no production directamente) para verificar
   - Una vez verificado, hacer `pg_dump` de la tabla específica en la branch y aplicarla a producción
4. Si fue hace más de 24h pero menos de 7 días:
   - Mismo procedimiento, eligiendo el backup del día correcto
5. Si fue hace más de 7 días:
   - Usar el snapshot semanal del repo `dceh-backups`
   - Ver Escenario C para procedimiento de extracción parcial

**Tiempo estimado de recuperación**: 15–30 min.

---

## Escenario B — Proyecto Supabase corrupto o caído (pero accesible)

**Síntoma**: queries fallan, dashboard accesible, pero data inconsistente.

**Procedimiento**:

1. Confirmar status en https://status.supabase.com
2. Si es incidente de Supabase: esperar y monitorizar
3. Si es corrupción local del proyecto:
   - Supabase Dashboard → Database → Backups → restaurar último backup completo
   - Esto sobreescribe la DB actual; coordinar para evitar pérdida de datos del día
4. Tras restauración, verificar:
   ```bash
   curl https://www.dceholdings.app/api/alerts  # debe devolver 200
   curl https://www.dceholdings.app/api/earnings  # debe devolver 200
   ```
5. Si hubo escrituras desde el último backup → reconciliar manualmente

**Tiempo estimado**: 30–60 min.

---

## Escenario C — Proyecto Supabase ELIMINADO o cuenta perdida

**Síntoma**: el proyecto ya no existe, o no se puede acceder a la cuenta de Supabase.

**Este es el escenario worst-case. Aquí entran los backups off-site.**

**Procedimiento**:

### C.1 — Crear nuevo proyecto Supabase

1. Crear nueva cuenta o usar otra existente
2. Crear proyecto nuevo en región `eu-west-1` (Ireland)
3. Plan: **Pro desde el inicio** (no Free, evita auto-pause)
4. Anotar el nuevo `project_ref`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, y construir `DB_URL`:
   ```
   postgresql://postgres.<project_ref>:<password>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres
   ```

### C.2 — Restaurar DB desde backup off-site

```bash
# Clonar el repo de backups
git clone https://github.com/luisjosedelcid/dceh-backups.git
cd dceh-backups

# Identificar el backup más reciente (carpeta YYYY-WNN)
ls -d 20*-W* | sort -r | head -1

# Ejecutar el script de restauración
cd ../dceh
./scripts/restore-from-backup.sh ../dceh-backups/2026-W18 "$NEW_DB_URL"
```

Esto deja la DB con todas las tablas y datos del schema public.

### C.3 — Restaurar Storage (PDFs del Reporting Hub)

```bash
# Crear los buckets en el nuevo proyecto
# Dashboard → Storage → New bucket → "reports" (public) → repetir para "study"

# Extraer el tarball de storage
mkdir -p /tmp/dceh-storage-restore
tar -xzf ../dceh-backups/2026-W18/storage_*.tar.gz -C /tmp/dceh-storage-restore

# Re-subir con el script (TODO: crear scripts/upload-storage.sh)
# Por ahora, manualmente vía Supabase Dashboard → Storage → Upload
```

### C.4 — Reconectar Vercel al nuevo proyecto

1. Vercel → Settings → Environment Variables
2. Editar:
   - `SUPABASE_URL` → URL del nuevo proyecto
   - `SUPABASE_SERVICE_ROLE_KEY` → service_role key del nuevo proyecto
   - `SUPABASE_DB_URL` (si existe) → connection string del nuevo proyecto
3. **NO cambiar**: `ADMIN_TOKEN_SECRET`, `FINNHUB_KEY`, etc.
4. Redeploy:
   ```bash
   git commit --allow-empty -m "chore: redeploy after DR restore" && git push
   ```
5. Smoke test:
   ```bash
   curl https://www.dceholdings.app/api/alerts
   curl https://www.dceholdings.app/api/earnings
   ```

### C.5 — Re-aplicar migraciones de seguridad

El backup contiene el schema con datos pero las **policies de RLS y triggers** podrían no estar todas. Re-aplicar:

```bash
# Las migraciones más importantes (idempotentes, seguras de re-aplicar):
# - enable_rls_sensitive_tables
# - security_definer_view_and_user_metadata_policies
# - lock_function_search_paths
# - login_attempts_table
```

Aplicarlas con Supabase MCP o via dashboard SQL editor copiando desde el repo dceh.

### C.6 — Actualizar el workflow de backup

Editar `.github/workflows/weekly-backup.yml`:
- Actualizar el secret `SUPABASE_DB_URL` en GitHub repo settings
- Actualizar `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` también

**Tiempo estimado total C.1–C.6**: 2–4 horas.

---

## Escenario D — Repo GitHub comprometido o eliminado

**Síntoma**: no se puede pushear, repo no existe, o sospecha de acceso no autorizado.

**Procedimiento**:

1. **Inmediato**: rotar `GITHUB_TOKEN` y `BACKUP_REPO_TOKEN`
2. Si el código del repo principal se perdió:
   - Vercel guarda el último build con código embebido — puedes descargar el deployment
   - El sandbox local en `/home/user/workspace/dceh` también es una copia válida
3. Crear nuevo repo y hacer `git push` desde la copia local
4. Re-conectar Vercel al nuevo repo (Settings → Git)

---

## Escenario E — Vercel caído o cuenta perdida

**Procedimiento**:

1. El sitio estará offline hasta resolver
2. Si es incidente de Vercel: monitorizar https://www.vercel-status.com
3. Si es cuenta perdida: deployar a alternativa (Netlify, Cloudflare Pages) usando el código del repo
4. Actualizar DNS para apuntar al nuevo host
5. Re-configurar todas las env vars en el nuevo host

---

## Fire drill trimestral

**Cada 3 meses**, ejecutar este test para verificar que los backups funcionan:

1. Crear branch nueva en Supabase (Dashboard → Branches → New branch)
2. Restaurar el backup más reciente del repo `dceh-backups` a esa branch
3. Verificar que `prices_daily`, `transactions`, `decision_journal` tienen counts esperados
4. Eliminar la branch
5. Documentar en este runbook si algo falló

**Próximo fire drill**: 2026-08-05.

---

## Secrets y env vars críticos

Lista de qué variables tiene Vercel y dónde se obtienen:

| Variable | Origen | Rotación recomendada |
|----------|--------|----------------------|
| `SUPABASE_URL` | Supabase Dashboard → Settings → API | No rotar (es URL pública) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase Dashboard → API Keys → secret | 180 días |
| `ADMIN_TOKEN_SECRET` | Generar: `openssl rand -hex 64` | 90 días |
| `FINNHUB_KEY` | Finnhub dashboard | Si se filtra |
| `ANTHROPIC_API_KEY` | Anthropic console | Si se filtra |

Lista en GitHub repo settings (para el workflow de backup):

| Variable | Origen |
|----------|--------|
| `SUPABASE_DB_URL` | Supabase Dashboard → Settings → Database → Connection string (Session pooler) |
| `SUPABASE_URL` | Igual que en Vercel |
| `SUPABASE_SERVICE_ROLE_KEY` | Igual que en Vercel |
| `BACKUP_REPO_TOKEN` | GitHub PAT con scope `repo` para el repo `dceh-backups` |

---

## Última verificación

- Backups nativos Supabase: ✅ activos (Pro plan)
- Workflow GitHub Actions: ⏳ pendiente primera ejecución
- Repo `dceh-backups`: ⏳ pendiente creación
- Fire drill inicial: ⏳ pendiente
