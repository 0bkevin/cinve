import { StringDecoder } from 'node:string_decoder';

/** One raw-mode reader for both fields. Never echoes input, including a multi-line paste. */
export function readCredentials(): Promise<{ username: string; password: string }> {
  const input = process.stdin, output = process.stderr;
  if (!input.isTTY || !output.isTTY) throw new Error('El login requiere una terminal interactiva. No pases contraseñas por argumentos ni variables de entorno.');
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    const decoder = new StringDecoder('utf8');
    let username = '', current = '', phase = 0, done = false, previousCR = false;
    const cleanup = () => {
      input.off('data', data); input.off('end', cancel); input.off('error', cancel);
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.off(signal, cancel);
      input.setRawMode(wasRaw); input.pause();
    };
    const fail = (message: string) => { if (done) return; done = true; cleanup(); output.write('\n'); reject(new Error(message)); };
    const cancel = () => fail('Login cancelado.');
    const data = (chunk: Buffer | string) => {
      for (const char of typeof chunk === 'string' ? chunk : decoder.write(chunk)) {
        if (done) break;
        if (char === '\x03' || char === '\x04' || char === '\x1b' || char === '\x1a') { cancel(); break; }
        if (char === '\n' && previousCR) { previousCR = false; continue; }
        previousCR = char === '\r';
        if (char === '\r' || char === '\n') {
          if (phase === 0) {
            username = current.trim(); current = '';
            if (!username) { fail('Email requerido.'); break; }
            phase = 1; output.write('\nPassword (hidden): ');
          } else {
            if (!current) { fail('Contraseña requerida.'); break; }
            done = true; cleanup(); output.write('\n'); resolve({ username, password: current });
          }
        } else if (char === '\x7f' || char === '\b') current = [...current].slice(0, -1).join('');
        else if (char >= ' ' && char !== '\x7f') {
          current += char;
          if (current.length > (phase === 0 ? 320 : 4096)) fail('Entrada de login demasiado larga.');
        }
      }
    };
    // Disable OS echo before displaying a prompt that could trigger input.
    input.setRawMode(true);
    input.on('data', data); input.once('end', cancel); input.once('error', cancel);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, cancel);
    output.write('Email (hidden): '); input.resume();
  });
}
