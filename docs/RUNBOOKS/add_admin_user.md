# Runbook — Añadir un usuario administrador

**Cuándo usar**: cuando alguien nuevo necesita acceso a la app con rol `admin` o `analyst`.

**Duración**: 5 minutos.

## Pre-requisitos

- Acceso al proyecto Supabase con permisos de escritura sobre la tabla `admin_users`
- Node.js instalado localmente para generar el hash de bcrypt
- Email del nuevo usuario confirmado
- Password temporal que se le comunicará por canal seguro

## Procedimiento

### 1. Generar el hash bcrypt del password

**Localmente**, nunca en un servidor compartido:

```bash
# Crear script one-shot
cat > /tmp/hash_password.js <<'EOF'
const bcrypt = require('bcryptjs');
const password = process.argv[2];
if (!password) { console.error('Uso: node hash_password.js <password>'); process.exit(1); }
const hash = bcrypt.hashSync(password, 10);
console.log(hash);
EOF

# Ejecutar con el password del nuevo usuario
node /tmp/hash_password.js "PasswordTemporalSeguro123!"
# Output: $2a$10$AbCdEf...  (guardar esta línea)

# Borrar el script
rm /tmp/hash_password.js
```

### 2. Insertar en `admin_users`

Vía Supabase SQL editor o vía MCP:

```sql
INSERT INTO admin_users (email, password_hash, role, is_active, created_at)
VALUES (
  'nuevo@dceholdings.com',
  '$2a$10$AbCdEf...',        -- el hash del paso 1
  'admin',                    -- o 'analyst'
  true,
  now()
);
```

### 3. Verificar

```sql
SELECT email, role, is_active, created_at
FROM admin_users
WHERE email = 'nuevo@dceholdings.com';
```

Debe devolver una fila.

### 4. Comunicar al usuario

Por canal seguro (no email plano, no Slack público):

- URL: `https://www.dceholdings.app/admin-login.html`
- Email
- Password temporal
- Instrucción de cambiar el password en el primer login (funcionalidad debe existir en `/settings.html` → My account)

### 5. Verificar el login del nuevo usuario

Pedirle al usuario que confirme que pudo entrar. Si falla, revisar:

- `admin_audit_log` para ver si registró el intento y el motivo del fallo:
  ```sql
  SELECT * FROM admin_audit_log WHERE email = 'nuevo@dceholdings.com' ORDER BY created_at DESC LIMIT 5;
  ```
- Si el motivo es `invalid_password`: el hash generado no coincide con el password comunicado. Repetir desde paso 1.
- Si el motivo es `user_not_found`: revisar typo en el email.
- Si el motivo es `user_disabled`: `is_active` está en `false`. Corregir con `UPDATE admin_users SET is_active = true WHERE email = ...`.

## Roles disponibles

- `admin` — acceso completo. Puede crear/borrar journal entries, subir al Data Room, gestionar usuarios.
- `analyst` — lectura completa, escritura limitada. No puede gestionar usuarios ni tocar configuración de sistema.

Detalles finos de qué puede hacer cada rol están en `api/_require-role.js`.

## Desactivar un usuario

Preferir `is_active = false` sobre `DELETE`. Preserva referencias en logs de auditoría.

```sql
UPDATE admin_users SET is_active = false WHERE email = 'usuario@dceholdings.com';
```

## Reset de password si el usuario lo olvida

Dos rutas:

1. **Auto-servicio**: el usuario usa el flujo "Forgot password" en la página de login (`/api/auth/forgot-password.js` → email con token → `/api/auth/reset-password.js`).
2. **Manual**: repetir este runbook desde paso 1 con un password nuevo, y hacer `UPDATE admin_users SET password_hash = '...' WHERE email = '...'`.
