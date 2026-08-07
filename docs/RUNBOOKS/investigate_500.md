# Runbook — Investigar un error 500

**Cuándo usar**: un usuario reporta que un endpoint devuelve 500, o el error rate en Vercel sube por encima del baseline (~0%).

**Duración**: 10-30 minutos según causa.

## Procedimiento

### 1. Identificar el endpoint y la ventana temporal

Si el usuario reportó el error:
- Preguntar hora exacta (o rango de minutos)
- Preguntar qué acción intentó (permite deducir el endpoint)

Si es detectado por monitoring:
- Ver en el dashboard de Vercel qué función tiene error rate elevado
- Filtrar el rango de tiempo

### 2. Revisar logs de Vercel

```
Vercel dashboard → project dceh → Deployments →
  deploy actual → Functions → api/<nombre> → Logs
```

Filtrar por:
- Time range que coincida con el reporte
- Log level `error` si está disponible

Buscar el stack trace. Los patrones comunes son:

**Patrón A**: `Cannot read property 'X' of undefined`
- Un objeto esperado llegó null/undefined
- Reproducir con el payload exacto que causó el error

**Patrón B**: `PostgrestError: relation "X" does not exist`
- La tabla no existe en producción. Puede que se haya olvidado aplicar una migration.
- Ver `list_migrations` vs código del endpoint.

**Patrón C**: `Server not configured` o `SUPABASE_URL not set`
- Env var faltante. Revisar Vercel → Settings → Environment Variables.

**Patrón D**: `Unauthorized` (401 no 500) — no es 500. Verificar que el usuario esté autenticado y su JWT sea válido.

**Patrón E**: timeout — la función excedió `maxDuration` configurado en `vercel.json`. Ver sección 4.

### 3. Revisar logs de Supabase (si involucra DB)

```
Supabase dashboard → project → Logs → Postgres
```

Filtrar por:
- Time range coincidente
- Errores o queries lentas

Errores comunes:
- Deadlock: dos transacciones colisionaron. Suele auto-resolverse; investigar solo si es recurrente.
- Statement timeout: query tomó demasiado. Optimizar con índice o límite explícito.
- Permission denied: RLS activado en una tabla que el endpoint no espera. Verificar RLS con `pg_class`.

### 4. Timeout de función

Vercel corta funciones que exceden `maxDuration` en `vercel.json`. Por defecto son 10s (plan Pro permite hasta 300s en Fluid).

Endpoints ya configurados con timeout extendido:

```json
{
  "api/generate-daily-report.js":       { "maxDuration": 60 },
  "api/generate-consolidated-report.js":{ "maxDuration": 60 },
  "api/generate-real-estate-report.js": { "maxDuration": 60 },
  "api/generate-fixed-income-report.js":{ "maxDuration": 60 },
  "api/generate-crypto-report.js":      { "maxDuration": 60 },
  "api/cron/portfolio-snapshot.js":     { "maxDuration": 60 },
  "api/cron/backup-nightly.js":         { "maxDuration": 300 },
  "api/cron/crypto-snapshot.js":        { "maxDuration": 30 },
  "api/admin-backfill-snapshots.js":    { "maxDuration": 60 },
  "api/admin-backfill-prices.js":       { "maxDuration": 60 }
}
```

Si un endpoint nuevo timea, añadirlo a esta lista (con el valor mínimo necesario, no siempre el máximo).

### 5. Reproducir localmente

Con las env vars de producción cargadas en `.env.local` (nunca commitearlas):

```bash
cd /path/to/dceh
vercel dev
# Abrir otro terminal
curl -X POST http://localhost:3000/api/<nombre> -H "..." -d '{...}'
```

Reproducir el request exacto que falló. Si no reproduce localmente, ver 5.1.

### 5.1 Si no reproduce local

Posibles causas:
- Datos en producción que no están en local (usar la copia de nightly backup, ver `RUNBOOK_DR.md`)
- Env var diferente (verificar con `printenv | grep DCE` en Vercel función logs)
- Concurrencia (dos requests simultáneos que en local nunca colisionan)

### 6. Fix y deploy

Una vez identificada la causa:

- Codear el fix
- Añadir un guard/validación para que el mismo bug no vuelva
- Ver [deploy.md](./deploy.md)

Post-deploy, verificar en logs que el error dejó de aparecer.

### 7. Post-mortem

Si el error afectó a usuarios o interrumpió operación, escribir 3-5 líneas en `docs/INCIDENTS.md` (crear si no existe):

- Fecha, endpoint, duración
- Causa raíz
- Fix aplicado
- Prevención a futuro (si aplica)

## Errores conocidos y su solución rápida

| Síntoma | Causa probable | Fix |
|---|---|---|
| `ADMIN_TOKEN_SECRET` no definido | Rotación mal aplicada | Verificar env var en Vercel + redeploy |
| Login OK pero endpoints protegidos dan 401 | JWT válido pero role incorrecto | `SELECT role FROM admin_users WHERE email = ...` |
| Cron devuelve 401 desde `curl` manual | `CRON_SECRET` cambió | Usar el valor actual |
| `pdfkit` throw en generate-report | Fuente faltante o payload inválido | Ver logs y validar input schema |
| Storage upload falla con 400 | Path colision o bucket mal configurado | Verificar bucket existe y policy `public` correcta |
| `dataroom_files` INSERT falla | folder_id no existe en `dataroom_folders` | Validar FK antes del INSERT |
