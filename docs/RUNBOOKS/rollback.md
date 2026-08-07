# Runbook — Rollback a un deploy anterior

**Cuándo usar**: un deploy recién promovido causa un error en producción que no se puede corregir rápido con un nuevo push.

**Duración**: 30 segundos.

## Procedimiento

### 1. Identificar el deploy previo estable

- Ir al dashboard de Vercel: https://vercel.com/[team]/dceh/deployments
- Listar deployments filtrados por `Production`
- El deploy actual está marcado `Current`. El siguiente hacia abajo es el previo.
- Confirmar que ese deploy estaba funcionando bien antes de promocionarlo (revisar mensaje de commit, timestamp).

### 2. Promocionar el deploy previo

- Click en el deploy previo → menú de tres puntos (`⋯`) → **Promote to Production**
- Confirmar en el modal

La promoción es instantánea: Vercel redirige el tráfico al deploy antiguo. No se hace re-build.

### 3. Verificar

```bash
curl -sI https://www.dceholdings.app/ | head -3
# Debe responder HTTP/2 200
```

Comprobar en la UI que el problema original desapareció.

### 4. Corregir el deploy problemático

El rollback compra tiempo. El problema del deploy fallido debe corregirse:

1. `git log --oneline -5` para ver el commit problemático
2. Reproducir el bug localmente con esos cambios aplicados
3. Fix y nuevo push (ver [deploy.md](./deploy.md))

**No revertir el commit vía `git revert`** salvo que el cambio ya esté descartado — el objetivo es fixear, no borrar el historial.

## Alternativa vía CLI (si el dashboard no está disponible)

Con Vercel CLI instalada y logueada:

```bash
# Listar deployments
vercel ls dceh

# Promover uno específico
vercel promote <deployment-url>
```

## Consideraciones

- **Migrations de DB**: si el deploy fallido incluyó cambios de schema (nueva columna, tabla), el rollback del código deja la DB con el schema nuevo. Puede que el código antiguo funcione con el schema nuevo (usualmente sí, si el cambio fue aditivo). Si no, hay que revertir la migration por separado.
- **Env vars**: los env vars están asociados al proyecto, no al deploy. Cambios en env vars no se revierten con este procedimiento.
- **Service worker**: si el deploy fallido bumpeó SW_VERSION, el rollback devuelve al SW anterior. Los clientes se re-actualizarán al abrir la app.
