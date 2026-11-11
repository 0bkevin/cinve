// Components built on Basecoat's class API (shadcn/ui's design in plain
// HTML and CSS). https://basecoatui.com
import { h, raw, type Child } from './jsx.js';

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'link' | 'destructive';
type ButtonProps = { variant?: Variant; size?: 'sm' | 'lg'; class?: string; children?: Child } & Record<string, string | boolean | undefined | Child>;

export function Button({ variant, size, class: className, children, ...rest }: ButtonProps) {
  return <button type="button" class={['btn', className].filter(Boolean).join(' ')} data-variant={variant} data-size={size} {...rest}>{children}</button>;
}

export function LinkButton({ variant, size, class: className, children, ...rest }: ButtonProps & { href: string }) {
  return <a class={['btn', className].filter(Boolean).join(' ')} data-variant={variant} data-size={size} {...rest}>{children}</a>;
}

export function Card({ title, description, footer, children, ...rest }: { title?: Child; description?: Child; footer?: Child; children?: Child } & Record<string, string | boolean | undefined | Child>) {
  return <div class="card" {...rest}>
    {(title || description) && <header>{title && <h2>{title}</h2>}{description && <p>{description}</p>}</header>}
    <section>{children}</section>
    {footer && <footer>{footer}</footer>}
  </div>;
}

export function Alert({ title, variant, icon, children, ...rest }: { title?: Child; variant?: 'destructive'; icon?: Child; children?: Child } & Record<string, string | boolean | undefined | Child>) {
  return <div class="alert" data-variant={variant} {...rest}>{icon}{title && <h2>{title}</h2>}<section>{children}</section></div>;
}

// Lucide icons (ISC license), inlined so pages need no icon font or requests.
const icon = (paths: string, className = '') => raw(`<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${className ? ` class="${className}"` : ''}>${paths}</svg>`);
export const icons = {
  copy: () => icon('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  circleCheck: () => icon('<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>'),
  circleAlert: () => icon('<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>'),
  shieldCheck: () => icon('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
  lock: () => icon('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  chevronDown: () => icon('<path d="m6 9 6 6 6-6"/>', 'chevron'),
  keyRound: () => icon('<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>'),
  link: () => icon('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  unplug: () => icon('<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>'),
  eyeOff: () => icon('<path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/>'),
  plus: () => icon('<path d="M5 12h14"/><path d="M12 5v14"/>', 'plus'),
  github: () => raw('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.558 21.923c.563.104.768-.244.768-.543 0-.267-.01-.975-.015-1.914-3.13.68-3.79-1.508-3.79-1.508-.512-1.3-1.25-1.646-1.25-1.646-1.022-.7.078-.686.078-.686 1.13.08 1.725 1.16 1.725 1.16 1.005 1.722 2.638 1.225 3.28.937.102-.728.394-1.225.716-1.507-2.498-.284-5.124-1.25-5.124-5.562 0-1.229.439-2.233 1.16-3.02-.117-.285-.503-1.429.11-2.979 0 0 .945-.302 3.094 1.154a10.8 10.8 0 0 1 5.63 0c2.148-1.456 3.092-1.154 3.092-1.154.614 1.55.228 2.694.112 2.979.722.787 1.158 1.791 1.158 3.02 0 4.323-2.63 5.275-5.136 5.553.404.35.765 1.044.765 2.104 0 1.519-.014 2.744-.014 3.117 0 .302.203.653.774.542A11.252 11.252 0 0 0 12 .75Z"/></svg>'),
  spinner: () => icon('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>', 'spinner'),
};
