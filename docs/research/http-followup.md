# Segunda investigación: ampliar el acceso sin navegador

11/09/2026. Se revisaron JavaScript público, páginas HTTP, endpoints de catálogo, metadatos de autenticación y rutas habituales de documentación/feed. No se utilizó navegador, no se enviaron credenciales y no se iniciaron reservas o compras.

## Resultado

El enfoque HTTP sigue siendo viable y permitió dos mejoras concretas de Cinepic. Para los demás huecos, hay que distinguir autenticación, datos no publicados y bloqueo del sitio. Un navegador no es un requisito demostrado para Cinex o Cines Unidos; tampoco se ha demostrado que podamos obtener todos sus precios como visitantes anónimos.

| Proveedor | Hallazgo adicional | Consecuencia |
|---|---|---|
| Cinepic | API de caramelería por sede y moneda/conversión documentadas en el código del checkout | Implementadas ambas mejoras en el MCP |
| Cines Unidos | Proveedor de login por credenciales y autenticación Bearer en consultas protegidas | Un adaptador HTTP autenticado es una posibilidad concreta, pendiente de cuenta/sesión autorizada y prueba de requisitos transaccionales |
| Cinex | Login mediante POST de formulario; páginas de entradas/caramelería redirigen sin sesión | Puede investigarse un cliente HTTP con cookies de sesión; no se confirmó acceso anónimo a los datos pendientes |
| Trasnocho | Homepage con y sin www, feed y robots responden 403 con página de desafío | No se encontró una fuente anónima accesible y vigente; sigue bloqueado |

## Cinepic: endpoint de caramelería

```text
GET https://api.cinexo.com.ar/api/complejo/123300/candy
GET https://api.cinexo.com.ar/api/complejo/123301/candy
```

Ambos devolvieron HTTP 200 sin autenticación, con JSON aunque el Content-Type es `text/html`:

```json
{"tiene_unidades_negocios": true, "unidades_negocios": []}
```

Esto permite consultar directamente el catálogo por sede, sin cargar `/compra`, y elimina la necesidad de `movie_id` y `session_id` en `get_concessions` para Cinepic. La ausencia de productos sigue siendo una limitación real de estas respuestas. No se infiere que la sede no tenga caramelería física.

Fuentes: [Candelaria](https://api.cinexo.com.ar/api/complejo/123300/candy), [VIP](https://api.cinexo.com.ar/api/complejo/123301/candy).

## Cinepic: moneda de tarifas confirmada en el frontend

La revisión anterior conservaba `currency: unknown` porque `moneda` no era fiable. Ahora se siguió el uso real de `functionData.tarifas`:

- El componente de tarifas muestra `tarifa.precio` bajo un encabezado con `(Bs.)`.
- El carrito divide `SubtotalTarifas` por `tasaConversion` y redondea a dos decimales.
- La estructura enviada por el checkout identifica esa conversión como USD. Solo se inspeccionó código; no se ejecutó la reserva.

Se volvieron a descargar los archivos públicos de la página activa, confirmando estas reglas:

- [Componente de compra](https://cinepiccandelaria.com/_next/static/chunks/app/%5Blocale%5D/compra/page-bd4a58f0f09ca176.js).
- [Carrito y conversión](https://cinepiccandelaria.com/_next/static/chunks/1018-28b7501a8253d37f.js).
- [Configuración consultada por la web](https://api.cinexo.com.ar/api/complejo/123300/configuration), cuya respuesta contiene `tasaConversion`.

El MCP ahora conserva el importe en VES y añade la equivalencia USD con `basis: provider_conversion`. Ejemplo verificado mediante cliente MCP: tarifa completa, VES 4162.40 / tasa 832.48 = USD 5.00 para la [función 23310](https://cinepiccandelaria.com/es-AR/compra?cid=123300&fid=23310&pid=970). No se equipara la tasa del proveedor con una tasa BCV verificada. `final_total_verified` sigue siendo `false`.

## Cines Unidos: autenticación HTTP, no dependencia de navegador demostrada

[GET /api/auth/providers](https://www.cinesunidos.com/api/auth/providers) respondió 200 y anunció:

- `credentials`, tipo `credentials`, con callback `/api/auth/callback/credentials`.
- `keycloak`, tipo `oauth`.

El bundle de la aplicación añade `Authorization: Bearer …` a su cliente protegido cuando la sesión está autenticada, y elimina la cabecera cuando no lo está. La ruta de lectura de tarifas utiliza cine, función y `userSessionId`.

Esto corrige la interpretación de la primera investigación: el 401 demuestra que la consulta anónima falla; no demuestra que haya que usar un navegador. Un flujo HTTP podría manejar login, cookies/CSRF y token. Falta verificar con una cuenta autorizada los campos del login, restricciones adicionales y si la lectura de tarifas exige antes una sesión transaccional. No se probó ese flujo ni se implementó soporte de credenciales.

También se comprobó [la especificación OpenAPI del gateway](https://gateway.cinesunidos.com/swagger/v1/swagger.json): responde 200, pero describe configuración del gateway y control de caché, no una API pública de tarifas. Las rutas equivalentes bajo `/tickets/swagger/v1/swagger.json` y `/search/swagger/v1/swagger.json` devolvieron 404. No se llamaron operaciones de configuración o modificación de caché.

## Cinex: HTTP con sesión pendiente de verificación

El JavaScript público muestra `POST assets/php/validatelogin.php`, con `username` y `password` en un formulario. Es evidencia de un flujo HTTP convencional, no una prueba de que todos sus pasos funcionen sin navegador.

Las lecturas anónimas de `ventaconcesioncomplejo.php` y de `boletos.php?cinemaid=TLN&sessionid=76907` terminaron en `clearsession.html`, sin catálogo ni tarifas. Los métodos PHP visibles adicionales de caramelería calculan totales o participan en la compra; no se encontró en ellos una consulta pública nueva de catálogo.

No se enviaron credenciales ni se ejecutaron operaciones de carrito. Los precios y productos pendientes podrían obtenerse con un cliente HTTP que conserve una sesión legítima, pero no está verificado. Las ciudades, sedes consultables, cartelera y funciones ya funcionan por HTTP.

Fuente de código: [bundle público de Cinex](https://www.cinex.com.ve/assets/js/scripts.min.js.pagespeed.ce.wzEavrDSxF.js).

## Trasnocho: bloqueo también en posibles fuentes sencillas

Se probaron `/robots.txt`, `/feed/` y el dominio sin `www`, además de las pruebas anteriores de `/cine/` y `/wp-json/`. Todas las nuevas lecturas devolvieron HTTP 403 con una página de desafío. No se intentó resolverla ni eludirla mediante proxies, otros orígenes o sesiones ajenas.

No hay base para prometer una integración de Trasnocho exclusivamente anónima desde este entorno. Haría falta una fuente pública distinta y vigente facilitada por el proveedor, acceso autorizado al sitio/API o un cambio de su política de acceso. El contenido indexado antiguo sigue sin ser adecuado como fuente de funciones actuales.

## Cambios y pruebas

- `get_concessions` de Cinepic usa el endpoint directo y requiere únicamente la sede.
- `get_ticket_prices` identifica VES y añade USD calculado, sin inventar una equivalencia cuando falta la tasa.
- El transporte continúa siendo HTTP GET y el MCP conserva stdio; no se añadió navegador ni autenticación.
- Compilación correcta y 23 pruebas aprobadas. El cliente MCP real confirmó los dos catálogos vacíos y la tarifa VES/USD indicada arriba.

La siguiente investigación útil para Cinex/Cines Unidos sería autenticación HTTP con una cuenta autorizada. Las rutas y metadatos públicos encontrados no sustituyen esa autorización ni permiten afirmar de antemano que se pueden leer todos los datos.
