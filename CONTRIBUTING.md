# Contribuir

Al participar, aceptas el [código de conducta](CODE_OF_CONDUCT.md). Para
cambios grandes, abre primero un issue. Para vulnerabilidades, sigue
[`SECURITY.md`](SECURITY.md).

## Preparar el entorno

Requiere Node.js 22 o posterior y PostgreSQL local (`initdb` y `pg_ctl`), o una
base desechable en `TEST_DATABASE_URL`. Nunca uses una base de producción.

```sh
npm ci
npm run check
npm test
npm run build
```

`npm run smoke` consulta los cines reales; es opcional.

## Pull requests

- Un solo problema por pull request, con pruebas si cambia el comportamiento.
- Actualiza la documentación si cambia la interfaz pública.
- Explica qué resuelve y cómo lo probaste; añade una captura si cambia la web.
- No incluyas contraseñas, cookies, tokens ni datos personales, tampoco en
  fixtures.

## Cambios en un cine

- Distingue una respuesta vacía de un fallo.
- Valida IDs, importes y enlaces antes de devolverlos.
- Marca como `partial` lo que no puedas interpretar con certeza.
- Nunca presentes un asiento desconocido como libre.
- Prueba el caso normal y el degradado.

Al contribuir, aceptas publicar tu código bajo la [licencia MIT](LICENSE).
