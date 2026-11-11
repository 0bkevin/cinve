// Text to copy as is, each with a copy button that site.js reveals (the
// buttons stay hidden without JavaScript; the text remains selectable).
import { h, Fragment } from '../jsx.js';
import { Button, icons } from '../ui.js';

type CopyButtonProps = { target: string; id?: string; variant?: 'ghost'; size?: 'sm'; 'data-feedback'?: string; 'aria-label'?: string };
const CopyButton = ({ target, ...rest }: CopyButtonProps) =>
  <Button data-copy={target} hidden {...rest}>{icons.copy()}<span>Copiar</span></Button>;

/** The message users paste into their assistant. */
export function InstallMessage({ origin }: { origin: string }) {
  return <>
    <div class="install">
      <p id="install-message">Instala Cinve siguiendo {origin}/install</p>
      <CopyButton target="install-message" id="copy-install" data-feedback="copy-feedback" />
    </div>
    <p id="copy-feedback" class="note" role="status" aria-live="polite"></p>
  </>;
}

/** A command or setting. Each word is unbreakable, so long commands wrap only between words. */
export function Snippet({ id, children }: { id: string; children: string }) {
  return <div class="snippet">
    <pre id={id}>{children.split('\n').map((line, i) => <>{i > 0 && '\n'}{line.split(' ').map((word, j) => <>{j > 0 && ' '}<span>{word}</span></>)}</>)}</pre>
    <CopyButton target={id} variant="ghost" size="sm" aria-label="Copiar" />
  </div>;
}
