#!/usr/bin/env bash
# DCE Holdings - Disaster Recovery Restore Script
#
# Uso:
#   ./scripts/restore-from-backup.sh <ruta-al-folder-de-backup> <NEW_DB_URL>
#
# Ejemplo:
#   ./scripts/restore-from-backup.sh ../dceh-backups/2026-W18 \
#     "postgresql://postgres.xxxx:PASS@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"
#
# El folder de backup debe contener:
#   - db_*.sql.gz             (dump del schema public)
#   - storage_*.tar.gz        (objetos de Supabase Storage)
#   - storage_manifest_*.json (metadatos)
#   - migrations_*.tar.gz     (archivos de migración del repo)

set -euo pipefail

BACKUP_DIR="${1:-}"
NEW_DB_URL="${2:-}"

if [ -z "$BACKUP_DIR" ] || [ -z "$NEW_DB_URL" ]; then
  echo "ERROR: argumentos requeridos"
  echo "Uso: $0 <backup-dir> <new-db-url>"
  exit 1
fi

if [ ! -d "$BACKUP_DIR" ]; then
  echo "ERROR: $BACKUP_DIR no existe"
  exit 1
fi

DUMP_FILE=$(ls "$BACKUP_DIR"/db_*.sql.gz 2>/dev/null | head -1)
STORAGE_TAR=$(ls "$BACKUP_DIR"/storage_*.tar.gz 2>/dev/null | head -1)

if [ -z "$DUMP_FILE" ]; then
  echo "ERROR: no se encontró db_*.sql.gz en $BACKUP_DIR"
  exit 1
fi

echo "==========================================="
echo "DCE Holdings — Disaster Recovery Restore"
echo "==========================================="
echo "Backup folder: $BACKUP_DIR"
echo "Dump file:     $DUMP_FILE"
echo "Storage tar:   ${STORAGE_TAR:-(no encontrado)}"
echo "Target DB:     ${NEW_DB_URL%%@*}@..."
echo "==========================================="
echo ""
echo "ADVERTENCIA: este script va a:"
echo "  1. Hacer DROP del schema public en la DB destino"
echo "  2. Restaurar todo desde el dump"
echo ""
read -rp "Escribe 'RESTAURAR' para continuar: " CONFIRM
if [ "$CONFIRM" != "RESTAURAR" ]; then
  echo "Abortado."
  exit 1
fi

echo ""
echo "[1/3] Drop del schema public..."
psql "$NEW_DB_URL" -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO postgres; GRANT ALL ON SCHEMA public TO public;"

echo ""
echo "[2/3] Restaurando dump..."
gunzip -c "$DUMP_FILE" | psql "$NEW_DB_URL" -v ON_ERROR_STOP=1

echo ""
echo "[3/3] Verificando..."
psql "$NEW_DB_URL" -c "SELECT count(*) AS public_tables FROM pg_tables WHERE schemaname='public';"
psql "$NEW_DB_URL" -c "SELECT 'prices_daily' AS tbl, count(*) FROM prices_daily UNION ALL SELECT 'transactions', count(*) FROM transactions UNION ALL SELECT 'decision_journal', count(*) FROM decision_journal;"

echo ""
echo "DB restaurada. Storage NO se ha restaurado automáticamente."
if [ -n "${STORAGE_TAR:-}" ]; then
  echo ""
  echo "Para restaurar Storage manualmente:"
  echo "  1. Crear los buckets reports y study en el nuevo proyecto Supabase"
  echo "  2. Extraer: tar -xzf $STORAGE_TAR -C /tmp/dceh-storage"
  echo "  3. Subir cada archivo con curl o usar Supabase CLI:"
  echo "     supabase storage cp --recursive /tmp/dceh-storage/reports ssb://reports"
  echo "     supabase storage cp --recursive /tmp/dceh-storage/study   ssb://study"
fi

echo ""
echo "Próximos pasos:"
echo "  - Actualizar SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en Vercel"
echo "  - Redeploy: git commit --allow-empty -m 'chore: post-restore redeploy' && git push"
echo "  - Smoke test: curl https://www.dceholdings.app/api/alerts (debe devolver 200)"
