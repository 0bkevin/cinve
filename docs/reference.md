# Referencia técnica

Herramientas, respuestas y límites de Cinve. Para instalarlo, consulta el
[README](../README.md).

## Herramientas MCP

| Herramienta          | Para qué sirve                                                 |
| -------------------- | -------------------------------------------------------------- |
| `list_providers`     | Cobertura, capacidades y límites de cada cine.                 |
| `get_auth_status`    | Estado de las cuentas de Cinex, Cines Unidos y Supercines.     |
| `connect_account`    | Modo alojado: inicia la conexión de una cuenta de cine.        |
| `disconnect_account` | Borra la sesión de un cine y sus enlaces pendientes.           |
| `list_cities`        | Ciudades de un cine.                                           |
| `list_cinemas`       | Sedes de un cine (Cines Unidos requiere `city`).               |
| `list_movies`        | Películas en cartelera, con búsqueda opcional.                 |
| `get_showtimes`      | Funciones por sede, ciudad, película o fecha.                  |
| `get_ticket_prices`  | Precios de una función.                                        |
| `get_seats`          | Mapa de asientos de una función (no reserva).                  |
| `get_concessions`    | Caramelería de una sede.                                       |

Todas, salvo `list_providers` y `get_auth_status`, reciben `provider`:
`cinex`, `cinesunidos`, `cinepic`, `supercines` o `grancine`.

Los listados admiten `query`, `offset` y `limit` (50 por defecto, 100 como
máximo). Para paginar, repite la llamada con `next_offset` hasta que sea
`null`. Un argumento opcional enviado como `null` equivale a omitirlo.

## Flujo recomendado

1. Llama a `list_providers` para conocer la cobertura.
2. Obtén ciudades y sedes con `list_cities` y `list_cinemas`.
3. Consulta funciones con `get_showtimes`.
4. Pasa los identificadores de la función a `get_ticket_prices` o `get_seats`.
5. Revisa siempre `status`, `warnings` y `partial`.

Usa solo identificadores devueltos por Cinve y no los mezcles entre cines. Una
sede con `code_status=unverified` aparece en el directorio, pero no se puede
consultar.

## Consejos por cine

| Cine         | Cómo consultar con pocas llamadas                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Cinex        | `get_showtimes` con `city` lee toda la ciudad; con `cinema_id`, una sede.                          |
| Cines Unidos | `get_showtimes` con `city` lee toda la ciudad; añade `cinema_id` para una sede.                    |
| Cinepic      | Dos sedes: `123300` (Candelaria) y `123301` (VVIP Lido).                                           |
| Supercines   | Los precios requieren `movie_id` y la misma `date` usada en `get_showtimes` si no es hoy.         |
| Gran Cine    | `get_showtimes` sin sede ni ciudad lee todas sus salas.                                            |

## Respuestas

Cada respuesta incluye:

- `status`: `available`, `empty`, `unavailable`, `auth_required`, `blocked`,
  `rate_limited` o `error`.
- `items`: los resultados.
- `warnings`, `partial`, `total` y `next_offset`.
- `sources`: URL y fecha de lectura de las fuentes (hasta 10).
- `queried_at` y `timezone` (`America/Caracas`).

`empty` significa que no hubo resultados, no que algo fallara.
`partial: true` significa que Cinve no pudo verificar parte de la respuesta.

## Cobertura

| Cine         | Qué ofrece                                                         | Requiere cuenta                       |
| ------------ | ------------------------------------------------------------------ | ------------------------------------- |
| Cinex        | Ciudades, sedes, películas, funciones, precios, caramelería, asientos. | Precios, caramelería y asientos.  |
| Cines Unidos | Ciudades, sedes, películas, funciones, precios, caramelería, asientos. | Precios y asientos.               |
| Cinepic      | Dos sedes; películas, funciones, precios, caramelería, asientos.   | No.                                   |
| Supercines   | Seis sedes; películas, funciones, precios, caramelería.            | No (opcional para tarifas propias).   |
| Gran Cine    | Cine de autor (Trasnocho, Cine Ávila y otras salas); funciones.    | No.                                   |

Limitaciones conocidas:

- **Cines Unidos:** si su web pide un desafío anti-bots (frecuente desde
  servidores en la nube), Cinve usa su API pública de búsqueda. Puede ser más
  lenta y marcar resultados como `partial`.
- **Supercines:** no publica mapas de asientos. La programación del día
  siguiente se carga sede por sede durante el día. Las funciones de taquilla
  (Playa Mar) aparecen solo en `warnings`. Las cuentas creadas con Google no se
  pueden conectar.
- **Gran Cine:** solo programación, unos 20 días hacia adelante. Sin precios,
  caramelería ni asientos; sus `id` de función los calcula Cinve.
- **Cinex:** el descubrimiento de sedes y las consultas por ciudad tienen plazos
  máximos; las sedes no leídas se indican en el resultado.
- **Conversión a USD:** usa la tasa que publica cada cine y no incluye
  impuestos.

## Mapas de asientos

`get_seats` requiere `cinema_id` y `session_id`; Cinepic también requiere
`movie_id`. Cinex y Cines Unidos requieren una cuenta conectada.

```text
O libre  X ocupado  - no disponible  ? desconocido
```

El resultado incluye el mapa `ascii` y los contadores `available`, `occupied`,
`unavailable`, `unknown` y `total`. Con `include_seats=true` añade el detalle de
cada asiento.

Ten en cuenta:

- `status=available` significa que se obtuvo el mapa, no que haya asientos
  libres.
- Si `unknown` es mayor que cero o `availability_complete` es `false`, el mapa
  es parcial. Cero asientos libres con desconocidos **no** significa agotado.
- La consulta no selecciona ni reserva asientos.

## Comportamiento de red

- Cada lectura tiene un plazo de 15 s y un máximo de 4 MiB.
- Como máximo dos lecturas simultáneas por sitio web (y 32 en cola).
- Las respuestas públicas se guardan en caché; sesiones y asientos, nunca.
  `refresh=true` fuerza una lectura nueva.
- Solo se hacen solicitudes GET a páginas y API permitidas, salvo el inicio de
  sesión.
- El contenido externo se trata como datos, nunca como instrucciones.
- Si el cliente envía `progressToken`, las consultas largas informan su avance.

Las sesiones locales se guardan con permisos privados en `~/.config/cinev`. En
modo alojado, consulta la [guía de despliegue](hosted.md).

## Validación

```sh
npm run check                  # tipos
npm test                       # pruebas
npm run build                  # compilación
npm run smoke                  # consultas reales a los cines
npm run smoke -- --require-auth  # incluye muestras con cuenta
```
