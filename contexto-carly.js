/**
 * Memoria conversacional ligera por usuario (sin IA).
 * Expande mensajes cortos y fallback útil cuando no hay Groq.
 */

const TTL_MS = 20 * 60 * 1000;

let deps = {};
let log = () => {};

function init(dependencies) {
  deps = { ...dependencies };
  log = deps.botLogger || {};
}

function crearMemoria() {
  return {
    ultimoTema: null,
    ultimoProducto: null,
    ultimaCategoria: null,
    ultimoComplemento: null,
    ultimoIntent: null,
    ultimaSalsa: null,
    ultimoTamano: null,
    at: 0
  };
}

function memoriaVigente(estado) {
  const m = estado?.ctxMemoria;
  if (!m?.at) return false;
  return Date.now() - m.at < TTL_MS;
}

function touch(estado, patch) {
  if (!estado.ctxMemoria) estado.ctxMemoria = crearMemoria();
  Object.assign(estado.ctxMemoria, patch, { at: Date.now() });
  if (log.contexto) log.contexto("actualizado", patch);
}

function xNorm(textoClean) {
  return deps.sinAcentos(deps.normalizarTextoPedido(textoClean));
}

function detectarSalsaEnTexto(textoClean) {
  const lista = deps.getSalsasLista?.() || [];
  const t = xNorm(textoClean);
  for (const s of lista) {
    const hit = deps.nombresSalsaCoincidenEnTexto?.(t, s);
    if (hit) return hit;
  }
  return null;
}

function buscarComplementoAlitas() {
  const items = deps.getComplementosItems?.() || [];
  const hit = items.find((c) => /\b(alitas|boneless|wings)\b/i.test(c.nombre || ""));
  return hit?.nombre || null;
}

function textoTieneProductoCatalogo(textoClean) {
  const t = xNorm(textoClean);
  if (deps.detectarIngredientes(t, { permitirFuzzy: true }).length > 0) return true;
  if (deps.obtenerComplementoPorEntrada?.(textoClean)) return true;
  for (const b of deps.getBebidasItems?.() || []) {
    const bn = deps.sinAcentos(deps.normalizarTextoPedido(b.nombre));
    if (bn.length >= 4 && t.includes(bn)) return true;
  }
  return false;
}

function esConsultaPrecioSuave(textoClean) {
  const x = xNorm(textoClean);
  return (
    deps.esConsultaPrecio?.(textoClean) ||
    /^(cuanto|cuánto|que cuestan|cuanto cuestan|precio|cuanto sale|a como|vale)\b/.test(x) ||
    /\b(cuanto|precio|cuestan|cuesta)\b/.test(x)
  );
}

function esMensajeCorto(textoClean) {
  const x = String(textoClean || "").trim();
  return x.length <= 36 && x.split(/\s+/).filter(Boolean).length <= 5;
}

function detectarTema(textoClean) {
  const x = xNorm(textoClean);
  if (/\b(alitas|boneless|wings|nuggets)\b/.test(x)) return "alitas";
  if (deps.detectarIngredientes(x, { permitirFuzzy: false }).length > 0) return "pizza";
  if (/(promo|promocion|oferta)\b/.test(x)) return "promo";
  if (/(combo|paquete)\b/.test(x)) return "combo";
  if (esConsultaPrecioSuave(textoClean)) return "precio";
  return null;
}

function actualizarContextoDesdeTexto(estado, textoClean) {
  if (!textoClean) return;
  const tema = detectarTema(textoClean);
  if (tema) touch(estado, { ultimoTema: tema });

  const comp = deps.obtenerComplementoPorEntrada?.(textoClean);
  if (comp) {
    touch(estado, {
      ultimoComplemento: comp,
      ultimoProducto: comp,
      ultimaCategoria: "complemento",
      ultimoTema: /\b(alitas|boneless|wings)\b/i.test(comp) ? "alitas" : estado.ctxMemoria?.ultimoTema || "complemento"
    });
  } else if (tema === "alitas") {
    const al = buscarComplementoAlitas();
    if (al) touch(estado, { ultimoComplemento: al, ultimoProducto: al });
  }

  const ings = deps.detectarIngredientes(textoClean, { permitirFuzzy: true });
  if (ings[0] && deps.getMenu?.()?.[ings[0]]) {
    touch(estado, {
      ultimoProducto: ings[0],
      ultimoTema: "pizza",
      ultimaCategoria: "pizza"
    });
  }

  const tam = deps.detectarTamano?.(textoClean);
  if (tam) touch(estado, { ultimoTamano: tam });

  const salsa = detectarSalsaEnTexto(textoClean);
  if (salsa) touch(estado, { ultimaSalsa: salsa, ultimoTema: estado.ctxMemoria?.ultimoTema || "alitas" });

  if (esConsultaPrecioSuave(textoClean)) touch(estado, { ultimoIntent: "precio" });
  if (/\b(quiero|dame|necesito|ponme)\b/.test(xNorm(textoClean))) {
    touch(estado, { ultimoIntent: "pedido" });
  }
}

function expandirTextoConContexto(estado, textoClean) {
  if (!memoriaVigente(estado) || !esMensajeCorto(textoClean)) {
    return { texto: textoClean, uso: false };
  }
  const x = xNorm(textoClean);
  const m = estado.ctxMemoria;

  if (esConsultaPrecioSuave(textoClean) && !textoTieneProductoCatalogo(textoClean)) {
    let add = m.ultimoComplemento || m.ultimoProducto;
    if (m.ultimaSalsa && (m.ultimoTema === "alitas" || /alita|boneless/i.test(add || ""))) {
      add = `${add || "alitas"} ${m.ultimaSalsa}`;
    }
    if (add) {
      return { texto: `${textoClean} ${add}`, uso: true, tipo: "precio_ctx" };
    }
  }

  const salsa = detectarSalsaEnTexto(textoClean);
  const soloSalsa =
    salsa &&
    x.split(/\s+/).length <= 2 &&
    !textoTieneProductoCatalogo(textoClean) &&
    !deps.detectarTamano?.(textoClean);

  if (soloSalsa && m.ultimoTema === "alitas") {
    const comp = m.ultimoComplemento || buscarComplementoAlitas() || "alitas";
    touch(estado, { ultimaSalsa: salsa, ultimoComplemento: comp });
    return {
      texto: `${comp} ${salsa}`,
      uso: true,
      tipo: "salsa_ctx",
      salsa,
      comp
    };
  }

  const tam = deps.detectarTamano?.(textoClean);
  if (tam && m.ultimoTema === "pizza" && m.ultimoProducto) {
    const menu = deps.getMenu?.() || {};
    if (menu[m.ultimoProducto] && !deps.detectarIngredientes(textoClean, { permitirFuzzy: false }).length) {
      return { texto: `${m.ultimoProducto} ${tam}`, uso: true, tipo: "tamano_ctx" };
    }
  }

  if (/^de\s+/.test(x) && m.ultimoTema === "pizza") {
    const resto = textoClean.replace(/^de\s+/i, "").trim();
    if (resto) return { texto: resto, uso: true, tipo: "de_sabor_ctx" };
  }

  if (/^(la\s+)?(mediana|grande|familiar|jumbo|mega)\b/.test(x) && m.ultimoProducto) {
    const tam2 = deps.detectarTamano?.(textoClean);
    if (tam2 && m.ultimoTema === "pizza") {
      return { texto: `${m.ultimoProducto} ${tam2}`, uso: true, tipo: "la_tamano_ctx" };
    }
  }

  if (/^(esa|esa pizza|la misma|igual)\b/.test(x) && m.ultimoProducto) {
    return { texto: String(m.ultimoProducto), uso: true, tipo: "referencia_ctx" };
  }

  return { texto: textoClean, uso: false };
}

function precioComplementoPorNombre(nombre) {
  const items = deps.getComplementosItems?.() || [];
  const c = items.find((it) => it.nombre === nombre);
  return c?.precio != null ? Number(c.precio) : null;
}

function intentarRespuestaConContexto(estado, textoClean) {
  actualizarContextoDesdeTexto(estado, textoClean);
  const exp = expandirTextoConContexto(estado, textoClean);

  if (exp.uso && log.contexto_usado) {
    log.contexto_usado("expandir", {
      de: textoClean.slice(0, 40),
      a: exp.texto.slice(0, 60),
      tipo: exp.tipo
    });
  }

  const textoUse = exp.uso ? exp.texto : textoClean;

  if (exp.tipo === "salsa_ctx" && !esConsultaPrecioSuave(textoClean)) {
    const comp = exp.comp || estado.ctxMemoria?.ultimoComplemento || "alitas";
    const precio = precioComplementoPorNombre(comp);
    const cap = deps.capitalizar?.(comp) || comp;
    const sal = deps.capitalizar?.(exp.salsa) || exp.salsa;
    let msg = `🍗 *${cap}* con salsa *${sal}*`;
    if (precio != null) msg += ` — *$${precio}*`;
    msg += ".\n¿Las pides o necesitas otra cosa? 😊";
    touch(estado, { ultimoIntent: "alitas_salsa", ultimaSalsa: exp.salsa });
    return msg;
  }

  if (esConsultaPrecioSuave(textoUse) || esConsultaPrecioSuave(textoClean)) {
    const precioTxt = deps.resolverConsultaPrecio?.(textoUse, estado);
    if (precioTxt) {
      touch(estado, { ultimoIntent: "precio" });
      return precioTxt;
    }
    if (exp.uso && estado.ctxMemoria?.ultimoComplemento) {
      const p = precioComplementoPorNombre(estado.ctxMemoria.ultimoComplemento);
      if (p != null) {
        return `💲 *${deps.capitalizar(estado.ctxMemoria.ultimoComplemento)}*: *$${p}*`;
      }
    }
  }

  if (soloSalsaAmbigua(textoClean, estado)) {
    const salsa = detectarSalsaEnTexto(textoClean);
    return `🤔 ¿Te refieres a alitas con salsa *${deps.capitalizar?.(salsa) || salsa}*? 😊`;
  }

  return null;
}

function soloSalsaAmbigua(textoClean, estado) {
  const salsa = detectarSalsaEnTexto(textoClean);
  if (!salsa || !esMensajeCorto(textoClean)) return false;
  if (memoriaVigente(estado) && estado.ctxMemoria.ultimoTema === "alitas") return false;
  return xNorm(textoClean).split(/\s+/).length <= 2;
}

function respuestaFallbackInteligente(estado, motivo = "") {
  if (log.fallback) log.fallback("local", { paso: estado?.pasoPedido, motivo: String(motivo).slice(0, 80) });

  const custom = String(deps.getRestaurante?.()?.mensajeFallbackSinGroq || "").trim();
  if (custom) return custom;

  const paso = estado?.pasoPedido;
  if (paso && !["G", "H", "I"].includes(paso)) {
    const ayuda = deps.textoAyudaPasoPedido?.(estado) || `Paso *${paso}*`;
    if (log.no_entendido) log.no_entendido("en_paso", { paso });
    return `🤔 Perdón, no entendí bien.\n${ayuda}`;
  }

  const m = estado?.ctxMemoria;
  if (memoriaVigente(estado) && m?.ultimoTema === "alitas") {
    if (log.no_entendido) log.no_entendido("tema_alitas", {});
    const sal = m.ultimaSalsa ? ` (${m.ultimaSalsa})` : "";
    return (
      `🤔 No entendí bien.\n` +
      `¿*Precio* de alitas${sal}, otra *salsa* (bbq, buffalo…) o *promos*? 🍗`
    );
  }

  if (memoriaVigente(estado) && m?.ultimoProducto && m.ultimoTema === "pizza") {
    if (log.no_entendido) log.no_entendido("tema_pizza", { producto: m.ultimoProducto });
    const nom = deps.capitalizar?.(m.ultimoProducto) || m.ultimoProducto;
    const tam = m.ultimoTamano ? ` ${m.ultimoTamano}` : "";
    return (
      `🤔 No entendí bien.\n` +
      `¿*Precio* de *${nom}${tam}*, *pedido* o *promos*? 🍕`
    );
  }

  if (memoriaVigente(estado) && m?.ultimoIntent === "precio") {
    return (
      "🤔 Perdón, no entendí el producto.\n" +
      "Ej: *hawaiana grande*, *precio alitas*, *promos* 🍕"
    );
  }

  if (log.no_entendido) log.no_entendido("generico", {});
  const base =
    deps.MENSAJE_FALLBACK_DEFAULT ||
    "😊 Puedo ayudarte con *precios*, *promos* o tu *pedido*.\nEj: *hawaiana grande*, *precio alitas*, *promos* 🍕";
  const promos = deps.obtenerPromosVigentes?.() || [];
  if (promos.length === 1 && deps.textoPromoCortoParaCliente) {
    const det = deps.textoPromoCortoParaCliente(promos[0]);
    if (det) return `${base}\n\n🔥 Hoy: *${promos[0].titulo || "promo"}* — ${det}`;
  }
  if (paso && paso !== "G") {
    return `${base}\n\n📋 Sigues en pedido (paso ${paso}). Escribe el dato que falta o *cancelar*.`;
  }
  return base;
}

module.exports = {
  init,
  crearMemoria,
  memoriaVigente,
  actualizarContextoDesdeTexto,
  expandirTextoConContexto,
  intentarRespuestaConContexto,
  respuestaFallbackInteligente
};
