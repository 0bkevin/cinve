import { h, Fragment } from '../jsx.js';
import { renderPage } from '../layout.js';
import { InstallMessage } from '../components/copy.js';
import { AppPicker } from '../components/assistants.js';

export const installationPage = (origin: string) => renderPage('Cómo usar Cinve', <>
  <h1>Cinve en tu asistente.</h1>
  <p class="lead">Envía este mensaje a tu asistente y él se encarga del resto:</p>
  <InstallMessage origin={origin} />
  <section class="manual" aria-labelledby="mano">
    <h2 id="mano">Si prefieres añadirlo a mano</h2>
    <AppPicker endpoint={`${origin}/mcp`} labelledBy="mano" />
    <p class="note">Reinicia tu asistente si no ve Cinve enseguida. Luego pregúntale qué películas hay en tu ciudad.</p>
  </section>
  <p class="note"><a href="/instrucciones">Ver qué instrucciones recibe tu asistente</a></p>
</>, { compact: true, script: '/assets/js/site.js', index: true, canonical: origin + '/install',
  description: 'Añade Cinve a Claude Code, Codex, OpenCode, Antigravity, Hermes u OpenClaw con un mensaje o un comando.' });
