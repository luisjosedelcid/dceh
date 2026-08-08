#!/usr/bin/env bash
# scripts/dr-download-snapshot.sh
#
# Descarga el snapshot mas reciente del bucket privado Supabase a tu Mac local.
# Requiere: bash, curl, jq, tar (todos en macOS por defecto).
#
# Uso:
#   export ADMIN_TOKEN="<pega tu admin token desde localStorage de la app>"
#   ./scripts/dr-download-snapshot.sh
#
# El token se saca asi:
#   1. Abrir dceholdings.app > Settings, estar loggeado como CIO
#   2. Abrir DevTools > Application > Local Storage > pplx-admin-token
#   3. Copiar el string completo
#
# Output: dr-snapshot-YYYY-MM-DD_HHMM.tar.gz en el directorio actual.

set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────
API_BASE="${API_BASE:-https://www.dceholdings.app}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
OUT_DIR="${OUT_DIR:-.}"

if [[ -z "$ADMIN_TOKEN" ]]; then
  echo "ERROR: ADMIN_TOKEN no esta seteado."
  echo ""
  echo "Como obtenerlo:"
  echo "  1. Abrir https://www.dceholdings.app/settings.html"
  echo "  2. Loggearte como CIO"
  echo "  3. Chrome DevTools > Application > Local Storage > pplx-admin-token"
  echo "  4. export ADMIN_TOKEN='<pega aqui>'"
  echo ""
  exit 1
fi

# ── 1. Trigger snapshot ───────────────────────────────────────────────
echo "→ Solicitando snapshot al servidor..."
RESP=$(curl -sS -X POST "${API_BASE}/api/admin/dr-snapshot" \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"kind":"manual"}')

if ! echo "$RESP" | jq -e '.ok' > /dev/null; then
  echo "ERROR: snapshot fallo."
  echo "$RESP" | jq .
  exit 1
fi

SNAP_NAME=$(echo "$RESP" | jq -r '.snapshot_name')
BYTES=$(echo "$RESP" | jq -r '.bytes_total')
TABLES=$(echo "$RESP" | jq -r '.tables_included')
FILES=$(echo "$RESP" | jq -r '.files_included')
DURATION=$(echo "$RESP" | jq -r '.duration_seconds')
DL_URL=$(echo "$RESP" | jq -r '.download_url')

SIZE_MB=$(echo "scale=1; $BYTES / 1048576" | bc)
echo "  Snapshot generado: $SNAP_NAME"
echo "  Tamano: ${SIZE_MB} MB"
echo "  Tablas: $TABLES"
echo "  Archivos: $FILES"
echo "  Duracion: ${DURATION}s"

# ── 2. Download ───────────────────────────────────────────────────────
OUT_FILE="${OUT_DIR}/${SNAP_NAME}.tar.gz"
mkdir -p "$OUT_DIR"
echo ""
echo "→ Descargando desde signed URL a ${OUT_FILE}..."
curl -sS -o "$OUT_FILE" "$DL_URL"

ACTUAL_BYTES=$(stat -f%z "$OUT_FILE" 2>/dev/null || stat -c%s "$OUT_FILE")
if [[ "$ACTUAL_BYTES" != "$BYTES" ]]; then
  echo "WARN: tamano descargado ($ACTUAL_BYTES B) != tamano reportado ($BYTES B)"
fi

SHA256=$(shasum -a 256 "$OUT_FILE" | awk '{print $1}')
echo "  Descargado: ${OUT_FILE}"
echo "  SHA-256:    ${SHA256}"
echo ""

# ── 3. Verify contents ────────────────────────────────────────────────
echo "→ Verificando integridad..."
TABLE_COUNT=$(tar -tzf "$OUT_FILE" | grep -c '/database/tables/' || true)
FILE_COUNT=$(tar -tzf "$OUT_FILE" | grep -c '/storage/dataroom/' || true)
HAS_MANIFEST=$(tar -tzf "$OUT_FILE" | grep -c '/database/manifest.json' || true)
HAS_METADATA=$(tar -tzf "$OUT_FILE" | grep -c '/config/site-metadata.json' || true)
HAS_README=$(tar -tzf "$OUT_FILE" | grep -c '/README.md' || true)

echo "  Tablas en tarball:    $TABLE_COUNT (esperado: $TABLES)"
echo "  Archivos en tarball:  $FILE_COUNT (esperado: $FILES)"
echo "  manifest.json:        $([[ $HAS_MANIFEST -ge 1 ]] && echo OK || echo FALTA)"
echo "  site-metadata.json:   $([[ $HAS_METADATA -ge 1 ]] && echo OK || echo FALTA)"
echo "  README.md:            $([[ $HAS_README -ge 1 ]] && echo OK || echo FALTA)"

if [[ $TABLE_COUNT -ne $TABLES ]] || [[ $FILE_COUNT -ne $FILES ]]; then
  echo ""
  echo "WARN: conteos no cuadran. Snapshot puede estar incompleto."
  exit 2
fi

echo ""
echo "✓ Snapshot descargado y verificado."
echo ""
echo "Siguiente paso (opcional):"
echo "  Copiar a Google Drive:"
echo "    Abre Finder → arrastra ${OUT_FILE} a tu carpeta de Drive"
echo ""
echo "  O restaurar si fuera necesario:"
echo "    tar -xzf ${OUT_FILE}"
echo "    cat ${SNAP_NAME}/README.md"
echo ""
