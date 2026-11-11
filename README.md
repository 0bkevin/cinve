![Cinve: look up movies, showtimes and prices at Venezuelan cinemas from your assistant](src/assets/og.png)

# Cinve

An [MCP](https://modelcontextprotocol.io/) server that lets your AI assistant
look up movies, showtimes, ticket prices, concessions and seats at **Cinex,
Cines Unidos, Cinepic, Supercines and Gran Cine** in Venezuela.

[Website](https://cinve.kevinbravo.com) ·
[Report an issue](https://github.com/0bkevin/cinve/issues/new/choose)

> An independent, non-profit project, not affiliated with any cinema. It does not
> buy tickets or reserve seats.

## Usage

Ask your assistant:

```text
Install Cinve following https://cinve.kevinbravo.com/install
```

Or add this remote MCP server: `https://cinve.kevinbravo.com/mcp`

Then ask, for example: "What movies are showing in Caracas today?" or "Are
there seats left for the 7 pm showing?".

Some Cinex and Cines Unidos queries need your cinema account; the assistant will
give you a private link to connect it. Never type passwords in the chat.

## Run it locally

Requires Node.js 22 or later.

```sh
git clone https://github.com/0bkevin/cinve.git
cd cinve
npm ci
npm run build
```

Configure your MCP client:

```json
{
  "mcpServers": {
    "cinve": {
      "command": "node",
      "args": ["/absolute/path/cinve/dist/index.js"]
    }
  }
}
```

Connect your cinema accounts from your terminal:

```sh
npm run login -- cinex     # or cinesunidos, supercines
npm run logout -- cinex
```

## Host your own server

You need PostgreSQL and a domain with HTTPS. Follow the
[deployment guide](docs/hosted.md).

## Development

```sh
npm run check
npm test
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[technical reference](docs/reference.md). For vulnerabilities, follow
[`SECURITY.md`](SECURITY.md).

## Author

Created by [Kevin Bravo](https://kevinbravo.com).

## License

[MIT](LICENSE).
