# Cinev MCP

Servidor MCP de consulta de cines venezolanos, pensado para agentes. Expone ocho herramientas sobre `stdio` usando el SDK oficial MCP de TypeScript v2. Compatible también con la negociación de protocolo MCP 2025 mediante `serveStdio`. Las consultas y los logins funcionan por HTTP, sin navegador.

## Servicio alojado

El endpoint HTTP `/mcp` permite consultar datos públicos sin iniciar sesión.
Las conexiones privadas usan Postgres y sesiones cifradas; el usuario introduce
las credenciales del cine en una página privada. La configuración para Vercel,
las migraciones y los límites actuales del alta de clientes están en
[la guía del servicio alojado](docs/hosted.md).

## Instalación guiada para Codex

Comparte con Codex: `Instala Cinev siguiendo https://cinev-indol.vercel.app/install`.
La ruta `/install` devuelve texto plano con los pasos para configurar el MCP
público y verificar la conexión. Usa el dominio configurado en `CINEV_PUBLIC_URL`.
Puede ser necesario reiniciar Codex para cargar las herramientas recién añadidas.
Las consultas públicas no requieren cuenta ni clonar este repositorio.

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

El servicio alojado admite varios clientes con tokens independientes, sesiones cifradas por cliente y un enlace privado de un solo uso para conectar cada cuenta. Revisa [la guía del servicio alojado](docs/hosted.md) antes de desplegarlo; no compartas un token ni una cuenta de cine entre usuarios.

## Herramientas

| Herramienta | Uso y argumentos |
|---|---|
| `list_providers` | Capacidades implementadas y limitaciones. No es un chequeo de salud en vivo. |
| `get_auth_status` | Sin argumentos. Estado local de las cuentas Cinex/Cines Unidos y comandos para conectarlas. |
| `list_cities` | `provider`; ciudades del proveedor. |
| `list_cinemas` | `provider`, `city` opcional; obligatorio para Cines Unidos. |
| `list_movies` | Cinepic: `cinema_id`; Cines Unidos: `city`. Ambos admiten `date`, por defecto hoy. Cinex: catálogo general, `query` opcional. |
| `get_showtimes` | Cinepic: `cinema_id`; Cines Unidos: `city`; Cinex: `movie_id`. Fecha opcional, por defecto hoy en Caracas. |
| `get_ticket_prices` | Cinepic: `cinema_id`, `movie_id`, `session_id`. Cines Unidos: `cinema_id`, `session_id` y login. Cinex: `cinema_id`, `session_id` y login; sin función prueba el listado público, que puede no estar disponible. |
| `get_concessions` | Cinepic y Cines Unidos: solo `cinema_id`, por API pública. Cinex: `cinema_id`. |

Todos salvo `list_providers` y `get_auth_status` requieren `provider`: `cinepic`, `cinesunidos`, `cinex` o `trasnocho`. Listados admiten `query` cuando corresponde, `offset` y `limit` (50 por defecto, máximo 100). Seguir `next_offset` hasta que sea `null`; `total` es el número de registros antes de paginar.

Ejemplo de flujo para el agente:

1. `list_providers({})` para conocer la cobertura.
2. `list_cinemas({"provider":"cinepic"})` para obtener IDs de sede.
3. `get_showtimes({"provider":"cinepic","cinema_id":"123300","query":"coyote"})`.
4. Pasar el `id` de la función como `session_id`, y su `movie_id`, a `get_ticket_prices`.
5. Para caramelería: `get_concessions({"provider":"cinesunidos","cinema_id":"1005"})`. Obtener primero la sede con `list_cinemas`; el ejemplo es Sambil Caracas.

No mezclar IDs entre proveedores ni entre las dos sedes Cinepic. En Cinex, `movie_id` es el slug de la ficha e `id` de la sede es su código de consulta.

## Datos y cobertura

Cada respuesta de consulta contiene:

- `status`: `available`, `empty`, `unavailable`, `auth_required`, `blocked`, `rate_limited` o `error`.
- `items`: registros normalizados y seleccionados; no se expone la configuración completa de los sitios.
- `sources`: URL, `fetched_at` y `cached` por lectura exitosa. Una página en caché conserva su fecha de obtención original.
- `queried_at`, `timezone: America/Caracas`, `warnings`, `partial`, `total` y `next_offset`.

`empty` indica una lista vacía del proveedor o sin coincidencias para el filtro. No significa servicio inexistente ni precio cero. `partial: true` indica que se omitieron registros por falta de identificadores verificables. Un fallo HTTP o cambio de estructura no se convierte en una cartelera vacía. No se ofrecen datos históricos del informe como respaldo en vivo.

| Proveedor | Implementado | Límite actual |
|---|---|---|
| Cinepic | Dos sedes, películas/funciones por API, tarifas desde datos Next.js, consulta de caramelería por API de sede | Se verificó en el JavaScript público que `precio` está en bolívares. Se expone VES y USD calculado con la tasa del proveedor (`basis: provider_conversion`); no es una cotización BCV independiente ni incluye necesariamente cargos finales. Caramelería vacía en las muestras; un catálogo nuevo se marca sin verificar. |
| Cines Unidos | Ciudades por API; sedes, películas y funciones por datos Next.js; caramelería por API pública; tarifas USD/VES por API autenticada | Requiere login local para tarifas. Se conservan restricciones de edad/canje y estado de venta; no se confirma el total de una compra. |
| Cinex | Ciudades, sedes consultables, catálogo general, funciones por película; tarifas y caramelería por HTML autenticado | Algunas sedes no exponen un código verificable; se omiten con `partial`. Tarifas por función incluyen desglose boleto/otros cargos en VES. Caramelería incluye combos con `options_required`; no se interpretan cantidades máximas como stock. |
| Trasnocho | Comprobación de acceso al sitio | Devolvió 403. No hay parser validado de programación ni precios; si cambia el bloqueo, devuelve `unavailable` hasta implementarlo. |

Los formatos/salas/idiomas solo se devuelven cuando se reconocen en la respuesta. Cinepic `no_subtitulada` no se convierte automáticamente a un idioma. Las funciones marcadas como trasnoche conservan fecha comercial y hora, pero omiten `starts_at` hasta verificar el día calendario. Los precios incluyen `final_total_verified: false`.

Cinex puede devolver importes con más de dos decimales; se conserva su valor y los componentes visibles redondeados de la página. No se calcula automáticamente USD para Cinex. Su catálogo incluye productos y grupos de opciones, no un inventario completo de variantes. Los precios publicados de combos pueden depender de la selección final.

## Desarrollo y validación

```sh
npm run check
npm test
npm run build
npm run smoke
```

`npm run check` comprueba tipos de código, pruebas y scripts. `npm test` usa respuestas sintéticas y un cliente MCP real sobre stdio; no consulta Internet. Incluye casos adversariales de autenticación, salida, límites de recursos y parsers. La prueba de terminal POSIX requiere Python 3 para crear un PTY; si no está disponible, esa prueba se marca omitida. La comprobación de archivos especiales usa `mkfifo`.

`npm run smoke` usa el servidor compilado y un cliente oficial para consultar las webs en vivo. Usa sesiones locales existentes para tarifas Cinex/Cines Unidos y caramelería Cinex; sin ellas informa `auth_required`. No hace compras, reservas ni login. Las cantidades de resultados cambian; el script informa los estados y falla ante errores de transporte/interpretación. Si no hay funciones futuras ese día, omite su consulta de tarifas.

`npm run smoke -- --require-auth` exige que ambas cuentas estén configuradas, que se consulte una tarifa disponible de cada una y que responda la caramelería Cinex. Busca funciones entre hasta ocho películas; si no encuentra muestra, falla en lugar de dar por comprobada esa capacidad. Los bloqueos y las indisponibilidades publicados en los resultados siguen siendo límites reales aunque una ejecución termine sin errores de transporte.

El servidor MCP solo realiza GET a orígenes permitidos; las rutas autenticadas y sus parámetros también están limitados. Las credenciales se envían únicamente al proveedor correspondiente. Cada lectura HTTP tiene un plazo de 15 segundos que incluye cola, conexión y cuerpo; hay dos consultas activas y hasta 32 en cola por origen. El cuerpo se limita a 4 MiB. La caché pública admite hasta 64 entradas y 16 MiB contabilizados conservadoramente como cadenas UTF-16: TTL de 2 minutos por defecto, 1 minuto para tarifas públicas y 1 hora para sedes. No persiste caché en disco ni sigue redirecciones. Las redirecciones reconocidas al login se informan como `auth_required`. El comando local de login sí sigue redirecciones del proveedor: plazo de 25 segundos por cadena y 60 segundos para el flujo HTTP completo, sin reenviar contraseñas entre orígenes.

Los enlaces no HTTPS o con credenciales se omiten con advertencia. Los registros se validan antes de filtrar/paginar: importes no finitos, identificadores inutilizables o cambios de esquema no escapan como excepciones sin estructurar. Los datos Next.js se recorren con límites de profundidad/nodos y sin ejecutar scripts. Estas defensas no convierten los textos de los proveedores en instrucciones confiables para el agente.

Código: `src/server.ts` (contrato MCP), `src/service.ts` (normalización de respuesta y paginación), `src/providers.ts` (adaptadores), `src/http.ts` (lecturas/caché), `src/parsers.ts` (JSON/HTML sin ejecutar scripts).

Autenticación: `src/auth.ts` (login HTTP y sesiones), `src/auth-cli.ts` (entrada oculta), `src/authenticated-parsers.ts` (tarifas y caramelería autenticadas). Hallazgos: [investigación con cuentas autorizadas](docs/research/authenticated-access.md).

La investigación original sigue en [docs/research/cinema-data-audit.md](docs/research/cinema-data-audit.md); sus cifras son observaciones fechadas, no constantes del servidor. El puente stdio para un servidor alojado se ejecuta con `npm run start:remote -- /ruta/privada/cinev.json`; la configuración de ese archivo y del servicio HTTP está en [la guía del servicio alojado](docs/hosted.md).

La [segunda investigación sin navegador](docs/research/http-followup.md) corrigió la incertidumbre de moneda Cinepic y añadió la consulta directa de caramelería, sin requerir película ni función. El MCP sigue usando exclusivamente HTTP: no incorpora un navegador.

La [revisión adversarial del 12/09/2026](docs/reviews/adversarial-2026-09-12.md) documenta los defectos reproducidos, sus correcciones y los fallos de proveedor que permanecieron durante la validación.
