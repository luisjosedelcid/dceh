# Runbook — Deploy a producción

**Frecuencia esperada**: 0-5 veces al día. **Duración**: 3-5 minutos activos + 90 segundos de espera.

## Pre-requisitos

- Acceso `write` al repo `luisjosedelcid/dceh`
- Acceso al dashboard de Vercel del proyecto `dceh`
- Cambios en local ya probados manualmente

## Procedimiento

### 1. Confirmar el estado local

```bash
cd /path/to/dceh
git status
git diff --stat
```

Debe mostrar solo los archivos que se pretende desplegar. Si aparecen archivos no relacionados, hacer `git checkout -- <archivo>` para descartarlos antes de continuar.

### 2. Bumpear SW_VERSION (obligatorio si hay cambios en frontend)

Si se modificó cualquier `.html`, `.css`, o `.js` de cliente en `public/`:

```bash
# Ver versión actual
grep "^const SW_VERSION" public/sw.js
# Output: const SW_VERSION = 'dce-v111';

# Bumpear (incrementar el número al final)
sed -i "s/const SW_VERSION = 'dce-v111'/const SW_VERSION = 'dce-v112'/" public/sw.js

# Confirmar
grep "^const SW_VERSION" public/sw.js
```

Si solo se cambió código en `api/*` o `scripts/*`, saltar este paso.

### 3. Validar sintaxis local

```bash
# Vercel config
node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))" && echo "vercel.json OK"

# Cualquier archivo JS nuevo o modificado en api/
node --check api/path/to/modified.js && echo "OK"
```

### 4. Commit y push

```bash
git add -A
git commit -m "descripción breve del cambio

Detalle del cambio en varias líneas si aplica.
Referencia a ticket o issue si existe."

git push origin main
```

### 5. Monitorear el build en Vercel

- Abrir el dashboard: https://vercel.com/[team]/dceh/deployments
- Ver el deploy más reciente en estado `Building`
- Duración típica: 60-90 segundos

Si el build falla:

- Click en el deploy → **Build Logs**
- Errores comunes: sintaxis inválida (no debería pasar si se validó en paso 3), env var faltante, dependencia rota
- Corregir localmente y repetir desde paso 4

### 6. Smoke test post-deploy

Al terminar el build, el deploy se promociona automáticamente. Verificar:

```bash
# 1. La app carga
curl -sI https://www.dceholdings.app/ | head -3
# Debe responder HTTP/2 200

# 2. Endpoint público responde
curl -s https://www.dceholdings.app/api/finnhub-search?q=AAPL | head -c 100
# Debe responder JSON válido

# 3. Endpoint protegido rechaza sin auth
curl -sI https://www.dceholdings.app/api/admin/journal | head -1
# Debe responder HTTP/2 401
```

### 7. Smoke test funcional (si el cambio es UI)

Abrir la app en un navegador nuevo o incógnito:

- Login
- Navegar a la sección modificada
- Verificar que los cambios se ven correctamente
- Refrescar (Ctrl+F5) para forzar re-descarga del SW

Si el SW no se actualiza (usuario ve la versión vieja):

- Confirmar que SW_VERSION se bumpeó (paso 2)
- El cliente debe cerrar y reabrir la app; puede tomar hasta un refresh completo

## Rollback

Si el deploy causa problemas en producción, ver [rollback.md](./rollback.md).

## Checklist express

- [ ] Cambios locales revisados con `git diff`
- [ ] SW_VERSION bumpeado si aplica
- [ ] Sintaxis validada
- [ ] Commit con mensaje descriptivo
- [ ] Push a `main`
- [ ] Build de Vercel exitoso
- [ ] Smoke test HTTP básico
- [ ] Smoke test funcional si es UI
