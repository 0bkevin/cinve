# Cinve

Consulta la cartelera de cine de Venezuela desde un asistente compatible con
[Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

[Sitio web](https://cinve.kevinbravo.com) ·
[Cómo instalarlo](https://cinve.kevinbravo.com/install) ·
[Reportar un problema](https://github.com/0bkevin/cinve/issues/new/choose)

Cinve reúne películas, horarios, precios, caramelería y disponibilidad de
asientos publicada por distintos cines venezolanos.

> **Cinve es un proyecto independiente, gratuito y sin fines de lucro.** No está
> afiliado, asociado, patrocinado ni respaldado por Cinex, Cines Unidos,
> Cinepic, Trasnocho ni por ninguna otra cadena de cines. Sus responsables no
> reciben pagos, comisiones, contraprestaciones ni beneficios económicos de los
> cines o proveedores consultados.

Cinve solo consulta y organiza información. No compra entradas, no reserva
asientos y no interviene en pagos o transacciones. La disponibilidad puede
cambiar antes de completar una compra.

## Qué puedes consultar

- Ciudades, sedes, películas y funciones.
- Precios de entradas y caramelería cuando el proveedor los publica.
- Mapas de asientos de Cinex, Cines Unidos y Cinepic.
- Datos de Cinepic, Cines Unidos y Cinex. Trasnocho tiene cobertura limitada
  porque su sitio bloquea actualmente las consultas automatizadas.

Algunas consultas de Cinex y Cines Unidos requieren que conectes tu cuenta del
cine. Las credenciales se introducen únicamente en el formulario privado; no se
envían al chat ni se guardan como contraseñas en Cinve.

## Usar el servicio alojado

Envía este mensaje a un asistente compatible con MCP:

```text
Instala Cinve siguiendo https://cinve.kevinbravo.com/install
```

También puedes añadir manualmente un servidor MCP remoto llamado `Cinve`:

```text
https://cinve.kevinbravo.com/mcp
```

Las consultas públicas no requieren una cuenta de Cinve. Si una operación
necesita autenticación, el asistente iniciará el flujo seguro para conectar la
cuenta del cine.

## Ejecutar Cinve localmente

Necesitas Node.js 22 o posterior y acceso a Internet.

```sh
git clone https://github.com/0bkevin/cinve.git
cd cinve
npm ci
npm run build
node dist/index.js
```

El último comando usa `stdio`: no muestra un menú porque la salida estándar está
reservada para el protocolo MCP. Configura tu cliente para iniciarlo:

```json
{
  "mcpServers": {
    "cinve": {
      "command": "node",
      "args": ["/ruta/absoluta/cinve/dist/index.js"]
    }
  }
}
```

Hay un ejemplo listo para adaptar en [`mcp.example.json`](mcp.example.json).

### Conectar cuentas en modo local

Ejecuta estos comandos en tu propia terminal. Nunca compartas contraseñas,
cookies ni tokens en un chat, un issue o los argumentos del proceso.

```sh
npm run login -- cinex
npm run login -- cinesunidos
npm run auth:status
```

Cinve guarda sesiones, no contraseñas, en `$XDG_CONFIG_HOME/cinev` o
`~/.config/cinev`. Para eliminarlas:

```sh
npm run logout -- cinex
npm run logout -- cinesunidos
```

## Desarrollo

```sh
npm ci
npm run check
npm test
npm run build
```

`npm test` usa datos sintéticos y una instancia temporal de PostgreSQL; no
consulta las webs de los cines. Necesitas `initdb` y `pg_ctl` disponibles, o una
base de pruebas indicada mediante `TEST_DATABASE_URL`. Nunca uses una base de
producción para las pruebas.

La prueba en vivo es opcional y sí consulta a los proveedores:

```sh
npm run smoke
```

Antes de proponer cambios, lee [`CONTRIBUTING.md`](CONTRIBUTING.md). Los reportes
de vulnerabilidades siguen el proceso privado de [`SECURITY.md`](SECURITY.md).

## Cómo funciona

Cinve expone herramientas MCP sobre `stdio` y HTTP. Los adaptadores consultan
fuentes públicas o sesiones autorizadas, validan las respuestas y normalizan los
resultados antes de entregarlos al asistente.

```text
Asistente MCP → servidor Cinve → adaptador del proveedor → sitio o API del cine
```

- `src/server.ts`: contrato y herramientas MCP.
- `src/service.ts`: respuestas, filtros y paginación.
- `src/providers.ts`: integración con los proveedores.
- `src/http.ts`: acceso HTTP, límites y caché.
- `src/parsers.ts`: lectura segura de JSON y HTML.
- `src/auth.ts`: sesiones locales autorizadas.

Consulta la [referencia técnica](docs/reference.md) para herramientas, estados,
límites y mapas de asientos, y la [guía de despliegue](docs/hosted.md) para el
servicio HTTP con Vercel y PostgreSQL.

## Alcance y precisión

Los cines pueden cambiar sus sitios sin aviso. Cinve distingue una respuesta
vacía de un fallo, conserva advertencias y marca resultados parciales cuando no
puede verificar todos los datos. No inventa identificadores, precios ni estados
de asientos.

Los datos de terceros pertenecen a sus respectivos titulares. Cinve no garantiza
disponibilidad, exactitud ni precios finales; confirma la información con el cine
antes de comprar.

## Independencia y uso no comercial

Cinve no representa a las cadenas de cines ni actúa en su nombre. Los nombres,
marcas, logotipos y demás elementos identificativos mencionados pertenecen a sus
respectivos titulares y se utilizan únicamente para indicar la fuente de la
información consultada.

El proyecto no vende datos, publicidad, entradas ni servicios de intermediación;
no cobra suscripciones o comisiones y no obtiene lucro de las consultas. Su
finalidad es facilitar el acceso a información de cartelera mediante software
abierto.

Las consultas se limitan a información publicada por los proveedores o a datos
que el propio usuario autoriza a consultar mediante su sesión. Cinve no elude
pagos, no realiza compras, no modifica cuentas y no reserva asientos. Cada
persona sigue siendo responsable de respetar las condiciones aplicables y de
confirmar directamente con el cine cualquier precio, disponibilidad o compra.

## Comunidad

- [Contribuir](CONTRIBUTING.md)
- [Código de conducta](CODE_OF_CONDUCT.md)
- [Soporte](SUPPORT.md)
- [Seguridad](SECURITY.md)

## Licencia

El código de Cinve se distribuye bajo la [licencia MIT](LICENSE). La fuente Inter
incluida conserva su propia [licencia SIL Open Font](src/assets/Inter-LICENSE.txt).
