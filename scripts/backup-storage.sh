#!/usr/bin/env bash
# Backup de buckets de Supabase Storage
# Usado por .github/workflows/weekly-backup.yml
#
# Variables de entorno requeridas:
#   SUPABASE_URL                 -- https://xxx.supabase.co
#   SUPABASE_SERVICE_ROLE_KEY    -- secret key
#   BACKUP_DIR                   -- carpeta destino (ej: backups/2026-W18)
#   STAMP                        -- timestamp para nombrar archivos

set -euo pipefail

: "${SUPABASE_URL:?SUPABASE_URL no definida}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY no definida}"
: "${BACKUP_DIR:?BACKUP_DIR no definida}"
: "${STAMP:?STAMP no definida}"

MANIFEST_FILE="${BACKUP_DIR}/storage_manifest_${STAMP}.json"
STORAGE_DIR="${BACKUP_DIR}/storage_${STAMP}"
BUCKETS=("reports" "study")

mkdir -p "$STORAGE_DIR"

echo "[storage] listando buckets..."
curl -sf -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  "$SUPABASE_URL/storage/v1/bucket" > /tmp/buckets.json
echo "[storage] buckets encontrados:"
cat /tmp/buckets.json

# Construye manifest JSON
{
  echo "{"
  echo "  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"buckets\": $(cat /tmp/buckets.json),"
  echo "  \"objects\": {"
} > "$MANIFEST_FILE"

first=1
for bucket in "${BUCKETS[@]}"; do
  if [ $first -eq 0 ]; then
    echo "    ," >> "$MANIFEST_FILE"
  fi
  first=0
  echo "    \"$bucket\":" >> "$MANIFEST_FILE"

  # Lista objetos del bucket
  curl -sf -X POST \
    -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
    -H "Content-Type: application/json" \
    -d '{"prefix":"","limit":10000,"offset":0,"sortBy":{"column":"name","order":"asc"}}' \
    "$SUPABASE_URL/storage/v1/object/list/$bucket" \
    > "/tmp/${bucket}_list.json" || echo "[]" > "/tmp/${bucket}_list.json"

  cat "/tmp/${bucket}_list.json" >> "$MANIFEST_FILE"
done

{
  echo "  }"
  echo "}"
} >> "$MANIFEST_FILE"

# Validacion JSON
python3 -m json.tool "$MANIFEST_FILE" > /dev/null && echo "[storage] manifest JSON valido"

# Descarga de archivos
for bucket in "${BUCKETS[@]}"; do
  mkdir -p "$STORAGE_DIR/$bucket"

  # Extrae nombres de archivos (objetos con id != null)
  python3 -c "
import json, sys
with open('/tmp/${bucket}_list.json') as f:
    data = json.load(f)
if isinstance(data, list):
    for o in data:
        if o.get('id'):
            print(o['name'])
" > "/tmp/${bucket}_files.txt"

  count=0
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    dest="$STORAGE_DIR/$bucket/$path"
    mkdir -p "$(dirname "$dest")"
    if curl -sf -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
        "$SUPABASE_URL/storage/v1/object/$bucket/$path" \
        -o "$dest"; then
      count=$((count+1))
    else
      echo "[storage] FAIL: $bucket/$path"
    fi
  done < "/tmp/${bucket}_files.txt"

  echo "[storage] bucket $bucket: $count archivos descargados"
done

# Tarball
tar -czf "${STORAGE_DIR}.tar.gz" -C "$BACKUP_DIR" "$(basename "$STORAGE_DIR")"
rm -rf "$STORAGE_DIR"
ls -lh "${STORAGE_DIR}.tar.gz"
echo "[storage] backup completo"
