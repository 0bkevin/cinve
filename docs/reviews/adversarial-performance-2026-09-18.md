# Revisión adversarial de rendimiento — 18/09/2026

## Alcance y evidencia

La revisión cubrió el diff actual, las pruebas existentes y probes sintéticos de HTTP bajo `/tmp`. No se usaron credenciales, llamadas reales ni despliegues. La evidencia de la carrera de alias frío está en `/tmp/cinve-adversarial-providers-http-alias-overlap.ts` y su reporte asociado; la verificación posterior usa `/tmp/cinve-adversarial-http-cold-alias-fixed.ts`.

## Hallazgos confirmados y estado final

- **Cinex — asociación URL obsoleta (medio): corregido.** La catalogación actualiza el URL verificado, conserva alias válidos y `resolve()` hace rediscovery dirigido y acotado ante 404 o cambio de identidad.
- **Cinex — trabajo de directorio sin límite real (medio): corregido.** Los filtros se aplican antes del trabajo; la búsqueda limita candidatas y devuelve `partial` con advertencia cuando recorta cobertura.
- **Cinex — evidencia histórica reutilizada como verificación (alto): corregido.** La asociación recordada es solo una pista; metadata y detalle actuales deben confirmar identidad antes de publicar un código.
- **Cinex — código de detalle sin identidad (alto): corregido.** Los códigos derivados requieren título/identidad estrictamente coincidentes; una semilla ausente solo se conserva tras confirmar la página actual.
- **Proveedores — diagnósticos y flags (medio): corregido.** Épocas inutilizables, flags desconocidos y esquemas ambiguos producen resultados conservadores, `partial` y advertencias acotadas.
- **HTTP — caché pública y redirects (alto): corregido.** Las páginas Cinex siguen un único redirect same-origin de página de cine, mantienen procedencia canónica, deduplican alias en una entrada con límites de 64 claves y 16 MiB, y rechazan destinos fuera de la ruta permitida o con credenciales.
- **HTTP — carreras de refresh (alto): corregido.** Las lecturas normales iniciadas durante refresh no pueden repoblar la caché después de éxito o fallo. La finalización conserva una marca de invalidación por generación para los targets del refresh; así también invalida una lectura de alias desconocido cuyo redirect se descubre después de terminar el refresh. El caso frío determinista reproduce cuatro solicitudes y deja `afterCached: false` tanto para éxito como para fallo.
- **HTTP — procedencia autenticada (medio): corregido.** `ReadContext` deduplica por `page.source.url`, incluida la URL final después de la migración autenticada.
- **HTTP — plazo, cuerpo y memoria (alto/medio): corregido.** El plazo total cubre cola, autorización, promesa de transporte, headers y lecturas del cuerpo inyectado; las cancelaciones tardías no bloquean ni conservan slots. Las respuestas siguen limitadas a 4 MiB y los errores de auth, status y redirects no se convierten en éxitos cacheables.

## Límites y no-hallazgos

La revisión fue local y sintética: no demuestra el comportamiento de todos los cambios del sitio real ni coordinación de caché entre instancias. Un resultado vacío con funciones válidas para otra fecha sigue siendo una respuesta válida; los datos malformados o insuficientes para probar cobertura se marcan como `partial`.

`npm run check`, `npm run build`, `git diff --check` y la suite completa con `PATH=/usr/lib/postgresql/16/bin:$PATH npm test` pasaron. Resultado final: **151/151 pruebas**.
