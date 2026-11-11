// What the public pages say about Cinve. Every claim must stay true to the
// service: see docs/hosted.md, docs/reference.md and src/install.ts.
import type { Html } from './jsx.js';
import { icons } from './ui.js';

/** Whether a cinema publishes something, and whether it needs the visitor's own account. */
export type Access = 'open' | 'account' | 'none';
export const accessLabel: Record<Access, string> = { open: 'Sin cuenta', account: 'Con tu cuenta', none: 'No disponible' };
export const cinemas = ['Cinex', 'Cines Unidos', 'Cinepic', 'Supercines', 'Gran Cine'] as const;
/** One value per cinema, in order: adding a cinema without its column fails to compile. */
type Each<T extends readonly unknown[], V> = { -readonly [K in keyof T]: V };
type PerCinema = Each<typeof cinemas, Access>;
export const coverage: { topic: string; ask: string; access: PerCinema }[] = [
  { topic: 'Cartelera y horarios', ask: '¿Qué hay hoy en Caracas?', access: ['open', 'open', 'open', 'open', 'open'] },
  { topic: 'Precios', ask: '¿Cuánto cuesta la entrada?', access: ['account', 'account', 'open', 'open', 'none'] },
  { topic: 'Asientos', ask: '¿Quedan dos asientos juntos?', access: ['account', 'account', 'open', 'none', 'none'] },
  { topic: 'Caramelería', ask: '¿Qué combos tienen?', access: ['account', 'open', 'none', 'open', 'none'] },
];

/** An assistant Cinve works with and its documented way to add a remote MCP
 *  server (each tool's docs or --help; logo sources in src/assets/logos/SOURCES.md).
 *  Codex is configured in config.toml because some versions of `codex mcp
 *  add` start an optional login at once. Gemini CLI is left out: since June
 *  2026 it only serves Gemini Code Assist Standard/Enterprise, and individual
 *  users moved to Antigravity. */
export type Assistant = { name: string; logo: LogoFile; how: string; file?: string; setup: (endpoint: string) => string };
export type LogoFile = 'claudecode.svg' | 'codex.png' | 'opencode.svg' | 'antigravity.svg' | 'hermes.svg' | 'openclaw.svg';
export const assistants: Assistant[] = [
  { name: 'Claude Code', logo: 'claudecode.svg', how: 'Ejecuta en tu terminal:', setup: url => `claude mcp add --transport http cinve ${url}` },
  { name: 'Codex', logo: 'codex.png', how: 'Añade esto a', file: '~/.codex/config.toml', setup: url => `[mcp_servers.cinve]\nurl = "${url}"` },
  { name: 'OpenCode', logo: 'opencode.svg', how: 'Ejecuta en tu terminal:', setup: url => `opencode mcp add cinve --global --url ${url}` },
  { name: 'Antigravity', logo: 'antigravity.svg', how: 'Ejecuta en tu terminal:', setup: url => `agy mcp add cinve ${url}` },
  { name: 'Hermes', logo: 'hermes.svg', how: 'Ejecuta en tu terminal:', setup: url => `hermes mcp add cinve --url ${url}` },
  { name: 'OpenClaw', logo: 'openclaw.svg', how: 'Ejecuta en tu terminal:', setup: url => `openclaw mcp add cinve --url ${url} --transport streamable-http` },
];

/** How visitor data is handled: four short points, then the details. */
export const safeguardSummary: [title: string, text: string][] = [
  ['Tu contraseña', 'Se usa una vez para entrar al cine y no se guarda.'],
  ['Sesión cifrada', 'Atada a la conexión de tu asistente.'],
  ['Enlaces privados', 'De un solo uso; caducan en 10 minutos.'],
  ['Tú decides', 'Desconecta tu cuenta cuando quieras.'],
];
export const safeguards: [icon: Html, title: string, text: string][] = [
  [icons.keyRound(), 'Tu contraseña no se guarda', 'La escribes solo en la página privada del enlace, nunca en el chat. Cinve la usa una vez, por una conexión segura, para iniciar sesión en el cine, y no la almacena.'],
  [icons.lock(), 'Sesiones cifradas', 'Solo guardamos la sesión que te da el cine, cifrada con AES-256-GCM y atada a tu conexión. Vence cuando vence la del cine.'],
  [icons.link(), 'Enlaces de un solo uso', 'Caducan en 10 minutos. Su código va después del «#» de la dirección, así que el navegador no lo envía al servidor.'],
  [icons.shieldCheck(), 'Acceso con tu permiso', 'Tu asistente se conecta con OAuth y PKCE. Guardamos solo huellas SHA-256 de sus tokens, y reutilizar uno revoca la conexión.'],
  [icons.unplug(), 'Desconecta cuando quieras', 'Pídeselo a tu asistente y borramos tu sesión. Lo vencido se elimina cada día. Para cerrarla también en el cine, hazlo en su web.'],
  [icons.eyeOff(), 'Sin rastreadores', 'Esta web no carga anuncios, analíticas ni recursos de otros sitios. Cada conexión está separada: otra aplicación no ve tus cuentas.'],
];

export const faq: [question: string, answer: string][] = [
  ['¿Qué es Cinve?', 'Un servidor MCP gratuito y de código abierto. Con él, tu asistente consulta la cartelera, los horarios, los precios y los asientos de Cinex, Cines Unidos, Cinepic, Supercines y Gran Cine, según lo que publica cada cine. Solo consulta: no compra entradas.'],
  ['¿Cuánto cuesta?', 'Nada. Cinve es gratis y no muestra anuncios.'],
  ['¿Con qué asistentes funciona?', 'Con los que aceptan conexiones MCP remotas, como Claude Code, Codex u OpenCode. Si tu asistente no tiene esa opción, todavía no puede usar Cinve.'],
  ['¿Necesito crear una cuenta?', 'En Cinve, no. Para ver precios y asientos de Cinex y Cines Unidos, tu asistente te pedirá conectar tu cuenta de ese cine. En Supercines es opcional: sin ella ves las tarifas públicas.'],
  ['¿Qué tan actualizada está la información?', 'Cinve la consulta en la web del cine cuando preguntas y reutiliza algunas respuestas por unos minutos. Los asientos pueden cambiar: confírmalos en la web del cine antes de comprar.'],
  ['¿Puedo comprar entradas desde el chat?', 'No. Cinve solo consulta, pero cuando el cine lo publica, tu asistente te da el enlace para comprar esa función en su web.'],
  ['¿Por qué no aparece mi cine o mi ciudad?', 'Cinve muestra las sedes que cada cine publica en su web, y Cinepic por ahora solo en Caracas. Si falta alguna, avísanos en GitHub.'],
  ['¿Cómo desconecto mi cuenta del cine?', 'Escríbele a tu asistente «desconecta mi cuenta de Cinex» (o de Cines Unidos o Supercines) y borramos la sesión guardada.'],
  ['¿Cinve es oficial?', 'No. Es un proyecto independiente, sin relación con los cines.'],
];

/** Who and what Cinve is, for search and answer engines (schema.org). No
 *  ratings or offers: Cinve has none, so none are claimed. */
export const structuredData = (origin: string) => ({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', '@id': `${origin}/#website`, url: `${origin}/`, name: 'Cinve', inLanguage: 'es-VE', publisher: { '@id': 'https://kevinbravo.com/#person' } },
    { '@type': 'SoftwareApplication', '@id': `${origin}/#app`, name: 'Cinve', url: `${origin}/`,
      description: 'Servidor MCP gratuito y de código abierto para que tu asistente consulte cartelera, horarios, precios y asientos de cines en Venezuela.',
      applicationCategory: 'UtilitiesApplication', operatingSystem: 'Cualquiera (servidor MCP remoto)', isAccessibleForFree: true,
      license: 'https://opensource.org/license/mit', inLanguage: 'es-VE', areaServed: { '@type': 'Country', name: 'Venezuela' },
      sameAs: ['https://github.com/0bkevin/cinve'], author: { '@id': 'https://kevinbravo.com/#person' } },
    { '@type': 'Person', '@id': 'https://kevinbravo.com/#person', name: 'Kevin Bravo', url: 'https://kevinbravo.com' },
  ],
});
