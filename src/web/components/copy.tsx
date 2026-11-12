// Text to copy as is, each with a copy button that site.js reveals (the
// buttons stay hidden without JavaScript; the text remains selectable).
import { h, Fragment } from '../jsx.js';
import { Button, icons } from '../ui.js';
import { catalog } from '../content.js';
import type { Locale } from '../locale.js';

type CopyButtonProps = { target: string; id?: string; variant?: 'ghost'; size?: 'sm'; 'data-feedback'?: string; 'aria-label'?: string };
const CopyButton = ({ target, locale = 'es', ...rest }: CopyButtonProps & { locale?: Locale }) =>
  <Button data-copy={target} hidden data-copy-label={catalog(locale).browser.copy} data-copied-label={catalog(locale).browser.copied} {...rest}>{icons.copy()}<span>{catalog(locale).browser.copy}</span></Button>;

/** The message users paste into their assistant. */
export function InstallMessage({ origin, locale = 'es' }: { origin: string; locale?: Locale }) {
  return <>
    <div class="install">
      <p id="install-message">{catalog(locale).components.installMessage} {origin}/install</p>
      <CopyButton locale={locale} target="install-message" id="copy-install" data-feedback="copy-feedback" />
    </div>
    <p id="copy-feedback" class="note" role="status" aria-live="polite" data-copy-error={catalog(locale).browser.copyFailure}></p>
  </>;
}

/** A command or setting. Each word is unbreakable, so long commands wrap only between words. */
export function Snippet({ id, children, locale = 'es' }: { id: string; children: string; locale?: Locale }) {
  return <div class="snippet">
    <pre id={id}>{children.split('\n').map((line, i) => <>{i > 0 && '\n'}{line.split(' ').map((word, j) => <>{j > 0 && ' '}<span>{word}</span></>)}</>)}</pre>
    <CopyButton locale={locale} target={id} variant="ghost" size="sm" aria-label={catalog(locale).components.copy} />
  </div>;
}
