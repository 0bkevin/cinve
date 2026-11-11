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
   OAuth, se identifica (con un documento de metadatos o mediante registro
   dinámico) y abre la aprobación en el navegador.
3. En esa misma página el usuario elige el cine, escribe su correo y su
   contraseña y pulsa **Conectar**: Cinve inicia sesión en el cine y autoriza
   al asistente en un solo paso. También puede continuar sin conectar un cine.
4. El cliente intercambia el código de un solo uso mediante PKCE y repite la
   llamada. `connect_account` devuelve `connected=true` y el asistente repite
   la consulta original.

Si la cuenta no se conectó durante la aprobación, o su sesión del cine caducó
(Cinex, a las 24 horas), `connect_account` devuelve `connected=false` y un
enlace privado, válido durante diez minutos. El usuario introduce sus
credenciales únicamente en ese formulario y el asistente repite la consulta.

Solo se ejecuta un inicio de sesión a la vez por solicitud y hay un máximo de
cinco intentos por solicitud. Para que Cinve no pueda usarse para probar
credenciales en los cines, los inicios de sesión de la aprobación y de los
enlaces comparten estos límites:

- por red (una IPv4 o un prefijo IPv6 /64): 20 intentos por minuto y 100 fallos
  por día; cada /48 de IPv6 admite además 60 intentos por minuto y 300 fallos
  por día;
- por cuenta del cine (correo sin distinguir mayúsculas): 5 intentos cada 15
  minutos desde cualquier red; un inicio correcto los reinicia. Así nadie puede
  adivinar una contraseña repartiendo intentos ni hacer que el cine bloquee la
  cuenta de su dueño;
- en todo el servicio: con 300 fallos en 15 minutos, solo pueden iniciar sesión
  las redes sin fallos recientes. Los inicios correctos no tienen tope global,
  así que un ataque no bloquea a quien introduce bien sus datos.

Las claves de estos límites se guardan solo como resúmenes SHA-256 y caducan
como mucho en un día. Recomendamos añadir además reglas de límite de
solicitudes en el firewall de Vercel para `/oauth/authorize` y `/connect/login`. Un doble
envío espera al primero y devuelve al navegador al asistente con un código
nuevo; el código anterior deja de ser válido.

La sesión del cine conectada durante la aprobación pertenece a la conexión
nueva solo cuando el cliente canjea el código. Si nunca lo canjea, la limpieza
diaria elimina esa sesión. Reutilizar el código revoca la conexión y su sesión.

Cada autorización crea una conexión vacía e independiente. No hereda sesiones
de otros clientes ni del navegador. Autorizar otra aplicación, perder sus tokens
o crear una conexión nueva requiere volver a conectar los cines.

El cliente debe admitir MCP sobre HTTP, OAuth, PKCE S256 y un documento de
metadatos de cliente o el registro dinámico.
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

Si después la conversación sigue anónima, el asistente usa la acción nativa del
cliente para recargar las conexiones MCP (en Codex, `config/mcpServer/reload`)
o pide al usuario recargarlas o abrir una conversación nueva.

Cinve exige consentimiento informado: el asistente nunca ejecuta comandos en el
equipo del usuario sin explicarle antes qué hará y para qué, y obtener su
aprobación explícita. Si el usuario no aprueba, el asistente no lo hace y usa el
control de conexión del propio cliente. El flujo alojado nunca pide descargar ni
ejecutar código: así, un servidor comprometido o suplantado no puede convertir
sus instrucciones en ejecución de código en el equipo del usuario.

No ejecutes este flujo en una terminal remota ajena al usuario y no sustituyas
el flujo alojado con `npm run login`: ese comando pertenece exclusivamente al
modo local `stdio`.

## Endpoints OAuth

- `/.well-known/oauth-protected-resource/mcp`: metadatos del recurso MCP.
- `/.well-known/oauth-authorization-server`: metadatos del servidor OAuth.
- `POST /oauth/register`: registro dinámico de clientes públicos (Dynamic Client
  Registration) con sus redirecciones exactas. Se aceptan HTTPS y HTTP de
  loopback. El protocolo 2026-07-28 lo declara obsoleto; se mantiene para los
  clientes que todavía no usan documentos de metadatos. Su retirada se sigue en
  [#21](https://github.com/0bkevin/cinve/issues/21).
- `GET|POST /oauth/authorize`: muestra y procesa la aprobación explícita.

### Documentos de metadatos de cliente

El método de registro preferido es el *Client ID Metadata Document*: el
`client_id` es una URL HTTPS cuyo documento JSON declara `client_id` (la misma
URL), `client_name` y `redirect_uris`. Los metadatos del servidor lo anuncian con
`client_id_metadata_document_supported: true`. Al autorizar, Cinve:

- acepta solo URL HTTPS con ruta, sin credenciales, fragmento (ni vacío) ni
  segmentos `.`/`..` (tampoco codificados), y compara el `client_id` como cadena
  exacta. Por decisión propia, más estricta que el borrador, tampoco admite IP
  literales ni puertos distintos de 443;
- resuelve el dominio y se conecta únicamente a una dirección comprobada, sin
  segunda resolución, para evitar SSRF y DNS rebinding. Solo admite unicast
  global, decidido sobre los bytes de la dirección: en IPv4 rechaza los rangos
  de uso especial (privadas, loopback, link-local, CGNAT, documentación,
  multidifusión, reservadas); en IPv6 solo admite `2000::/3` sin documentación,
  asignaciones de protocolo del IETF ni 6to4. Una IPv4 mapeada (`::ffff:a.b.c.d`)
  se juzga como su IPv4, y cualquier otra IPv4 incrustada se rechaza;
- no sigue redirecciones, exige `application/json`, lee como máximo 16 KiB,
  corta de inmediato una respuesta rechazada sin leer su cuerpo y abandona a
  los 5 s;
- exige que el documento coincida con su URL, que sea un cliente público
  (`token_endpoint_auth_method` y `token_endpoint_auth_methods_supported`
  coherentes con `none`), que no incluya secretos ni claves privadas o
  simétricas (ni `jwks` junto a `jwks_uri`) y que la redirección solicitada
  figure en `redirect_uris`;
- guarda en caché los documentos válidos según `max-age`, entre 1 minuto y
  24 horas (5 minutos por defecto), con un cupo de 20 lecturas por minuto e IP;
- muestra en la aprobación el dominio que publica el documento, porque el nombre
  lo declara el propio cliente.

Un documento inválido o inaccesible nunca redirige al cliente.

La aprobación muestra una advertencia visible cuando Cinve no puede respaldar el
destino: solo se reconocen las redirecciones de loopback (el código se queda en
el equipo del usuario) y las que están en el sitio que publica el documento o en
sus subdominios. Cualquier cliente registrado dinámicamente con una redirección
web recibe la advertencia, porque su nombre y su destino los elige quien lo
registra.
- `POST /oauth/token`: intercambia códigos y renueva tokens.
- `POST /oauth/revoke`: revoca toda la conexión y elimina sus sesiones de cine.

Los códigos duran cinco minutos y las aprobaciones pendientes, diez. Los tokens
de acceso duran una hora; los tokens de renovación rotan en cada uso dentro de
una autorización absoluta de 30 días. Reutilizar un token de renovación o un
código consumido revoca la conexión para contener una posible repetición.

Los tokens opacos se guardan únicamente como resúmenes SHA-256. Las sesiones de
cine se cifran con AES-256-GCM y se vinculan criptográficamente a su propietario
y proveedor. El registro, la aprobación y la emisión de tokens tienen límites
persistentes por IP y globales. El límite global solo se consume cuando la IP
todavía tiene cupo, para que una sola dirección no agote el servicio para todos.

En `/mcp`, cada conexión admite hasta 120 solicitudes por minuto y cuatro
simultáneas; el proceso admite 32 simultáneas. La plaza se reserva antes de leer
el cuerpo, que debe llegar completo en diez segundos. Las llamadas con
`refresh: true` evitan la caché pública compartida y pueden generar varias
lecturas al proveedor, por lo que tienen un cupo propio de diez por minuto y uno global de 120 por
minuto. Los cupos por dirección agrupan IPv6 por su prefijo /64, porque un solo
usuario suele disponer de un bloque así de direcciones; IPv4 se cuenta por
dirección.

`/mcp` admite solicitudes desde cualquier origen web, porque la autorización es
solo mediante token Bearer y nunca usa cookies; la comprobación exacta de `Host`
impide el DNS rebinding. Una cabecera `Origin` mal formada recibe 403. El
endpoint no guarda estado: solo acepta POST (GET y DELETE reciben 405) y nunca
crea sesiones, así que CORS permite `Authorization`, `Content-Type`,
`MCP-Protocol-Version`, `Mcp-Method` y `Mcp-Name`, sin las cabeceras de sesión y
reanudación que el protocolo 2026-07-28 eliminó.

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
vencidos. El registro OAuth es anónimo, así que también elimina los clientes
registrados sin autorizaciones vigentes que llevan 90 días sin emitir tokens; un
cliente que vuelva se registra de nuevo. Ejecuta `npm run db:migrate` antes de
desplegar una versión con migraciones nuevas. La validez se comprueba al acceder y no depende de esa limpieza. La
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
