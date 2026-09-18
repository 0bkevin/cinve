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
`cinepic`, `cinesunidos`, `cinex` o `trasnocho`. Los listados admiten `query`
cuando corresponde, `offset` y `limit` —50 por defecto y 100 como máximo—.
Continúa con `next_offset` hasta que sea `null`.

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
- `sources`: URL, fecha de lectura y estado de caché de cada fuente.
- `queried_at` y `timezone`, configurada como `America/Caracas`.
- `warnings`, `partial`, `total` y `next_offset`.

`empty` significa que el proveedor devolvió una lista vacía o que no hubo
coincidencias. No equivale a un fallo ni a un precio cero. `partial: true` indica
que Cinve omitió o no pudo verificar parte de la respuesta.

## Cobertura actual

| Proveedor | Cobertura | Límites conocidos |
| --- | --- | --- |
| Cinepic | Dos sedes configuradas; películas, funciones, precios, asientos y consulta de caramelería. | No descubre sedes nuevas automáticamente. La conversión a USD usa la tasa publicada por el proveedor. |
| Cines Unidos | Ciudades, sedes, películas, funciones, caramelería, precios y asientos. | Precios y asientos requieren una cuenta conectada. |
| Cinex | Ciudades, sedes, catálogo, funciones, precios, caramelería y asientos. | Precios, caramelería y asientos requieren una cuenta conectada. Algunos cruces de títulos pueden ser parciales. |
| Trasnocho | Comprobación de acceso. | El sitio devuelve actualmente HTTP 403; no hay un parser de programación validado. |

La cobertura describe implementaciones, no certifica que cada proveedor esté
disponible en todo momento ni que abarque todos los cines de Venezuela.

## Mapas de asientos

`get_seats` requiere `cinema_id` y `session_id`; Cinepic también requiere
`movie_id`. Cinex y Cines Unidos requieren una cuenta conectada. La herramienta
no selecciona asientos ni crea órdenes.

```text
O libre  X ocupado  - no disponible  ? desconocido
```

El resultado incluye `available`, `occupied`, `unavailable`, `unknown`, `total`
y `availability_complete`. En esta herramienta, `status=available` significa que
se obtuvo un mapa, no que todas sus butacas estén libres. Si `unknown` es mayor
que cero, el mapa es parcial; cero asientos libres confirmados no significa que
la función esté agotada.

## Caché, red y seguridad

- Las lecturas HTTP tienen un plazo de 15 segundos y un cuerpo máximo de 4 MiB.
- Hay como máximo dos consultas activas y 32 en cola por origen.
- La caché pública mantiene hasta 64 entradas y 16 MiB. Las sesiones y los mapas
  de asientos no usan caché.
- El servidor solo realiza solicitudes GET a orígenes y rutas permitidos. Los
  flujos de inicio de sesión son la excepción controlada.
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

Las investigaciones fechadas y las revisiones adversariales permanecen en
[`docs/research`](research/) y [`docs/reviews`](reviews/). Son evidencia de una
fecha concreta, no datos en vivo ni garantías del servicio.
