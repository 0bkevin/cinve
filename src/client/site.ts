// Copy buttons: each names the element it copies in data-copy. Buttons stay
// hidden without JavaScript; the text remains selectable.

// Some browsers and embedded previews block the async clipboard API, so fall
// back to selecting the element and copying the selection.
async function copyFrom(source: HTMLElement) {
  try { await navigator.clipboard.writeText(source.textContent ?? ''); return; } catch {}
  const selection = getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(source);
  selection.removeAllRanges(); selection.addRange(range);
  const copied = document.execCommand('copy');
  selection.removeAllRanges();
  if (!copied) throw new Error('copy failed');
}

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-copy]')) {
  const source = document.getElementById(button.dataset.copy!);
  if (!source) continue;
  const label = button.querySelector('span')!;
  const feedback = button.dataset.feedback ? document.getElementById(button.dataset.feedback) : null;
  let reset: number | undefined;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await copyFrom(source);
      label.textContent = 'Copiado';
      if (feedback) feedback.textContent = 'Mensaje copiado. Pégalo en tu asistente.';
      clearTimeout(reset);
      reset = window.setTimeout(() => { label.textContent = 'Copiar'; }, 2500);
    } catch {
      if (feedback) feedback.textContent = 'Selecciona el texto y cópialo.';
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
  if (target instanceof HTMLDetailsElement && !target.open) slide(target, true);
});

// Collapsible sections slide open and closed. FAQ answers are exclusive:
// opening one closes the others. Without JavaScript, the FAQ details' shared
// name keeps them exclusive natively, with no animation.
const still = matchMedia('(prefers-reduced-motion: reduce)');
const running = new WeakMap<HTMLDetailsElement, Animation>();

function slide(item: HTMLDetailsElement, open: boolean) {
  const summary = item.querySelector('summary')!;
  const from = item.getBoundingClientRect().height;
  running.get(item)?.cancel();
  if (open) { item.removeAttribute('data-closing'); item.open = true; } else item.setAttribute('data-closing', '');
  // Open: the natural height now that the content shows. Closed: the summary alone.
  const to = open ? item.getBoundingClientRect().height : summary.getBoundingClientRect().height;
  if (still.matches) { finish(item, open); return; }
  // fill: forwards holds the end height until the state change, so the
  // section never pops back to full size for a frame before closing.
  const animation = item.animate({ height: [`${from}px`, `${to}px`] }, { duration: open ? 320 : 260, easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'forwards' });
  running.set(item, animation);
  animation.onfinish = () => { running.delete(item); finish(item, open); animation.cancel(); };
}

function finish(item: HTMLDetailsElement, open: boolean) {
  if (!open) { item.open = false; item.removeAttribute('data-closing'); }
}

const faq = [...document.querySelectorAll<HTMLDetailsElement>('.faq details')];
for (const item of document.querySelectorAll<HTMLDetailsElement>('.faq details, details.more')) {
  item.removeAttribute('name');
  item.querySelector('summary')!.addEventListener('click', event => {
    event.preventDefault();
    const opening = !item.open || item.hasAttribute('data-closing');
    if (opening && faq.includes(item)) for (const other of faq) if (other !== item && other.open && !other.hasAttribute('data-closing')) slide(other, false);
    slide(item, opening);
  });
}
