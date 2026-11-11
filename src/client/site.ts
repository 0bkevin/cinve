// Copy button for the install message on the landing and install pages.
// The button stays hidden without JavaScript; the message remains selectable.
const button = document.getElementById('copy-install') as HTMLButtonElement | null;
const message = document.getElementById('install-message');
const feedback = document.getElementById('copy-feedback');

if (button && message && feedback) {
  const label = button.querySelector('span')!;
  let reset: number | undefined;
  button.hidden = false;
  // Some browsers and embedded previews block the async clipboard API, so
  // fall back to selecting the message and copying the selection.
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); return; } catch {}
    const selection = getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(message);
    selection.removeAllRanges(); selection.addRange(range);
    const copied = document.execCommand('copy');
    selection.removeAllRanges();
    if (!copied) throw new Error('copy failed');
  };
  button.addEventListener('click', async () => {
    try {
      await copy(message.textContent ?? '');
      label.textContent = 'Copiado';
      feedback.textContent = 'Mensaje copiado. Pégalo en tu asistente.';
      clearTimeout(reset);
      reset = window.setTimeout(() => { label.textContent = 'Copiar'; }, 2500);
    } catch {
      feedback.textContent = 'Selecciona el mensaje y cópialo para enviarlo a tu asistente.';
    }
  });
}

// A link to a collapsed section (such as #cines) opens it before scrolling.
const openTarget = () => {
  const target = location.hash && document.getElementById(location.hash.slice(1));
  if (target instanceof HTMLDetailsElement) target.open = true;
};
addEventListener('hashchange', openTarget);
openTarget();
// hashchange does not fire when the hash is already set, so also open on click.
document.addEventListener('click', event => {
  const link = (event.target as Element).closest?.('a[href^="#"]');
  const target = link && document.getElementById(link.getAttribute('href')!.slice(1));
  if (target instanceof HTMLDetailsElement) target.open = true;
});

// FAQ: one answer open at a time, sliding open and closed. Without
// JavaScript, the details' shared name keeps them exclusive natively.
const faq = [...document.querySelectorAll<HTMLDetailsElement>('.faq details')];
const still = matchMedia('(prefers-reduced-motion: reduce)');
const running = new WeakMap<HTMLDetailsElement, Animation>();

function slide(item: HTMLDetailsElement, open: boolean) {
  const summary = item.querySelector('summary')!;
  const from = item.getBoundingClientRect().height;
  running.get(item)?.cancel();
  if (open) { item.removeAttribute('data-closing'); item.open = true; } else item.setAttribute('data-closing', '');
  // scrollHeight still reports the closed size right after opening, so add
  // the answer's own height to the question's.
  const answer = item.querySelector<HTMLElement>(':scope > :not(summary)')!;
  const to = summary.offsetHeight + (open ? answer.offsetHeight : 0);
  if (still.matches) { finish(item, open); return; }
  // fill: forwards holds the end height until the state change, so the
  // answer never pops back to full size for a frame before closing.
  const animation = item.animate({ height: [`${from}px`, `${to}px`] }, { duration: 280, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' });
  running.set(item, animation);
  animation.onfinish = () => { running.delete(item); finish(item, open); animation.cancel(); };
}

function finish(item: HTMLDetailsElement, open: boolean) {
  if (!open) { item.open = false; item.removeAttribute('data-closing'); }
}

for (const item of faq) {
  item.removeAttribute('name');
  item.querySelector('summary')!.addEventListener('click', event => {
    event.preventDefault();
    const opening = !item.open || item.hasAttribute('data-closing');
    if (opening) for (const other of faq) if (other !== item && other.open && !other.hasAttribute('data-closing')) slide(other, false);
    slide(item, opening);
  });
}
