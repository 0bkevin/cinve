# Contribuir a Cinve

Gracias por ayudar a mejorar Cinve. Se aceptan correcciones de errores,
documentación, pruebas y mejoras pequeñas que mantengan el alcance del proyecto:
consultar información de cines venezolanos de forma segura y verificable.

Al participar, aceptas el [Código de conducta](CODE_OF_CONDUCT.md).

## Antes de empezar

- Busca si ya existe un issue o pull request relacionado.
- Para un error reproducible, abre un reporte con los pasos y el resultado real.
- Para una función nueva o un cambio grande, abre primero una propuesta. Esto
  evita invertir tiempo en una dirección que no encaje con el proyecto.
- No publiques credenciales, cookies, tokens, datos personales ni respuestas
  privadas de cuentas de cine. Usa el proceso de [seguridad](SECURITY.md) si el
  reporte revela una vulnerabilidad.

## Preparar el entorno

Necesitas Git, Node.js 22 o posterior y npm.

```sh
git clone https://github.com/0bkevin/cinve.git
cd cinve
npm ci
npm run check
npm run build
```

La suite completa necesita PostgreSQL local (`initdb` y `pg_ctl`) o una base de
pruebas desechable en `TEST_DATABASE_URL`:

```sh
npm test
```

Las pruebas crean y eliminan esquemas temporales. Nunca apuntes
`TEST_DATABASE_URL` a producción ni a una base que contenga datos importantes.

## Hacer un cambio

1. Crea una rama desde `main`.
2. Mantén el cambio pequeño y enfocado en un solo problema.
3. Añade o actualiza pruebas cuando cambie el comportamiento.
4. Actualiza el README o la referencia técnica si cambia la interfaz pública.
5. Ejecuta la validación antes de abrir el pull request.

```sh
npm run check
npm test
npm run build
```

`npm run smoke` consulta sitios reales y es opcional para la mayoría de cambios.
Indica en el pull request si lo ejecutaste y qué proveedores responden. No uses
sesiones personales para generar fixtures ni pegues respuestas autenticadas sin
anonimizarlas.

## Cambios en proveedores y parsers

Los sitios de los cines son fuentes externas y pueden cambiar sin aviso. Un
cambio en un adaptador debe:

- conservar la diferencia entre una respuesta vacía y un fallo;
- validar identificadores, importes y enlaces antes de exponerlos;
- marcar como parcial lo que no pueda interpretar con certeza;
- incluir fixtures mínimos y pruebas del caso normal y del caso degradado;
- documentar la fecha y la fuente cuando una decisión dependa de una observación
  externa;
- evitar incluir credenciales, perfiles, cookies o datos personales.

No conviertas suposiciones en datos confirmados. En especial, un estado de
asiento desconocido nunca debe presentarse como libre.

## Pull requests

Explica qué problema resuelve el cambio, cómo lo resolviste y cómo lo validaste.
Relaciona el issue correspondiente cuando exista. Para cambios visibles en la
web, incluye una captura; para interacciones, añade una grabación breve si ayuda
a revisar el comportamiento.

Al enviar una contribución, confirmas que puedes licenciarla bajo la
[licencia MIT](LICENSE) del proyecto.
