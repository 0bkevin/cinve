# Investigación de datos de cines venezolanos

Fecha: 11 de septiembre de 2026. Objetivo: determinar cómo consultar películas, sedes, funciones, tarifas y caramelería, y evaluar una interfaz CLI o MCP.

## Resultado

Hay suficiente acceso para construir un agregador útil, pero la cobertura de precios es desigual. Cinepic ofrece cartelera por API y tarifas en los datos de la página; Cines Unidos ofrece caramelería por API y cartelera estructurada en sus páginas; Cinex combina HTML y consultas PHP. Trasnocho requiere más validación porque bloqueó las solicitudes directas.

Recomiendo una biblioteca común de proveedores, un CLI inicial con salida JSON y, si la interfaz principal será un asistente, un servidor MCP sobre esa misma biblioteca. Elegir MCP no resuelve por sí solo el acceso a los proveedores.

## Método y alcance

- Solicitudes HTTP GET a las páginas proporcionadas, sus enlaces y archivos JavaScript públicos; lectura de los datos Next.js enviados con el HTML.
- Pruebas de endpoints de lectura encontrados en el código. Sin iniciar sesión, comprar, reservar asientos ni enviar mensajes.
- El navegador de inspección no estuvo operativo; esta investigación se basa en HTTP, código público y contenido indexado, no en una navegación visual completa del checkout.
- Las comprobaciones son muestras, no una prueba de todos los cines, fechas o tarifas. No se encontró documentación pública que garantice estabilidad de las APIs utilizadas por las webs.
- Evidencias seleccionadas: [evidence-2026-09-11.json](evidence-2026-09-11.json). Consultas reproducibles: [queries.http](queries.http).

## Cobertura comprobada

| Proveedor | Películas y funciones | Sedes | Entradas | Caramelería |
|---|---|---|---|---|
| Cinex | HTML con fechas, salas, horarios e IDs | HTML y JSON de ciudad/detalle | Endpoint encontrado; sin precios útiles en las muestras | Acceso de interfaz condicionado a login; catálogo/precios no verificados |
| Cinepic | API JSON por sede y fecha | Dos portales con datos de sede incluidos | Tarifas comprobadas en HTML/Next.js de una función por sede | Estructura presente; catálogo vacío en ambas muestras |
| Cines Unidos | Datos estructurados en HTML/Next.js | Ciudades por API; sedes por página de ciudad | Ruta encontrada; GET anónimo devolvió 401 | JSON con precio USD/VES, categoría, descripción y existencias |
| Trasnocho Cultural | Cartelera, ciclos y fichas en contenido indexado | Cines Paseo en el espacio cultural | Precios editoriales indexados, no confirmados en vivo | Sin catálogo verificado |

## Cinex

### Organización

La portada separa Top 5, cartelera, preventas, estrenos, próximos estrenos y Cinexshop. La cartelera incluye filtros 2D, 3D, VIP y 4DX. Hay dos accesos complementarios: ficha de película (`sinopsis-….html`) y ficha de complejo (`cinex-….html`). La ficha de película agrupa funciones por fecha y complejo; incluye sala, hora y el par `sessionid`/`cinemaid` en la llamada `checkLogin`.

Fuentes: [portada](https://www.cinex.com.ve/), [sedes](https://www.cinex.com.ve/cines.html), [película analizada](https://www.cinex.com.ve/sinopsis-coyotevsacme.html), [Tolón](https://www.cinex.com.ve/cinex-tolon.html).

### Consultas identificadas

Base: `https://www.cinex.com.ve/assets/php/datasource.php`

| Parámetros GET | Resultado de la prueba |
|---|---|
| `method=getcinemacitieslist` | 200, JSON con ciudades |
| `method=getcinemadatafromcinemaid&cinemaid=TLN` | 200, JSON con nombre, dirección e identificadores de Tolón |
| `method=preparepricecinema&cinemaid=TLN` | 200, texto indicando listado no disponible |
| `method=preparepricecinema&cinemaid=REC` | Mismo resultado para Recreo |

El parámetro numérico `cinemaid=21`, obtenido del detalle de Tolón, tampoco produjo precios: devolvió un cuerpo vacío tras quitar espacios. Por tanto, la ruta de precios encontrada en `showPrices(cinemaid)` no constituye todavía una integración funcional de tarifas.

El botón de caramelería ejecuta `checkLoginConcessions()`, consulta `checklogin.php` y dirige a `ventaconcesioncomplejo.php` si hay sesión. Esto demuestra el requisito en la interfaz; no demuestra que cualquier endpoint de catálogo esté necesariamente protegido. No se verificó una API independiente de caramelería.

Implementación propuesta: extracción HTML para cartelera/funciones y JSON para ciudades/detalle. Deduplicar las tarjetas repetidas por formato y preservar los identificadores. Revisar codificación: aparecieron textos con escapes Unicode y caracteres mal codificados en las respuestas.

## Cinepic

### Organización

[cinepic.com.ve](https://cinepic.com.ve/) enlaza a dos sistemas de venta de Nexo/Cinexo:

| Sede | Portal | ID de complejo |
|---|---|---|
| Sambil La Candelaria | https://cinepiccandelaria.com/es-AR | `123300` |
| VVIP Centro Lido | https://cinepicvip.com/es-AR | `123301` |

La navegación muestra próximos estrenos, cartelera por día y ficha de película. Las funciones distinguen idioma/subtítulos y formato. El segmento `es-AR` forma parte de la ruta y no indica que estas sedes estén en Argentina.

### API comprobada

```text
GET https://apifront.cinexo.com.ar/mobile/consultas/peliculas/PeliculasConFuncionesYHorarios
    ?idComplejo=123300&fecha=11%2F09%2F2026
```

Respuesta 200 sin cookies ni credenciales, también para `123301`. Estructura:

- `success` y `message`.
- `data.datos`: películas con código, título, duración, género, clasificación, sinopsis, imágenes y formato.
- `data.funciones`: función `_id`, `codPelicula`, `hora`, `subtitulada`, `formato`, `TipoSala`, `idUltracine` y `trasnoche`.

Muestra: Candelaria devolvió 17 registros de películas y 22 funciones; VIP devolvió 9 y 7. Es necesario unir ambas listas por código; el catálogo no debe confundirse con películas que tienen función en el día consultado. Para funciones de trasnoche hay que verificar la relación entre fecha comercial y fecha calendario.

### Tarifas comprobadas

La página `/es-AR/compra?cid={complejo}&fid={funcion}&pid={pelicula}` incluye `functionData.tarifas` en los datos Next.js enviados con el HTML. La lectura no requirió login ni una reserva.

| Muestra | Tarifa recibida | Precio bruto del campo `precio` | Equivalencia calculada con la tasa del proveedor |
|---|---|---:|---:|
| Candelaria, función `23255`, Coyote vs Acme, 11/09 a las 13:45 | COMPLETO | 4162.40 | USD 5.00 |
| Misma función | NIÑOS | 2081.20 | USD 2.50 |
| VIP, función `3063`, La Odisea, 11/09 a las 20:30 | VIP COMPLETO | 12487.20 | USD 15.00 |

La configuración devuelve `tasaConversion=832.48`; las equivalencias anteriores son divisiones hechas con esa tasa, no una verificación independiente del BCV. El campo de moneda recibido es `$$`, ambiguo: antes de publicar precios normalizados debe verificarse la presentación y cualquier recargo de compra. No son tarifas universales del circuito ni totales finales garantizados.

Fuentes: [muestra Candelaria](https://cinepiccandelaria.com/es-AR/compra?cid=123300&fid=23255&pid=913), [muestra VIP](https://cinepicvip.com/es-AR/compra?cid=123301&fid=3063&pid=175).

### Caramelería y limitaciones

Ambas páginas incluyeron `candyData={"tiene_unidades_negocios":true,"unidades_negocios":[]}`. El código contempla unidades de negocio, categorías, productos y modificadores, pero las muestras no entregaron productos ni precios. Un resultado vacío debe informarse como tal, sin concluir que no existe venta de caramelería.

La API directa de funciones es la integración más sencilla. Las tarifas necesitarían, por ahora, un parser de los datos de la página. Los IDs/hash de funciones internas de Next.js no deben tratarse como una API estable. También aparecieron metadatos de ubicación inconsistentes: conviene usar direcciones verificadas y no confiar automáticamente en coordenadas.

## Cines Unidos

### Organización

La aplicación usa ciudad como contexto (`?city=Caracas`). Separa cines, cartelera, caramelería y preventa, y enlaza a `/pelicula/{vistaId}?city={ciudad}`. Los datos de películas incluyen `vistaId`, título, sinopsis y `theaters[].showTimes[]`, con ID de función, fecha/hora, sala, formato y atributos.

La consulta de sedes por ciudad incluye ID, nombre, dirección y coordenadas. Es importante conservar `city`: las páginas consultadas sin ese parámetro no entregaron el mismo contenido útil.

Fuentes: [cartelera Caracas](https://www.cinesunidos.com/cartelera?city=Caracas), [cines Caracas](https://www.cinesunidos.com/cines?city=Caracas), [ficha analizada](https://www.cinesunidos.com/pelicula/HO00006121?city=Caracas).

### API comprobada

Base: `https://gateway.cinesunidos.com`. Cabecera observada en el frontend: `xChannel: www`.

| Ruta GET | Resultado |
|---|---|
| `/search/cities` | 200, 10 ciudades |
| `/concessions/www/cinemas/1002/concessions` | 200, catálogo para Metrocenter |
| `/tickets/www/theaters/1002/sessions/44738/` | 401 sin autenticación |

El código de tarifas construye `/tickets/www/theaters/{theaterId}/sessions/{showTimeId}/{userSessionId}`. Se probó el caso sin sesión, que el propio frontend permite como valor vacío. El 401 no permite precisar qué combinación de autenticación y sesión transaccional necesita; falta verificarlo con un flujo autorizado de usuario.

No se confirmó un endpoint directo de películas o listado de sedes: esos datos sí se obtuvieron del contenido Next.js de las páginas. El hecho de existir un gateway no implica que todas las rutas sean públicas.

### Caramelería

El catálogo devuelve `itemId`, `codigoCine`, descripción, categoría, detalles, imágenes, `itemPriceUSD`, `itemPriceVE`, `itemTaxRate`, `itemStock` y grupos de modificadores.

Ejemplos recibidos para Metrocenter:

| Producto | `itemPriceUSD` | `itemPriceVE` |
|---|---:|---:|
| Mega combo | 15.60 | 12986.84 |
| Mega combo nuggets | 14.40 | 11987.86 |
| Combo para dos doritos | 13.50 | 11238.62 |

Estos son valores del catálogo de esa sede en el momento de consulta. No se verificó si incluyen todo impuesto/cargo del checkout. No se debe sumar automáticamente `itemTaxRate` ni asumir precio o existencia para otra sede.

Fuente: [catálogo consultado](https://gateway.cinesunidos.com/concessions/www/cinemas/1002/concessions).

## Trasnocho Cultural

La portada, `/cine/`, `/product-category/salas-cine/` y `/wp-json/` devolvieron 403. El contenido indexado permitió identificar organización editorial: cartelera regular, próximos estrenos, clásicos, especiales, retrospectivas y ópera. Hay fichas de películas y publicaciones semanales de programación.

Las rutas `/product/`, `/product-category/` y `/wp-content/` son indicios de WordPress/WooCommerce, no una confirmación de una API de programación disponible. La prueba de `/wp-json/` quedó bloqueada. No se probó acceso autenticado a WooCommerce.

Una [ficha indexada de El día de la revelación](https://www.trasnochocultural.com/product/el-dia-de-la-revelacion-estreno-11-de-junio/) mostraba horarios de junio de 2026, entrada general de USD 5 y lunes popular/tercera edad de USD 2.50. Otra [ficha de cine encuentro](https://www.trasnochocultural.com/product/la-odisea-cine-encuentro-ideas-de-babel/) mostraba USD 6 para una actividad de agosto. Son ejemplos de estructura editorial e históricos respecto a esta revisión, no precios vigentes confirmados.

Las fichas señalan venta por taquilla y WhatsApp. No se contactó al cine. No se encontró un catálogo verificable de caramelería.

Implementación posible: extracción de fichas/programación si se consigue acceso estable; alternativamente una fuente facilitada por el espacio cultural. No usar el índice del buscador como cartelera actual del agregador. Mantener este proveedor con estado `blocked` hasta validar una fuente en vivo.

## CLI o MCP

| Necesidad | Interfaz que propongo |
|---|---|
| Consultas desde terminal, scripts, tareas programadas y depuración | CLI con tablas y `--json` |
| Preguntas desde un asistente conectado, con argumentos estructurados | MCP |
| Ambos usos | Dos interfaces sobre la misma biblioteca de proveedores |

MCP permite exponer herramientas con nombres, descripción y esquemas de entrada/salida para invocación por modelos: [especificación oficial](https://modelcontextprotocol.io/specification/2025-11-25/server/tools). El CLI facilita inspeccionar las mismas respuestas, automatizarlas y depurar diferencias entre proveedores. Ninguna interfaz elimina bloqueos, requisitos de sesión ni datos ausentes.

Arquitectura propuesta:

```text
Cinex HTML/PHP ───────┐
Cinepic API/páginas ──┤
Cines Unidos API/web ├─ Adaptadores → Modelo común + caché → CLI
Trasnocho pendiente ─┘                                  └→ MCP
```

La biblioteca debería exponer `list_cinemas`, `list_movies`, `get_showtimes`, `get_ticket_prices` y `get_concessions`. Cada respuesta debe declarar cobertura, fuente y fecha de consulta. Para comparar presupuesto, solo calcular un total cuando existan precios compatibles de entradas y productos para la misma sede y fecha.

Ejemplos de interfaz propuesta, todavía no implementada:

```sh
cinev movies --city Caracas --date 2026-09-11 --json
cinev showtimes --provider cinepic --cinema 123300 --date 2026-09-11
cinev concessions --provider cinesunidos --cinema 1002 --json
cinev prices --provider cinepic --cinema 123300 --session 23255
```

Modelo mínimo: proveedor, ID de sede, ID de película, ID de función, fecha/hora en `America/Caracas`, idioma, formato, sala, tipo de tarifa, importe, moneda, cargos conocidos, URL de compra, `fetched_at` y estado del dato. Preservar IDs y valores originales; no convertir ausencias a cero. Distinguir `available`, `empty`, `unavailable`, `auth_required` y `blocked`.

Hay diferencias de duración, título y género entre registros de la misma película y variantes dobladas/subtituladas. No unir películas únicamente por título ni asumir que los IDs coinciden entre sedes. Conservar el registro de origen y una asociación normalizada revisable.

Propuesta inicial de caché: metadatos/sedes durante horas, funciones durante pocos minutos y precios/caramelería durante un intervalo corto configurable. Son parámetros de diseño a medir, no garantías de vigencia. Limitar concurrencia por proveedor, respetar errores/429 y mostrar fallos parciales.

Orden propuesto: (1) cartelera/funciones Cinepic y Cines Unidos, más caramelería de Cines Unidos; (2) Cinex; (3) endurecer extracción de tarifas Cinepic; (4) resolver tarifas autenticadas, caramelería pendiente y acceso a Trasnocho. Si el uso prioritario es conversar con un asistente, el MCP puede salir en la primera etapa junto a esa biblioteca; para validar el acceso y trabajar desde terminal, empezaría por CLI.
