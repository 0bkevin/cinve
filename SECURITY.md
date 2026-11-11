# Seguridad

## Reportar una vulnerabilidad

**No abras un issue público.** Envía un reporte privado por
[GitHub Security Advisories](https://github.com/0bkevin/cinve/security/advisories/new)
con:

- el impacto;
- los pasos para reproducirlo;
- la versión o commit afectado;
- una prueba de concepto sin datos ni credenciales reales.

No accedas a cuentas ajenas, no interrumpas los sitios de los cines y no envíes
contraseñas, cookies, tokens ni claves. Coordina con el mantenedor antes de
publicar detalles.

## Versiones

Solo se corrigen la versión publicada y la rama `main`.

## Qué es especialmente relevante

- Exposición de sesiones de cine.
- Saltarse la separación entre usuarios o la autorización MCP.
- Ampliar los orígenes HTTP permitidos.
- Inyectar instrucciones a través de contenido externo.

Los problemas normales de soporte o cambios en las webs de los cines van como
[issues](https://github.com/0bkevin/cinve/issues/new/choose).
