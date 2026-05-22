/**
 * Resistencia a comportamiento humano en WhatsApp (sin IA).
 * Ambigüedad, cambios rápidos, ráfagas de mensajes, reclamos, tamaño solo en pizza.
 */

const BURST_WAIT_MS = 750;
const BURST_WINDOW_MS = 2200;
const CAMBIO_RAPIDO_MS = 8000;

let deps = {};
let log = () => {};

function init(dependencies) {
  deps = { ...dependencies };
  log = deps.botLogger || {};
}

function xNorm(textoClean) {
  return deps.sinAcentos(deps.normalizarTextoPedido(textoClean));
}

function esReclamoCliente(textoClean) {
  const x = xNorm(textoClean);
  return (
    /(ya\s+llevo\s+mucho|mucho\s+tiempo|tarda(n)?\s+mucho)/.test(x) ||
    /(no\s+llega|nunca\s+llego|no\s+ha\s+llegado|no\s+me\s+llego)/.test(x) ||
    /(mal\s+pedido|pedido\s+mal|se\s+equivocaron|equivocaron)/.test(x) ||
    /(pesimo|p[eé]simo|horrible|fatal)\s+(servicio|atencion|experiencia)/.test(x) ||
    /(no\s+contestan|no\s+me\s+contestan|nadie\s+contesta)/.test(x) ||
    /(me\s+cobraron\s+mal|cobro\s+mal|me\s+robaron)/.test(x) ||
    /(reclamo|queja|estoy\s+molest|muy\s+molest)/.test(x)
  );
}

function mensajeReclamoCliente() {
  return "😕 Déjame ayudarte con eso.\nVoy a avisar a un asesor para revisarlo 🍕";
}

function textoMencionaComplementoOBebida(textoClean) {
  const x = xNorm(textoClean);
  if (/\b(alitas|boneless|wings|nuggets|papas|dedos|bebida|coca|pepsi|fanta|sprite)\b/.test(x)) {
    return true;
  }
  if (deps.obtenerComplementoPorEntrada?.(textoClean)) return true;
  return false;
}

function hayPizzaEnPedido(estado) {
  return (estado.ingredientes?.length || 0) > 0;
}

function hayContextoPizzaClaro(estado) {
  if (hayPizzaEnPedido(estado)) return true;
  if (estado.pasoPedido === "A" || estado.pasoPedido === "B") return true;
  const m = estado.ctxMemoria;
  if (m?.ultimoTema === "pizza" && m.ultimoProducto && deps.getMenu?.()?.[m.ultimoProducto]) {
    return true;
  }
  return false;
}

function hayContextoCruzado(estado) {
  const pizza = hayPizzaEnPedido(estado);
  const comps =
    Object.keys(estado.complementos || {}).length +
    (estado.lineasComplemento?.length || 0);
  const beb = estado.lineasBebida?.length || 0;
  return pizza && (comps > 0 || beb > 0);
}

function registrarProductoReciente(estado, tipo, nombre) {
  if (!estado.productosRecientes) estado.productosRecientes = [];
  const entry = { tipo, nombre, at: Date.now() };
  estado.productosRecientes = [
    entry,
    ...estado.productosRecientes.filter((p) => !(p.tipo === tipo && p.nombre === nombre))
  ].slice(0, 4);
}

function esMensajeAmbiguoCorto(textoClean) {
  const x = xNorm(textoClean);
  if (!x || x.length > 40) return false;
  return (
    /^(la\s+)?(otra|esa|esa\s+pizza|la\s+misma|igual|lo\s+mismo|la\s+de\s+siempre)\b/.test(x) ||
    /^(la\s+)?(mediana|grande|familiar|jumbo|mega)\s*$/.test(x) ||
    /^(si|sii+|ok|va|dale|bueno)$/.test(x)
  );
}

function esSoloTamano(textoClean) {
  const x = xNorm(textoClean);
  const tam = deps.detectarTamano?.(textoClean);
  if (!tam) return false;
  const sinTam = x.replace(new RegExp(`\\b${tam}\\b`, "g"), "").trim();
  return sinTam.length <= 12 && !deps.detectarIngredientes(textoClean, { permitirFuzzy: false }).length;
}

function intentarAclaracionHumana(estado, textoClean) {
  const x = xNorm(textoClean);
  if (!x || ["G", "H", "I"].includes(estado.pasoPedido)) return null;

  if (esReclamoCliente(textoClean)) return null;

  const tam = deps.detectarTamano?.(textoClean);
  const cap = deps.capitalizar || ((s) => s);

  if (tam && esSoloTamano(textoClean)) {
    if (textoMencionaComplementoOBebida(textoClean) && !hayPizzaEnPedido(estado)) {
      if (log.ambiguo) log.ambiguo("tamano_en_comp", { tam });
      return "🤔 Los complementos y bebidas tienen precio fijo en menú.\n¿Te refieres a una *pizza*? 🍕";
    }
    if (hayContextoCruzado(estado)) {
      if (log.contexto_cruzado) log.contexto_cruzado("tamano_multiproducto", { tam });
      return `🤔 ¿La *${tam}* es para la *pizza*? 😊`;
    }
    if (!hayContextoPizzaClaro(estado)) {
      if (log.ambiguo) log.ambiguo("tamano_sin_pizza", { tam });
      return `🤔 ¿Te refieres a la pizza *${tam}*? 😊`;
    }
  }

  if (/^(la\s+)?(otra|esa|la\s+misma|igual)\b/.test(x)) {
    const recientes = estado.productosRecientes || [];
    if (recientes.length >= 2 || hayContextoCruzado(estado)) {
      if (log.ambiguo) log.ambiguo("referencia_vaga", { x });
      return "🤔 ¿Te refieres a la *pizza* o a un *complemento*? Dime cuál 😊";
    }
  }

  if (/^(la\s+)?(mediana|grande|familiar|jumbo|mega)\s*$/.test(x) && estado.pasoPedido === "B") {
    return null;
  }

  return null;
}

/** Aplica corrección de tamaño (solo pizza). Devuelve tamaño aplicado o null. */
function aplicarTamanoPizzaConCorreccion(estado, textoClean) {
  if (!hayContextoPizzaClaro(estado) && estado.pasoPedido !== "B") {
    const tamSolo = deps.detectarTamano?.(textoClean);
    if (tamSolo && esSoloTamano(textoClean) && textoMencionaComplementoOBebida(textoClean)) {
      return null;
    }
  }

  const x = xNorm(textoClean);
  const mNo = x.match(/\bno\s+(mediana|grande|familiar|jumbo|mega)\b/);
  if (mNo) {
    const quit = mNo[1];
    if (estado.tamano === quit) {
      estado.tamano = null;
      if (log.cambio_rapido) log.cambio_rapido("quitar", { tamano: quit });
    }
  }

  const tam = deps.detectarTamano?.(textoClean);
  if (!tam) return null;

  if (!hayContextoPizzaClaro(estado) && estado.pasoPedido !== "B") return null;

  const ahora = Date.now();
  if (
    estado._ultimoCambioTamanoAt &&
    ahora - estado._ultimoCambioTamanoAt < CAMBIO_RAPIDO_MS &&
    estado.tamano &&
    estado.tamano !== tam
  ) {
    if (log.cambio_rapido) log.cambio_rapido("reemplazo", { de: estado.tamano, a: tam });
  }

  estado.tamano = tam;
  estado._ultimoCambioTamanoAt = ahora;
  deps.recalcularExtrasTotal?.(estado);
  return tam;
}

function debeAgruparBurst(estado, textoClean) {
  const x = xNorm(textoClean);
  if (!x || x.length > 80) return false;
  if (esReclamoCliente(textoClean)) return false;
  if (estado.confirmacionPendiente) return false;
  if (estado.modoHumano) return false;
  const now = Date.now();
  if (estado._burstTimer) return true;
  if (
    estado._burstUltimoProcesadoAt &&
    now - estado._burstUltimoProcesadoAt < BURST_WINDOW_MS
  ) {
    return true;
  }
  return false;
}

function marcarProcesadoBurst(estado, texto, textoClean) {
  estado._burstUltimoProcesadoAt = Date.now();
  estado._ultimoTextoCliente = texto;
  estado._ultimoTextoCleanCliente = textoClean;
}

/**
 * Agrupa mensajes rápidos. Si encolado=true, el handler debe salir sin procesar aún.
 */
function encolarBurst(estado, payload, onFlush) {
  const now = Date.now();
  if (!estado._burstPartes) estado._burstPartes = [];

  estado._burstPartes.push({ ...payload, at: now });
  estado._burstPartes = estado._burstPartes.filter((p) => now - p.at < BURST_WINDOW_MS);
  estado._burstUltimoAt = now;

  if (estado._burstTimer) clearTimeout(estado._burstTimer);

  estado._burstTimer = setTimeout(() => {
    const partes = estado._burstPartes || [];
    estado._burstPartes = [];
    estado._burstTimer = null;
    if (!partes.length) return;

    const prev =
      estado._ultimoTextoCliente &&
      estado._burstUltimoProcesadoAt &&
      Date.now() - estado._burstUltimoProcesadoAt < BURST_WINDOW_MS
        ? estado._ultimoTextoCliente
        : "";
    const texto = [prev, ...partes.map((p) => p.texto)].filter(Boolean).join(" ");
    const textoClean = deps.sinAcentos(
      deps.normalizarTextoPedido(texto.toLowerCase().trim())
    );
    if (log.multiples_mensajes) {
      log.multiples_mensajes("flush", { n: partes.length, preview: textoClean.slice(0, 60) });
    }
    onFlush({ texto, textoClean, partes: partes.length });
  }, BURST_WAIT_MS);

  return { encolado: true };
}

function sincronizarProductosRecientesDesdeEstado(estado) {
  if (estado.ingredientes?.[0]) {
    registrarProductoReciente(estado, "pizza", estado.ingredientes[0]);
  }
  for (const L of estado.lineasComplemento || []) {
    registrarProductoReciente(estado, "comp", L.nombre);
  }
  for (const L of estado.lineasBebida || []) {
    registrarProductoReciente(estado, "bebida", L.nombre);
  }
}

module.exports = {
  init,
  esReclamoCliente,
  mensajeReclamoCliente,
  hayContextoPizzaClaro,
  hayContextoCruzado,
  intentarAclaracionHumana,
  aplicarTamanoPizzaConCorreccion,
  registrarProductoReciente,
  sincronizarProductosRecientesDesdeEstado,
  debeAgruparBurst,
  encolarBurst,
  marcarProcesadoBurst,
  esSoloTamano
};
