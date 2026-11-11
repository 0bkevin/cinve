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
      button.dataset.copied = '';
      // The green 'Copiado' button is the confirmation; the note is only for failures.
      if (feedback) feedback.textContent = '';
      clearTimeout(reset);
      reset = window.setTimeout(() => { label.textContent = 'Copiar'; delete button.dataset.copied; }, 2500);
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

// Sample conversation: plays once when it scrolls into view. The HTML holds
// the finished state, so without JavaScript or with reduced motion nothing
// is hidden.
const demo = document.querySelector<HTMLElement>('.demo');
if (demo && !matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in window) {
  const bubble = demo.querySelector<HTMLElement>('.demo-me')!;
  const text = bubble.dataset.text ?? '';
  const wait = (ms: number) => new Promise(done => setTimeout(done, ms));
  demo.dataset.stage = 'idle';
  const play = async () => {
    // Hold the bubble at its finished size (CSSOM, allowed by the CSP).
    const box = bubble.getBoundingClientRect();
    bubble.style.width = `${box.width}px`; bubble.style.minHeight = `${box.height}px`;
    bubble.textContent = ''; demo.dataset.stage = 'typing';
    for (const char of text) { bubble.textContent += char; await wait(char === ' ' ? 55 : 38); }
    await wait(350); demo.dataset.stage = 'thinking';
    await wait(1400); demo.dataset.stage = 'answer';
  };
  const watcher = new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting)) { watcher.disconnect(); void play(); }
  }, { threshold: 0.45 });
  watcher.observe(demo);
}
