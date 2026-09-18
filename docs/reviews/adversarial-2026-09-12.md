# Revisión adversarial — 12/09/2026

La revisión reprodujo y corrigió defectos, y amplió la suite de 36 a **52 pruebas
exitosas**. El hallazgo más importante fue la exposición de la contraseña en la
terminal al pegar juntos ambos campos de credenciales. Las lecturas autenticadas
de Cinex y Cines Unidos funcionaron. La prueba completa en vivo no terminó en
verde porque Cinepic Candelaria presentó fallos del proveedor. Esta es una
revisión acotada de código y regresiones, no una certificación de seguridad ni
una garantía de cobertura completa.

## Alcance y método

Se revisaron el MCP local por `stdio`, la configuración en terminal, los archivos
de sesión, solicitudes y redirecciones HTTP, parsers públicos y autenticados,
validación de salida y scripts de prueba en vivo. Se usaron cargas sintéticas
hostiles, pseudoterminales POSIX reales y cuentas autorizadas existentes para
lecturas HTTP normales. No se usaron navegador, compras, reservas ni pagos. El
informe no contiene contraseñas, tokens, perfiles ni HTML autenticado sin filtrar.

Entorno: Node.js **v24.20.0** en Linux/POSIX. Las pruebas de credenciales ejecutan
el prompt real en un PTY e incluyen pegado de varias líneas, entrada separada,
Ctrl+C y SIGTERM.

## Hallazgos y correcciones

La prioridad describe el impacto dentro de esta aplicación local; no corresponde
a una puntuación CVSS. Todos los hallazgos de código se corrigieron.

| Prioridad | Hallazgo y reproducción | Corrección y evidencia |
| --- | --- | --- |
| Alta | **La contraseña aparecía al pegar ambos campos juntos.** Enviar email y contraseña sintéticos en una sola escritura los mostraba durante el cambio entre dos lectores. El prompt también podía aparecer antes de desactivar el eco del sistema. | [`credentials-prompt.ts`](../../src/credentials-prompt.ts) usa un único lector en modo raw, desactiva el eco antes del primer prompt y no muestra ninguno de los campos. Las pruebas PTY comprueban que no aparece el texto y que el terminal se restaura al terminar o cancelar. Un login real de Cinex también funcionó. |
| Media | **Espera de cola sin límite y retención excesiva de caché.** El plazo de 15 segundos empezaba después de entrar en la cola; la cola no tenía tope y la caché de 64 entradas no tenía límite de bytes. | [`http.ts`](../../src/http.ts) incluye la espera en el plazo, permite dos lecturas activas y 32 en cola por origen, y limita la caché a 16 MiB y 64 entradas. Las pruebas saturan la cola, vencen trabajos y comprueban la expulsión por tamaño. Las cadenas de redirecciones comparten un solo plazo. |
| Media | **Las solicitudes en cola retenían credenciales antiguas.** Una lectura que esperaba capacidad podía conservar el token después de cerrar la sesión local. | Las credenciales se cargan después de salir de la cola. Una regresión ocupa ambos cupos, encola una lectura autenticada, cierra sesión y confirma que no se envía ninguna solicitud. Una lectura ya enviada todavía puede terminar; el logout local no revoca el token remoto. |
| Media | **La salida externa podía escapar del contrato de error o incluir enlaces inseguros.** Una conversión Cinepic de `1e-320` producía un valor no finito y una ZodError fuera del manejador. Los campos de imagen podían emitir URLs `javascript:`, `data:` o con credenciales. | [`service.ts`](../../src/service.ts) valida todos los registros dentro de la ruta protegida antes de filtrar y paginar. Los registros inválidos devuelven `error` estructurado. Los enlaces inseguros se omiten con una advertencia. Hay pruebas para valores no finitos, registros fuera de página, esquemas ejecutables y credenciales embebidas. |
| Media | **Los datos Flight malformados podían provocar trabajo desproporcionado.** Marcadores repetidos sin cierre generaban búsquedas solapadas y el recorrido recursivo de JSON podía agotar la pila. | [`parsers.ts`](../../src/parsers.ts) avanza después de cada llamada y se detiene ante una llamada incompleta. El recorrido es iterativo y tiene límites de profundidad 64 y 100.000 nodos. También se comprueba que un marcador dentro de una cadena JSON no se interprete como otra llamada. |
| Media/Baja | **Casos límite del sistema de archivos podían bloquear lecturas o desviar el logout.** Un FIFO en la ruta de sesión podía bloquear antes de comprobar el tipo de archivo y el logout no rechazaba un directorio de sesión simbólico. | [`auth.ts`](../../src/auth.ts) abre con `O_NONBLOCK`, exige un archivo regular y privado, valida la sesión serializada y rechaza directorios simbólicos. Las pruebas usan un FIFO y comprueban que un archivo externo sobreviva al logout. |
| Media | **Había huecos en el límite de autenticación y los errores.** Las rutas autenticadas de Cinex aceptaban parámetros adicionales o duplicados. Las excepciones de login se exponían según un prefijo de texto. Una sesión Cinex vencida redirigía a `/clearsession.html` y se clasificaba como error genérico. | Se validan claves y valores exactos. Las cabeceras de login se reconstruyen desde el almacén de cookies y se eliminan cabeceras aportadas por el llamador. Solo se muestran errores de login creados internamente. Las redirecciones reconocidas devuelven `auth_required` sin seguirse. |
| Media | **Algunos filtros y valores externos carecían de validación útil.** Los precios Cinex aceptaban `movie_id` pero lo ignoraban; Cines Unidos aceptaba horas imposibles y podían devolverse IDs que luego las herramientas rechazaban. | Cinex rechaza ese filtro no compatible. Se validan fechas, horas e identificadores reutilizables y el parser numérico rechaza formatos no decimales. Las pruebas usan una función a las 29:99:99 y un ID similar a un traversal. Los enlaces de detalle Cinex desconocidos se omiten sin seguirlos. |
| Media | **La validación podía omitir fallos importantes.** Los tests y scripts no se comprobaban con TypeScript. La prueba en vivo podía elegir un estreno sin funciones y no ejercitar precios autenticados de Cinex. | [`tsconfig.check.json`](../../tsconfig.check.json) incluye código, pruebas y scripts. [`smoke.ts`](../../scripts/smoke.ts) revisa hasta ocho películas y ofrece `--require-auth`, que falla si no logra la cobertura autenticada exigida. |

La implementación de terminal coincide con el
[modo raw de Node.js](https://nodejs.org/api/tty.html#readstreamsetrawmodemode):
se desactiva el eco y la cancelación con Ctrl+C se maneja explícitamente. El
plazo de red usa
[`AbortSignal.timeout`](https://nodejs.org/api/globals.html#static-method-abortsignaltimeoutdelay)
para cabeceras y cuerpo. Las pruebas PTY y de cola validan el comportamiento de
la aplicación de forma independiente a esas referencias.

## Observaciones en vivo

La prueba autenticada completa ocurrió el 12 de septiembre alrededor de las
06:54 UTC. Los conteos son observaciones, no constantes ni afirmaciones de
cobertura nacional.

| Comprobación | Observación |
| --- | --- |
| Login Cinex | La sesión remota había vencido antes del límite local de 24 horas. El nuevo prompt reconectó correctamente. |
| Tarifas Cinex | `available`: Múltiplaza Paraíso (`MPP`), función `26346`, dos tarifas. |
| Caramelería Cinex | `available`: Tolón (`TLN`), 86 productos únicos. |
| Tarifas Cines Unidos | `available`: sede `1009`, función `53947`, dos tarifas. |
| Caramelería Cines Unidos | `available`: Sambil Caracas (`1005`), 74 productos. |
| Tarifas y caramelería Cinepic VVIP | Tarifas `available`; caramelería `empty` en esta muestra. |
| Catálogo Cinepic Candelaria | Películas y funciones `available`. |
| Compra Cinepic Candelaria | La primera lectura superó el plazo. Un reintento mostró el error visible del proveedor “No pudimos mostrar la función”, referencia `AC-001`, sin datos de la función. El adaptador lo clasifica como `unavailable`, distinto de un esquema desconocido. |
| Caramelería Cinepic Candelaria | Otro reintento superó aproximadamente 15 segundos. No se sustituyeron datos viejos ni precios inventados. |
| Trasnocho | HTTP 403, reportado como `blocked`. |

El mensaje de Candelaria se verificó en el HTML visible de su
[página de compra](https://cinepiccandelaria.com/es-AR/compra?cid=123300&fid=23257&pid=913),
sin incluir scripts ni estilos. La página puede cambiar cuando el proveedor se
recupere o la función venza. La prueba completa terminó con error por los fallos
del proveedor; las pruebas unitarias exitosas no borran esa observación.

Una solicitud MCP final volvió a superar el plazo. La clasificación `AC-001`
queda cubierta por un fixture basado en la página observada, aunque los timeouts
intermitentes impidieron confirmarla en esa última solicitud. Ambas observaciones
se conservaron en el archivo de evidencia.

## Verificación

- `npm run check`: correcto para código, pruebas y scripts.
- `npm test`: **52 pruebas aprobadas**, sin fallos ni omisiones en ese entorno.
- `npm run build`: correcto.
- `npm audit --json`: sin avisos para el grafo instalado en ese momento; no
  demuestra la ausencia de vulnerabilidades.
- Se consultaron tarifas y caramelería autenticadas de Cinex y Cines Unidos por
  un cliente MCP real sobre `stdio`.
- Las pruebas sintéticas no usan credenciales reales. La prueba PTY requiere
  Python 3 y la de archivos especiales requiere `mkfifo` de POSIX.

## Límites y valoración

La implementación mejoró para el uso **local por un único usuario del sistema**.
Los archivos de sesión dependen de permisos del sistema, no de cifrado o un
llavero. Los procesos del mismo usuario pueden leerlos y el proceso MCP no es una
barrera de seguridad frente a ese usuario. Un despliegue remoto compartido
necesita autenticación propia, sesiones cifradas por usuario y aislamiento.

Las sesiones pueden vencer antes, los endpoints y HTML pueden cambiar y los
fallos de Cinepic o Trasnocho quedan fuera del control del adaptador. No se
garantiza cubrir todos los cines, variantes, asientos, cargos o totales. El texto
de los proveedores sigue siendo un dato no confiable para el agente. No se añadió
renovación automática de contraseñas, OTP/CAPTCHA, compras ni reservas.
