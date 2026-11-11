// Copy button for the install message on the landing and install pages.
// The button stays hidden without JavaScript; the message remains selectable.
const button = document.getElementById('copy-install') as HTMLButtonElement | null;
const message = document.getElementById('install-message');
const feedback = document.getElementById('copy-feedback');

if (button && message && feedback) {
  const label = button.querySelector('span')!;
  let reset: number | undefined;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(message.textContent ?? '');
      label.textContent = 'Copiado';
      feedback.textContent = 'Mensaje copiado. Pégalo en tu asistente.';
      clearTimeout(reset);
      reset = window.setTimeout(() => { label.textContent = 'Copiar mensaje'; }, 2500);
    } catch {
      feedback.textContent = 'Selecciona el mensaje y cópialo para enviarlo a tu asistente.';
    }
  });
}
