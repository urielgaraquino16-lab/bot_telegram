/**
 * Plantillas cortas estilo WhatsApp (sin lógica de negocio).
 */

function mensajeEntendiCambio(lineas, pie = "") {
  const items = (lineas || []).filter(Boolean).map((l) => `• ${l}`);
  if (!items.length) return null;
  let msg = `Entendí esto:\n${items.join("\n")}\n\n¿Correcto? 😊`;
  if (pie) msg += `\n${pie}`;
  return msg;
}

function mensajeAmbiguoOpciones(opciones) {
  const items = (opciones || []).filter(Boolean).map((o) => `• ${o}`);
  if (!items.length) return null;
  return `🤔 Para no equivocarme:\n${items.join("\n")}\n\n¿Cuál te refieres? 😊`;
}

/** Confirmación corta cuando hay pizza + complementos en el mismo mensaje. */
function mensajeConfirmacionMulti(estado, deps) {
  const lineas = [];
  const cap = deps.capitalizar || ((s) => s);

  if (estado.ingredientes?.length) {
    let p = estado.ingredientes.map((i) => cap(i)).join(" / ");
    if (estado.tamano) p += ` ${estado.tamano}`;
    lineas.push(p);
  }

  for (const L of estado.lineasComplemento || []) {
    let n = cap(L.nombre);
    const sal = L.salsaEtiqueta || L.salsa;
    if (sal) n += ` ${sal}`;
    else if (
      deps.complementoRequiereSalsa?.(L.nombre) &&
      estado.ctxMemoria?.ultimaSalsa
    ) {
      n += ` ${cap(estado.ctxMemoria.ultimaSalsa)}`;
    }
    if (L.extraMitadSalsa) n += ` (+${L.extraMitadSalsa})`;
    if (L.cantidad > 1 && !deps.complementoRequiereSalsa?.(L.nombre)) n += ` x${L.cantidad}`;
    lineas.push(n);
  }

  for (const L of estado.lineasBebida || []) {
    let n = cap(L.nombre);
    if (L.cantidad > 1) n += ` x${L.cantidad}`;
    lineas.push(n);
  }

  if (lineas.length < 2) return null;

  const { total } = deps.subtotalesPedidoActuales(estado) || { total: 0 };
  const pie = total > 0 ? `💰 Total: *$${total}*` : "";
  let msg = `🍕 Entendí:\n${lineas.map((l) => `• ${l}`).join("\n")}`;
  if (pie) msg += `\n\n${pie}`;
  msg += "\n\n¿Correcto? 😊";
  return msg;
}

module.exports = {
  mensajeEntendiCambio,
  mensajeAmbiguoOpciones,
  mensajeConfirmacionMulti
};
