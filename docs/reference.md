# Referencia técnica de Cinve

Esta página reúne el contrato de consulta y los límites que interesan al integrar
o mantener Cinve. Para empezar, consulta el [README](../README.md).

## Herramientas MCP

| Herramienta | Uso principal |
| --- | --- |
| `list_providers` | Describe proveedores, capacidades y límites implementados. |
| `get_auth_status` | Informa el estado de las conexiones Cinex y Cines Unidos. |
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
`cinepic`, `cinesunidos`, `cinex`, `supercines` o `grancine`. Los listados admiten `query`
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
- Supercines: `get_showtimes` con `cinema_id` lee toda una sede; con `city`,
  sus sedes de la ciudad. Sus tarifas requieren `movie_id` y, si la función no
  es de hoy, la misma `date` usada en `get_showtimes`, porque varían por día.
- Gran Cine: `get_showtimes` sin sede ni ciudad lee todas sus salas; con `city`
  o `cinema_id`, solo esas. Los `id` de sus funciones los calcula Cinve.
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
| Cinepic | Dos sedes configuradas; películas, funciones, precios, asientos y consulta de caramelería. | No descubre sedes nuevas automáticamente. La conversión a USD usa la tasa publicada por el proveedor. |
| Cines Unidos | Ciudades, sedes, películas, funciones, caramelería, precios y asientos. | Precios y asientos requieren una cuenta conectada. Si su web exige un desafío anti-bots (ocurre desde algunas redes de centros de datos, como la del servicio alojado), sedes, películas y funciones se leen de su API pública de búsqueda y el resultado lo advierte. Esa vía consulta cada título por separado, dos a la vez y con un plazo total de 45 s; con `query` solo consulta los títulos que coinciden. Los títulos que fallan o no se alcanzan a leer se cuentan en una advertencia y el resultado se marca `partial`. |
| Supercines | Seis sedes (Valencia, Maracay, Carrizal, Puerto Cabello y Barcelona); ciudades, sedes, cartelera, funciones, precios y caramelería, sin cuenta. | Sin mapa de asientos: solo se muestra dentro del flujo de compra. Las funciones se leen título por título (dos a la vez, hasta 40 títulos y 45 s), como en su web. Los importes son VES; la conversión a USD usa la tasa publicada en su página de compra y no incluye impuestos ni el total final. |
| Gran Cine | Circuito de cine de autor: salas del C. C. Paseo Las Mercedes (sede del Trasnocho Cultural), Cine Ávila, Villa Planchart, Cinética Cultural, funciones al aire libre y sus títulos en salas asociadas de Cines Unidos y Supercines; títulos y funciones (hora y sala) por fecha. | Solo programación: no publica tarifas, caramelería, asientos ni identificadores de función, así que Cinve calcula un `id` estable que no sirve para otras consultas. Publica unos 20 días desde hoy. En salas asociadas lista solo sus títulos. La ciudad de una sala nueva solo se conoce si su nombre la indica. |
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

## Caché, red y seguridad

- Las lecturas HTTP tienen un plazo de 15 segundos y un cuerpo máximo de 4 MiB.
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
