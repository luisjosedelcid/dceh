# Runbook — Aplicar una migration de base de datos

**Cuándo usar**: cualquier cambio DDL (CREATE TABLE, ALTER TABLE, DROP, CREATE INDEX, etc.) o data seed que debe reflejarse en producción y quedar auditable.

**Regla general**: nunca ejecutar DDL manualmente en el SQL editor de producción sin dejar registro. Toda migration debe quedar como archivo en el repo.

## Pre-requisitos

- Cambios probados primero en un branch de Supabase (ver 3.1) o en un entorno local si existe
- Migration escrita de forma **idempotente** (usar `IF NOT EXISTS`, `CREATE OR REPLACE`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`)
- Migration **reversible cuando sea posible**: incluir en un comentario el SQL de rollback

## Procedimiento

### 1. Crear el archivo de migration

Nombre con timestamp ordenable:

```bash
cd /path/to/dceh
DATE=$(date -u +%Y-%m-%d)
NAME="add_column_x_to_table_y"
FILE="supabase/migrations/${DATE}_${NAME}.sql"
touch "$FILE"
```

Estructura recomendada:

```sql
-- ============================================================================
-- Migration: 2026-08-07_add_column_x_to_table_y
-- Purpose:   Añade columna `x` a `table_y` para soportar la feature Z
-- Author:    IT team
-- Rollback:  ALTER TABLE table_y DROP COLUMN IF EXISTS x;
-- ============================================================================

ALTER TABLE public.table_y
  ADD COLUMN IF NOT EXISTS x TEXT;

COMMENT ON COLUMN public.table_y.x IS
  'Descripción del propósito de la columna';

-- Índice si la columna se va a usar en filtros frecuentes
CREATE INDEX IF NOT EXISTS idx_table_y_x
  ON public.table_y (x)
  WHERE x IS NOT NULL;
```

### 2. Probar la migration en un branch

**Opción A**: Supabase branches (recomendada si la migration es riesgosa).

```
Supabase MCP → create_branch → confirm_cost si aplica
             → apply_migration en el branch nuevo
             → verificar con execute_sql
             → si sale bien, merge_branch
             → si sale mal, delete_branch
```

**Opción B**: aplicar directamente en producción con migration idempotente.

Aceptable cuando:
- El cambio es aditivo puro (ADD COLUMN, CREATE TABLE, CREATE INDEX)
- Se ha revisado que ninguna consulta existente rompe con el cambio
- La migration es idempotente

### 3. Aplicar la migration

Vía Supabase MCP:

```
apply_migration(
  project_id="mlmmcciknvydlekztqtj",
  name="2026-08-07_add_column_x_to_table_y",
  query="<contenido del archivo .sql>"
)
```

Vía SQL editor de Supabase (menos preferible porque no queda en `list_migrations` con el nombre):
- Copiar el SQL al editor → Run

### 4. Verificar el estado

```sql
-- Verificar que la migration está registrada
SELECT version, name FROM supabase_migrations.schema_migrations
ORDER BY version DESC LIMIT 5;
-- Debe listar la nueva migration en top

-- Verificar el efecto (varía según la migration)
\d public.table_y   -- o SELECT column_name FROM information_schema.columns WHERE ...
```

### 5. Commit del archivo en repo

**Muy importante**: aunque la migration ya se aplicó, hay que dejar el archivo en el repo para que sea auditable y reproducible en otros entornos (branches, staging futuro).

```bash
git add supabase/migrations/2026-08-07_add_column_x_to_table_y.sql
git commit -m "db: add column x to table_y"
git push origin main
```

### 6. Desplegar código dependiente

Si el código de la app depende del cambio de schema, desplegar el nuevo código **después** de que la migration esté aplicada en producción, no antes. Ver [deploy.md](./deploy.md).

## Casos especiales

### Migration destructiva (DROP COLUMN, DROP TABLE)

- Confirmar que ningún endpoint ni cron referencia la columna/tabla:
  ```bash
  grep -rn "columna_a_borrar" api/ scripts/ public/
  ```
- Hacer backup manual antes:
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" \
       "https://www.dceholdings.app/api/cron/backup-nightly?kind=manual"
  ```
- Aplicar en ventana de baja actividad
- Confirmar durante 24 horas que nada rompió antes de eliminar el backup manual

### Migration de datos (UPDATE masivo)

- Si el UPDATE tocará más de ~10 000 filas, considerar hacerlo por lotes:
  ```sql
  UPDATE table_y SET x = ... WHERE id IN (SELECT id FROM table_y WHERE x IS NULL LIMIT 1000);
  -- Repetir hasta que no queden filas
  ```
- Puede ser preferible un script one-shot en `scripts/` en vez de una migration

### Cambio de tipo de columna

- Casi siempre requiere un enfoque en dos pasos:
  1. Añadir nueva columna del tipo correcto
  2. Copiar datos con casting
  3. Actualizar código para usar la nueva columna
  4. Eliminar la vieja en una migration posterior

## Recuperar del error

Si la migration deja la DB en un estado incorrecto:

1. **NO intentar arreglar con más SQL manual sin plan**
2. Ver el bloque `Rollback:` en el comentario de la migration (paso 1)
3. Aplicar el rollback como una migration nueva
4. Si el rollback tampoco funciona: contactar al titular y considerar restore desde el nightly backup previo (ver `RUNBOOK_DR.md`)
