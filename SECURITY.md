# Política de seguridad

## Versiones compatibles

Cinve está en desarrollo activo. Las correcciones de seguridad se aplican a la
versión publicada y a la rama `main`; no se mantienen ramas antiguas.

## Reportar una vulnerabilidad

No abras un issue público. Envía un reporte privado mediante
[GitHub Security Advisories](https://github.com/0bkevin/cinve/security/advisories/new).

Incluye, cuando sea posible:

- una descripción del impacto;
- los pasos mínimos para reproducirlo;
- la versión, commit o entorno afectado;
- una prueba de concepto sin datos personales ni credenciales reales;
- cualquier mitigación que ya hayas identificado.

No accedas a cuentas ajenas, no interrumpas los sitios de los cines y no extraigas
más información de la necesaria para demostrar el problema. Nunca envíes
contraseñas, cookies, tokens ni claves de cifrado en el reporte.

Se intentará confirmar la recepción y evaluar el reporte antes de divulgarlo. El
plazo de una corrección dependerá de su impacto y complejidad. Coordina la
publicación de detalles con el mantenedor para que los usuarios tengan tiempo de
actualizar.

## Alcance

Son especialmente relevantes los fallos que puedan exponer sesiones de cine,
eludir la separación entre usuarios, ampliar los orígenes HTTP permitidos,
inyectar instrucciones mediante contenido externo o evadir la autorización MCP.

Los problemas generales de soporte y los cambios normales de las webs de los
proveedores deben reportarse como [issues](https://github.com/0bkevin/cinve/issues/new/choose).
