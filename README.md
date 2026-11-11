# Cinve

Cartelera de cine de Venezuela para tu asistente de IA.

Cinve es un servidor [MCP](https://modelcontextprotocol.io/) que permite a
asistentes como Claude Code, Codex o Cursor consultar películas, horarios, precios,
caramelería y disponibilidad de asientos de **Cinex, Cines Unidos, Cinepic,
Supercines y Gran Cine**.

[Sitio web](https://cinve.kevinbravo.com) ·
[Instalación](https://cinve.kevinbravo.com/install) ·
[Reportar un problema](https://github.com/0bkevin/cinve/issues/new/choose)

> Cinve es un proyecto independiente y sin fines de lucro, no afiliado a ninguna
> cadena de cines. Solo consulta información: no compra entradas ni reserva
> asientos.

## Uso rápido

Pídele a tu asistente:

```text
Instala Cinve siguiendo https://cinve.kevinbravo.com/install
```

O añade manualmente un servidor MCP remoto con esta URL:

```text
https://cinve.kevinbravo.com/mcp
```

Después pregunta con naturalidad:

- «¿Qué películas hay hoy en Caracas?»
- «¿A qué hora dan la nueva película de Pixar en Cinex?»
- «¿Cuánto cuestan las entradas y las cotufas en Cines Unidos?»
- «¿Quedan asientos para la función de las 7?»

Las consultas públicas no requieren cuenta. Algunas consultas de Cinex y
Cines Unidos necesitan tu cuenta del cine: el asistente te
abrirá un formulario privado para conectarla. Nunca escribas contraseñas en el
chat.

## Ejecutarlo en tu equipo

Requiere Node.js 22 o posterior.

```sh
git clone https://github.com/0bkevin/cinve.git
cd cinve
npm ci
npm run build
```

Configura tu cliente MCP para iniciarlo por `stdio`:

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

Para conectar tus cuentas de cine, ejecuta en tu propia terminal:

```sh
npm run login -- cinex        # o cinesunidos, supercines
npm run auth:status
npm run logout -- cinex
```

Las sesiones (nunca las contraseñas) se guardan en `~/.config/cinev`.

## Alojar tu propio servidor

El modo HTTP sirve a varios usuarios con OAuth y guarda sesiones cifradas en
PostgreSQL.

**Variables de entorno**

| Variable               | Descripción                                                     |
| ---------------------- | --------------------------------------------------------------- |
| `DATABASE_URL`         | Conexión a PostgreSQL (con TLS).                                |
| `CINEV_PUBLIC_URL`     | Origen HTTPS público, p. ej. `https://cine.ejemplo.com`.        |
| `CINEV_ENCRYPTION_KEY` | 64 caracteres hex: `openssl rand -hex 32`. Consérvala.          |
| `CRON_SECRET`          | Secreto para la limpieza diaria (`openssl rand -hex 32`).        |
| `PORT`                 | Puerto HTTP (por defecto `3000`). Solo fuera de Vercel.         |

Cambiar `CINEV_ENCRYPTION_KEY` obliga a todos a reconectar sus cuentas.

### En Vercel

1. Crea un proyecto en Vercel y conecta una base PostgreSQL (p. ej. Neon).
2. Define las variables de entorno anteriores.
3. Aplica las migraciones: `npm run db:migrate`.
4. Despliega: `vercel --prod`. `vercel.json` ya incluye las rutas y la tarea
   diaria de limpieza.
5. Verifica: `curl https://<dominio>/health`.

### En cualquier servidor con Node.js

```sh
npm ci
npm run build
npm run db:migrate
npm run start:hosted
```

Ponlo detrás de un proxy con HTTPS y programa la limpieza diaria (por ejemplo,
con cron):

```sh
npm run db:cleanup
```

Tu servidor MCP quedará en `https://<dominio>/mcp`. Consulta la
[guía de despliegue](docs/hosted.md) para los detalles de OAuth, límites de uso
y seguridad.

## Desarrollo

```sh
npm run check   # tipos
npm test        # pruebas con PostgreSQL temporal (requiere initdb y pg_ctl)
npm run smoke   # prueba en vivo contra los cines
```

Lee [`CONTRIBUTING.md`](CONTRIBUTING.md) antes de proponer cambios y
[`SECURITY.md`](SECURITY.md) para reportar vulnerabilidades. La
[referencia técnica](docs/reference.md) describe las herramientas MCP, el
contrato de respuesta y los mapas de asientos.

## Autor

Creado por [Kevin Bravo](https://kevinbravo.com).

## Licencia

[MIT](LICENSE). Las fuentes y hojas de estilo incluidas en `src/assets`
conservan sus propias licencias. Los nombres y marcas de los cines pertenecen a
sus titulares.
