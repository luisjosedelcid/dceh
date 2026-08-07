# Runbook — Restaurar desde el backup nightly

**Cuándo usar**: pérdida de datos, tabla corrupta, o rollback de una operación destructiva.

**Duración**: 15 minutos para una tabla, 30-60 minutos para varias.

## Cómo funciona el backup

Un cron corre a las 03:30 UTC diariamente (`api/cron/backup-nightly.js`, ver `vercel.json`). En cada corrida:

1. Vuelca todas las tablas críticas de Postgres a JSON, uno por tabla
2. Mirror del bucket `dataroom` completo
3. Sube todo al bucket privado `backups/` con path `backups/YYYY-MM-DD/`
4. Registra la corrida en la tabla `backup_log`

Retención: definida por `BACKUP_RETENTION_DAYS` en Vercel (default: 30 días).

## Procedimiento base

### 1. Identificar el backup a restaurar

```sql
SELECT run_id, started_at, finished_at, status, tables_dumped, files_mirrored, storage_prefix
FROM backup_log
WHERE status = 'success'
ORDER BY started_at DESC
LIMIT 10;
```

Elegir el backup más reciente **antes** del incidente. Anotar `storage_prefix` (formato `backups/YYYY-MM-DD/`).

### 2. Listar archivos del backup

Vía Supabase MCP o API storage:

```
GET /storage/v1/object/list/backups?prefix=backups/2026-08-06/
```

Ver runbook detallado en el archivo raíz del repo: `RUNBOOK_DR.md`, sección "Estructura del backup".

## Caso A — Restaurar una tabla completa

**Prerequisito**: la tabla existe con el schema correcto. Si el schema cambió, restaurar el schema primero (ver Caso C).

### A.1 Descargar el JSON de la tabla

Desde el SQL editor con acceso a storage:

```sql
SELECT storage.file_get(
  'backups',
  'backups/2026-08-06/dump/<tabla>.json'
);
```

O vía CLI si se tiene acceso:

```bash
# Requiere SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY
node scripts/download_backup.js --date 2026-08-06 --table decision_journal --out /tmp/
```

### A.2 Preparar la tabla actual

**Si la tabla tiene datos que no deben perderse**: no ejecutar `TRUNCATE`. Ver Caso D (restauración parcial).

**Si la tabla debe reemplazarse íntegramente**:

```sql
BEGIN;
TRUNCATE TABLE public.<tabla> RESTART IDENTITY CASCADE;
```

`CASCADE` cortará FKs a hijas. Confirmar que es lo esperado antes de ejecutar.

### A.3 Reimportar el JSON

Con un script Node one-shot:

```javascript
// scripts/restore_table.js (esbozo)
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = process.argv[2];      // ruta al JSON descargado
const table = process.argv[3];     // nombre de tabla
const rows = JSON.parse(fs.readFileSync(path, 'utf8'));
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
// Insertar en batches de 500 para evitar payload limits
for (let i = 0; i < rows.length; i += 500) {
  const batch = rows.slice(i, i + 500);
  const { error } = await supabase.from(table).insert(batch);
  if (error) throw error;
  console.log(`Inserted ${i + batch.length} / ${rows.length}`);
}
```

Ejecutar:

```bash
node scripts/restore_table.js /tmp/decision_journal.json decision_journal
```

### A.4 Verificar

```sql
SELECT COUNT(*) FROM public.<tabla>;
-- Comparar contra el conteo esperado del backup

SELECT MIN(created_at), MAX(created_at) FROM public.<tabla>;
-- Rango temporal debe cubrir hasta la fecha del backup
```

### A.5 Commit

Si todo salió bien:

```sql
COMMIT;
```

Si algo salió mal:

```sql
ROLLBACK;
```

## Caso B — Restaurar un archivo del Data Room

Los archivos están en el mirror del backup en `backups/YYYY-MM-DD/dataroom/`.

### B.1 Descargar el archivo

```
storage GET  backups/2026-08-06/dataroom/<path del archivo>
```

### B.2 Subir de vuelta al bucket `dataroom`

```
storage POST dataroom/<path original>
```

### B.3 Restaurar el metadata en `dataroom_files` si se perdió

```sql
INSERT INTO dataroom_files (id, folder_id, name, path, size_bytes, uploaded_at, uploaded_by)
VALUES ( ... );
```

Los valores pueden obtenerse del backup del JSON `dataroom_files.json` del mismo día.

## Caso C — Restaurar schema (DDL)

El backup nightly hace dump **solo de datos**, no de schema. Si el schema se rompió:

1. Revisar el historial de migrations en el repo: `supabase/migrations/`
2. Reaplicar las migrations en orden desde la última conocida como buena
3. Después restaurar datos (Caso A)

Si el estado del schema no es reconstruible desde el repo:

- Contactar soporte de Supabase — tienen backups internos de Postgres (PITR según plan)
- Escalable: promover la última DB branch conocida como buena

## Caso D — Restauración parcial (merge)

Cuando parte de los datos actuales debe preservarse y parte del backup debe reincorporarse. Ejemplo típico: un UPDATE masivo se ejecutó por error hace 6 horas; solo hay que revertir las filas que ese UPDATE tocó, no toda la tabla.

### D.1 Cargar el backup en una tabla temporal

```sql
CREATE TEMPORARY TABLE _restore_journal AS
  SELECT * FROM public.decision_journal WHERE 1=0;
-- Insertar el JSON del backup en _restore_journal (script Node como Caso A pero apuntando a la tabla temp)
```

### D.2 Comparar

```sql
SELECT r.id, r.thesis AS thesis_backup, j.thesis AS thesis_actual
FROM _restore_journal r
JOIN public.decision_journal j USING (id)
WHERE r.thesis IS DISTINCT FROM j.thesis;
```

### D.3 Aplicar el merge

Solo las filas afectadas:

```sql
BEGIN;
UPDATE public.decision_journal j
SET thesis = r.thesis, updated_at = now()
FROM _restore_journal r
WHERE r.id = j.id
  AND j.updated_at > '2026-08-06 12:00:00'   -- solo las modificadas después del backup
  AND r.thesis IS DISTINCT FROM j.thesis;
COMMIT;
```

## Verificación post-restauración

Correr smoke tests:

```bash
# La app responde
curl -sI https://www.dceholdings.app/ | head -1

# Los datos restaurados aparecen en la UI
# (login manual y verificar la sección afectada)
```

Y monitorear logs de Vercel durante 30 minutos para detectar errores inesperados por datos re-insertados.

## Post-mortem

Después de cualquier restauración desde backup:

1. Documentar en `docs/INCIDENTS.md`:
   - Qué se perdió
   - Cómo se detectó
   - Qué backup se usó
   - Ventana de datos perdidos entre el backup y el incidente
2. Considerar prevención:
   - ¿Bloqueo del UPDATE masivo detrás de un confirm?
   - ¿Aumentar frecuencia del backup a 12h?
   - ¿Point-in-time recovery de Supabase (upgrade de plan si aplica)?

## Referencia larga

El runbook completo con detalles (estructura exacta de archivos JSON, procedimiento de recovery para desastres mayores, contactos de soporte) está en el raíz del repo: `RUNBOOK_DR.md`.
