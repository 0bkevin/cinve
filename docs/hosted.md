# Alojar Cinve

Cómo desplegar tu propio servidor HTTP de Cinve. Para usar el servicio público
no necesitas nada de esto.

## Requisitos

- Node.js 22 o posterior.
- Una base PostgreSQL dedicada (por ejemplo, Neon).
- Un dominio con HTTPS.

## Variables de entorno

| Variable                | Obligatoria | Descripción                                              |
| ----------------------- | ----------- | -------------------------------------------------------- |
| `DATABASE_URL`          | Sí          | Conexión a PostgreSQL con TLS.                           |
| `DATABASE_URL_UNPOOLED` | No          | Conexión directa para las migraciones.                   |
| `CINEV_PUBLIC_URL`      | Sí          | Origen HTTPS sin ruta: `https://cine.ejemplo.com`.       |
| `CINEV_ENCRYPTION_KEY`  | Sí          | Genérala con `openssl rand -hex 32`.                     |
| `CRON_SECRET`           | En Vercel   | Protege la limpieza diaria. Genéralo igual que la clave. |
| `PORT`                  | No          | Puerto fuera de Vercel (por defecto `3000`).             |

Conserva `CINEV_ENCRYPTION_KEY`: si cambia, todos deben reconectar sus cuentas.

## Desplegar en Vercel

1. Crea un proyecto y conecta una base PostgreSQL en la misma región.
2. Define las variables de entorno.
3. Aplica las migraciones: `npm run db:migrate`. Si tu red bloquea conexiones
   PostgreSQL directas a Neon:

   ```sh
   node --env-file=.env.production.local --import tsx scripts/migrate-neon.ts
   ```

4. Despliega y comprueba: `vercel --prod` y `curl https://<dominio>/health`.

`vercel.json` ya incluye las rutas y la limpieza diaria.

## Desplegar en otro servidor

```sh
npm ci
npm run build
npm run db:migrate
npm run start:hosted
```

Programa `npm run db:cleanup` una vez al día (por ejemplo, con cron).

Ponlo detrás de un proxy inverso con HTTPS, teniendo en cuenta que:

- El proxy debe conservar la cabecera `Host`; si no coincide con
  `CINEV_PUBLIC_URL`, el servidor responde 403. En Nginx:
  `proxy_set_header Host $host;`.
- Cinve no lee `X-Forwarded-For`: todos los usuarios comparten los límites por
  IP del proxy (por ejemplo, 20 inicios de sesión por minuto). Sirve para uso
  personal o de pocas personas.
- No instales con `--omit=dev`: las migraciones y la limpieza usan `tsx`.

## Proteger el servicio

- Limita solicitudes por IP en tu firewall o CDN para `/mcp`, `/oauth/*` y
  `/connect/*`.
- Fija un tamaño máximo de cómputo en la base de datos.
- No registres parámetros SQL ni cuerpos de solicitudes.

## Verificar

```sh
npm run smoke -- --url https://<dominio>/mcp
```

Ejecuta consultas reales y comprueba que las rutas protegidas pidan
autenticación.

## Actualizar

Ejecuta `npm run db:migrate` antes de desplegar una versión con migraciones
nuevas. Son idempotentes.

## Tokens manuales

Para clientes sin OAuth (requiere `npm run build`):

```sh
npm run hosted:admin -- issue              # muestra el token una sola vez
npm run hosted:admin -- revoke <client-id>
```
