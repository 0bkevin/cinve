// Sign-ins the server (src/auth/credentials.ts) and the connect page
// (src/client/connect.ts) must judge the same way.
export const validEmails = ['person@example.test', 'ana.perez+cine@correo.com.ve', 'A_B-c@sub.xn--mgbh0a.com', '  padded@example.com  '];
export const invalidEmails = [
  '', '   ', 'plain', '@example.com', 'person@', 'person@localhost', 'person@example.c0m', 'a..b@example.com', '.a@example.com',
  '<script>alert(1)</script>@example.com', 'person@example.com<script>', '"quoted"@example.com', "o'brien@example.com",
  'person @example.com', 'person@exa mple.com', 'person@-example.com', 'person@example-.com', 'per;son@example.com',
  'javascript:alert(1)@example.com', 'person\n@example.com', 'person​@example.com', 'pérez@example.com', `${'a'.repeat(65)}@example.com`,
  `person@${'a'.repeat(250)}.com`, 'a@b@example.com', '${jndi:ldap://x}@example.com',
];
export const validPasswords = ['x', 'SYNTHETIC_PASSWORD', 'p@ss w0rd!', '<script>alert(1)</script>', "'; DROP TABLE users; --", 'contraseña😀', ' leading space', 'x'.repeat(256)];
export const invalidPasswords = ['', 'x'.repeat(257), 'line\nbreak', 'tab\there', 'nul\u0000', 'zero​width', 'bidi‮override', 'sep line', 'lone\ud800surrogate', 'del\u007f'];
