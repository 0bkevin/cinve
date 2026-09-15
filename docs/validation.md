# Validación de la versión 0.1.0

Estado actual: 52 pruebas aprobadas, ocho herramientas MCP y login HTTP local para Cinex/Cines Unidos. La [revisión adversarial del 12/09/2026](reviews/adversarial-2026-09-12.md) documenta correcciones y fallos de proveedor observados. Las revisiones iniciales que siguen documentan la evolución, no la cobertura actual completa.

Ejecutada el 11/09/2026. Las comprobaciones en vivo principales se realizaron entre las 19:33:25 y las 19:33:34 UTC.

- Compilación y comprobación TypeScript correctas.
- Suite determinista de 21 pruebas: parsers, filtros, moneda, datos ausentes, caché, concurrencia y contrato MCP por stdio con el cliente oficial.
- Compatibilidad comprobada con apertura JSON-RPC `initialize` de MCP `2025-11-25`, seguida de `tools/list` (7 herramientas) y `tools/call` sobre `list_providers` (4 proveedores).
- `npm run smoke`: consultas reales mediante el proceso compilado y un cliente MCP oficial, sin errores de transporte/interpretación. Los estados de bloqueo, autenticación y datos ausentes se recibieron como resultados estructurados.

| Consulta en vivo | Observación |
|---|---|
| Cines Unidos: ciudades y sedes Caracas | 10 ciudades; 7 sedes en Caracas |
| Cinepic: sedes | 2 sedes con nombre/dirección |
| Cinex: sedes Caracas | 9 sedes consultables |
| Cinepic Candelaria: películas y funciones del día | 11 películas con función; 20 funciones |
| Cinepic VIP: películas y funciones del día | 5 películas con función; 6 funciones |
| Cinepic: tarifas de una función futura por sede | `available`; importes conservados con moneda `unknown` |
| Cinepic: caramelería de esas funciones | `empty`, con advertencia |
| Cines Unidos: cartelera Caracas | 28 registros; consulta de funciones por película también válida |
| Cines Unidos: caramelería Sambil Caracas (`1005`) | 77 productos |
| Cinex: catálogo general | 29 registros |
| Cinex: funciones de Coyote vs Acme, comprobación anterior del mismo día | 42 funciones; sala y hora extraídas correctamente |
| Cinex Tolón: tarifas | `unavailable` |
| Cines Unidos: tarifas | `auth_required` (capacidad no implementada para usuarios autenticados) |
| Trasnocho | `blocked`, HTTP 403 |

Las cantidades son observaciones fechadas. No están incorporadas como respuestas fijas del MCP. El catálogo de caramelería de Metrocenter respondió vacío durante esta implementación, aunque la investigación anterior había obtenido productos. No se ejecutaron compras, reservas ni login.

## Segunda revisión HTTP, 11/09/2026 a las 19:55 UTC

- Suite ampliada: 23 pruebas aprobadas y compilación correcta.
- El cliente MCP real consultó la API directa de caramelería de las sedes Cinepic 123300 y 123301 usando solo `cinema_id`; ambas respondieron `empty`.
- Se verificó el etiquetado de bolívares y la conversión a USD en el JavaScript público del checkout. La consulta MCP de tarifas para la función 23310 de Candelaria devolvió VES 4162.40 y USD 5.00, este último con `basis: provider_conversion` y tasa 832.48. Esto sustituye la limitación `currency: unknown` de la revisión anterior para las tarifas Cinepic.
- Los cargos finales siguen sin verificarse. El MCP no incorpora login ni navegador.

## Tercera revisión: cuentas autorizadas, 11/09/2026

- `npm run check`, `npm test` (36 pruebas) y `npm run build`: correctos.
- Login real con el CLI de entrada oculta: Cinex y Cines Unidos autenticados por HTTP, sin navegador. Sesiones persistidas fuera del repositorio; contraseñas no guardadas.
- Pruebas nuevas: permisos/symlinks, aislamiento de usuarios, vencimiento, no reutilización de caché autenticada tras logout, cookie y bearer limitados a su proveedor/ruta, redirecciones sin reenviar contraseñas, login NextAuth/Keycloak, ausencia de secretos/perfiles en resultados y parsers de importes/restricciones.
- `npm run smoke` a las 20:21 UTC: terminó sin errores. Ocho herramientas detectadas; Cines Unidos devolvió tarifas autenticadas para la sede 1009 y función 53925. Cinex Tolón devolvió 86 registros únicos de caramelería. Cinepic conservó tarifas USD/VES y caramelería vacía; Trasnocho volvió a responder 403.
- La primera película Cinex ordenada alfabéticamente no tenía función ese día, por lo que esa ejecución general omitió su tarifa autenticada. Una comprobación MCP adicional consultó explícitamente la función futura 76907 de Tolón y la función 44738 de Metrocenter, además de caramelería Cinex Recreo; las tres devolvieron `available`. Las muestras seleccionadas están en [authenticated-evidence.json](research/authenticated-evidence.json).
- La ausencia de cuenta ahora devuelve `auth_required` con indicación de login local. No se solicita contraseña desde el MCP. No hay compras ni reservas implementadas.

Detalles y límites: [acceso autenticado](research/authenticated-access.md). La prueba en vivo valida muestras concretas, no todos los cines, formatos ni combos posibles.
