# Runbooks — DCE Holdings App

Procedimientos operativos técnicos. Cada archivo cubre un solo escenario y es autocontenido.

**Cómo leer**: identificar el escenario y abrir el runbook. Cada uno indica cuándo usarlo, duración estimada y pasos numerados.

## Índice

### Operación diaria
- [`deploy.md`](./deploy.md) — Desplegar cambios a producción
- [`rollback.md`](./rollback.md) — Revertir a un deploy anterior

### Usuarios y seguridad
- [`add_admin_user.md`](./add_admin_user.md) — Crear un usuario admin o analyst
- [`rotate_admin_token_secret.md`](./rotate_admin_token_secret.md) — Rotar el secreto JWT
- [`rotate_secrets.md`](./rotate_secrets.md) — Rotación completa de todos los secretos (ofboarding, auditoría)

### Investigación
- [`investigate_500.md`](./investigate_500.md) — Diagnosticar errores 500 en la API
- [`investigate_cron_failure.md`](./investigate_cron_failure.md) — Diagnosticar por qué un cron programado no funcionó

### Datos
- [`apply_migration.md`](./apply_migration.md) — Aplicar cambios de schema a la DB
- [`data_correction.md`](./data_correction.md) — Corregir un dato erróneo en producción
- [`restore_from_backup.md`](./restore_from_backup.md) — Restaurar desde el backup nightly

### Onboarding
- [`handoff_checklist.md`](./handoff_checklist.md) — Checklist de recepción del sistema

## Referencias externas

- `../IT_HANDBOOK.md` — Manual técnico completo del sistema
- `../../RUNBOOK_DR.md` — Plan detallado de disaster recovery (raíz del repo)

## Convenciones

- **Comandos con `<placeholder>`**: sustituir por el valor real antes de ejecutar
- **`SUPABASE_MCP` o "Supabase MCP"**: referirse a la CLI/API oficial de Supabase o al SQL editor del dashboard según se prefiera
- **`api_credentials`**: convención interna para invocación programática — usar el mecanismo equivalente del entorno operativo
