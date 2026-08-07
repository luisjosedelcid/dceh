# Runbook — Rotación completa de secretos

**Cuándo usar**:
- Ofboarding de personal técnico con acceso a Vercel/Supabase/GitHub
- Sospecha de compromiso de credenciales
- Auditoría periódica de seguridad (recomendado: anual)

**Duración**: 30-60 minutos si se hace en orden.

## Orden recomendado

1. `SUPABASE_SERVICE_ROLE_KEY` (impacta al backend entero)
2. `ADMIN_TOKEN_SECRET` (invalida sesiones)
3. `CRON_SECRET` (afecta a jobs programados)
4. API keys de terceros (efecto local por servicio)
5. `VAPID_*` keys (push notifications, opcional)

## 1. `SUPABASE_SERVICE_ROLE_KEY`

Este es el más crítico: cualquier request al backend lo usa para hablar con Postgres.

### 1.1 Generar nueva key

- Supabase dashboard → project → **Settings → API**
- Sección `service_role` → **Reset service_role secret** → confirmar
- Copiar el nuevo valor (aparece solo una vez)

### 1.2 Actualizar en Vercel

- Vercel → project → **Settings → Environment Variables**
- Editar `SUPABASE_SERVICE_ROLE_KEY` → pegar nuevo valor → guardar
- Redeployar (ver [deploy.md](./deploy.md), sección Redeploy)

### 1.3 Verificar

```bash
# Un endpoint que use Supabase debe responder correctamente
curl -sI https://www.dceholdings.app/api/finnhub-search?q=AAPL | head -1
# HTTP/2 200
```

Cualquier request devolviendo `Server not configured` o `SUPABASE_SERVICE_ROLE_KEY not set` indica que Vercel no aplicó el cambio. Redeployar de nuevo.

## 2. `ADMIN_TOKEN_SECRET`

Ver runbook dedicado: [rotate_admin_token_secret.md](./rotate_admin_token_secret.md).

## 3. `CRON_SECRET`

### 3.1 Generar

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 3.2 Actualizar en Vercel

Igual que en 1.2, con el nuevo valor.

### 3.3 Redeployar

Igual que en 1.2.

### 3.4 Verificar

```bash
# Los crons de Vercel siguen funcionando (usan header x-vercel-cron-schedule)
# Verificar que un cron manual con el nuevo secret funciona:
curl -H "Authorization: Bearer <NUEVO_CRON_SECRET>" \
     "https://www.dceholdings.app/api/cron/backup-nightly?dry=1"
# Debe responder JSON con status "success"

# Y que el viejo ya no funciona:
curl -H "Authorization: Bearer <VIEJO_CRON_SECRET>" \
     "https://www.dceholdings.app/api/cron/backup-nightly?dry=1"
# Debe responder 401
```

### 3.5 Actualizar clientes externos

Si hay algún automatismo fuera de Vercel que invoque crons con el secret (GitHub Actions, cron machines externas), actualizarlos también.

## 4. API keys de terceros

Cada una rota desde el dashboard del proveedor. Después actualizar en Vercel y redeployar.

| Env var | Rotar en |
|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → Settings → API Keys |
| `FINNHUB_KEY`, `FINNHUB_API_KEY` | finnhub.io → Dashboard → API Keys |
| `COINGECKO_API_KEY` | coingecko.com → Developer Dashboard |
| `RESEND_API_KEY` | resend.com → API Keys |
| `FINTEL_API_KEY` | fintel.io → Account → API |
| `ROIC_API_KEY`, `CUSTOM_CRED_API_ROIC_AI_TOKEN` | roic.ai → Account (verificar UI actual) |
| `SLACK_WEBHOOK_URL`, `SLACK_BOT_TOKEN` | api.slack.com → Apps del workspace |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | console.cloud.google.com → OAuth Credentials |

Rotar una key de tercero **no** requiere redeploy inmediato: solo cuando se quiera que el sistema use la nueva. Coordinar la rotación de key con el redeploy en el mismo minuto para evitar ventana con key inválida.

## 5. `VAPID_*` (opcional)

Rotar solo si sospecha de compromiso. **Efecto**: todas las suscripciones push existentes se invalidan; los usuarios deben re-consentir push notifications.

### 5.1 Generar nuevo par

```bash
npx web-push generate-vapid-keys
# Output:
# Public Key:  BN...
# Private Key: ...
```

### 5.2 Actualizar en Vercel

`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` — pegar los nuevos valores. `VAPID_SUBJECT` (`mailto:...`) puede dejarse igual.

### 5.3 Purgar suscripciones antiguas

```sql
TRUNCATE TABLE push_subscriptions;
```

Los usuarios re-suscribirán al próximo login.

## Checklist de rotación completa

- [ ] `SUPABASE_SERVICE_ROLE_KEY` rotada y verificada
- [ ] `ADMIN_TOKEN_SECRET` rotada y verificada
- [ ] `CRON_SECRET` rotado y verificado
- [ ] API keys de terceros rotadas (marcar cuáles)
- [ ] `VAPID_*` — decidir si aplica
- [ ] Usuarios notificados de re-login inminente
- [ ] Log de rotación actualizado
- [ ] Contraseñas antiguas removidas del gestor tras 24 horas de estabilidad
