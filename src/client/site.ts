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
