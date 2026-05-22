/**
 * Logs claros para operación del restaurante (consola + metricas.jsonl).
 * No altera flujo de pedido; solo observabilidad.
 */

let registrarMetricas = null;

function init(deps = {}) {
  registrarMetricas = deps.registrarEventoMetricas || null;
}

function escribirConsola(categoria, evento, payload) {
  const extra = payload && Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : "";
  console.log(`[Carly/${categoria}] ${evento}${extra}`);
}

async function emitir(categoria, evento, payload = {}) {
  escribirConsola(categoria, evento, payload);
  if (typeof registrarMetricas === "function") {
    try {
      await registrarMetricas(`log_${categoria}`, { subevento: evento, ...payload });
    } catch {
      /* no bloquear al cliente */
    }
  }
}

module.exports = {
  init,
  estado: (evento, payload) => emitir("estado", evento, payload),
  carrito: (evento, payload) => emitir("carrito", evento, payload),
  escalado: (evento, payload) => emitir("escalado", evento, payload),
  error: (evento, payload) => emitir("error", evento, payload),
  promo: (evento, payload) => emitir("promo", evento, payload),
  cliente: (evento, payload) => emitir("cliente", evento, payload),
  contexto: (evento, payload) => emitir("contexto", evento, payload),
  contexto_usado: (evento, payload) => emitir("contexto_usado", evento, payload),
  fallback: (evento, payload) => emitir("fallback", evento, payload),
  no_entendido: (evento, payload) => emitir("no_entendido", evento, payload),
  fuzzy: (evento, payload) => emitir("fuzzy", evento, payload),
  objecion: (evento, payload) => emitir("objecion", evento, payload),
  confirm_multi: (evento, payload) => emitir("confirm_multi", evento, payload)
};
