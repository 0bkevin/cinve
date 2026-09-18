# Trasnocho: investigación de acceso y datos bajo demanda

Observado el 17 de septiembre de 2026 mediante una pestaña de Chrome abierta por
el usuario.

## Acceso y contenido confirmados

La portada, `/cine/`, `/teatro/` y las fichas de productos cargaron correctamente
en esa sesión. Esto reemplaza la observación anterior de bloqueo en navegador,
pero no demuestra que un servidor sin intervención pueda acceder.

- La cartelera de cine es el producto `395931`. Su URL todavía menciona febrero,
  mientras el título y las tablas visibles indican 13–19 de agosto. Las filas de
  una película indican 8–9 de agosto. Ni la URL ni el título semanal pueden
  fechar con seguridad todas las filas.
- `La invitación`, producto `396980`, muestra sinopsis, ficha técnica, afiche,
  días y horas de agosto y precios editoriales —general $5; lunes y tercera edad
  $2,50 con condiciones—. Son observaciones de la fuente, no precios actuales
  verificados.
- `Sin/Con Secuencias`, producto `48562`, muestra descripción teatral, reparto,
  categoría `Salas Espacio Plural`, funciones del 15–16 de agosto a las 7 p. m. y
  entrada general de $12. El breadcrumb llama “Películas” incluso a este producto
  teatral, por lo que no sirve por sí solo para clasificar el evento.
- El catálogo mezcla anuncios y concursos con funciones. Cinve no tiene un tipo
  `event` ni una operación para eventos; el teatro no debe convertirse
  silenciosamente en una película.

## Descubrimiento de la API pública

`https://www.trasnochocultural.com/wp-json/` mostró correctamente en Chrome el
documento de descubrimiento REST. Anuncia:

- `GET /wp-json/wp/v2/product`, con registros publicados, orden por modificación
  y paginación de hasta 100 elementos;
- `GET /wp-json/wc/store/v1/products`, colección separada de la tienda;
- `GET /wp-json/wp/v2/product_cat`.

Candidato concreto para una lectura incremental:

```text
https://www.trasnochocultural.com/wp-json/wp/v2/product?orderby=modified&order=desc&per_page=10&_fields=id,modified,date,link,title,content,product_cat
```

La consulta de productos y la colección de tienda devolvieron
`ERR_BLOCKED_BY_CLIENT` en Chrome. Una lectura separada con Node devolvió HTTP
403 y un desafío de Cloudflare. No se obtuvo ningún contenido de la API,
fecha de modificación ni evento vigente. Descubrir una ruta no demuestra que
sea utilizable. No se desactivaron protecciones del navegador ni se exportaron
cookies.

## Frescura y requisitos de integración

El candidato es un adaptador de solo lectura con un lector de navegador como
respaldo opcional. Sigue sin validar hasta que el endpoint devuelva datos. Una
integración desatendida requiere acceso repetible al endpoint público o una
fuente ofrecida por el proveedor.

Cuando el acceso funcione, debe consultarse bajo demanda y conservar por separado
la URL, la hora de consulta y la fecha de modificación de la fuente. Las fechas
de funciones deben interpretarse en `America/Caracas`, validar día de semana y
año, y señalar años ausentes, cancelaciones, reprogramaciones o contradicciones.
No se deben trasladar filas antiguas de agosto a la semana actual. Una descarga o
edición reciente no demuestra que las funciones sigan vigentes.

Se deben usar identificadores estables de producto, no títulos o slugs con
fechas. Los metadatos del catálogo deben separarse de las funciones fechadas y
los eventos de teatro deben mantenerse distintos del cine. Los precios
editoriales deben conservar sus condiciones y nunca presentarse como un total de
compra confirmado. Si solo hay horarios vencidos o ambiguos, la respuesta debe
ser `unavailable` con una advertencia de frescura; no debe afirmar que no hay
funciones.

## Otras fuentes oficiales revisadas

El perfil oficial de Instagram `https://www.instagram.com/trasnochocult/` carga,
pero abrir una publicación requiere login. No se verificó ningún texto actual.

Las fichas enlazan el catálogo oficial de taquilla en WhatsApp,
`https://wa.me/c/584146913811`. Su página pública carga y redirige a WhatsApp Web.
No se envió ningún mensaje.

El usuario prohibió explícitamente entrar en WhatsApp. Se cerró esa pestaña y se
volvió a la portada de Trasnocho. No debe usarse WhatsApp para investigaciones o
integraciones posteriores.

El adaptador de producción no cambió: no puede anunciar inventario actual basándose
solo en estas muestras históricas o en el documento de descubrimiento.
