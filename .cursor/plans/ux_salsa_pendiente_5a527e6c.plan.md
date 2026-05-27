---
name: UX salsa pendiente
overview: "Ajuste mínimo en index.js: tras anotar salsa válida, confirmar la orden recién llenada y pedir la siguiente sin repetir el menú completo. Primera solicitud, salsa inválida y texto no entendido siguen usando solicitarSalsaSiFalta con menú o msg de parseEleccionSalsa."
todos:
  - id: helpers-conteo-salsa
    content: Añadir conteoLineasSalsaAlitasBoneless, formatearSalsaLineaCliente, ordinalOrdenSalsa, textoConfirmacionSalsaConPendientes, textoPidaSalsaSeguimiento
    status: completed
  - id: solicitar-salsa-modo
    content: solicitarSalsaSiFalta — menú completo solo si conSalsa.length === 0; si no, textoPidaSalsaSeguimiento
    status: completed
  - id: paso-d-unificar-msg
    content: paso D — tras OK con pendientes usar textoConfirmacionSalsaConPendientes; NO llamar solicitarSalsaSiFalta; error → salsaPick.msg y return
    status: completed
isProject: false
---

# Plan: UX salsa pendiente (alitas/boneless)

## Alcance estricto

- **Archivo único:** [`index.js`](c:\Users\uriel\Downloads\bot-whatsapp\index.js)
- **Solo UX conversacional** (strings y ramas de envío)

### NO tocar

- Lógica comercial, precios, `extraMitadSalsa`, `agregarLineaComplemento`
- `parseEleccionSalsa` (reglas internas)
- `aplicarSalsaALineasSinEtiqueta` (lógica FIFO — solo se invoca igual)
- Totales, resumen cocina, estructura carrito
- Pagos, Firestore, pizzas, deduplicación, cola, fuzzy, flujo A→I general

### Funciones a modificar / añadir

| Acción | Función |
|--------|---------|
| Añadir | `conteoLineasSalsaAlitasBoneless`, `ordinalOrdenSalsa`, `formatearSalsaLineaCliente`, `textoConfirmacionSalsaConPendientes`, `textoPidaSalsaSeguimiento` |
| Modificar | `solicitarSalsaSiFalta` |
| Modificar | `procesarConversacionCarly` — bloque `if (estado.pasoPedido === "D")` (~2713-2734) |

---

## Problema actual

Tras salsa OK con más pendientes:

1. `sendText`: `✅ Salsa ... anotada.`
2. `solicitarSalsaSiFalta` → **menú completo otra vez**

---

## Comportamiento deseado

### Primera solicitud (`conSalsa.length === 0`)

Sin cambio: `solicitarSalsaSiFalta` → menú completo (`textoMenuSalsasAlitas`).

### Tras salsa válida + aún hay pendientes

**Un solo mensaje**, sin `solicitarSalsaSiFalta`:

```
✅ Primera orden:
mitad Mango habanero / BBQ (+10)

🍗 Falta la salsa de la segunda orden 😊
Puedes escribir solo el nombre, ej. Buffalo o mitad BBQ y Mango.
```

Implementado por `textoConfirmacionSalsaConPendientes(estado)` (lee última línea en `conSalsa` tras `aplicarSalsaALineasSinEtiqueta`).

### Tras salsa válida + sin pendientes

Sin cambio: `✅ Salsa *{label}* anotada.`

### Salsa inválida / no entendida en paso D

- `resultado === "error"` → `sendText(salsaPick.msg)` y `return` (msg ya trae menú desde `parseEleccionSalsa`).
- Otro texto con pendientes → `solicitarSalsaSiFalta`:
  - `conSalsa.length === 0` → menú completo
  - `conSalsa.length > 0` → `textoPidaSalsaSeguimiento` (corto, sin lista)

---

## Reglas de producto (confirmadas)

1. **FIFO:** salsa siempre a la primera línea pendiente (`lineaComplementoSinSalsa` / `aplicarSalsaALineasSinEtiqueta`) — sin cambios.
2. **Una salsa por mensaje** — sin interpretar "1 bbq y 1 mango" como dos órdenes.
3. **Sin** selección manual de línea, parser nuevo ni IA.
4. **No** llamar menú completo después de `aplicarSalsaALineasSinEtiqueta` si quedan pendientes.

---

## Detección de estados

```javascript
function conteoLineasSalsaAlitasBoneless(estado) {
  const conSalsa = [];
  const sinSalsa = [];
  for (const L of estado.lineasComplemento || []) {
    if (!complementoRequiereSalsa(L.nombre)) continue;
    if (etiquetaSalsaComplemento(L)) conSalsa.push(L);
    else sinSalsa.push(L);
  }
  return { conSalsa, sinSalsa };
}
```

| Estado | Condición |
|--------|-----------|
| Pendiente | `sinSalsa.length > 0` |
| Modo menú grande | `conSalsa.length === 0` y hay pendiente |
| Modo seguimiento corto | `conSalsa.length > 0` y hay pendiente |
| Salsa válida | `parseEleccionSalsa → ok` (sin modificar parser) |

---

## Cambios concretos en código

### 1. Helpers (insertar tras `hayComplementosRequiriendoSalsaSinEtiqueta`, ~922)

- `formatearSalsaLineaCliente(L)` — `salsaEtiqueta` + `(+N)` si `extraMitadSalsa`
- `textoConfirmacionSalsaConPendientes(estado)` — copy unificado post-OK
- `textoPidaSalsaSeguimiento(estado)` — solo nudge para 2ª+ orden

### 2. `solicitarSalsaSiFalta` (~946)

```javascript
const { conSalsa } = conteoLineasSalsaAlitasBoneless(estado);
const texto =
  conSalsa.length > 0
    ? textoPidaSalsaSeguimiento(estado)
    : `🍗 Para *${capitalizar(L.nombre)}* elige la salsa:\n\n${textoMenuSalsasAlitas()}`;
```

### 3. Paso D en `procesarConversacionCarly` (~2713)

```javascript
if (salsaPick?.resultado === "error" && salsaPick.msg) {
  await sendText(sock, from, estado, salsaPick.msg);
  return;
}
if (salsaPick?.resultado === "ok" && aplicarSalsaALineasSinEtiqueta(...)) {
  estado._pendienteSalsaNombre = null;
  estado._bloqueoSalsaPendiente = false;
  if (hayComplementosRequiriendoSalsaSinEtiqueta(estado)) {
    await sendText(sock, from, estado, textoConfirmacionSalsaConPendientes(estado) || fallback);
  } else {
    await sendText(sock, from, estado, `✅ Salsa *${salsaPick.label}* anotada.`);
  }
  return; // NO solicitarSalsaSiFalta aquí
}
```

**Eliminar** la llamada `await solicitarSalsaSiFalta` tras salsa OK con pendientes (línea ~2727 actual).

---

## Call sites `solicitarSalsaSiFalta` (sin cambiar ubicación)

| Contexto | Comportamiento tras fix |
|----------|-------------------------|
| Paso D tras OK + pendientes | **No llamar** — mensaje unificado |
| Paso D texto no OK | `solicitarSalsaSiFalta` (menú o corto según `conSalsa`) |
| Paso D `error` | Solo `salsaPick.msg` |
| ~2763, 2771, 2783, 2926 | Auto vía `solicitarSalsaSiFalta` interno |

---

## Riesgos

| Riesgo | Mitigación |
|--------|------------|
| Usuario no ve lista en 2ª orden | Hint con ejemplos; menú en 1ª vez y en `error` |
| Doble menú en error | `return` tras `salsaPick.msg` |
| Loop de mensajes | Un `sendText` tras OK; no encadenar confirm + solicitar |
| Regresión A→I / totales | Sin cambios en pasos ni cálculos |

---

## Verificación manual

1. `2 alitas` → menú completo (1ª vez).
2. `mitad mango y bbq` → mensaje corto con primera orden + falta segunda; **sin** lista 1-8.
3. `buffalo` → segunda orden; confirmación simple si ya no hay pendientes.
4. Salsa inválida en 2ª orden → `salsaPick.msg` con menú, sin tercer menú por `solicitarSalsaSiFalta`.

**Estimación:** ~50 líneas en un solo archivo.
