# Acceso autenticado por HTTP

Comprobado el 11 de septiembre de 2026 con cuentas que el usuario autorizó expresamente. Este documento no incluye identificadores personales, contraseñas, cookies ni tokens. No se ejecutó navegador ni JavaScript remoto.

## Resultado

| Proveedor | Login HTTP | Datos adicionales verificados |
|---|---|---|
| Cinex | Sí, formulario PHP y cookie de sesión | Tarifas por función y caramelería de sede, incluidos precios de combos en HTML de sus modales. |
| Cines Unidos | Sí, NextAuth + formulario Keycloak | Tarifas por función en API JSON, sin crear una orden ni proporcionar un identificador de transacción. |

Esto confirma acceso a los datos probados, no a toda la información de cada cadena. No se consultaron historiales de compra, datos bancarios ni otros perfiles. No se seleccionaron asientos, añadieron productos o confirmaron pagos. Durante la exploración de Cinex se envió el formulario de selección de sede a `prepareconcessionprocess.php`; después se verificó que el catálogo funciona por GET directo con una sesión nueva. El MCP no necesita ese POST.

## Cinex

1. GET de [la página principal](https://www.cinex.com.ve/), conservando cookies.
2. POST multipart a `https://www.cinex.com.ve/assets/php/validatelogin.php`, campos `username`, `password`. Se añaden `Origin`, `Referer` del sitio y `X-Requested-With: XMLHttpRequest`, como su frontend jQuery.
3. Se requiere `result: OK` y GET a `https://www.cinex.com.ve/checklogin.php` con respuesta `on`. No se conserva el perfil incluido en el JSON.
4. GET `https://www.cinex.com.ve/boletos.php?sessionid={funcion}&cinemaid={sede}` para tarifas.
5. GET `https://www.cinex.com.ve/concesiones.php?cinemaid={sede}` para caramelería.

La solicitud inicial sin los encabezados del formulario devolvió HTTP 200 con `ACCESO DENEGADO`; no era evidencia de contraseña incorrecta. Con los encabezados, ambos chequeos de login resultaron correctos. Las pruebas posteriores también funcionaron desde el comando TypeScript implementado.

Muestras: Tolón `TLN`, función futura `76907` de Coyote vs Acme, devolvió Adulto Dig por **5.827,43 VES**, compuesto por boleto **832,49 VES** y otros cargos **4.994,94 VES**. La función pasada `76900` devolvió el mensaje de boletos no disponibles. El MCP distingue ese fallo de una lista vacía y de un login faltante.

Caramelería: se obtuvieron **86 registros únicos en Tolón** y **52 en Recreo**, con la sesión nueva del CLI. Son productos/grupos de opciones normalizados, no todos los SKU posibles. Ejemplo de la muestra inicial Tolón: Cotufa Mega Pop **16.649,80 VES**. Los importes se leen de campos `amount{id}` y etiquetas `Bs.`. Los combos pueden guardar el importe en `overlaycombofather{id}`; se devuelve `options_required: true`. Los grupos de bebidas contienen radios para elegir sabor. Los límites del control de cantidad no prueban stock, por lo que se omite ese campo.

Solo se exponen precios Cinex en VES: los campos internos con sufijo USD no se han validado para producir una cotización final equivalente. Se conservan los decimales del proveedor. Las sumas de componentes visibles pueden tener pequeñas diferencias por redondeo.

## Cines Unidos

El frontend usa `signIn("keycloak")`; la lista de [proveedores NextAuth](https://www.cinesunidos.com/api/auth/providers) también anuncia credentials, pero no hizo falta usar esa alternativa.

1. GET `https://www.cinesunidos.com/api/auth/csrf` y conservar cookie/CSRF.
2. POST de formulario a `https://www.cinesunidos.com/api/auth/signin/keycloak`, con `csrfToken`, `callbackUrl` y `json=true`.
3. Seguir su URL hacia `keycloak.cinesunidos.com`, leer el formulario y sus campos ocultos.
4. POST con email/contraseña a la acción de ese formulario bajo `/realms/cinesunidos/login-actions/authenticate`. Conservar cookies y seguir la respuesta OAuth hasta el callback del sitio.
5. GET `https://www.cinesunidos.com/api/auth/session`. Conservar únicamente `access_token` y su vencimiento; descartar perfil, id_token y cookies del login.
6. GET `https://gateway.cinesunidos.com/tickets/www/theaters/{cinema_id}/sessions/{session_id}/` con `Authorization: Bearer …` y `xChannel: www`.

El último segmento `userSessionId` de la ruta del frontend puede quedar vacío, con barra final. La consulta devolvió HTTP 200 sin crear órdenes. Anónimamente había devuelto HTTP 401.

Ejemplo: Metrocenter `1002`, función `44738` de Código Venganza, tarifa general **2 USD / 1.664,97 VES** y adulto mayor **1 USD / 832,49 VES**. Los valores se toman de `price.refPrice` (USD) y `price.total` (VES), los mismos que muestra el frontend. `price.grossPrice.total` difiere por redondeo en algunas muestras, por lo que no sustituye a `price.total`.

La semántica está en los bundles oficiales observados: `155-ec8027c80bd103eb.js` pasa `refPrice,total` a `formatCurrency`; `6956-f2ca16d60eb0294e.js` selecciona USD/VES para esos argumentos. Los nombres/hash pueden cambiar. Se preservan las restricciones `redemption_only`, `child_only`, `sales_allowed` y `area_category_code`.

La caramelería de Cines Unidos ya funcionaba sin login mediante `/concessions/www/cinemas/{id}/concessions`; no necesita recibir el token.

## Uso por otros usuarios

El agente usa `get_auth_status` y, si falta sesión, indica `npm run login -- cinex` o `npm run login -- cinesunidos`. La persona introduce su contraseña en una terminal con entrada oculta. No hay parámetros MCP para secretos ni una herramienta que le pida al agente recopilar contraseñas.

Cada usuario mantiene su propia sesión local, con permisos privados y fuera del repositorio. No se guardan contraseñas ni se refrescan mediante ellas. El token de Cines Unidos observado tiene cinco días de vigencia; el código usa su `exp`, no ese número fijo. Cinex tiene un límite local de 24 horas, sin prometer que la sesión remota dure ese tiempo. Un desafío extra, revocación o expiración obliga a conectar de nuevo.

El alcance implementado es MCP local por usuario. Un servicio remoto multiusuario requiere diseño adicional de autenticación del servicio, enlace privado de cuentas y aislamiento/cifrado de sesiones. No se deben reutilizar estas cuentas autorizadas como credenciales comunes para otros usuarios.

## Límites que permanecen

- Cinepic conserva el acceso público verificado en la investigación anterior; la caramelería de sus dos sedes devolvió listas vacías en las muestras.
- Trasnocho devolvió 403. Las credenciales de Cinex/Cines Unidos no cambian ese resultado.
- No se comprueban totales finales de compra, disponibilidad de asientos ni todas las variantes de combos.
- No hay autorización de API oficial garantizada ni estabilidad contractual de estos endpoints del frontend; cambios de HTML, formularios o API deben reflejarse como errores explícitos.

## Verificación

Los dos logins funcionaron desde el CLI nuevo. Se comprobaron lecturas reales con esas sesiones y el cliente oficial MCP sobre stdio. `npm run check`, `npm test` (36 pruebas) y `npm run build` pasaron. Las pruebas incluyen sesiones privadas, aislamiento entre cuentas, rutas/redirects limitados, logout sin caché autenticada, ausencia de secretos en respuestas y normalización de los precios observados. Los datos de prueba son sintéticos; las respuestas privadas de investigación se eliminan después de comprobar la integración.
