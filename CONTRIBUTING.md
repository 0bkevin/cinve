# Contribuir a Cinve

Gracias por ayudar. Se aceptan correcciones, pruebas, documentación y mejoras
pequeñas dentro del alcance del proyecto: consultar cines venezolanos de forma
segura y verificable.

Al participar, aceptas el [código de conducta](CODE_OF_CONDUCT.md).

## Antes de empezar

- Busca si ya existe un issue o pull request sobre lo mismo.
- Para cambios grandes o funciones nuevas, abre primero una propuesta.
- Nunca publiques contraseñas, cookies, tokens ni datos personales. Si
  encontraste una vulnerabilidad, sigue [`SECURITY.md`](SECURITY.md).

## Preparar el entorno

Necesitas Node.js 22 o posterior y PostgreSQL local (`initdb` y `pg_ctl`) para
las pruebas.

```sh
git clone https://github.com/0bkevin/cinve.git
cd cinve
npm ci
npm run check
npm test
npm run build
```

En lugar de PostgreSQL local puedes usar una base desechable con
`TEST_DATABASE_URL`. Las pruebas crean y borran esquemas: **nunca** apuntes a
producción.

## Hacer un cambio

1. Crea una rama desde `main`.
2. Resuelve un solo problema por pull request.
3. Añade o actualiza pruebas si cambia el comportamiento.
4. Actualiza la documentación si cambia la interfaz pública.
5. Ejecuta `npm run check`, `npm test` y `npm run build`.

`npm run smoke` consulta los cines reales; es opcional. Si lo ejecutas, indícalo
en el pull request.

## Cambios en un cine

Las webs de los cines cambian sin aviso. Al modificar un adaptador:

- Distingue una respuesta vacía de un fallo.
- Valida identificadores, importes y enlaces antes de devolverlos.
- Marca como `partial` lo que no puedas interpretar con certeza.
- Nunca presentes un asiento desconocido como libre.
- Añade fixtures mínimos y anonimizados, con pruebas del caso normal y del
  degradado.

## Pull requests

Explica qué resuelve el cambio y cómo lo probaste, y enlaza el issue si existe.
Para cambios visibles en la web, añade una captura.

Al contribuir, aceptas publicar tu código bajo la [licencia MIT](LICENSE).
