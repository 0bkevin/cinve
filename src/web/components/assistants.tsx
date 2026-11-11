import { h, Fragment } from '../jsx.js';
import { assetUrl } from '../assets.js';
import { icons } from '../ui.js';
import { assistants, type LogoFile } from '../content.js';
import { Snippet } from './copy.js';
import { catalog } from '../content.js';
import type { Locale } from '../locale.js';

/** An assistant's logo on a light disc, so each mark shows as published. The
 *  data-logo hook lets CSS size each mark by how big it looks, not by its
 *  file's box. Claude Code's vendored mark is a bare shape, so CSS paints it in
 *  its brand colour through a mask instead of editing the file. */
export function AppMark({ logo }: { logo: LogoFile }) {
  const slug = logo.replace(/\.\w+$/, '');
  return <span class="app-mark" aria-hidden="true">{slug === 'claudecode'
    ? <span class="logo-claudecode" data-logo={slug}></span>
    : <img src={assetUrl(`/assets/logos/${logo}`)} alt="" width="18" height="18" loading="lazy" data-logo={slug} />}</span>;
}

export function WorksWith({ locale = 'es' }: { locale?: Locale }) {
  return <ul class="works-with" aria-label={catalog(locale).components.compatibleAssistants}>
    {assistants.map(({ name, logo }) => <li><AppMark logo={logo} />{name}</li>)}
  </ul>;
}

/** Pick an app, see only its step. Radios keep it working without JavaScript
 *  and give arrow-key navigation; CSS shows the panel whose position matches
 *  the checked radio. */
export function AppPicker({ endpoint, labelledBy, locale = 'es' }: { endpoint: string; labelledBy: string; locale?: Locale }) {
  const words = catalog(locale).components;
  return <div class="picker" role="radiogroup" aria-labelledby={labelledBy}>
    <div class="picker-options">
      {assistants.map(({ name, logo }, i) => <>
        <input type="radio" name="app" id={`app-${i}`} class="visually-hidden" checked={i === 0} />
        <label for={`app-${i}`}><AppMark logo={logo} />{name}</label>
      </>)}
      <input type="radio" name="app" id="app-other" class="visually-hidden" />
      <label for="app-other"><span class="app-mark app-mark-other" aria-hidden="true">{icons.ellipsis()}</span>{words.other}</label>
    </div>
    <div class="picker-panels">
      {assistants.map(({ file, setup }, i) => <div class="picker-panel">
        <p>{i === 1 ? words.addTo : words.runTerminal}{file && <> <code>{file}</code>:</>}</p>
        <Snippet locale={locale} id={`cmd-${i}`}>{setup(endpoint)}</Snippet>
      </div>)}
      <div class="picker-panel">
        <p>{words.genericSetup} <strong>cinve</strong>, {words.chooseHttp}</p>
        <Snippet locale={locale} id="cmd-url">{endpoint}</Snippet>
      </div>
    </div>
  </div>;
}
