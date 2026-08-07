# Runbook — Hand-off (recepción del sistema)

**Cuándo usar**: al recibir el sistema por primera vez (equipo de IT nuevo, cambio de proveedor).

**Duración**: 4-8 horas para completar. Marcar cada ítem al validarlo.

## Fase 1 — Lectura

- [ ] Leer `docs/IT_HANDBOOK.md` completo (30-45 min)
- [ ] Leer los runbooks en `docs/RUNBOOKS/`:
  - [ ] `deploy.md`
  - [ ] `rollback.md`
  - [ ] `add_admin_user.md`
  - [ ] `rotate_admin_token_secret.md`
  - [ ] `rotate_secrets.md`
  - [ ] `investigate_500.md`
  - [ ] `investigate_cron_failure.md`
  - [ ] `apply_migration.md`
  - [ ] `data_correction.md`
  - [ ] `restore_from_backup.md`
- [ ] Leer `RUNBOOK_DR.md` (raíz del repo) — plan completo de disaster recovery
- [ ] Leer `README.md` si existe

## Fase 2 — Accesos

- [ ] Recibir invitación al team de **Vercel** — confirmar acceso al proyecto `dceh`
- [ ] Recibir invitación como **Owner** o **Admin** en el proyecto **Supabase** `mlmmcciknvydlekztqtj`
- [ ] Recibir acceso `write` al repo **GitHub** `luisjosedelcid/dceh`
- [ ] Recibir acceso `write` al repo **GitHub** `luisjosedelcid/dceh-backups`
- [ ] Recibir acceso al proveedor del dominio para gestionar DNS (dceholdings.app)
- [ ] Confirmar que hay cuenta admin propia en la app (`admin_users`) — solicitar creación siguiendo `add_admin_user.md`
- [ ] Recibir acceso al gestor de contraseñas donde viven los env vars de rescate
- [ ] Confirmar recepción de canal Slack (o equivalente) donde llegan alertas

## Fase 3 — Setup local

- [ ] Clonar el repo:
  ```bash
  git clone git@github.com:luisjosedelcid/dceh.git
  cd dceh
  ```
- [ ] Instalar dependencias:
  ```bash
  npm install
  ```
- [ ] Instalar Vercel CLI:
  ```bash
  npm i -g vercel
  vercel login
  vercel link  # asociar el directorio al proyecto dceh
  ```
- [ ] Verificar que `vercel env pull .env.local` funciona (permite jalar env vars localmente, nunca commitear el archivo)
- [ ] Levantar la app localmente:
  ```bash
  vercel dev
  # abrir http://localhost:3000
  ```

## Fase 4 — Verificación de accesos

### 4.1 Login en la app

- [ ] Abrir https://www.dceholdings.app/admin-login.html
- [ ] Login con credencial propia
- [ ] Confirmar que se llega al home admin

### 4.2 Consulta directa a Postgres

Vía SQL editor de Supabase:

- [ ] Ejecutar:
  ```sql
  SELECT count(*) FROM admin_users;
  SELECT count(*) FROM decision_journal;
  SELECT count(*) FROM transactions;
  SELECT MAX(started_at) FROM backup_log WHERE status = 'success';
  ```
- [ ] Verificar que el último backup exitoso fue en las últimas 26 horas

### 4.3 Trigger de cron manual

- [ ] Obtener `CRON_SECRET` del gestor de contraseñas
- [ ] Ejecutar:
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" \
       "https://www.dceholdings.app/api/cron/backup-nightly?dry=1&kind=manual"
  ```
- [ ] Confirmar respuesta 200 con JSON de status

### 4.4 Deploy de prueba

Ejercicio para validar todo el pipeline sin arriesgar:

- [ ] En un branch local, hacer un cambio trivial (ej. añadir un espacio en un comentario)
- [ ] Push a `main`:
  ```bash
  git commit -m "test: verificar pipeline de deploy tras hand-off"
  git push origin main
  ```
- [ ] Ver el deploy en Vercel dashboard → build exitoso
- [ ] Smoke test: la app carga en https://www.dceholdings.app/
- [ ] Anotar la duración del build (baseline para futuras comparaciones)

## Fase 5 — Simulacros

### 5.1 Simulacro de rollback

- [ ] Elegir un deploy previo estable en Vercel Deployments
- [ ] Simular: identificar cuál sería el "deploy previo" si el actual fallara
- [ ] **No ejecutar la promoción**. Solo confirmar que se sabe dónde está el botón

### 5.2 Simulacro de restauración de dato

Sin aplicar cambios reales:

- [ ] Elegir una fila de una tabla no crítica
- [ ] Practicar la query de recuperación desde `backup_log` + descarga del JSON de esa tabla en el último backup
- [ ] Confirmar que se sabe cómo obtener el valor histórico

### 5.3 Simulacro de investigación

- [ ] Ir a Vercel dashboard → Deployments → deploy actual → Functions → cualquier función activa → Logs
- [ ] Filtrar por últimas 24 horas → identificar el volumen normal de requests y detectar cualquier error inesperado
- [ ] Confirmar que se sabe cómo llegar a los logs de un endpoint específico

## Fase 6 — Handshake final

- [ ] Reunión de cierre con el titular anterior:
  - [ ] Preguntas abiertas resueltas
  - [ ] Deudas técnicas comprendidas (sección 16 del handbook)
  - [ ] Conocimiento tácito documentado (cosas que no están en los runbooks)
- [ ] Actualizar la lista de contactos:
  - [ ] Confirmar quién es el titular actual (persona con `admin` en `admin_users`)
  - [ ] Actualizar `docs/IT_HANDBOOK.md` sección "Contacto" si aplica
- [ ] Programar rotación inicial de secretos como acto simbólico de takeover:
  - [ ] Seguir `rotate_secrets.md`
  - [ ] Documentar la rotación con fecha

## Fase 7 — Cadencia recurrente propuesta

Establecer estas rutinas desde el día 1:

- [ ] **Diario**: revisar `backup_log` — confirmar que la corrida nocturna tuvo `status = 'success'`
- [ ] **Semanal**: revisar Vercel logs por error rate; revisar `admin_audit_log` por logins sospechosos
- [ ] **Mensual**: verificar que ningún cron está fallando de forma sostenida
- [ ] **Trimestral**: rotación de `ADMIN_TOKEN_SECRET` (`rotate_admin_token_secret.md`)
- [ ] **Anual**: rotación completa de secretos (`rotate_secrets.md`) + simulacro de restore desde backup

## Bloqueos comunes en hand-off

**"No puedo hacer login"**: el usuario aún no está creado en `admin_users`. Solicitar creación con `add_admin_user.md`.

**"`vercel env pull` falla con permisos"**: la cuenta de Vercel no tiene rol suficiente en el team. Solicitar upgrade.

**"El SQL editor no me deja ejecutar"**: acceso solo lectura. Solicitar rol de writer al Supabase org owner.

**"El repo pide 2FA que no configuré"**: activar 2FA en GitHub. Es requisito para push.

**"No sé cuál es la URL de un cron manual"**: todos los crons están listados en `vercel.json`. Path exacto: `https://www.dceholdings.app/api/cron/<nombre-en-vercel-json>`.
