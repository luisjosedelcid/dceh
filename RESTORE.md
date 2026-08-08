# DCE Holdings — Disaster Recovery Runbook

**Última actualización**: 2026-08-08
**Owner**: Luis del Cid (luis@dceholdings.com)
**Frecuencia de simulacro**: trimestral (fire drill desde Settings > Disaster Recovery)

---

## 1. Anatomía del sitio

Antes de restaurar necesitas entender qué se pierde y qué se conserva. El sitio tiene **5 componentes independientes**:

| # | Componente | Vive en | Backup semanal | Restore desde |
|---|-----------|---------|----------------|----------------|
| 1 | Código (HTML, JS, endpoints) | GitHub `luisjosedelcid/dceh` | Ya está en GitHub (permanente) | `git clone` |
| 2 | Base de datos (Supabase Postgres) | Supabase project `mlmmcciknvydlekztqtj` | Snapshot semanal → GitHub `dceh-backups` | Restore desde snapshot |
| 3 | Archivos (PDF/XLSX del Data Room) | Supabase Storage bucket `dataroom` | Snapshot semanal → GitHub `dceh-backups` | Restore desde snapshot |
| 4 | Secretos (env vars) | Vercel project settings | **Manual — GPG file en Mac + password manager** | Copiar del archivo GPG |
| 5 | Dominio (`dceholdings.app`) | GoDaddy | Ya está en tu cuenta | Actualizar CNAME/A |

**Lo crítico**: los componentes 1, 2 y 3 se restauran solos con el snapshot. **El componente 4 (secretos) tú lo tienes que restaurar manualmente** del archivo GPG en tu Mac. Es el punto único de fallo humano — si pierdes ese archivo o la passphrase, el sitio no se puede levantar automáticamente.

---

## 2. Fuentes de verdad

### Snapshots automáticos
- **Cron**: `/api/cron/dr-snapshot-weekly` corre los domingos 05:00 UTC.
- **Contenido**: código (referencia SHA1 al commit), DB entera (47 tablas críticas), Data Room entero, metadata del sitio.
- **Destino primario**: repo privado `luisjosedelcid/dceh-backups`, path `snapshots/YYYY-MM-DD/dr-snapshot-<date>_<time>.tar.gz`.
- **Destino secundario**: bucket privado `backups` en Supabase, path `snapshots/YYYY-MM-DD_HHMM/`.
- **Retención**: 12 semanas (~3 meses) en `dceh-backups`. Los más viejos se purgan automáticamente por el cron.

### Snapshots on-demand
- Desde `dceholdings.app/settings.html` > **Sistema** > **Disaster Recovery** > botón **"Crear snapshot ahora"**.
- Retorna un signed URL de 15 min para descargar.
- Puedes también correr `scripts/dr-download-snapshot.sh` desde tu Mac.

### Archivo GPG de secretos
- **Path**: `~/dce-secrets/secrets.env.gpg` en tu Mac.
- **Passphrase**: en tu password manager (1Password / iCloud Keychain), entry "DCE Holdings — DR passphrase".
- **Contenido**: variables de entorno de Vercel (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ADMIN_TOKEN_SECRET, VAPID keys, ROIC_API_KEY, todas las claves de connectors, etc.).
- **Actualización**: cada vez que agregues/cambies una env var en Vercel, actualiza el archivo GPG. Rutina trimestral en tu calendario.

---

## 3. Escenarios de fallo

### Escenario A: perdiste solo la DB
Supabase se corrompió, pero el código y el dominio están intactos.

1. Ir a `supabase.com` > tu proyecto > o crear uno nuevo si el actual no responde.
2. Correr `scripts/dr-restore-full.sh --snapshot ./dr-snapshot-... --skip-storage --execute`.
3. En Vercel actualizar `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` si es proyecto nuevo.
4. Trigger redeploy.

**Tiempo estimado**: 30-60 min.

### Escenario B: perdiste solo los archivos del Data Room
El bucket `dataroom` se vació, pero DB y código están bien.

1. Correr `scripts/dr-restore-full.sh --snapshot ./dr-snapshot-... --skip-schema --execute` (o `--skip-schema` para no aplicar migrations).
2. El script solo sube los archivos del snapshot al bucket.

**Tiempo estimado**: 15 min.

### Escenario C: catástrofe total (Supabase + Vercel muertos)
El escenario que este runbook resuelve principalmente.

Ver **§ 4 Procedimiento completo**.

### Escenario D: perdiste el dominio en GoDaddy
Poco probable, pero:

1. Si expiró: pagar renovación en GoDaddy (30 días de gracia).
2. Si te lo hackearon: soporte GoDaddy 24/7, chat en godaddy.com.
3. Si es catastrófico (perdiste GoDaddy entero): comprar `dceholdings.app` en otro registrar o usar `dceholdings.com` si lo tienes.

---

## 4. Procedimiento completo — restore end-to-end

**Duración estimada**: 2-4 horas la primera vez; menos si ya lo simulaste.

### Paso 0 — Verificar recursos
Antes de arrancar necesitas:
- Tu Mac con Terminal, Node, git, curl, jq, tar (todos vienen instalados o vía brew).
- Acceso a tu cuenta Vercel (`vercel.com/luisjosedelcid`).
- Acceso a tu cuenta Supabase (`supabase.com`).
- Acceso a tu cuenta GoDaddy.
- El archivo `~/dce-secrets/secrets.env.gpg` y su passphrase.

### Paso 1 — Descargar el snapshot más reciente
Opción A (recomendado): desde tu Mac.
```bash
cd ~/dce-restore
git clone https://github.com/luisjosedelcid/dceh-backups.git
cd dceh-backups
# El snapshot más reciente:
ls -la snapshots/ | tail -3
# Extraer:
mkdir -p ../restore-work
tar -xzf snapshots/YYYY-MM-DD/dr-snapshot-YYYY-MM-DD_HHMM.tar.gz -C ../restore-work
cd ../restore-work
cat dr-snapshot-*/README.md   # Instrucciones del snapshot
```

Opción B: si `dceh-backups` no está disponible, usar Supabase bucket directamente:
```bash
# Solo si el sitio aún corre y puedes autenticarte:
cd ~/dce-restore
./dceh/scripts/dr-download-snapshot.sh
tar -xzf dr-snapshot-*.tar.gz
```

### Paso 2 — Crear nuevo proyecto Supabase (si el actual está muerto)
1. `supabase.com` > New Project.
2. Region: `eu-west-1` (misma que la original).
3. Plan: Pro.
4. Nombre: `dceh-restored-YYYY-MM-DD`.
5. Guardar:
   - Project URL (algo como `https://abcdefgh.supabase.co`)
   - Anon key
   - Service role key
   - Direct DB connection string (Settings > Database > Connection string > "URI" en "Session pooler")

### Paso 3 — Aplicar schema
Todas las migrations están en `dceh/supabase/migrations/*.sql` en el repo. Clonar y aplicar:
```bash
git clone https://github.com/luisjosedelcid/dceh.git ~/dce-restore/dceh
export TARGET_DB_URL="postgresql://postgres.NEW_REF:PASSWORD@aws-0-eu-west-1.pooler.supabase.com:5432/postgres"
cd ~/dce-restore/dceh/supabase/migrations
for f in *.sql; do
  echo "Aplicando $f..."
  psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -f "$f"
done
```

### Paso 4 — Restaurar datos y archivos
Desde la carpeta del snapshot extraído:
```bash
export TARGET_SUPABASE_URL="https://abcdefgh.supabase.co"
export TARGET_SUPABASE_KEY="<service-role-key>"

cd ~/dce-restore/dceh
./scripts/dr-restore-full.sh \
  --snapshot ../restore-work/dr-snapshot-YYYY-MM-DD_HHMM \
  --skip-schema \
  --execute
```

El script:
- Sube todas las filas de todas las tablas (orden FK-safe).
- Sube todos los archivos del Data Room al bucket `dataroom`.

Verificar en `supabase.com` > Table Editor y Storage.

### Paso 5 — Restaurar secretos
```bash
cd ~/dce-secrets
gpg --output secrets.env --decrypt secrets.env.gpg
# Introducir la passphrase de tu password manager.
# Ahora tienes secrets.env con todas las env vars.
```

Ir a `vercel.com/luisjosedelcid/dceh/settings/environment-variables` (o crear un proyecto nuevo si el actual está muerto):
1. Actualizar `SUPABASE_URL` con el URL del nuevo proyecto.
2. Actualizar `SUPABASE_SERVICE_ROLE_KEY` con la nueva service key.
3. Copiar el resto de las variables tal cual de `secrets.env`.

**IMPORTANTE**: borrar `secrets.env` (sin `.gpg`) apenas termines. No commitear nunca al repo.

### Paso 6 — Redeploy
Si el proyecto Vercel existe:
```bash
cd ~/dce-restore/dceh
git push origin main --force-with-lease   # o solo git push si no cambiaste nada
# O trigger deploy desde Vercel dashboard: Deployments > "Redeploy"
```

Si el proyecto Vercel no existe:
1. `vercel.com/new` > importar `luisjosedelcid/dceh`.
2. Framework preset: "Other".
3. Build command: dejar en blanco (es static + serverless).
4. Output directory: `public`.
5. Deploy.

### Paso 7 — Actualizar DNS en GoDaddy
1. `godaddy.com` > sign in > My Products > Domains > `dceholdings.app` > "DNS" o "Manage DNS".
2. Buscar los registros existentes.
3. Actualizar / crear:
   - Type `A`, Name `@`, Value `76.76.21.21` (Vercel IP).
   - Type `CNAME`, Name `www`, Value `cname.vercel-dns.com`.
4. Guardar.
5. Esperar 5-15 min para propagación.

En Vercel > tu proyecto > Settings > Domains, agregar `dceholdings.app` y `www.dceholdings.app`. Vercel emitirá el certificado SSL automáticamente.

### Paso 8 — Smoke tests
Verificar que el sitio responde:
```bash
curl -sI https://www.dceholdings.app/                    # 200
curl -sI https://www.dceholdings.app/api/alerts          # 200 o 401
curl -sI https://www.dceholdings.app/api/earnings        # 200 o 401
curl -sI https://www.dceholdings.app/sw.js               # 200 con SW_VERSION
```

Abrir el sitio en el navegador. Loggearte. Verificar:
- Cockpit muestra portafolio.
- Data Room lista archivos.
- Decision Journal lista entradas.
- Screener corre.

Si algo falla, revisar Vercel logs: `vercel.com/luisjosedelcid/dceh/logs`.

### Paso 9 — Post-restore
1. Generar un snapshot inmediato desde Settings > DR > "Crear snapshot ahora" (para tener uno del nuevo entorno).
2. Actualizar este documento si algo cambió.
3. Programar el próximo fire drill (calendario, trimestral).

---

## 5. Fire drill (simulacro trimestral)

Cada trimestre corre un simulacro **sin restaurar** para verificar que el snapshot es sano:

Opción A (recomendado): desde `dceholdings.app/settings.html` > **Sistema** > **Disaster Recovery** > **"Correr simulacro (fire drill)"**.

Opción B: desde tu Mac (independiente del sitio):
```bash
cd ~/dce-restore
./dceh/scripts/dr-download-snapshot.sh   # Descarga latest
# El script verifica automáticamente conteos, integridad de tarball, etc.
```

Si el fire drill falla, **NO ES OPCIONAL** arreglarlo antes de volver a trabajar: es la única forma de saber que el sistema de respaldo funciona antes de necesitarlo.

---

## 6. Checklist recuperación rápida (imprimible)

Ver `RESTORE-CHECKLIST.pdf` (2 páginas, para pegar en la pared).

---

## 7. Historial de este runbook

| Fecha | Cambio |
|-------|--------|
| 2026-08-08 | Versión inicial. Fases 1 y 2 del sistema DR completadas. |

---

## 8. Preguntas frecuentes

**¿Y si pierdo la passphrase del GPG?**
No hay recovery. Por eso está en el password manager Y (opcional) escrita en papel en la caja fuerte de tu casa. Rota la passphrase cada año.

**¿Se puede automatizar el paso 4 (secretos)?**
No con la seguridad actual. Si automatizamos, tenemos que guardar la passphrase o el service key en algún lado — que es exactamente el vector de ataque que evitamos. La fricción humana ES el control.

**¿Cuánto cuesta correr un fire drill?**
$0. El endpoint solo lee del bucket, descomprime en memoria, verifica y escribe una fila de log. No crea infra nueva ni consume storage.

**¿Cuánto cuesta un snapshot?**
~$0.001 por snapshot (~5-15 MB en tráfico Supabase + storage temporal en GitHub, borrado a las 12 semanas). Anual: <$0.10.
