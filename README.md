![Cinve: consulta películas, horarios y precios de cines en Venezuela desde tu asistente](src/assets/og.png)

# Cinve

Servidor [MCP](https://modelcontextprotocol.io/) para consultar desde tu
asistente de IA las películas, horarios, precios, caramelería y asientos de
**Cinex, Cines Unidos, Cinepic, Supercines y Gran Cine**.

[Sitio web](https://cinve.kevinbravo.com) ·
[Reportar un problema](https://github.com/0bkevin/cinve/issues/new/choose)

> Proyecto independiente y sin fines de lucro, no afiliado a ningún cine. No
> compra entradas ni reserva asientos.

## Uso

Pídele a tu asistente:

```text
Instala Cinve siguiendo https://cinve.kevinbravo.com/install
```

O añade este servidor MCP remoto: `https://cinve.kevinbravo.com/mcp`

Luego pregunta, por ejemplo: «¿Qué películas hay hoy en Caracas?» o «¿Quedan
asientos para la función de las 7?».

Algunas consultas de Cinex y Cines Unidos requieren tu cuenta del cine; el
asistente te dará un enlace privado para conectarla. Nunca escribas contraseñas
en el chat.

## Ejecutarlo en tu equipo

Requiere Node.js 22 o posterior.

```sh
git clone https://github.com/0bkevin/cinve.git
cd cinve
npm ci
npm run build
```

Configura tu cliente MCP:

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

Conecta tus cuentas de cine desde tu terminal:

```sh
npm run login -- cinex     # o cinesunidos, supercines
npm run logout -- cinex
```

## Alojar tu propio servidor

Necesitas PostgreSQL y un dominio con HTTPS. Sigue la
[guía de despliegue](docs/hosted.md).

## Desarrollo

```sh
npm run check
npm test
```

Consulta [`CONTRIBUTING.md`](CONTRIBUTING.md) y la
[referencia técnica](docs/reference.md). Para vulnerabilidades, sigue
[`SECURITY.md`](SECURITY.md).

## Autor

Creado por [Kevin Bravo](https://kevinbravo.com).

## Licencia

[MIT](LICENSE).
