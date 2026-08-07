# Runbook — Rotar `ADMIN_TOKEN_SECRET`

**Cuándo usar**:
- Sospecha de compromiso del secreto
- Ofboarding de personal con acceso previo a Vercel
- Rotación periódica programada (recomendado: trimestral)

**Efecto**: invalida todos los JWTs vigentes. Todos los usuarios activos serán forzados a re-login. No hay downtime real del servicio, solo re-login masivo.

**Duración**: 10 minutos.

## Procedimiento

### 1. Generar el nuevo secreto

Localmente, generar 256 bits de aleatoriedad:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# Output: algo como  hK8s+xF3.....  (44 caracteres base64)
```

Guardar el valor temporalmente en un gestor de contraseñas — no en un archivo plano ni en un mensaje.

### 2. Actualizar en Vercel

- Ir a: `Vercel dashboard → project dceh → Settings → Environment Variables`
- Localizar `ADMIN_TOKEN_SECRET`
- Click en editar → **pegar el nuevo valor** → **seleccionar entornos**: `Production`, `Preview`, `Development`
- Guardar

### 3. Redesplegar

Los env vars en Vercel se leen en el momento del deploy. Es necesario redesplegar para que el cambio surta efecto:

**Opción A** (recomendada): trigger un deploy vacío desde Vercel dashboard → Deployments → **Redeploy** el commit actual, con la casilla "Use existing Build Cache" **desactivada** para forzar rebuild limpio.

**Opción B**: hacer un commit trivial (por ejemplo, bumpear SW_VERSION una vez más) y hacer push. Ver [deploy.md](./deploy.md).

Esperar 60-90 segundos a que el deploy termine.

### 4. Verificar que el nuevo secreto está activo

```bash
# Intentar hacer login con credenciales conocidas
curl -X POST https://www.dceholdings.app/api/admin-login \
  -H "Content-Type: application/json" \
  -d '{"email":"luis@dceholdings.com","password":"..."}'
# Debe devolver { token: "...", user: {...} }

# Copiar el token y probar un endpoint protegido
TOKEN="<token del paso anterior>"
curl -H "x-admin-token: $TOKEN" https://www.dceholdings.app/api/admin/journal
# Debe devolver JSON con entries
```

Si el login funciona pero el endpoint protegido devuelve 401 con el token nuevo:
- Vercel no completó el redeploy. Confirmar en Deployments que el deploy está en estado `Ready`.
- Puede haber caching intermedio; esperar 1-2 minutos más.

### 5. Notificar a los usuarios

Los usuarios activos verán sesión expirada al próximo request y serán redirigidos al login. Enviar un mensaje breve para que no sea sorpresa:

> Rotación de seguridad del sistema. Vas a tener que hacer login de nuevo. Tu password sigue siendo el mismo.

### 6. Documentar la rotación

Registrar la fecha en un log de rotaciones (puede ser una nota en el sistema, un archivo `SECURITY_LOG.md` en el repo — no incluir valores del secreto).

## Rollback (si algo sale mal)

Si tras la rotación nadie puede loguearse ni siquiera con credenciales válidas:

1. Revisar en Vercel Logs si el endpoint `/api/admin-login` tira excepción sobre `ADMIN_TOKEN_SECRET`
2. Si el nuevo valor está mal formateado (ej. tiene espacios): editarlo en Vercel y redeployar
3. En emergencia: revertir a un valor previo si aún lo tienes (en el gestor de contraseñas). No es un rollback limpio pero desbloquea.

## Rotación paralela de `CRON_SECRET`

Si se rota `ADMIN_TOKEN_SECRET` por sospecha de compromiso, considerar rotar también `CRON_SECRET` en la misma ventana. Ver [rotate_secrets.md](./rotate_secrets.md).
