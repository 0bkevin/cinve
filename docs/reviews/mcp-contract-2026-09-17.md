# Revisión del contrato MCP · 2026-09-17

Esta revisión compara la salida de Cinev con el contrato de herramientas MCP
vigente y con la documentación del SDK oficial de TypeScript v2. Se revisó el
servidor local y una consulta pública del servicio alojado; los datos de los
proveedores siguen siendo observaciones en vivo y pueden cambiar.

## Hallazgos y correcciones

Antes del cambio, una llamada que no podía completar la consulta del proveedor
devolvía un `structuredContent` válido pero `isError: false`. Eso confundía un
fallo de autenticación, bloqueo, límite de solicitudes o indisponibilidad con
una respuesta normal. Ahora `isError` es `true` para esos estados y para
`error`; `available` y `empty` siguen siendo resultados de negocio válidos.
El payload `Result` no cambió y el texto continúa siendo el JSON compacto del
mismo payload, para conservar clientes que lean `content[0].text`.

Antes, las herramientas no tenían `title` y el JSON Schema no explicaba de
dónde salen `cinema_id`, `movie_id` y `session_id`. Ahora cada herramienta
publica un título y esos campos incluyen su procedencia y el requisito de
mantener los IDs dentro del mismo proveedor. Las reglas condicionales que
dependen de `provider` siguen validándose en el servidor y sus requisitos
principales también están descritos en cada herramienta.

El sobre de salida sigue compartido para que los clientes puedan reutilizar
los campos de paginación y procedencia, pero `tools/list` ahora restringe
`items[].kind` por operación: `city`, `cinema`, `movie`, `showtime`,
`ticket_price` o `concession`, respectivamente. Esto permite validar la clase
de registro sin duplicar el sobre común.
En la medición local del JSON de `tools/list`, los seis esquemas de consulta
ocupan 11.406 caracteres en conjunto después de la especialización, frente a
18.078 para seis copias del esquema genérico anterior. Es una comparación del
metadato de descubrimiento, no una medición de respuestas ni una promesa de
ahorro fijo de tokens.

El puente `start:remote` ahora conserva las instrucciones del servidor alojado
y el `_meta` de los resultados de herramientas. Su identidad MCP continúa
siendo la del puente; no suplanta la identidad declarada por el servidor
remoto.

Las excepciones de los adaptadores de cuenta se convierten en mensajes
genéricos antes de llegar al cliente MCP. Esto evita exponer detalles internos
de base de datos o infraestructura, manteniendo el mensaje útil para reintento.

## Salida observada

Una consulta pública alojada de ciudades con `limit: 2` produjo esta forma;
se omiten aquí `queried_at`, `sources` y `warnings` para mostrar solo los
campos relevantes:

```json
{
  "provider":"cinesunidos",
  "status":"available",
  "timezone":"America/Caracas",
  "total":10,
  "next_offset":2,
  "partial":false,
  "items":[{"kind":"city","id":"Barquisimeto","name":"Barquisimeto"},{"kind":"city","id":"Caracas","name":"Caracas"}]
}
```

En la medición del despliegue alojado anterior a esta revisión, una consulta
protegida sin cuenta produjo `status: "auth_required"` pero `isError: false`,
y una consulta al proveedor bloqueado produjo `status: "blocked"` también con
`isError: false`. En la salida revisada ambos estados conservan sus payloads y
advertencias, pero ahora llevan `isError: true`; ninguna respuesta incluye
contraseñas, tokens ni texto de excepciones internas.

## Fuentes y límites

- [MCP Tools, Specification 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): herramientas, esquemas de entrada/salida, anotaciones y la semántica de resultados con error.
- [MCP TypeScript SDK v2 · soporte de 2026-07-28](https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28): títulos, `_meta`, instrucciones, eras del protocolo y compatibilidad del SDK.
- [OpenAI tools guidance](https://developers.openai.com/plugins/plan/tools): títulos, esquemas, IDs explícitos, anotaciones y comportamiento de fallo para herramientas consumidas por OpenAI.

La versión instalada del SDK es `@modelcontextprotocol/*` 2.0.0. Las pruebas
usan un cliente MCP oficial sobre stdio y transporte en memoria; la prueba de
servicio alojado comprueba que el puente recibe las instrucciones del servidor.
El smoke test acepta estados publicados como `auth_required` o `unavailable`
cuando forman parte de su alcance esperado, y verifica que su `isError`
coincida con el estado en vez de tratarlos como transporte roto.
El bearer del servicio alojado se emite de forma privada por el operador y no
es un flujo OAuth de MCP; el alta automática desde un cliente MCP todavía no
está implementada, tal como se describe en la guía de despliegue.
No se interpreta `status: empty` como error, porque significa que el proveedor
respondió con una lista vacía o que no hubo coincidencias. Las lecturas HTTP
conservan un plazo total de 15 segundos; la cancelación MCP no aborta una
lectura HTTP ya admitida, que permanece acotada por ese plazo.

El smoke local del 17/09/2026 (`npm run smoke`, salida en
`/tmp/cinev-smoke-20260917.log`) alcanzó ciudades y sedes de Cinex, Cines
Unidos y Cinepic, además de caramelería pública. Terminó con código 1 porque
dos lecturas de Cinepic Candelaria agotaron el plazo de 15 segundos y otra
respondió HTTP 503; Cinepic VVIP sí devolvió funciones y una tarifa. Las
cuentas locales estaban vencidas, por lo que las tarifas y caramelería
protegidas de Cinex y Cines Unidos devolvieron `auth_required`. Esto es una
limitación de disponibilidad del proveedor y autenticación local, no una
afirmación de que esas rutas estén siempre sanas.
