# Continuación del login de Codex local

## Causa reproducida

El login CLI guarda OAuth, pero la conexión MCP de una conversación abierta puede continuar anónima. La prueba real con App Server reproduce `client_authorized=false` después del login externo y `true` después de `config/mcpServer/reload`. Nuestra instrucción anterior terminaba pidiendo una reconexión si el asistente no tenía expuesta esa acción. El usuario recibía ese texto literalmente aunque el equipo ya tenía la autorización guardada.

## Cambio

Se ofrece un auxiliar autónomo en `/codex-client.mjs`. Usa el Codex instalado y un hilo efímero exclusivamente para llamadas de herramientas: no ejecuta modelos, ni lee archivos de tokens ni contraseñas. Si OAuth existe lo reutiliza. Si falta, inicia OAuth nativo en su propio App Server, emite inmediatamente la URL y espera la notificación de éxito. Luego obtiene el enlace de cuenta de cine, lo muestra y sondea el estado hasta que se conecta o vence. Denegación, cancelación y errores detienen el flujo sin repetir login.

Si la conversación original conserva su transporte anónimo, el auxiliar ejecuta las consultas pendientes sobre una conexión nueva usando las credenciales guardadas por Codex. No afirma actualizar el transporte de otra aplicación. Las instrucciones del servidor y `/install` describen cuándo usarlo automáticamente, cómo presentar enlaces y continuar sin reiniciar la conversación. Se conservan los formularios privados, aislamiento de cuentas y OAuth estándar.

## Validación

- Pruebas deterministas: OAuth nuevo, OAuth guardado sin reautorizar, denegación sin reintento, consultas permitidas y rechazo de herramientas de modificación.
- HTTP: script autónomo servido por GET/HEAD, sin caché; POST rechazado.
- `npm run test:codex-auth`: Codex real contra servidor y cuentas sintéticas. Reproduce transporte anónimo tras CLI, verifica refresco nativo y prueba el auxiliar publicado: reutiliza OAuth, conecta cuenta, detecta finalización y devuelve una consulta posterior sin reiniciar la conversación original.
- Comprobación local de producción: el auxiliar encontró OAuth válido y ambas cuentas de cine desconectadas; generó directamente el enlace privado Cinex, presentado al usuario. No se introdujeron credenciales del usuario como agente.

Referencia de los métodos de App Server: https://learn.chatgpt.com/docs/app-server . Se trata de una API experimental del cliente; el camino MCP OAuth nativo sigue disponible para otros asistentes y para versiones de Codex que no admitan el auxiliar.
