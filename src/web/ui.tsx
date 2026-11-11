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
  spinner: () => icon('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>', 'spinner'),
};
