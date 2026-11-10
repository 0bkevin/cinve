# Referencia técnica de Cinve

Esta página reúne el contrato de consulta y los límites que interesan al integrar
o mantener Cinve. Para empezar, consulta el [README](../README.md).

## Herramientas MCP

| Herramienta | Uso principal |
| --- | --- |
| `list_providers` | Describe proveedores, capacidades y límites implementados. |
| `get_auth_status` | Informa el estado de las conexiones Cinex y Cines Unidos. La caducidad de Cinex es un tope de 24 h: su sesión puede terminar antes por inactividad (se vio en menos de una hora); cuando Cinex la rechaza, Cinve la marca `expired`. |
| `connect_account` | En modo alojado, crea el enlace privado para conectar un cine. |
| `disconnect_account` | Elimina la sesión de un cine y sus enlaces pendientes. |
| `list_cities` | Lista las ciudades publicadas por un proveedor. |
| `list_cinemas` | Lista sedes; Cines Unidos requiere una ciudad. |
| `list_movies` | Lista o busca películas según el proveedor y la fecha. |
| `get_showtimes` | Consulta funciones por sede, película, ciudad o fecha. |
| `get_ticket_prices` | Consulta tarifas de una función cuando están disponibles. |
| `get_seats` | Devuelve un mapa de asientos sin seleccionar ni reservar. |
| `get_concessions` | Consulta la caramelería publicada para una sede. |

Salvo `list_providers` y `get_auth_status`, las herramientas reciben `provider`:
`cinepic`, `cinesunidos` o `cinex`. Los listados admiten `query`
cuando corresponde, `offset` y `limit` —50 por defecto y 100 como máximo—.
Continúa con `next_offset` hasta que sea `null`. Un argumento opcional enviado
como `null` equivale a omitirlo, como lo envían los adaptadores de llamadas a
funciones en modo estricto.

Para responder con pocas llamadas:

- Cinex: `get_showtimes` con `city` consulta todas las sedes verificadas de la
  ciudad en una sola llamada; con `cinema_id`, una sede (y `movie_id` opcional
  para filtrarla). Usa `query` para filtrar por título.
- Cines Unidos: `get_showtimes` con `city` devuelve toda la ciudad; añade
  `cinema_id` para una sede.
- Cinepic: sus dos sedes son `123300` (Candelaria) y `123301` (VVIP Lido).
- Las funciones incluyen `cinema_name` cuando la fuente publica el nombre de la
  sede junto a la función.
- Las tarifas de Cinex y Cines Unidos requieren `cinema_id`, `session_id` y una
  cuenta conectada.

## Flujo recomendado

1. Consulta `list_providers` una vez para conocer la cobertura.
2. Obtén ciudades y sedes con `list_cities` y `list_cinemas`.
3. Usa únicamente los identificadores devueltos por Cinve.
4. Consulta funciones y pasa sus identificadores a precios o asientos.
5. Revisa siempre `status`, `warnings`, `partial` y `sources`.

No mezcles identificadores entre proveedores. Una sede con
`code_status=unverified` puede aparecer en el directorio, pero no tiene un código
confirmado para consultar funciones, precios o caramelería.

## Contrato de respuesta

Las consultas incluyen:

- `status`: `available`, `empty`, `unavailable`, `auth_required`, `blocked`,
  `rate_limited` o `error`.
- `items`: registros normalizados y validados.
- `sources`: URL, fecha de lectura y estado de caché de las fuentes. Se listan
  como máximo 10, incluida siempre la más antigua; si hubo más, una advertencia
  indica el total.
- `queried_at` y `timezone`, configurada como `America/Caracas`.
- `warnings`, `partial`, `total` y `next_offset`.

`empty` significa que el proveedor devolvió una lista vacía o que no hubo
coincidencias. No equivale a un fallo ni a un precio cero. `partial: true` indica
que Cinve omitió o no pudo verificar parte de la respuesta.

## Cobertura actual

| Proveedor | Cobertura | Límites conocidos |
| --- | --- | --- |
| Cinepic | Dos sedes configuradas; películas, funciones, precios, asientos y consulta de caramelería. | No descubre sedes nuevas automáticamente. La conversión a USD usa la tasa publicada por el proveedor. La caramelería es el mismo catálogo que muestra su web de compra; el 5 de noviembre de 2026 estaba vacío en ambas sedes aunque la venta en línea está habilitada, y Cinve lo informa como `empty`. Cuando tenga productos, se leen como su web: precio en Bs. con equivalencia USD a su tasa, sin stock, y `options_required` para los combos con opciones. |
| Cines Unidos | Ciudades, sedes, películas, funciones, caramelería, precios y asientos. | Precios y asientos requieren una cuenta conectada. Si su web exige un desafío anti-bots (ocurre desde algunas redes de centros de datos, como la del servicio alojado), sedes, películas y funciones se leen de su API pública de búsqueda y el resultado lo advierte. Esa vía consulta cada título por separado, dos a la vez y con un plazo total de 45 s; con `query` solo consulta los títulos que coinciden. Los títulos que fallan o no se alcanzan a leer se cuentan en una advertencia y el resultado se marca `partial`. |
| Cinex | Ciudades, sedes, catálogo, funciones, precios, caramelería y asientos. | Precios, caramelería y asientos requieren una cuenta conectada. Algunos cruces de títulos pueden ser parciales. El descubrimiento de sedes tiene un plazo de 40 s, comprobado antes de cada lectura; las sedes sin comprobar se devuelven como `unverified` y `partial`. Las funciones por ciudad leen hasta 16 sedes, dos a la vez, con un plazo total de 45 s; nombran las que no se pudieron leer y fallan si no se leyó ninguna. |

La cobertura describe implementaciones, no certifica que cada proveedor esté
disponible en todo momento ni que abarque todos los cines de Venezuela.

## Mapas de asientos

`get_seats` requiere `cinema_id` y `session_id`; Cinepic también requiere
`movie_id`. Cinex y Cines Unidos requieren una cuenta conectada. La herramienta
no selecciona asientos ni crea órdenes.

```text
O libre  X ocupado  - no disponible  ? desconocido
```

El resultado incluye `available`, `occupied`, `unavailable`, `unknown`, `total`,
`availability_complete` y el mapa `ascii`, que muestra cada asiento con su
etiqueta y estado (`O` corresponde a `status=available`). El detalle por asiento
(`seats`: identificador, fila, coordenadas y estado del proveedor) se añade solo
con `include_seats=true`, porque ocupa unas diez veces más que el mapa. En esta herramienta, `status=available` significa que
se obtuvo un mapa, no que todas sus butacas estén libres. Si `unknown` es mayor
que cero, el mapa es parcial; cero asientos libres confirmados no significa que
la función esté agotada.

En Cinepic, una butaca libre solo cuenta como `available` si alguna tarifa de la
función puede venderla: su web compara el `id` de la tarifa con el tipo de
butaca y muestra las demás como no disponibles (en Candelaria, las butacas
especiales de la fila A y algunas de las filas I y J). Su web vende además un
cupo por tarifa, a menudo menor que las butacas libres; `get_ticket_prices` lo
devuelve como `tickets_available` (cupo menos vendidas y retenidas en compras en
curso) y `get_seats` lo advierte cuando es menor.

`layout` indica cómo se orientan el mapa ASCII y la imagen, igual que en la web
de cada cine (comprobado en su código el 5 de noviembre de 2026):

| Proveedor | Pantalla | Columnas |
| --- | --- | --- |
| Cinepic | Arriba, junto a la fila 1 | De derecha a izquierda en las salas marcadas `invertida` |
| Cines Unidos | Abajo | De izquierda a derecha |
| Cinex | Abajo: su página dibuja la imagen de la pantalla después de la fila A | En el orden de su página, de izquierda a derecha |

Para muchas funciones, Cinex solo envía el mapa después de elegir boletos, lo que
abre una orden temporizada. Cinve no elige boletos porque eso los retendría; en
ese caso `get_seats` responde `unavailable` con el contador "Asientos
disponibles" que Cinex sí publica en la misma página.

Además de los datos, `get_seats` devuelve el mapa como imagen PNG (hasta 1200 px
de ancho) para mostrarla o compartirla, con la leyenda, los contadores y la hora
de consulta. La cabecera nombra la función con `showing` (película, sede, sala,
fecha y hora), que se lee de la misma respuesta del mapa: completo en Cinex y
Cinepic; en Cines Unidos solo la sala, porque su mapa no trae la película ni la
sede. En Cinex se compara además con su contador "Asientos disponibles" y se
advierte si difiere. `image=svg` devuelve el mismo mapa como SVG embebido e
`image=none`, solo los datos. Si la imagen no se puede generar, la respuesta
conserva los datos y lo advierte. La imagen se dibuja con resvg (WebAssembly) y
la fuente Inter incluida en `src/assets`, sin depender de fuentes del sistema.

## Caché, red y seguridad

- Las lecturas HTTP tienen un plazo de 15 segundos y un cuerpo máximo de 4 MiB.
- Una llamada de herramienta no inicia lecturas del proveedor después de 60 s; con la lectura en curso termina en unos 75 s, por debajo del límite de 90 s del servicio alojado. Los plazos de 40 y 45 s de los recorridos por sedes o títulos cuentan dentro de ese límite.
- Hay como máximo dos consultas activas y 32 en cola por origen.
- Si el cliente cancela una llamada, Cinve no inicia más lecturas para ella; las
  que ya están en curso terminan, porque otras consultas pueden compartirlas.
- Si el cliente envía un `progressToken`, las consultas que leen muchas fuentes
  (descubrimiento de sedes Cinex, funciones Cinex por ciudad y la API de búsqueda
  de Cines Unidos) envían `notifications/progress` con un valor creciente y un
  mensaje como «Cinex: 3 de 9 sedes leídas.».
- Las instrucciones del servidor son breves (menos de 2.048 caracteres en todos
  los modos) y empiezan por las reglas esenciales, porque algunos clientes solo
  muestran el comienzo. Las reglas de asientos están en la descripción de
  `get_seats`, y los pasos de conexión llegan con cada resultado `auth_required`
  y en `get_auth_status`.
- Los esquemas publicados usan expresiones regulares compatibles con
  validadores ECMA, Python y RE2 (sin `lookaround` ni `\p{...}`); las reglas que
  no lo son se comprueban en el servidor.
- La caché pública mantiene hasta 512 entradas y 64 MiB, y descarta primero la
  entrada usada hace más tiempo. Las páginas HTML de Cinex se guardan con los
  espacios en blanco compactados. Las sesiones y los mapas
  de asientos no usan caché.
- Solo se guardan respuestas correctas: un error HTTP, un cuerpo vacío, un JSON
  inválido o una página sin la estructura esperada (por ejemplo, una página de
  mantenimiento) se informan y se vuelven a pedir en la siguiente consulta.
- Si un origen público responde con un desafío anti-bots, Cinve lo recuerda
  durante 10 minutos: las consultas siguientes usan directamente la alternativa
  documentada (o informan el bloqueo) sin volver a pedir la página. `refresh=true`
  vuelve a intentarlo, y cualquier lectura correcta del origen lo olvida.
- El servidor solo realiza solicitudes GET a orígenes y rutas permitidos: cada
  lectura pública se valida contra la lista de páginas y API que los adaptadores
  interpretan, con sus parámetros exactos, y las lecturas autenticadas tienen su
  propia lista. Los flujos de inicio de sesión son la excepción controlada.
- Si un proveedor devuelve el mismo identificador de función con película,
  fecha, hora o sala distintas, la función se omite y el resultado se marca
  `partial`, porque ese identificador se usa para tarifas y asientos.
- El HTML y JSON externos se tratan como datos, nunca como instrucciones.
- Los enlaces inseguros, redirecciones no autorizadas y registros inválidos se
  rechazan o se omiten con una advertencia.

En modo local se guardan sesiones con permisos privados del sistema de archivos.
En el servicio alojado se cifran con AES-256-GCM y los tokens OAuth se conservan
como resúmenes SHA-256. Consulta [la guía del servicio alojado](hosted.md) para el
ciclo completo de autenticación y despliegue.

## Validación

```sh
npm run check
npm test
npm run build
npm run smoke
```

Las tres primeras tareas validan tipos, comportamiento y compilación. `smoke`
consulta fuentes reales y sus resultados pueden cambiar. Con
`npm run smoke -- --require-auth` también se exigen muestras autenticadas de
Cinex y Cines Unidos.

Las decisiones vigentes deben quedar reflejadas en esta referencia, en el código
y en las pruebas. Las observaciones puntuales de proveedores no se presentan como
datos actuales ni como garantías del servicio.
