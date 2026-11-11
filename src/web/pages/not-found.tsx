import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { LinkButton } from '../ui.js';

export function notFoundPage() {
  return renderPage('Página no encontrada', <>
    {/* An empty row in the hero's style, numbered 404 instead of a letter. */}
    <div class="lost-row" aria-hidden="true">
      <span class="lost-label">404</span>
      {Array.from({ length: 8 }, () => <i></i>)}
    </div>
    <h1>Esta función no está en cartelera.</h1>
    <p class="lead">La página que buscas no existe o cambió de lugar.</p>
    <div class="lost-actions">
      <LinkButton href="/" size="lg">Volver al inicio</LinkButton>
      <LinkButton href="/#empezar" size="lg" variant="outline">Cómo empezar</LinkButton>
    </div>
  </>, { compact: true });
}
