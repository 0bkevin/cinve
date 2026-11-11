# Referencia técnica

Herramientas, respuestas y límites de Cinve.

## Herramientas MCP

| Herramienta          | Para qué sirve                                                 |
| -------------------- | -------------------------------------------------------------- |
| `list_providers`     | Cobertura, capacidades y límites de cada cine.                 |
| `get_auth_status`    | Estado de las cuentas de Cinex, Cines Unidos y Supercines.     |
| `connect_account`    | Solo modo alojado: inicia la conexión de una cuenta de cine.   |
| `disconnect_account` | Solo modo alojado: borra la sesión de un cine en Cinve.        |
| `list_cities`        | Ciudades de un cine.                                           |
| `list_cinemas`       | Sedes de un cine.                                              |
| `list_movies`        | Películas en cartelera, con búsqueda opcional.                 |
| `get_showtimes`      | Funciones por sede, ciudad, película o fecha.                  |
| `get_ticket_prices`  | Precios de una función.                                        |
| `get_seats`          | Mapa de asientos de una función (no reserva).                  |
| `get_concessions`    | Caramelería de una sede.                                       |

Las consultas reciben `provider`: `cinex`, `cinesunidos`, `cinepic`,
`supercines` o `grancine`. Las herramientas de cuenta solo aceptan `cinex`,
`cinesunidos` o `supercines`; en modo local se usa `npm run login`.

Los listados admiten `query`, `offset` y `limit` (50 por defecto, 100 máximo).
Para paginar, repite con `next_offset` hasta que sea `null`.

## Flujo recomendado

1. `list_cities` y `list_cinemas` para obtener sedes.
2. `get_showtimes` para obtener funciones.
3. `get_ticket_prices` o `get_seats` con los IDs de la función.

Usa solo IDs devueltos por Cinve, sin mezclarlos entre cines. Las sedes con
`code_status=unverified` no se pueden consultar.

## Argumentos por cine

| Cine         | Qué requiere                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------- |
| Cinex        | `get_showtimes` con `city` lee toda la ciudad; con `cinema_id`, una sede; con `movie_id`, todas las sedes de esa película. `list_movies` es el catálogo general, sin fecha ni sede. |
| Cines Unidos | `list_cinemas`, `list_movies` y `get_showtimes` requieren `city`; añade `cinema_id` para una sede. |
| Cinepic      | Dos sedes: `123300` (Candelaria) y `123301` (VVIP Lido). Todo salvo ciudades y sedes requiere `cinema_id`. |
| Supercines   | `get_showtimes` requiere `cinema_id`, `city` o `movie_id`. Los precios requieren `movie_id` y la misma `date` de `get_showtimes` si no es hoy. |
| Gran Cine    | `get_showtimes` sin sede ni ciudad lee todas sus salas.                                            |

## Respuestas

- `status`: `available`, `empty`, `unavailable`, `auth_required`, `blocked`,
  `rate_limited` o `error`. `empty` significa sin resultados, no un fallo.
- `items`: los resultados.
- `partial: true`: Cinve no pudo verificar parte de la respuesta.
- `warnings`, `sources`, `total`, `next_offset`, `queried_at` y `timezone`.

## Cobertura

| Cine         | Precios | Caramelería | Asientos | Requiere cuenta                     |
| ------------ | ------- | ----------- | -------- | ----------------------------------- |
| Cinex        | Sí      | Sí          | Sí       | Precios, caramelería y asientos     |
| Cines Unidos | Sí      | Sí          | Sí       | Precios y asientos                  |
| Cinepic      | Sí      | Sí          | Sí       | No                                  |
| Supercines   | Sí      | Sí          | No       | No (opcional para tarifas propias)  |
| Gran Cine    | No      | No          | No       | No                                  |

Todos ofrecen sedes, películas y funciones. Limitaciones:

- **Cines Unidos:** si su web pide un desafío anti-bots (frecuente desde
  servidores en la nube), Cinve usa su API pública de búsqueda. Puede ser más
  lenta y marcar resultados como `partial`.
- **Supercines:** las funciones que solo se venden en taquilla aparecen en
  `warnings`. Las cuentas creadas con Google no se pueden conectar.
- **Gran Cine:** cine de autor (Paseo Las Mercedes, Cine Ávila y otras salas);
  publica unos 20 días hacia adelante.
- **Cinepic:** su API de caramelería puede devolver un catálogo vacío.
- **Cinex:** el descubrimiento de sedes y las consultas por ciudad tienen plazos
  máximos; las sedes no leídas se indican en el resultado.
- **Precios:** Cinepic y Supercines calculan el USD con la tasa que publica el
  cine. Ningún precio es el total final de compra.

## Mapas de asientos

`get_seats` requiere `cinema_id` y `session_id`; Cinepic también requiere
`movie_id`. Cinex y Cines Unidos requieren una cuenta conectada.

```text
O libre  X ocupado  - no disponible  ? desconocido
```

Devuelve el mapa `ascii` y los contadores `available`, `occupied`,
`unavailable`, `unknown` y `total`. `include_seats=true` añade cada asiento.

- `status=available` significa que se obtuvo el mapa, no que haya asientos
  libres.
- `availability_complete` es `true` solo si el mapa tiene asientos y ninguno es
  desconocido. Si `unknown` es mayor que cero, el mapa es parcial: cero
  asientos libres con desconocidos **no** significa agotado.
- La consulta no selecciona ni reserva asientos.

## Caché y red

- Las respuestas públicas se guardan en caché; `refresh=true` fuerza una
  lectura nueva. Las lecturas con cuenta y los asientos nunca se cachean.
- Cada lectura tiene un plazo de 15 s y como máximo dos simultáneas por sitio.
- Solo se consultan páginas, API y formularios permitidos. Cinve nunca compra,
  reserva ni modifica cuentas.
