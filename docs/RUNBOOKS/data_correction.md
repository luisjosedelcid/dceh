# Runbook — Corregir un dato erróneo en producción

**Cuándo usar**: un usuario reporta un dato incorrecto (una transacción mal ingresada, un journal entry con thesis errónea, un ticker mal escrito). El objetivo es corregir sin perder trazabilidad.

**Regla general**: preferir corrección aplicativa (endpoint de PATCH) sobre `UPDATE` directo en SQL. Todo cambio manual en DB debe quedar auditable.

## Antes de empezar

Preguntar:

1. **Cuál es exactamente el dato incorrecto** (id de fila, si se conoce; si no, campo + criterios de búsqueda)
2. **Cuál es el valor correcto**
3. **Cómo se ingresó el dato incorrecto** (permite decidir si hay un bug de captura que además hay que arreglar)
4. **Si el dato ha sido usado en cálculos derivados** (portfolio value, P&L, dashboards) que también hay que recomputar

## Procedimiento

### 1. Backup manual antes de tocar nada

Aunque el cambio parezca trivial, correr un backup manual antes:

```bash
CRON_SECRET="<obtener de Vercel>"
curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://www.dceholdings.app/api/cron/backup-nightly?kind=manual"
```

Esperar 1-2 minutos y verificar que aparece en `backup_log`:

```sql
SELECT * FROM backup_log ORDER BY started_at DESC LIMIT 1;
-- Debe mostrar status='success', kind='manual'
```

### 2. Identificar el registro exacto

```sql
-- Ejemplo: transacción MSFT del 2026-07-14 con cantidad errónea
SELECT id, ticker, action, quantity, price, transacted_at, created_at
FROM transactions
WHERE ticker = 'MSFT'
  AND transacted_at::date = '2026-07-14';
```

Guardar el `id` exacto. Nunca hacer UPDATE por múltiples criterios sin haber visto la fila primero.

### 3. Preferir el endpoint aplicativo

Si existe un endpoint que hace la corrección con lógica de negocio (recalcula derivados, actualiza timestamps, deja audit trail):

```bash
TOKEN="<jwt admin>"
curl -X PATCH https://www.dceholdings.app/api/transactions/<id> \
     -H "x-admin-token: $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"quantity": 250}'
```

Buscar en el código: `grep -rn "PATCH\|PUT" api/ | grep -i <recurso>`.

### 4. Si no hay endpoint, UPDATE manual con precauciones

**Envolver siempre en transacción y con `WHERE id = <id>`**:

```sql
BEGIN;

UPDATE transactions
SET quantity = 250,
    updated_at = now()
WHERE id = '<uuid exacto>';

-- Verificar antes de commit
SELECT id, quantity, updated_at FROM transactions WHERE id = '<uuid exacto>';

-- Si se ve bien:
COMMIT;
-- Si algo se ve mal:
ROLLBACK;
```

**Nunca hacer**:
- `UPDATE ... WHERE ticker = 'X'` sin id (puede afectar más filas de las esperadas)
- Cambios sin `BEGIN;/COMMIT;` — impide `ROLLBACK` en caso de error
- Cambios sin actualizar `updated_at` si la columna existe

### 5. Registrar la corrección manualmente

Si el sistema no tiene una tabla de audit para el recurso corregido, dejar constancia manual:

```sql
-- Si existe una tabla comments o notes:
INSERT INTO comments (entity_type, entity_id, author, body, created_at)
VALUES ('transaction', '<uuid>', 'IT_team',
        'Corrección manual: quantity 200 → 250. Motivo: reporte del usuario.',
        now());
```

O como último recurso, un archivo `docs/DATA_CORRECTIONS.md` en el repo con fecha, quién, qué se corrigió y por qué.

### 6. Recomputar dependencias

Si el dato corregido alimenta cálculos derivados:

- **Portfolio snapshots**: correr `portfolio-snapshot` para las fechas afectadas
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" \
       "https://www.dceholdings.app/api/cron/portfolio-snapshot?date=2026-07-14"
  ```
  o vía `/api/admin-backfill-snapshots.js` para rango
- **Performance**: recomputar en `/api/performance.js` si guarda cache
- **Dashboards**: si son estáticos por ticker, regenerar el JSON del dashboard afectado

### 7. Confirmar con el usuario

Notificar al usuario que reportó el error:

> Corrección aplicada. Transacción [id] actualizada de quantity 200 a 250. Portfolio snapshot del 2026-07-14 recalculado. Verifica en la app.

Esperar confirmación de que ve el dato correcto antes de cerrar el ticket.

## Recuperación si algo sale mal

Si el UPDATE afectó más filas de las intended:

1. **NO hacer más UPDATEs para intentar deshacer** — riesgo de empeorar
2. Contactar al titular inmediatamente
3. Restaurar la tabla completa desde el backup nightly de antes del cambio (paso 1). Ver `RUNBOOK_DR.md` sección "Restaurar una tabla desde nightly backup".
4. Documentar el incidente en `docs/INCIDENTS.md`

## Casos comunes con recetas

### Journal entry con thesis incorrecta

```sql
-- ver
SELECT id, ticker, decision_type, thesis, decision_date
FROM decision_journal
WHERE ticker = 'MSFT' AND decision_date = '2026-05-15';

-- corregir
BEGIN;
UPDATE decision_journal
SET thesis = 'Nueva thesis correcta...',
    updated_at = now()
WHERE id = '<uuid>';
COMMIT;
```

### Ticker mal escrito

Cambiar ticker en múltiples tablas requiere cuidado — hay FKs implícitas:

```sql
BEGIN;
-- Tabla principal
UPDATE transactions SET ticker = 'GOOGL' WHERE ticker = 'GOOG' AND transacted_at = '...';
-- Tablas relacionadas si comparten el string 'ticker' como clave
UPDATE prices_daily SET ticker = 'GOOGL' WHERE ticker = 'GOOG' AND date > '...';
-- Verificar
SELECT COUNT(*) FROM transactions WHERE ticker = 'GOOG';
SELECT COUNT(*) FROM prices_daily WHERE ticker = 'GOOG';
-- Ambos deben ser 0
COMMIT;
```

### Precio histórico incorrecto

```sql
BEGIN;
UPDATE prices_daily
SET close = 425.13, updated_at = now()
WHERE ticker = 'MSFT' AND date = '2026-07-14';
COMMIT;

-- Recomputar snapshots que usaron ese precio
```

### Archivo del Data Room subido a carpeta equivocada

```sql
UPDATE dataroom_files
SET folder_id = '<nuevo folder_uuid>', updated_at = now()
WHERE id = '<file_uuid>';
```

El archivo en storage no se mueve — solo el metadata. El path físico sigue siendo el mismo pero el archivo aparece bajo la nueva carpeta en la UI.
