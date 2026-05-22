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

module.exports = {
  mensajeEntendiCambio,
  mensajeAmbiguoOpciones
};
