# Cinev MCP

Servidor MCP de consulta de cines venezolanos, pensado para agentes. Expone nueve herramientas sobre `stdio` usando el SDK oficial MCP de TypeScript v2. Compatible también con la negociación de protocolo MCP 2025 mediante `serveStdio`. Las consultas y los logins funcionan por HTTP, sin navegador.

## Servicio alojado

El endpoint HTTP `/mcp` permite consultar datos públicos sin iniciar sesión.
Las conexiones privadas usan Postgres y sesiones cifradas; el usuario introduce
las credenciales del cine en una página privada. La configuración para Vercel,
las migraciones y la autorización de clientes están en
[la guía del servicio alojado](docs/hosted.md).

## Instalación guiada para asistentes

Comparte con tu asistente compatible con MCP: `Instala Cinve siguiendo https://cinve.kevinbravo.com/install`.
La ruta `/install` ofrece instrucciones en texto plano para configurar el cliente y verificar la conexión.

## Ejecutar y conectar

Requiere Node.js 22 o posterior y acceso a Internet para consultar los cines.

```sh
npm ci
npm run build
node dist/index.js
```

El último comando espera mensajes MCP por stdin. Que no imprima un menú es normal: stdout está reservado al protocolo. El agente debe lanzar el proceso.

Configuración para agentes que usan el formato `mcpServers`:

```json
{
  "mcpServers": {
    "cinev": {
      "command": "node",
      "args": ["/home/ubuntu/projects/cinev/dist/index.js"]
    }
  }
}
```

La configuración también está en [mcp.example.json](mcp.example.json). Ajusta la ruta absoluta si mueves el proyecto, y la ruta de `node` si el agente no hereda tu PATH. No requiere claves API. No se ha registrado automáticamente en la configuración de ningún agente. El despliegue HTTP y el puente `start:remote` para clientes stdio están descritos en [la guía del servicio alojado](docs/hosted.md).

## Conectar cuentas personales

Cada usuario ejecuta en su propia terminal, dentro del proyecto:

```sh
npm run login -- cinex
npm run login -- cinesunidos
npm run auth:status
```

El comando pide email y contraseña con entrada oculta para ambos campos. Un único lector de terminal evita mostrar la contraseña incluso al pegar las dos líneas juntas. Ctrl+C cancela; no se admiten secuencias de escape. No pases contraseñas por chat, argumentos del MCP, argumentos del proceso ni variables de entorno. El servidor MCP sigue siendo la interfaz de consulta del agente; estos comandos solo conectan las cuentas.

Se guardan **sesiones, no contraseñas**: cookie de sesión Cinex y token de acceso Cines Unidos en `$XDG_CONFIG_HOME/cinev` o `~/.config/cinev`, fuera del repositorio. Directorio `0700`, archivos `0600`, escritura atómica. Son archivos con permisos privados, no un almacén cifrado; los procesos del mismo usuario del sistema pueden leerlos. El login y las sesiones se diseñaron para un proceso local por usuario en un sistema con permisos POSIX. No se guardan perfiles personales ni cookies de login Cines Unidos tras obtener su token.

El MCP relee la sesión en cada consulta autenticada; no hace falta reiniciarlo. Ante `auth_required`, el agente debe indicar el comando de login y esperar a que el usuario lo ejecute en su terminal. `get_auth_status` solo expone estado local, vencimiento y comando. `configured` no verifica revocación remota. Cinex tiene un límite local de 24 horas y puede expirar antes; Cines Unidos usa el vencimiento de su token. No hay renovación con contraseña guardada ni soporte de pasos adicionales como OTP/CAPTCHA; si el proveedor los exige, se informa el límite.

```sh
npm run logout -- cinex
npm run logout -- cinesunidos
```

Logout elimina la sesión local; no revoca automáticamente el token en el proveedor. Las consultas autenticadas no usan caché y releen la sesión al salir de la cola, antes de enviar el HTTP. Una consulta que ya se había enviado puede terminar.

En el servicio alojado, las consultas públicas usan por defecto una caché compartida por la instancia del servidor: conserva los TTL normales de cada fuente y `refresh: true` la omite y solicita una lectura nueva. Las lecturas autenticadas y los mapas de asientos siguen sin caché. La caché pública es en memoria; no se garantiza persistencia ni coordinación entre varias instancias desplegadas.

El servicio alojado permite autorizar el asistente desde el navegador mediante OAuth, sin pedir un token al operador. Ante `auth_required`, el agente llama `connect_account`: el cliente inicia la autorización si hace falta y después la herramienta devuelve un enlace privado de un solo uso para conectar el cine. Al terminar, consulta `get_auth_status` y repite la consulta original. Cada autorización crea una conexión independiente con sesiones cifradas; conectar otra aplicación requiere conectar de nuevo el cine. Se necesita un cliente MCP con OAuth, registro dinámico y PKCE. Los comandos locales anteriores no autentican el servicio alojado. Revisa [la guía del servicio alojado](docs/hosted.md) antes de desplegarlo; no compartas un token ni una cuenta de cine entre usuarios.

## Herramientas

| Herramienta | Uso y argumentos |
|---|---|
| `list_providers` | Capacidades implementadas y limitaciones. No es un chequeo de salud en vivo. |
| `get_auth_status` | Sin argumentos. Estado de las cuentas Cinex/Cines Unidos y siguiente paso según el modo de conexión. |
| `connect_account` | Solo alojado: `provider` Cinex/Cines Unidos. Inicia autorización OAuth si hace falta y devuelve el enlace privado para conectar el cine. |
| `disconnect_account` | Solo alojado: `provider`. Elimina la sesión del cine y sus enlaces pendientes. |
| `list_cities` | `provider`; ciudades del proveedor. |
| `list_cinemas` | `provider`, `city` opcional; obligatorio para Cines Unidos. |
| `list_movies` | Cinepic: `cinema_id`; Cines Unidos: `city`. Ambos admiten `date`, por defecto hoy. Cinex: catálogo general, `query` opcional. |
| `get_showtimes` | Cinepic: `cinema_id`; Cines Unidos: `city`; Cinex: `cinema_id` para toda la sede o `movie_id` para una película concreta. Fecha opcional, por defecto hoy en Caracas. |
| `get_ticket_prices` | Cinepic: `cinema_id`, `movie_id`, `session_id`. Cines Unidos: `cinema_id`, `session_id` y login. Cinex: `cinema_id`, `session_id` y login; sin función prueba el listado público, que puede no estar disponible. |
| `get_seats` | Mapa ASCII: `cinema_id`, `session_id`; Cinepic también `movie_id`. Cinex y Cines Unidos requieren cuenta conectada. |
| `get_concessions` | Cinepic y Cines Unidos: solo `cinema_id`, por API pública. Cinex: `cinema_id`. |

Todos salvo `list_providers` y `get_auth_status` requieren `provider`: `cinepic`, `cinesunidos`, `cinex` o `trasnocho`. Listados admiten `query` cuando corresponde, `offset` y `limit` (50 por defecto, máximo 100). Seguir `next_offset` hasta que sea `null`; `total` es el número de registros antes de paginar.

Ejemplo de flujo para el agente:

1. `list_providers({})` solo si aún no conoces la cobertura del servidor.
2. `list_cinemas({"provider":"cinepic"})` para obtener IDs de sede.
3. `get_showtimes({"provider":"cinepic","cinema_id":"123300","query":"coyote"})`.
4. Pasar el `id` de la función como `session_id`, y su `movie_id`, a `get_ticket_prices`.
5. Para caramelería: `get_concessions({"provider":"cinesunidos","cinema_id":"1005"})`. Obtener primero la sede con `list_cinemas`; el ejemplo es Sambil Caracas.

No mezclar IDs entre proveedores ni entre las dos sedes Cinepic. En Cinex, `get_showtimes` con `cinema_id` consulta la página completa de la sede en una sola llamada de cartelera y asigna `movie_id` únicamente cuando el título coincide de forma inequívoca con el catálogo actual; usa `movie_id` si necesitas una ficha concreta. En Cinex, Cines Unidos y Cinepic, las sedes con `code_status=verified` devuelven el código de consulta en `id` y `cinema_id` (puede ser numérico). Las sedes sin código conservan nombre, ciudad y enlace con `code_status=unverified`, sin `cinema_id`; su `id=directory-*` identifica únicamente la entrada y no sirve para consultar funciones, tarifas ni caramelería.

## Datos y cobertura

Cada respuesta de consulta contiene:

- `status`: `available`, `empty`, `unavailable`, `auth_required`, `blocked`, `rate_limited` o `error`.
- `items`: registros normalizados y seleccionados; no se expone la configuración completa de los sitios.
- `sources`: URL, `fetched_at` y `cached` por lectura exitosa. Una página en caché conserva su fecha de obtención original.
- `queried_at`, `timezone: America/Caracas`, `warnings`, `partial`, `total` y `next_offset`.
- La llamada MCP marca `isError: true` cuando `status` es `unavailable`, `auth_required`, `blocked`, `rate_limited` o `error`; `available` y `empty` son resultados de negocio válidos.
- El esquema de salida de cada herramienta fija `items[].kind` a su registro (`city`, `cinema`, `movie`, `showtime`, `ticket_price` o `concession`) y conserva como opcionales solo los campos que ese registro puede aportar.

`empty` indica una lista vacía del proveedor o sin coincidencias para el filtro. No significa servicio inexistente ni precio cero. `partial: true` indica que se omitieron registros por falta de identificadores verificables. Un fallo HTTP o cambio de estructura no se convierte en una cartelera vacía. No se ofrecen datos históricos del informe como respaldo en vivo.

| Proveedor | Implementado | Límite actual |
|---|---|---|
| Cinepic | Dos sedes configuradas, películas/funciones por API, tarifas desde datos Next.js, consulta de caramelería por API de sede | Una falla de verificación de sede conserva su nombre y enlace con `code_status=unverified` y `partial`. No descubre sedes nuevas automáticamente. Se verificó en el JavaScript público que `precio` está en bolívares. Se expone VES y USD calculado con la tasa del proveedor (`basis: provider_conversion`); no es una cotización BCV independiente ni incluye necesariamente cargos finales. Caramelería vacía en las muestras; un catálogo nuevo se marca sin verificar. |
| Cines Unidos | Ciudades por API; sedes, películas y funciones por datos Next.js; caramelería por API pública; tarifas USD/VES por API autenticada | Las sedes reconocibles sin código válido o con código contradictorio se conservan con `partial`; se procesan todos los bloques de directorio de la página. Requiere login local para tarifas. Se conservan restricciones de edad/canje y estado de venta; no se confirma el total de una compra. |
| Cinex | Ciudades, sedes consultables, catálogo general, funciones por sede o película; tarifas y caramelería por HTML autenticado | La cartelera de sede no publica slugs junto a cada bloque: los títulos se cruzan conservadoramente con el catálogo y los faltantes/ambiguos se omiten con `partial`. Las sedes sin código verificable se conservan con `partial` y `code_status=unverified`. `directory_status=not_listed` indica ausencia en el directorio recibido, no cierre. Tarifas por función incluyen desglose boleto/otros cargos en VES. Caramelería incluye combos con `options_required`; no se interpretan cantidades máximas como stock. |
| Trasnocho | Comprobación de acceso al sitio | Devolvió 403. No hay parser validado de programación ni precios; si cambia el bloqueo, devuelve `unavailable` hasta implementarlo. |

En Cines Unidos, si el catálogo no reconoce una ciudad escrita sin tilde, se reintenta con su nombre exacto del registro oficial. Un directorio vacío reconocido es distinto de un directorio defectuoso. En Cinepic, las películas con funciones pero sin ficha se conservan como referencias sin título confirmado y se marca `partial`.

Los formatos/salas/idiomas solo se devuelven cuando se reconocen en la respuesta. Cinepic `no_subtitulada` no se convierte automáticamente a un idioma. Las funciones marcadas como trasnoche conservan fecha comercial y hora, pero omiten `starts_at` hasta verificar el día calendario. Los precios incluyen `final_total_verified: false`.

El listado Cinex valida códigos de imágenes contra nombre y `siglas` de la API oficial; si no los confirma, busca códigos en funciones de la página individual. Conserva hasta 100 páginas conocidas en memoria por instancia del servicio (no persisten tras reiniciar). Metrópolis Barquisimeto tiene una URL oficial de descubrimiento predefinida y requiere confirmar el nombre en su página antes de incorporarse por primera vez; no se le asigna un código fijo. Las sedes conocidas ausentes del directorio se marcan pendientes de verificar. Esto no certifica apertura, cierre ni disponibilidad de venta.

Cinex puede devolver importes con más de dos decimales; se conserva su valor y los componentes visibles redondeados de la página. No se calcula automáticamente USD para Cinex. Su catálogo incluye productos y grupos de opciones, no un inventario completo de variantes. Los precios publicados de combos pueden depender de la selección final.

## Desarrollo y validación

```sh
npm run check
npm test
npm run build
npm run smoke
```

Para verificar también el cliente Codex instalado: `npm run test:codex-auth`.
Esta prueba opcional usa Postgres local, cuentas sintéticas y un servidor MCP
temporal; comprueba OAuth nativo, la recarga tras login por CLI y la cancelación.
No conecta cuentas reales ni modifica la configuración de servidores del usuario.

`npm run check` comprueba tipos de código, pruebas y scripts. `npm test` usa respuestas sintéticas y un cliente MCP real sobre stdio; no consulta Internet. Incluye casos adversariales de autenticación, salida, límites de recursos y parsers. La prueba de terminal POSIX requiere Python 3 para crear un PTY; si no está disponible, esa prueba se marca omitida. La comprobación de archivos especiales usa `mkfifo`.

`npm run smoke` usa el servidor compilado y un cliente oficial para consultar las webs en vivo. Usa sesiones locales existentes para tarifas Cinex/Cines Unidos y caramelería Cinex; sin ellas informa `auth_required`. No hace compras, reservas ni login. Las cantidades de resultados cambian; el script informa los estados y falla ante errores de transporte/interpretación. Si no hay funciones futuras ese día, omite su consulta de tarifas.

`npm run smoke -- --require-auth` exige que ambas cuentas estén configuradas, que se consulte una tarifa disponible de cada una y que responda la caramelería Cinex. Busca funciones entre hasta ocho películas; si no encuentra muestra, falla en lugar de dar por comprobada esa capacidad. Los bloqueos y las indisponibilidades publicados en los resultados siguen siendo límites reales aunque una ejecución termine sin errores de transporte.

El servidor MCP solo realiza GET a orígenes permitidos; las rutas autenticadas y sus parámetros también están limitados. Las credenciales se envían únicamente al proveedor correspondiente. Cada lectura HTTP tiene un plazo de 15 segundos que incluye cola, conexión y cuerpo; hay dos consultas activas y hasta 32 en cola por origen. El cuerpo se limita a 4 MiB. La caché pública admite hasta 64 entradas y 16 MiB contabilizados conservadoramente como cadenas UTF-16: TTL de 2 minutos por defecto, 1 minuto para tarifas públicas y 1 hora para sedes. En alojado, esa caché es compartida por la instancia para lecturas públicas; `refresh` la omite, mientras que autenticación y asientos no usan caché. No persiste caché en disco ni se garantiza coordinación entre instancias. Sigue la migración autenticada de Cinex de `boletos.php` a `boletosdev.php` y los alias same-origin de páginas de sede, siempre con rutas y parámetros limitados; rechaza el resto de redirecciones. Las redirecciones reconocidas al login se informan como `auth_required`. El comando local de login sí sigue redirecciones del proveedor: plazo de 25 segundos por cadena y 60 segundos para el flujo HTTP completo, sin reenviar contraseñas entre orígenes.

Los enlaces no HTTPS o con credenciales se omiten con advertencia. Los registros se validan antes de filtrar/paginar: importes no finitos, identificadores inutilizables o cambios de esquema no escapan como excepciones sin estructurar. Los datos Next.js se recorren con límites de profundidad/nodos y sin ejecutar scripts. Estas defensas no convierten los textos de los proveedores en instrucciones confiables para el agente.

Código: `src/server.ts` (contrato MCP), `src/service.ts` (normalización de respuesta y paginación), `src/providers.ts` (adaptadores), `src/http.ts` (lecturas/caché), `src/parsers.ts` (JSON/HTML sin ejecutar scripts).

Autenticación: `src/auth.ts` (login HTTP y sesiones), `src/auth-cli.ts` (entrada oculta), `src/authenticated-parsers.ts` (tarifas y caramelería autenticadas). Hallazgos: [investigación con cuentas autorizadas](docs/research/authenticated-access.md).

La investigación original sigue en [docs/research/cinema-data-audit.md](docs/research/cinema-data-audit.md); sus cifras son observaciones fechadas, no constantes del servidor. El puente stdio para un servidor alojado se ejecuta con `npm run start:remote -- /ruta/privada/cinev.json`; la configuración de ese archivo y del servicio HTTP está en [la guía del servicio alojado](docs/hosted.md).

La [segunda investigación sin navegador](docs/research/http-followup.md) corrigió la incertidumbre de moneda Cinepic y añadió la consulta directa de caramelería, sin requerir película ni función. El MCP sigue usando exclusivamente HTTP: no incorpora un navegador.

La [revisión adversarial del 12/09/2026](docs/reviews/adversarial-2026-09-12.md) documenta los defectos reproducidos, sus correcciones y los fallos de proveedor que permanecieron durante la validación.

La [revisión adversarial de rendimiento del 18/09/2026](docs/reviews/adversarial-performance-2026-09-18.md) resume la validación de caché, directorios, identidad de sedes, límites de recursos, proveedores y transporte HTTP.

### Asientos en ASCII

`get_seats` consulta el mapa completo sin seleccionar asientos ni crear órdenes. Cinex y Cines Unidos requieren `cinema_id`, `session_id` y cuenta conectada; Cinepic requiere además `movie_id` y no necesita login. Obtén los IDs de `get_showtimes`. Devuelve `seats`, `available`, `ascii`, fuentes y advertencias, sin caché local. Conserva posiciones y etiquetas del proveedor: `O` libre, `X` ocupado, `-` restringido/no disponible y `?` desconocido. La orientación de la pantalla no está verificada.

Cinex carga primero la función y después su mapa en `asientosdev.php`; se verifica la sede y función en el enlace de regreso del mapa para rechazar respuestas de otra función. En Cinepic, los cupos por tarifa pueden diferir del número de butacas libres; se advierte esa discrepancia. La caramelería de Cinepic devolvió catálogos vacíos en ambas sedes el 18/09/2026, sin demostrar ausencia de venta en taquilla.

El resultado incluye los contadores `available`, `occupied`, `unavailable`, `unknown`, `total` y `availability_complete`. `status=available` indica que se recibió un mapa; `availability_complete=false` indica que faltan estados por interpretar. Cero libres confirmados con estados desconocidos no significa agotado. El agente debe mostrar el ASCII con su leyenda, conservar los estados confirmados y explicar el resultado parcial. Esta guía se distribuye en la inicialización MCP, la descripción de `get_seats` y `/install` para guardarla en las instrucciones persistentes del cliente. Cinex admite el contador de boletos vacío observado en salas VIP; Cines Unidos considera libres los códigos 0 y 7, como su componente oficial de selección.

### Continuación de autorización en Codex local

Un `codex mcp login cinve` externo puede guardar OAuth sin actualizar las herramientas de una conversación ya abierta. Las instrucciones ahora continúan mediante `/codex-client.mjs` cuando no hay refresco nativo. El asistente descarga e inspecciona ese archivo temporal y ejecuta `node RUTA connect cinex` (o `cinesunidos`). El auxiliar carga la configuración del Codex instalado, reutiliza OAuth guardado y muestra los enlaces inmediatamente; espera la conexión de la cuenta sin pedir «listo». Si hace falta OAuth, usa la acción nativa de su propio App Server y continúa después de aprobar.

Las consultas pendientes pueden ejecutarse con `node RUTA call get_seats '{"provider":"cinex","cinema_id":"SBC","session_id":"ID_VERIFICADO"}'`, usando IDs previamente descubiertos. Admite `--server NOMBRE` antes del modo. No reinicia la conversación existente, no inicia turnos de modelo, no extrae tokens, no recibe contraseñas y no contesta aprobaciones. Solo sirve en el equipo que tiene el Codex y configuración del usuario. La ruta nativa sigue siendo preferida cuando el cliente la expone; otros clientes mantienen OAuth MCP estándar.

## Páginas públicas

La portada, la guía de instalación para navegadores, la conexión de cuentas y la autorización comparten `src/public-web.ts`. La paleta y la tipografía siguen el portafolio de Kevin Bravo: Inter, fondos neutros, acento ámbar y modos claro y oscuro según el sistema. Inter se sirve desde el propio proyecto; su licencia está en `src/assets/Inter-LICENSE.txt`.

El dominio principal es `https://cinve.kevinbravo.com`, configurado con `CINEV_PUBLIC_URL`. El dominio anterior `cinve.vercel.app` conserva su origen de autorización para no interrumpir clientes existentes. Las conexiones nuevas usan `/mcp` en el dominio principal.

`/install` responde con una guía en español cuando el navegador solicita HTML. Los asistentes reciben las instrucciones en texto plano; `/install?format=text` permite pedirlas explícitamente. No se cambia el contrato de instalación.

La imagen para compartir tiene una fuente editable en `src/assets/og.svg` y una versión PNG de 1200 × 630 en `src/assets/og.png`. Ambas usan la paleta de la página. Al sustituir la imagen PNG, actualiza su versión en las URLs Open Graph y Twitter de `src/public-web.ts` para evitar la caché de la imagen anterior.
