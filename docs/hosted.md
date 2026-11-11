# Alojar Cinve

Esta guía explica cómo desplegar tu propio servidor HTTP de Cinve. Si solo
quieres usarlo, no necesitas nada de esto: conecta tu cliente a
`https://cinve.kevinbravo.com/mcp`.

## Qué incluye el modo alojado

- Un endpoint MCP en `https://<dominio>/mcp`.
- OAuth para que cada usuario conecte su asistente y sus cuentas de cine.
- Sesiones de cine cifradas (AES-256-GCM) en PostgreSQL.
- Límites de uso por red, por cuenta y globales contra abusos.

Sin autenticación, cualquier cliente puede consultar los datos públicos. Las
operaciones protegidas de Cinex y Cines Unidos responden `auth_required` hasta
que el usuario conecte su cuenta.

## Requisitos

- Node.js 22 o posterior.
- Una base PostgreSQL dedicada (por ejemplo, Neon).
- Un dominio con HTTPS.

## Variables de entorno

| Variable                | Obligatoria | Descripción                                                    |
| ----------------------- | ----------- | -------------------------------------------------------------- |
| `DATABASE_URL`          | Sí          | Conexión a PostgreSQL con TLS. Usa la conexión agrupada.       |
| `DATABASE_URL_UNPOOLED` | No          | Conexión directa, usada por las migraciones si existe.         |
| `CINEV_PUBLIC_URL`      | Sí          | Origen HTTPS exacto, p. ej. `https://cine.ejemplo.com`.        |
| `CINEV_ENCRYPTION_KEY`  | Sí          | 64 caracteres hex. Genérala con `openssl rand -hex 32`.         |
| `CRON_SECRET`           | Sí          | Secreto de la limpieza diaria. Genéralo igual que la clave.    |
| `PORT`                  | No          | Puerto HTTP fuera de Vercel (por defecto `3000`).              |

- No guardes estos valores en el repositorio ni los pegues en un chat.
- Usa bases y claves distintas para producción y preview.
- Conserva `CINEV_ENCRYPTION_KEY` entre despliegues: si cambia, todos los
  usuarios deben volver a conectar sus cuentas.

## Desplegar en Vercel

1. Crea un proyecto en Vercel y conecta una base PostgreSQL en la misma región.
2. Define las variables de entorno.
3. Aplica las migraciones con esas variables cargadas:

   ```sh
   npm run db:migrate
   ```

   Si tu red bloquea conexiones PostgreSQL directas a Neon:

   ```sh
   node --env-file=.env.production.local --import tsx scripts/migrate-neon.ts
   ```

4. Despliega y comprueba que responde:

   ```sh
   vercel --prod
   curl https://<dominio>/health
   ```

`vercel.json` ya define las rutas, el tiempo máximo de ejecución y la tarea
diaria que llama a `/internal/cleanup`.

## Desplegar en otro servidor

```sh
npm ci
npm run build
npm run db:migrate
npm run start:hosted
```

Ponlo detrás de un proxy inverso con HTTPS (Caddy, Nginx…) y programa la
limpieza diaria, por ejemplo con cron:

```sh
npm run db:cleanup
```

## Proteger el servicio

- Añade reglas de límite por IP en tu firewall o CDN para `/mcp`, `/oauth/*` y
  `/connect/*`, para descartar abusos antes de llegar a la función.
- Fija un tamaño máximo de cómputo en la base de datos.
- No actives logs de parámetros SQL ni de cuerpos de solicitudes.

## Verificar el despliegue

```sh
npm run smoke -- --url https://<dominio>/mcp
```

Comprueba consultas anónimas reales y que las rutas protegidas pidan
autenticación. Haz esta prueba desde el servidor publicado: que un cine responda
desde tu equipo no garantiza que responda desde tu proveedor de hosting.

## Actualizar

Ejecuta `npm run db:migrate` antes de desplegar una versión con migraciones
nuevas. Las migraciones son transaccionales e idempotentes, y nunca se ejecutan
durante las solicitudes.

## Cómo se conecta un usuario

1. El asistente llama a `connect_account`.
2. Si aún no está autorizado, el cliente abre la página de aprobación de Cinve
   en el navegador.
3. El usuario elige el cine, escribe su correo y contraseña en esa página y
   pulsa **Conectar**. También puede continuar sin conectar ningún cine.
4. El cliente recibe sus tokens y repite la consulta original.

Si la sesión del cine caduca (Cinex, a las 24 horas), `connect_account`
devuelve un enlace privado válido durante diez minutos para reconectarla.

Cada autorización es independiente: autorizar otra aplicación requiere volver a
conectar los cines. El cliente debe soportar MCP sobre HTTP, OAuth con PKCE S256
y un documento de metadatos de cliente o el registro dinámico. Los clientes sin
OAuth pueden usar los datos públicos.

**Codex:** si el cliente no abre la autorización por sí solo, el usuario puede
ejecutar `codex mcp login cinve` en su terminal. Ese comando autoriza al
cliente; no pide la contraseña del cine. `npm run login` es solo para el modo
local `stdio`.

## Endpoints

| Ruta                                          | Función                                       |
| --------------------------------------------- | --------------------------------------------- |
| `POST /mcp`                                   | Endpoint MCP (sin sesiones; GET y DELETE: 405). |
| `GET /health`                                 | Estado del proceso.                           |
| `/.well-known/oauth-protected-resource/mcp`   | Metadatos del recurso MCP.                    |
| `/.well-known/oauth-authorization-server`     | Metadatos del servidor OAuth.                 |
| `POST /oauth/register`                        | Registro dinámico de clientes públicos.       |
| `GET\|POST /oauth/authorize`                  | Página de aprobación.                         |
| `POST /oauth/token`                           | Canje de códigos y renovación de tokens.      |
| `POST /oauth/revoke`                          | Revoca la conexión y borra sus sesiones.      |
| `/connect/*`                                  | Enlaces privados para conectar un cine.       |
| `GET /internal/cleanup`                       | Limpieza diaria (requiere `CRON_SECRET`).     |

## Tokens y límites

- Los códigos de autorización duran 5 minutos; los tokens de acceso, 1 hora.
- Los tokens de renovación rotan en cada uso, hasta 30 días en total.
- Reutilizar un código o un token de renovación revoca la conexión.
- Los tokens se guardan solo como resúmenes SHA-256 y van firmados con HMAC.
- Cada conexión admite 120 solicitudes por minuto en `/mcp` y 4 simultáneas.
- Los inicios de sesión en los cines están limitados por red (20 por minuto) y
  por cuenta (5 cada 15 minutos) para impedir que Cinve se use para probar
  contraseñas. El dueño de una cuenta ya conectada conserva su propio cupo.

## Acceso manual del operador

Para clientes antiguos sin OAuth puedes emitir un token a mano:

```sh
npm run build
npm run hosted:admin -- issue
npm run hosted:admin -- revoke <client-id>
```

`issue` muestra el token una sola vez. Guárdalo en la configuración privada del
cliente, nunca en una URL.

## Tablas

| Tabla                  | Contenido                                     |
| ---------------------- | --------------------------------------------- |
| `cinev_clients`        | Conexiones y resumen de su token.             |
| `cinev_sessions`       | Sesiones de cine cifradas.                    |
| `cinev_links`          | Enlaces temporales de conexión.               |
| `cinev_budgets`        | Contadores de límites de uso.                 |
| `cinev_oauth_apps`     | Clientes OAuth registrados.                   |
| `cinev_oauth_requests` | Aprobaciones pendientes y códigos.            |
| `cinev_oauth_grants`   | Autorizaciones vigentes.                      |
| `cinev_oauth_tokens`   | Resúmenes de tokens.                          |

La limpieza diaria elimina sesiones, enlaces, límites y objetos OAuth vencidos,
y los clientes registrados sin uso en 90 días. Si la base de datos cae, las
operaciones protegidas fallan de forma cerrada.
