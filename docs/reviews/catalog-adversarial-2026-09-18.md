# Revisión adversarial de catálogos: Cines Unidos y Cinepic

Fecha: 2026-09-18. Alcance: descubrimiento de sedes, interpretación de códigos, pérdidas de registros, filtrado por ciudad, películas asociadas a funciones y contrato MCP. Revisión del código con inyección de respuestas sintéticas y lecturas HTTP públicas. No es una revisión independiente ni una auditoría completa de seguridad, autenticación o pagos.

No usan la heurística de imágenes de tres letras que causaba las omisiones de Cinex. Sin embargo, se reprodujeron problemas equivalentes de pérdida de datos o cobertura engañosa. Las siete pruebas iniciales fallaron antes de corregirlos y pasan después. Se añadieron cuatro pruebas de límites adicionales.

## Hallazgos corregidos

| Gravedad | Fallo reproducido | Corrección |
|---|---|---|
| Alta | **Cinepic: una sede fallida borraba ambas.** Un HTTP 503 o una configuración con ID distinto rechazaba `Promise.all`; el servicio descartaba el listado completo. Ciudades dependía exclusivamente de Candelaria. | Se verifican ambas sedes de forma independiente. La sede fallida conserva nombre conocido y URL con `code_status=unverified`, sin código consultable; `partial=true` y advertencia explícita. Ciudades aprovecha la misma verificación. |
| Alta | **Cines Unidos: se podía leer solo un fragmento del directorio.** La búsqueda recursiva aceptaba el primer campo `theaters`, incluso el de una película, o un bloque vacío anterior a otro completo. | Se leen todos los campos de catálogo de las propiedades de componentes Next.js, sin confundir `movie.theaters` con un directorio. También se aplica a los bloques `movies`. |
| Alta | **Cines Unidos: un registro defectuoso borraba los válidos.** Una fila nula, un ID ausente o un ID como `../bad` invalidaba toda la respuesta. | Se conservan entradas con nombre reconocible. Un código ausente o inválido genera un ID local `directory-cu-*`, sin `cinema_id`. Las filas ilegibles se advierten y se marca `partial`. Un directorio totalmente ilegible sigue siendo error, no un catálogo vacío. |
| Media | **Cines Unidos: dos sedes con el mismo código se sobrescribían.** El servicio deduplicaba por ID y una desaparecía. | Si el código apunta a identidades distintas (nombre/dirección/ciudad), ambas se conservan sin código consultable, con una advertencia. Los IDs locales no dependen del orden de filas y permiten paginación estable. |
| Media | **Cines Unidos: “Maturin” fallaba mientras “Maturín” funcionaba.** Reproducido también contra la web en vivo. | Ante un catálogo sin el campo esperado, se consulta el registro oficial de ciudades y se reintenta con su escritura canónica. Una ciudad desconocida se informa como `unavailable`, con instrucción de consultar `list_cities`. No se adivina otra ciudad. |
| Media | **Cinepic: funciones sin ficha de película producían un catálogo de películas vacío.** La unión descartaba referencias con funciones válidas; las funciones advertían el problema pero no marcaban `partial`. | Se conserva la referencia de película con una etiqueta explícita `Película {id}` y advertencia de título no recibido. Películas y funciones marcan `partial`. |
| Media | **El identificador de directorio podía llegar a consultas ajenas a Cinex.** En Cines Unidos, un `directory-*` provocaba consulta autenticada o HTTP en vez de indicar la ausencia de código. | El servicio rechaza esos IDs antes de cualquier acceso a red o sesión para todos los proveedores. Las descripciones MCP documentan el contrato compartido. |

Código: [providers.ts](../../src/providers.ts), [cinema-directory.ts](../../src/cinema-directory.ts), [parsers.ts](../../src/parsers.ts), [service.ts](../../src/service.ts). Regresiones: [catalog-adversarial.test.ts](../../test/catalog-adversarial.test.ts).

## Evidencia en vivo

Lecturas del 18 de septiembre de 2026, aproximadamente 15:37–15:38 UTC. Los conteos cambian con el proveedor. Se conserva una [captura de resultados y fuentes públicas](catalog-evidence-2026-09-18.json).

- **Cines Unidos: 21 sedes en las 10 ciudades** del [registro oficial](https://gateway.cinesunidos.com/search/cities): Caracas 7; Barquisimeto, Maracaibo, Maracay, Margarita y Valencia 2 cada una; Maturín, Puerto La Cruz, Puerto Ordaz y San Cristóbal 1 cada una.
- Se contrastaron los códigos de sedes de las funciones de hoy con los directorios de las mismas ciudades: ninguna sede de las funciones consultadas faltaba en el directorio. Se recorrieron las dos páginas de resultados de Caracas; las otras ciudades tenían menos de 100 funciones.
- Barquisimeto devolvió 2 sedes y 0 funciones para hoy. Se mantuvieron ambas sedes: ausencia de funciones no equivale a cierre.
- `city=Maturin` recuperó Petroriente (`1007`) al reintentar con `Maturín`, con la URL canónica en el resultado.
- **Cinepic: 2 sedes** verificadas en sus páginas, coincidentes con los enlaces de la [portada oficial](https://cinepic.com.ve/): [Candelaria](https://cinepiccandelaria.com/es-AR), `123300`, y [VVIP](https://cinepicvip.com/es-AR), `123301`.
- Candelaria devolvió 13 películas y 22 funciones; VVIP, 6 películas y 6 funciones. Ninguno de esos cuatro resultados marcó datos parciales.

## Validación y límites

- `npm run check` y `npm run build`: correctos.
- 77 pruebas sin PostgreSQL: correctas, incluidas las 11 nuevas pruebas adversariales, las regresiones de Cinex, parsers, contrato de salida, autenticación, límites HTTP y cliente MCP real por stdio.
- No se ejecutó `test/hosted.test.ts`: requiere PostgreSQL y esta revisión no modificó almacenamiento ni aislamiento de usuarios alojados. No se afirma que haya pasado la suite completa `npm test`.
- No se consultaron tarifas autenticadas ni se realizaron compras, reservas o despliegues.
- Cinepic conserva **dos sedes configuradas**. La respuesta advierte que no descubre nuevas sedes automáticamente. Si ambos sitios fallan, conserva entradas conocidas explícitamente sin verificar; no inventa fuentes ni declara que verificó su operación actual.
- Cines Unidos depende del directorio actual por ciudad. Una sede ausente tanto del directorio como de la cartelera no se puede descubrir con esas fuentes. No se añadió un historial persistente ni se afirma cobertura de todo el país.
- `code_status=verified` indica que el código se obtuvo de datos oficiales reconocidos; no garantiza horarios, stock ni venta disponible. El parser continúa dependiendo del formato Next.js observado; las estructuras no reconocidas se señalan como error o resultado parcial.
