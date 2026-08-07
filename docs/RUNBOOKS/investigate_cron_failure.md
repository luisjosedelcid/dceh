# Runbook — Investigar un cron que falló

**Cuándo usar**: un cron programado no dejó rastro esperado (backup no aparece, snapshot faltante, alerta no llegó).

**Duración**: 15-30 minutos.

## Procedimiento

### 1. Confirmar que el cron debió dispararse

Consultar `vercel.json` para el schedule exacto del cron en cuestión. Los schedules están en UTC.

```bash
# Ejemplo: backup-nightly corre a 03:30 UTC diariamente
node -e "const j=JSON.parse(require('fs').readFileSync('vercel.json','utf8')); j.crons.forEach(c=>console.log(c.schedule.padEnd(20), c.path))" | grep backup-nightly
```

### 2. Verificar en Vercel que Vercel Cron intentó dispararlo

- Vercel dashboard → project → **Cron Jobs** (menú lateral)
- Filtrar por el cron en cuestión
- Ver historial de ejecuciones recientes

Cada ejecución muestra: timestamp, duración, HTTP status devuelto por la función, y link a logs.

Casos posibles:

**Caso A**: no aparece ninguna ejecución en la hora esperada.
- Vercel Cron falló al dispararlo (raro pero ocurre; ver Vercel status page)
- El cron fue removido de `vercel.json` sin darse cuenta
- **Acción**: disparar manualmente (paso 5), y reportar a Vercel si el patrón se repite

**Caso B**: aparece ejecución con status 401.
- El cron rechazó la invocación
- Suele significar que la validación de auth cambió y `x-vercel-cron-schedule` no fue reconocido
- **Acción**: revisar la lógica de auth en el archivo `api/cron/<nombre>.js`

**Caso C**: aparece ejecución con status 500.
- El cron intentó correr y falló. Ir al paso 3.

**Caso D**: aparece con status 200 pero el efecto esperado no ocurrió.
- La función devolvió éxito pero un branch interno saltó el trabajo
- Ir al paso 4

### 3. Revisar logs de la ejecución fallida

- Click en la ejecución en Vercel Cron Jobs → **View Logs**
- Buscar el stack trace o mensaje de error
- Aplicar el mismo diagnóstico que en [investigate_500.md](./investigate_500.md)

### 4. Consultar la tabla de log de la app (si existe)

Varios crons persisten su ejecución en una tabla. Los más importantes:

**`backup-nightly`**:
```sql
SELECT run_id, started_at, finished_at, status, tables_dumped, rows_total,
       files_mirrored, bytes_total, error
FROM backup_log
ORDER BY started_at DESC
LIMIT 10;
```

**`screener-refresh`**:
```sql
SELECT captured_at, snapshot_id, tickers_processed, error
FROM screener_snapshot
ORDER BY captured_at DESC
LIMIT 10;
```

**`portfolio-snapshot`**:
```sql
SELECT date, positions_count, mv_total
FROM portfolio_snapshots
ORDER BY date DESC
LIMIT 10;
```

**`prices-refresh`**:
```sql
SELECT MAX(date) AS latest, COUNT(DISTINCT ticker) AS tickers
FROM prices_daily;
-- Comparar contra la fecha esperada
```

Si el log muestra `status = 'failed'` con `error` diagnóstico, ya tienes el punto de partida. Si no hay fila, el cron ni siquiera llegó al primer INSERT.

### 5. Disparar manualmente para reproducir

Todos los crons aceptan invocación manual con el bearer token:

```bash
CRON_SECRET="<obtener de Vercel env vars>"
curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://www.dceholdings.app/api/cron/<nombre>?kind=manual"
```

Flags útiles según cron:
- `?dry=1` — no persiste efectos (útil para probar sin ensuciar datos)
- `?skip_dataroom=1` (solo backup) — omite mirror de storage
- `?kind=manual` — marca la corrida como manual en logs

Vía UI admin: hay un endpoint `/api/admin/run-cron.js` que dispara crons con formato JSON.

### 6. Fixear

Según diagnóstico:

- Bug en el código del cron → fix + deploy (ver [deploy.md](./deploy.md))
- Env var faltante → añadir en Vercel + redeploy
- Datos inconsistentes que el cron no manejó → limpiar los datos, y añadir un guard defensivo en el cron

### 7. Verificar que la siguiente ejecución automática funciona

Esperar al próximo trigger natural del cron y verificar que corrió bien. No cerrar el ticket hasta ver una corrida verde automática (no manual).

## Alertas proactivas

Configurar (si aún no existen) alertas Slack cuando un cron crítico falla más de una vez consecutiva:

- Añadir un hook al final del cron que, si `status === 'failed'`, envíe un mensaje a `SLACK_ALERT_WEBHOOK`
- Alternativa: un cron meta-observador que corra cada hora y compare la última fila de cada tabla de log contra la frecuencia esperada
