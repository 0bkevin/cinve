# Servicio alojado de Cinve: Vercel y PostgreSQL

Esta guía explica cómo desplegar el servidor HTTP de Cinve. Para usar la
instancia pública no necesitas desplegar nada: conecta tu cliente a
`https://cinve.kevinbravo.com/mcp`.

El servicio alojado usa PostgreSQL para autorizaciones, sesiones cifradas,
enlaces temporales y límites de uso. No guarda el estado de autenticación en
memoria, Blob ni archivos locales persistentes. El modo `stdio` conserva su
almacenamiento local independiente.

## Acceso público

Un cliente MCP puede conectarse a `https://<dominio>/mcp` sin cabecera
`Authorization` y consultar ciudades, sedes, películas, funciones y los precios
o la caramelería que sean públicos.

Las operaciones protegidas de Cinex y Cines Unidos devuelven
`auth_required`. Un token inválido devuelve HTTP 401; el servidor nunca degrada
silenciosamente una conexión autenticada a acceso anónimo.

## Conectar una cuenta de cine

El usuario no necesita una cuenta adicional de Cinve ni un token emitido por el
operador. El flujo normal es:

1. El asistente llama `connect_account`.
2. Si la conexión MCP aún no está autorizada, el cliente descubre el servidor
   OAuth, se registra y abre la aprobación en el navegador.
3. El cliente intercambia el código de un solo uso mediante PKCE y repite la
   llamada.
4. Cinve devuelve un enlace privado, válido durante diez minutos, para conectar
   Cinex o Cines Unidos.
5. El usuario introduce sus credenciales únicamente en ese formulario.
6. El asistente consulta `get_auth_status` y repite la operación original.

Cada autorización crea una conexión vacía e independiente. No hereda sesiones
de otros clientes ni del navegador. Autorizar otra aplicación, perder sus tokens
o crear una conexión nueva requiere volver a conectar los cines.

El cliente debe admitir MCP sobre HTTP, OAuth, registro dinámico y PKCE S256.
Los clientes sin OAuth pueden seguir usando los datos públicos. Nunca se deben
pegar contraseñas, cookies o tokens en el chat.

### Codex local

Si el cliente no abre automáticamente la autorización, puede iniciarse desde la
instalación local del usuario:

```sh
codex mcp login cinve
```

Este comando autoriza al cliente MCP; no solicita la contraseña del cine. El
proceso debe permanecer activo mientras el usuario aprueba la URL. Una
conversación ya abierta puede requerir recargar sus conexiones después del
login. `get_auth_status.connection.client_authorized` permite distinguir este
caso de una cuenta de cine todavía no conectada.

No ejecutes este flujo en una terminal remota ajena al usuario y no sustituyas
el flujo alojado con `npm run login`: ese comando pertenece exclusivamente al
modo local `stdio`.

## Endpoints OAuth

- `/.well-known/oauth-protected-resource/mcp`: metadatos del recurso MCP.
- `/.well-known/oauth-authorization-server`: metadatos del servidor OAuth.
- `POST /oauth/register`: registra clientes públicos con sus redirecciones
  exactas. Se aceptan HTTPS y HTTP de loopback.
- `GET|POST /oauth/authorize`: muestra y procesa la aprobación explícita.
- `POST /oauth/token`: intercambia códigos y renueva tokens.
- `POST /oauth/revoke`: revoca toda la conexión y elimina sus sesiones de cine.

Los códigos duran cinco minutos y las aprobaciones pendientes, diez. Los tokens
de acceso duran una hora; los tokens de renovación rotan en cada uso dentro de
una autorización absoluta de 30 días. Reutilizar un token de renovación o un
código consumido revoca la conexión para contener una posible repetición.

Los tokens opacos se guardan únicamente como resúmenes SHA-256. Las sesiones de
cine se cifran con AES-256-GCM y se vinculan criptográficamente a su propietario
y proveedor. El registro, la aprobación y la emisión de tokens tienen límites
persistentes por IP y globales.

## Despliegue

1. Crea un proyecto en Vercel y conecta una base PostgreSQL dedicada. Neon desde
   el Marketplace funciona; usa la misma región que la función. Separa las bases
   y claves de producción y preview.
2. Configura `DATABASE_URL` con una conexión agrupada y TLS verificado.
3. Configura `CINEV_PUBLIC_URL` con el origen HTTPS exacto,
   `CINEV_ENCRYPTION_KEY` con 32 bytes aleatorios codificados como 64 caracteres
   hexadecimales y `CRON_SECRET` con otro secreto aleatorio. Nunca confirmes
   estos valores en el repositorio ni en un chat.
4. Ejecuta las migraciones con las variables de la base cargadas:

   ```sh
   npm run db:migrate
   ```

   Usa `DATABASE_URL_UNPOOLED` cuando el proveedor ofrezca una conexión directa.
   La migración es transaccional, idempotente y usa un bloqueo de coordinación;
   no se ejecuta durante solicitudes HTTP ni arranques en frío.

   Si la red local no permite conexiones PostgreSQL directas a Neon, usa:

   ```sh
   node --env-file=.env.production.local --import tsx scripts/migrate-neon.ts
   ```

5. Despliega y verifica la salud del proceso:

   ```sh
   vercel --prod
   curl https://<dominio>/health
   ```

6. Prueba `/mcp` por separado para cubrir base de datos y protocolo. Comprueba
   consultas reales desde la infraestructura publicada: que un proveedor
   responda desde tu equipo no garantiza que responda desde Vercel.

`server.ts` exporta el handler HTTP. `npm run build:hosted` compila la función en
`.hosted/index.js`, separada de la entrada `stdio` en `dist/index.js`. El archivo
`vercel.json` contiene las rutas y el límite de ejecución.

## Acceso manual del operador

Los clientes antiguos sin OAuth pueden usar una conexión emitida manualmente:

```sh
npm run build
npm run hosted:admin -- issue
```

El comando muestra una vez un identificador y un bearer token. Guárdalo en la
configuración privada del cliente, nunca en una URL. Para revocarlo y eliminar
sus sesiones y enlaces:

```sh
npm run hosted:admin -- revoke <client-id>
```

Cinve no implementa cuentas propias basadas en email y contraseña.

## Datos y concurrencia

- `cinev_clients`: conexiones, resumen del token y fecha de revocación.
- `cinev_sessions`: sesiones cifradas por conexión y proveedor.
- `cinev_links`: enlaces temporales, etapa, propietario y estado de uso.
- `cinev_budgets`: límites de solicitudes por ventana de un minuto.
- `cinev_oauth_apps`: clientes públicos y redirecciones permitidas.
- `cinev_oauth_requests`: aprobaciones, CSRF, PKCE y códigos temporales.
- `cinev_oauth_grants`: autorización, cliente, recurso y vencimiento.
- `cinev_oauth_tokens`: resúmenes de tokens, tipo, uso y vencimiento.

Las mutaciones de una conexión bloquean la misma fila y usan transacciones. El
login HTTP al cine ocurre fuera de la transacción; una respuesta tardía no puede
guardar una sesión después de cancelar, reemplazar, vencer o revocar el enlace.
Ante una caída de la base, las operaciones protegidas fallan de forma cerrada.

Una tarea diaria autenticada elimina sesiones, enlaces, límites y objetos OAuth
vencidos. La validez se comprueba al acceder y no depende de esa limpieza. La
limpieza manual se ejecuta con:

```sh
npm run db:cleanup
```

Conserva `CINEV_ENCRYPTION_KEY` entre despliegues; cambiarla obliga a reconectar
las cuentas. No habilites logs de parámetros SQL ni cuerpos de solicitudes.

## Verificación local

```sh
npm run check
npm test
npm run build
```

Las pruebas usan un clúster PostgreSQL temporal por socket privado, o una base de
pruebas indicada por `TEST_DATABASE_URL`. Crean y eliminan esquemas con nombres
aleatorios: nunca uses una base de producción. Las credenciales empleadas en las
pruebas son sintéticas.

La prueba en vivo del servicio público es:

```sh
npm run smoke -- --url https://cinve.kevinbravo.com/mcp
```

Comprueba consultas anónimas y que las rutas protegidas soliciten autenticación.
