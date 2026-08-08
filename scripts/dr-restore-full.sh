#!/usr/bin/env bash
# scripts/dr-restore-full.sh
#
# DCE Holdings — Restore end-to-end desde un snapshot.
#
# Este script asume que:
#   - Tienes un snapshot dr-snapshot-YYYY-MM-DD_HHMM.tar.gz descomprimido
#   - Ya creaste un nuevo proyecto Supabase (o vas a reusar el actual)
#   - Ya creaste un nuevo proyecto Vercel (o vas a reusar el actual)
#   - Tienes las env vars del nuevo Supabase a mano
#   - Tienes acceso a GoDaddy para apuntar DNS
#
# Uso:
#   export TARGET_SUPABASE_URL="https://<new-project>.supabase.co"
#   export TARGET_SUPABASE_KEY="<new-service-role-key>"
#   export TARGET_DB_URL="postgresql://postgres.<ref>:<pass>@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"
#   ./scripts/dr-restore-full.sh --snapshot ./dr-snapshot-2026-08-08_1015
#
# Flags:
#   --snapshot PATH        (required) directorio del snapshot descomprimido
#   --dry-run              (default) valida sin escribir
#   --execute              aplica los cambios
#   --skip-storage         no re-subir archivos (solo DB)
#   --skip-schema          no aplicar migrations (asumir que ya existen)
#   --code-repo URL        override del repo de codigo (default: dceh de config)

set -euo pipefail

# ── Args ──────────────────────────────────────────────────────────────
SNAPSHOT=""
MODE="dry-run"
SKIP_STORAGE=false
SKIP_SCHEMA=false
CODE_REPO_OVERRIDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --snapshot)      SNAPSHOT="$2"; shift 2 ;;
    --dry-run)       MODE="dry-run"; shift ;;
    --execute)       MODE="execute"; shift ;;
    --skip-storage)  SKIP_STORAGE=true; shift ;;
    --skip-schema)   SKIP_SCHEMA=true; shift ;;
    --code-repo)     CODE_REPO_OVERRIDE="$2"; shift 2 ;;
    *) echo "ERROR: flag desconocido: $1"; exit 1 ;;
  esac
done

if [[ -z "$SNAPSHOT" ]] || [[ ! -d "$SNAPSHOT" ]]; then
  echo "ERROR: --snapshot <dir> requerido y debe existir"
  echo ""
  echo "Ejemplo:"
  echo "  ./scripts/dr-restore-full.sh --snapshot ./dr-snapshot-2026-08-08_1015 --dry-run"
  exit 1
fi

TARGET_SUPABASE_URL="${TARGET_SUPABASE_URL:-}"
TARGET_SUPABASE_KEY="${TARGET_SUPABASE_KEY:-}"

if [[ "$MODE" == "execute" ]]; then
  if [[ -z "$TARGET_SUPABASE_URL" ]] || [[ -z "$TARGET_SUPABASE_KEY" ]]; then
    echo "ERROR: en modo --execute necesitas TARGET_SUPABASE_URL y TARGET_SUPABASE_KEY"
    exit 1
  fi
fi

echo "==============================================================="
echo "  DCE Holdings — Disaster Recovery Restore"
echo "==============================================================="
echo "  Modo:     $MODE"
echo "  Snapshot: $SNAPSHOT"
[[ -n "$TARGET_SUPABASE_URL" ]] && echo "  Target:   $TARGET_SUPABASE_URL"
echo ""

# ── 0. Verify snapshot integrity ──────────────────────────────────────
echo "→ 0. Verificando snapshot..."
[[ -f "$SNAPSHOT/config/site-metadata.json" ]] || { echo "ERROR: falta site-metadata.json"; exit 1; }
[[ -f "$SNAPSHOT/database/manifest.json" ]] || { echo "ERROR: falta database/manifest.json"; exit 1; }
[[ -d "$SNAPSHOT/database/tables" ]] || { echo "ERROR: falta database/tables/"; exit 1; }

TABLE_COUNT=$(ls "$SNAPSHOT/database/tables" | wc -l | tr -d ' ')
FILE_COUNT=$(find "$SNAPSHOT/storage" -type f 2>/dev/null | wc -l | tr -d ' ')
ORIGINAL_META=$(cat "$SNAPSHOT/config/site-metadata.json")
ORIGINAL_PROJECT=$(echo "$ORIGINAL_META" | jq -r '.supabase_project_id')
ORIGINAL_DOMAIN=$(echo "$ORIGINAL_META" | jq -r '.domain')

echo "   Snapshot valido."
echo "   Tablas en snapshot:   $TABLE_COUNT"
echo "   Archivos en snapshot: $FILE_COUNT"
echo "   Proyecto original:    $ORIGINAL_PROJECT"
echo "   Dominio original:     $ORIGINAL_DOMAIN"
echo ""

# ── 1. Schema (migrations) ────────────────────────────────────────────
echo "→ 1. Schema (migrations)"
if [[ "$SKIP_SCHEMA" == "true" ]]; then
  echo "   [skip-schema] Saltando aplicacion de migrations."
elif [[ -z "${TARGET_DB_URL:-}" ]]; then
  echo "   [warn] TARGET_DB_URL no configurado — saltando."
  echo "   Aplica manualmente todas las migrations del repo dceh en supabase/migrations/*.sql"
else
  MIGRATIONS_DIR="$(dirname "$0")/../supabase/migrations"
  if [[ ! -d "$MIGRATIONS_DIR" ]]; then
    echo "   [warn] No se encuentra $MIGRATIONS_DIR — aplica migrations manualmente"
  else
    MIGRATION_FILES=$(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | sort)
    COUNT=$(echo "$MIGRATION_FILES" | wc -l | tr -d ' ')
    echo "   Encontradas $COUNT migrations en $MIGRATIONS_DIR"
    if [[ "$MODE" == "execute" ]]; then
      for M in $MIGRATION_FILES; do
        echo "     Aplicando $(basename $M)..."
        psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f "$M" > /dev/null
      done
      echo "   ✓ Schema aplicado."
    else
      echo "   [dry-run] no aplicado."
    fi
  fi
fi
echo ""

# ── 2. Data (tables) ──────────────────────────────────────────────────
echo "→ 2. Data (tablas)"
if [[ "$MODE" == "execute" ]]; then
  # Order matters: parents before children. This order matches the CRITICAL_TABLES
  # order in backup-nightly.js which was designed for foreign key sanity.
  ORDER=(
    "admin_users" "allowed_users" "analysts"
    "dataroom_folders" "dataroom_files" "dataroom_hidden_files"
    "study_articles" "study_files" "source_documents" "company_dashboards"
    "pipeline_cards" "pipeline_card_assets"
    "decision_journal" "decision_inputs_packages"
    "premortems" "premortem_revisions" "failure_modes"
    "reunderwriting_due" "reunderwriting_entries" "trigger_evaluations"
    "transactions" "trades" "portfolio_snapshots" "cashflows"
    "time_deposits" "real_estate_marks" "dividend_schedule" "iv_tracking"
    "watchlist" "tickers_tracked" "radar"
    "idea_feed_sources" "idea_feed_items" "user_news_tickers"
    "screener_snapshot" "discipline_rules"
    "push_subscriptions" "price_alerts"
    "earnings_alerts_sent" "earnings_calendar" "calendar_extras" "calendar_blocklist"
    "comments"
    "prices_daily" "fx_daily"
    "dr_test_log" "dr_snapshot_log"
  )

  for T in "${ORDER[@]}"; do
    F="$SNAPSHOT/database/tables/${T}.json"
    if [[ ! -f "$F" ]]; then
      echo "   [warn] $T no en snapshot, saltando"
      continue
    fi
    ROWS_JSON=$(jq -c '.rows' "$F")
    ROW_COUNT=$(echo "$ROWS_JSON" | jq 'length')
    if [[ "$ROW_COUNT" == "0" ]]; then
      echo "   $T: 0 filas (skip)"
      continue
    fi
    echo "   $T: subiendo $ROW_COUNT filas..."
    curl -sS -X POST "${TARGET_SUPABASE_URL}/rest/v1/${T}" \
      -H "apikey: ${TARGET_SUPABASE_KEY}" \
      -H "Authorization: Bearer ${TARGET_SUPABASE_KEY}" \
      -H "Content-Type: application/json" \
      -H "Prefer: resolution=merge-duplicates" \
      --data-binary "$ROWS_JSON" > /dev/null
  done
  echo "   ✓ Data restaurada."
else
  echo "   [dry-run] simulando restore de $TABLE_COUNT tablas"
  for F in "$SNAPSHOT"/database/tables/*.json; do
    T=$(basename "$F" .json)
    RC=$(jq '.row_count' "$F")
    echo "     $T ($RC filas)"
  done | head -20
  [[ $TABLE_COUNT -gt 20 ]] && echo "     ... (+$(($TABLE_COUNT - 20)) tablas mas)"
fi
echo ""

# ── 3. Storage (dataroom files) ───────────────────────────────────────
echo "→ 3. Storage (Data Room)"
if [[ "$SKIP_STORAGE" == "true" ]]; then
  echo "   [skip-storage] Saltando."
elif [[ ! -d "$SNAPSHOT/storage/dataroom" ]]; then
  echo "   [warn] $SNAPSHOT/storage/dataroom no existe — no hay files que restaurar"
elif [[ "$MODE" == "execute" ]]; then
  # Create bucket if not exists (idempotent — 400 if it exists).
  curl -sS -X POST "${TARGET_SUPABASE_URL}/storage/v1/bucket" \
    -H "apikey: ${TARGET_SUPABASE_KEY}" \
    -H "Authorization: Bearer ${TARGET_SUPABASE_KEY}" \
    -H "Content-Type: application/json" \
    -d '{"id":"dataroom","name":"dataroom","public":false}' > /dev/null || true

  UPLOADED=0
  find "$SNAPSHOT/storage/dataroom" -type f | while read F; do
    REL="${F#$SNAPSHOT/storage/dataroom/}"
    # Detect content type by extension (basic).
    case "$F" in
      *.pdf)  CT="application/pdf" ;;
      *.xlsx) CT="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ;;
      *.docx) CT="application/vnd.openxmlformats-officedocument.wordprocessingml.document" ;;
      *)      CT="application/octet-stream" ;;
    esac
    curl -sS -X POST "${TARGET_SUPABASE_URL}/storage/v1/object/dataroom/${REL}" \
      -H "apikey: ${TARGET_SUPABASE_KEY}" \
      -H "Authorization: Bearer ${TARGET_SUPABASE_KEY}" \
      -H "Content-Type: ${CT}" \
      -H "x-upsert: true" \
      --data-binary "@${F}" > /dev/null
    UPLOADED=$((UPLOADED + 1))
    [[ $((UPLOADED % 10)) -eq 0 ]] && echo "   ($UPLOADED archivos...)"
  done
  echo "   ✓ Storage restaurado ($UPLOADED archivos)."
else
  echo "   [dry-run] $FILE_COUNT archivos serian subidos al bucket dataroom"
fi
echo ""

# ── 4. Redeploy code ──────────────────────────────────────────────────
echo "→ 4. Codigo & redeploy"
REPO_URL="${CODE_REPO_OVERRIDE:-$(echo "$ORIGINAL_META" | jq -r '.github_repo')}"
echo "   Repo: https://github.com/$REPO_URL"
if [[ "$MODE" == "execute" ]]; then
  echo ""
  echo "   Pasos manuales:"
  echo "   4.1  Clonar el repo si no lo tienes:"
  echo "        git clone https://github.com/$REPO_URL /tmp/dceh-restore"
  echo "        cd /tmp/dceh-restore"
  echo ""
  echo "   4.2  Importar el repo a Vercel:"
  echo "        - Ve a vercel.com/new"
  echo "        - Importar $REPO_URL"
  echo "        - Framework: 'Other'"
  echo ""
  echo "   4.3  Configurar env vars en Vercel:"
  echo "        Ve a Project Settings > Environment Variables y configura:"
  echo "        - SUPABASE_URL:              $TARGET_SUPABASE_URL"
  echo "        - SUPABASE_SERVICE_ROLE_KEY: [target key]"
  echo "        - ADMIN_TOKEN_SECRET:        [de tu archivo secrets-encrypted.gpg]"
  echo "        - Otros ~15 secrets:         [ver runbook RESTORE.md]"
  echo ""
  echo "   4.4  Trigger deploy:"
  echo "        vercel --prod --token \$VERCEL_TOKEN"
else
  echo "   [dry-run] no ejecutado"
fi
echo ""

# ── 5. DNS (GoDaddy) ──────────────────────────────────────────────────
echo "→ 5. DNS (GoDaddy)"
echo "   Dominio: $ORIGINAL_DOMAIN"
echo ""
echo "   Pasos manuales (en godaddy.com):"
echo "   5.1  Login → My Products → Domains → $ORIGINAL_DOMAIN → Manage DNS"
echo "   5.2  Buscar el registro CNAME o A que apunta al deployment"
echo "   5.3  Actualizar:"
echo "        - Si Vercel: apuntar CNAME 'www' a 'cname.vercel-dns.com'"
echo "        - Y A record '@' a las IPs de Vercel (76.76.21.21)"
echo "   5.4  Esperar 5-10 minutos para propagacion"
echo "   5.5  Verificar: dig $ORIGINAL_DOMAIN"
echo ""

# ── 6. Smoke tests ────────────────────────────────────────────────────
echo "→ 6. Smoke tests"
echo "   Cuando el sitio este de vuelta, probar:"
echo "   curl -sI https://www.$ORIGINAL_DOMAIN/                 (debe dar 200)"
echo "   curl -sI https://www.$ORIGINAL_DOMAIN/api/alerts       (200 o 401)"
echo "   curl -sI https://www.$ORIGINAL_DOMAIN/api/earnings     (200 o 401)"
echo "   curl -sI https://www.$ORIGINAL_DOMAIN/sw.js            (200 con SW_VERSION)"
echo ""

echo "==============================================================="
if [[ "$MODE" == "dry-run" ]]; then
  echo "  DRY RUN completado — nada fue modificado."
  echo "  Corre con --execute para aplicar los cambios."
else
  echo "  RESTORE EJECUTADO"
  echo "  Verifica cada paso y sigue con la fase 4-6 manualmente."
fi
echo "==============================================================="
