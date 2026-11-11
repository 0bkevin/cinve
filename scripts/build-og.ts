import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Resvg } from '@resvg/resvg-js';
import es from '../src/web/locales/es.js';
import en from '../src/web/locales/en.js';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'src/assets');
const logos = ['claudecode.svg', 'codex.png', 'opencode.svg', 'antigravity.svg', 'hermes.svg', 'openclaw.svg'];
const fontkit = createRequire(import.meta.url)('fontkit') as typeof import('fontkit');

type Locale = typeof es | typeof en;
type OgCopy = Locale['landing']['og'];
type Font = import('fontkit').Font;

const woff2 = createRequire(import.meta.url)('wawoff2') as {
  decompress(data: Uint8Array): Promise<Uint8Array>;
};
// Decode WOFF2 before selecting variations: Fontkit's WOFF2 getVariation()
// loses the compressed table directory. TTF variations retain real weights.
async function loadFont(name: string): Promise<Font> {
  const bytes = await readFile(resolve(out, `${name}.woff2`));
  return fontkit.create(Buffer.from(await woff2.decompress(bytes))) as Font;
}
const display = await loadFont('bricolage-grotesque');
const body = await loadFont('instrument-sans');
const medium = body.getVariation({ wght: 500 });
const semibold = body.getVariation({ wght: 600 });

function textPath(text: string, x: number, baseline: number, font: Font, size: number, color: string, letterSpacing = 0): string {
  const run = font.layout(text);
  const scale = size / font.unitsPerEm;
  let cursor = x;
  const paths = run.glyphs.map((glyph, i) => {
    const position = run.positions[i]!;
    const path = glyph.path.toSVG();
    const part = `<path d="${path}" transform="translate(${(cursor + position.xOffset * scale).toFixed(3)} ${(baseline - position.yOffset * scale).toFixed(3)}) scale(${scale.toFixed(6)} ${(-scale).toFixed(6)})"/>`;
    cursor += position.xAdvance * scale + letterSpacing;
    return part;
  }).join('');
  return `<g fill="${color}">${paths}</g>`;
}

function copyLayer(copy: OgCopy): string {
  const light = '#f3e9e2';
  const muted = '#b8a9a5';
  const amber = '#ffbd3f';
  const deep = '#180e12';
  const pieces: string[] = [];
  const put = (text: string, x: number, y: number, font: Font, size: number, color: string, spacing = 0) => pieces.push(textPath(text, x, y, font, size, color, spacing));

  put('cinve', 68, 99, display, 44, light, -0.5);
  put('.', 170, 99, display, 44, amber, -1.5);
  put(copy.title1, 68, 193, display, 64, light, 1);
  put(copy.title2, 68, 257, display, 64, light, 1);
  put(copy.title3a, 68, 321, display, 64, light, 1);
  const row3PrefixWidth = display.layout(copy.title3a).positions.reduce((n, p) => n + p.xAdvance, 0) * 64 / display.unitsPerEm + copy.title3a.length;
  put(copy.title3b, 68 + row3PrefixWidth, 321, display, 64, amber, 1);
  put(copy.description1, 68, 379, body, 24, muted);
  put(copy.description2, 68, 412, body, 24, muted);

  put(copy.question1, 820, 121, semibold, 21, deep);
  put(copy.question2, 820, 148, semibold, 21, deep);
  put(copy.assistant, 700, 216, medium, 16, muted);
  const assistantWidth = medium.layout(copy.assistant).positions.reduce((n, p) => n + p.xAdvance, 0) * 16 / body.unitsPerEm;
  put('·', 700 + assistantWidth + 7, 216, medium, 16, muted);
  put(copy.withCinve, 700 + assistantWidth + 20, 216, medium, 16, muted);
  put(copy.answer, 684, 250, medium, 21, light);
  put('A', 694, 308, semibold, 15, muted);
  put('B', 694, 338, semibold, 15, muted);
  put('C', 694, 368, semibold, 15, muted);
  put('D', 694, 398, semibold, 15, muted);
  put(copy.available, 706, 431, body, 16, muted);
  put(copy.occupied, 824, 431, body, 16, muted);
  put(copy.together, 947, 431, body, 16, muted);

  put(copy.worksWith, 68, 507, semibold, 14, muted, 1.4);
  put(copy.footer1, 378, 537, body, 18, light);
  put(copy.footer2, 378, 562, body, 18, light);
  const site = 'cinve.kevinbravo.com';
  const siteTracking = 0.5;
  const taglineTracking = 0.5;
  const siteWidth = display.layout(site).positions.reduce((n, p) => n + p.xAdvance, 0) * 24 / display.unitsPerEm + siteTracking * site.length;
  const taglineWidth = body.layout(copy.tagline).positions.reduce((n, p) => n + p.xAdvance, 0) * 20 / body.unitsPerEm + taglineTracking * copy.tagline.length;
  put(site, 1132 - siteWidth, 539, display, 24, light, siteTracking);
  put(copy.tagline, 1132 - taglineWidth, 565, body, 20, muted, taglineTracking);
  return `<g id="copy">${pieces.join('')}</g><!-- /copy -->`;
}

function svgImage(mime: string, base64: string): string {
  return `data:${mime};base64,${base64}`;
}

async function buildSvg(copy: OgCopy): Promise<string> {
  const logoRefs: string[] = [];
  for (const logo of logos) {
    const bytes = await readFile(resolve(out, 'logos', logo));
    if (logo === 'claudecode.svg') {
      const brandSvg = bytes.toString('utf8').replace('<path ', '<path fill="#d97757" ');
      logoRefs.push(svgImage('image/svg+xml', Buffer.from(brandSvg).toString('base64')));
    } else logoRefs.push(svgImage(logo.endsWith('.png') ? 'image/png' : 'image/svg+xml', bytes.toString('base64')));
  }

  const rowPatterns = ['x.x.xx.x.x.x', '.x.xx.x.x.xx', 'x.xxx**xx.x.', '.x.x.xx.x.x.'];
  const rows = rowPatterns.map((pattern, row) => [...pattern].map((state, col) => {
    const x = 722 + col * 32;
    const y = 290 + row * 29.5;
    const fill = state === 'x' ? '#352a2f' : state === '*' ? '#ffbd3f' : '#b21f3d';
    const path = `M${x + 4} ${y + 23}Q${x} ${y + 23} ${x} ${y + 19}V${y + 10}Q${x} ${y} ${x + 13} ${y}Q${x + 26} ${y} ${x + 26} ${y + 10}V${y + 19}Q${x + 26} ${y + 23} ${x + 22} ${y + 23}Z`;
    const glow = state === '*' ? `<path d="${path}" fill="#ffbd3f" opacity=".65" filter="url(#seat-glow)"/>` : '';
    return `${glow}<path d="${path}" fill="${fill}"/>`;
  }).join('')).join('');

  const badges = logoRefs.map((src, i) => {
    const cx = 88 + i * 50;
    const width = i === 2 ? 19 : 24;
    const height = i === 2 ? 24 : 24;
    return `<circle cx="${cx}" cy="545" r="20" fill="#f4ebe3"/><image href="${src}" x="${cx - width / 2}" y="533" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/>`;
  }).join('');

  const copyPaths = copyLayer(copy);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <title>Cinve · ${copy.title1} ${copy.title2} ${copy.title3a}${copy.title3b}</title>
  <desc>${copy.description1} ${copy.description2} ${copy.answer}</desc>
  <defs>
    <filter id="seat-glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="8"/></filter>
    <radialGradient id="background" cx="0" cy="0" r="390" gradientUnits="userSpaceOnUse"><stop stop-color="#241811"/><stop offset="1" stop-color="#120a0e"/></radialGradient>
    <radialGradient id="warmth" cx="1010" cy="210" r="420" gradientUnits="userSpaceOnUse"><stop stop-color="#251116" stop-opacity=".3"/><stop offset="1" stop-color="#120a0e" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#background)"/><rect width="1200" height="630" fill="url(#warmth)"/>
  <path d="M822 86H1112Q1132 86 1132 106V162Q1132 168 1126 168H822Q802 168 802 148V106Q802 86 822 86Z" fill="#ffbd3f"/>
  <path d="M685 182H1109Q1132 182 1132 205V428Q1132 451 1109 451H668Q662 451 662 445V205Q662 182 685 182Z" fill="#1b1017"/>
  <circle cx="688" cy="210" r="4" fill="#ffbd3f"/>
  <path d="M728 270Q901 279 1074 270" fill="none" stroke="#b8a9a5" stroke-width="1.3"/>
  <path d="M729 272Q901 281 1073 272" fill="none" stroke="#b8a9a5" stroke-opacity=".36" stroke-width=".65"/>
  <g id="seatmap">${rows}</g>
  <rect x="684" y="418" width="16" height="14" rx="5" fill="#b21f3d"/><rect x="802" y="418" width="16" height="14" rx="5" fill="#352a2f"/><rect x="925" y="418" width="16" height="14" rx="5" fill="#ffbd3f"/>
  ${badges}
  ${copyPaths}
</svg>`;
}

export async function generate(locale: 'es' | 'en'): Promise<{ svg: string; png: Buffer }> {
  const copy = (locale === 'es' ? es : en).landing.og;
  const svg = await buildSvg(copy);
  const png = Buffer.from(new Resvg(svg, { fitTo: { mode: 'original' }, font: { loadSystemFonts: false } }).render().asPng());
  return { svg, png };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const locale of ['es', 'en'] as const) {
    const { svg, png } = await generate(locale);
    const suffix = locale === 'es' ? '' : '-en';
    await Promise.all([
      writeFile(resolve(out, `og${suffix}.svg`), `${svg}\n`),
      writeFile(resolve(out, `og${suffix}.png`), png),
    ]);
  }
}
