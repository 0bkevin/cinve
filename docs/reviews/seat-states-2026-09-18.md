# Interpretación de asientos — 18/09/2026

Se reprodujo el caso reportado en producción: La Odisea, Cinex Sambil Chacao, función 23067 a las 17:50. El parser devolvía 64 desconocidos y G3/G4 ocupados. El markup observado para un libre VIP era:

```html
<div id="H1" class="seatvipplus" alt="0" onclick="javascript:decideAsientoNew('H1','0','1','2','0000000002','','N','N');"></div>
```

El sexto argumento es el contador de boletos seleccionados. La cadena vacía, antes de seleccionar boletos, no es un estado desconocido del asiento. Se admite vacío o numérico únicamente en ese argumento; siguen vigentes las comprobaciones de identidad de función/asiento, clase, `alt=0`, handler conocido y restricciones. No se evalúa JavaScript ni se seleccionan boletos o asientos. El diagnóstico temporal del markup se retiró del código final.

En Cines Unidos se inspeccionó el [componente oficial de asientos](https://www.cinesunidos.com/_next/static/chunks/6221-387e904905fdba32.js), módulo 39732. Los estados 0 y 7 reciben el color libre y el mismo manejador de selección; ambos se representan como `available`. 1/2 permanecen ocupados, 3/4/5/6 no disponibles y códigos no reconocidos desconocidos. La cuenta Cines Unidos del cliente no estaba conectada durante esta revisión: esta corrección se valida contra el frontend y respuestas sintéticas, sin afirmar una nueva prueba autenticada de ese proveedor.

Todos los proveedores devuelven contadores de estados y `availability_complete`; los estados desconocidos producen una advertencia explícita de interpretación parcial. Obtener un mapa (`status=available`) no implica tener todos sus estados interpretados. Cero libres con desconocidos no demuestra agotamiento. Las instrucciones compartidas en MCP, `get_seats` y `/install` indican mostrar el ASCII con leyenda, preservar los estados confirmados y no repetir autorización por un fallo de interpretación.

Verificación: typecheck, build local y alojado, 107 pruebas aprobadas. Regresiones: contador VIP vacío, restricciones, estado no libre, handler desconocido, identificador inconsistente, todos los códigos Cines Unidos y contadores completos/parciales. Se actualizó también la sección Cinve del AGENTS.md del usuario local, conservando el resto del archivo.
