/**
 * Multi-intención Carly — detecta varios objetivos en un mensaje y arma una sola respuesta.
 * Solo reglas + menú (sin inventar precios). Log opcional para mejorar el bot con el tiempo.
 */

let deps = {};

const ORDEN_RESPUESTA = [
  "humano",
  "saludo",
  "horario",
  "domicilio",
  "promo",
  "rebanadas",
  "ingredientes",
  "mitad_precio",
  "precio",
  "pedido",
  "complemento",
  "menu",
  "carrito"
];

function init(dependencies) {
  deps = dependencies;
}

function detectarIntenciones(textoClean, estado) {
  const t = textoClean;
  const found = new Set();
  if (!t) return { intents: [], slots: {}, raw: t };

  if (/(asesor|humano|persona|queja|reclamo|reembolso|inconforme|mal servicio)/.test(t)) {
    found.add("humano");
  }
  if (/(^hola$|^hola\s|buenas|buen dia|que tal|hey\b)/.test(t) && !estado?.pasoPedido) {
    found.add("saludo");
  }
  if (/(horario|abren|abre|cierran|cierra)/.test(t)) found.add("horario");
  if (/(domicilio|reparto|entrega|envio|envío|a domicilio|a casa)/.test(t)) {
    found.add("domicilio");
  }
  if (/(promo|promocion|oferta|combo)/.test(t)) found.add("promo");
  if (deps.esPreguntaRebanadas?.(t)) found.add("rebanadas");
  if (deps.esPreguntaIngredientesPizza?.(t)) found.add("ingredientes");
  if (/(mitad\s*y\s*mitad|media\s*y\s*media|dos\s*sabores)/.test(t)) {
    found.add("mitad_precio");
  }
  if (deps.esConsultaPrecio?.(t)) found.add("precio");
  if (
    /\b(quiero|dame|pedir|ordenar|mandar|necesito|ponme|deseo)\b/.test(t) ||
    /\b(una|un)\s+pizza\b/.test(t) ||
    deps.detectarInicioPedido?.(t)
  ) {
    found.add("pedido");
  }
  if (/(menu|carta|que pizzas|sabores tienen|que sabores)/.test(t)) found.add("menu");
  if (deps.textoPideVerCarrito?.(t) && deps.hayContenidoCarrito?.(estado)) {
    found.add("carrito");
  }

  const ings = deps.detectarIngredientes?.(t) || [];
  const tam = deps.detectarTamano?.(t) || null;
  const { encontrados: comps } = deps.detectarComplementosEnTexto?.(t) || {
    encontrados: {}
  };
  const bebs = deps.detectarBebidasEnTexto?.(t) || {};
  if (Object.keys(comps).length || Object.keys(bebs).length) found.add("complemento");

  const slots = {
    sabores: ings.slice(0, 2),
    tamano: tam,
    complementos: comps,
    bebidas: bebs
  };

  return { intents: [...found], slots, raw: t };
}

function debeUsarMultiIntent(analisis) {
  const n = analisis.intents.length;
  if (n >= 2) return true;
  const combo = new Set(analisis.intents);
  if (combo.has("precio") && (combo.has("domicilio") || combo.has("horario") || combo.has("pedido"))) {
    return true;
  }
  if (combo.has("pedido") && combo.has("promo")) return true;
  if (combo.has("saludo") && n >= 2) return true;
  const t = analisis.raw || "";
  if (n >= 1 && /\s+y\s+|\?.*\s+y\s+|tambien|ademas/.test(t)) return true;
  return false;
}

function bloqueHorario() {
  const r = deps.getRestaurante?.() || {};
  let msg = `🕒 Horario: ${r.horarioTexto || "consulta en tienda"}`;
  if (deps.estaAbiertoEfectivo && !deps.estaAbiertoEfectivo()) {
    msg += "\n⏰ Ahorita estamos *cerrados* según este horario.";
  }
  return msg;
}

function bloqueDomicilio() {
  const r = deps.getRestaurante?.() || {};
  return r.servicioDomicilio
    ? `🚚 ${r.servicioDomicilioTexto || "Sí hay servicio a domicilio."}`
    : "🚚 Por el momento no hay servicio a domicilio.";
}

function bloquePromos() {
  const promos = deps.obtenerPromosVigentes?.() || [];
  if (!promos.length) {
    return `🔥 ${deps.getRestaurante?.()?.promocionesTexto || "Pregunta promos del día en tienda."}`;
  }
  const lineas = promos.slice(0, 4).map((p, i) => {
    const tit = p.titulo || p.id || `Promo ${i + 1}`;
    return `*${i + 1}.* ${tit}\n${deps.formatearTextoPromoCliente?.(p) || ""}`;
  });
  return `🔥 *Promos de hoy:*\n\n${lineas.join("\n\n")}`;
}

function bloquePrecio(slots, textoClean) {
  const sub = deps.resolverConsultaPrecio?.(textoClean);
  if (sub) return sub;
  const { sabores, tamano } = slots;
  if (tamano && sabores.length === 0) {
    return `💲 La *${tamano}* depende del *sabor*. ¿Cuál quieres? (ej. hawaiana, peperoni…)`;
  }
  if (sabores.length === 1 && tamano) {
    const pr = deps.getMenu?.()?.[sabores[0]]?.[tamano];
    if (pr != null) {
      return `💲 *${deps.capitalizar?.(sabores[0])}* ${tamano}: *$${pr}*`;
    }
  }
  return null;
}

function bloqueMitadPrecio(slots, textoClean) {
  const { sabores, tamano } = slots;
  if (sabores.length >= 2 && tamano) {
    const p = deps.calcularPrecio?.(sabores.slice(0, 2), tamano);
    if (p) {
      return `🍕 Mitad *${sabores[0]}* y mitad *${sabores[1]}* (${tamano}): *$${p}*`;
    }
  }
  if (sabores.length >= 2 && !tamano) {
    return "📏 Para mitad y mitad dime también el *tamaño* (mediana, grande…).";
  }
  return deps.resolverConsultaPrecio?.(textoClean);
}

function aplicarSlotsAlEstado(estado, slots) {
  if (!estado || !slots) return [];
  const notas = [];
  const { sabores, tamano, complementos, bebidas } = slots;

  if (sabores?.length) {
    const validos = sabores.filter((s) => deps.getMenu?.()?.[s]);
    if (validos.length) {
      estado.ingredientes = validos.slice(0, 2);
      if (!estado.pasoPedido) estado.pasoPedido = "A";
      if (validos.length >= 1) {
        estado.pasoPedido = tamano ? "C" : "B";
        notas.push(`🍕 Pizza *${validos.join(" / ")}* anotada.`);
      }
    }
  }
  if (tamano && estado.ingredientes?.length && deps.getMenu?.()?.[estado.ingredientes[0]]?.[tamano]) {
    estado.tamano = tamano;
    estado.pasoPedido = estado.pasoPedido || "C";
    if (notas.length === 0) notas.push(`📏 Tamaño *${tamano}* anotado.`);
  } else if (tamano && !estado.ingredientes?.length) {
    estado.tamano = tamano;
    notas.push(`📏 Tamaño *${tamano}* — dime el *sabor* para el precio exacto.`);
  }

  if (complementos && typeof complementos === "object") {
    estado.complementos = estado.complementos || {};
    for (const [nom, cant] of Object.entries(complementos)) {
      estado.complementos[nom] = (estado.complementos[nom] || 0) + (cant || 1);
      if (!Array.isArray(estado.lineasComplemento)) estado.lineasComplemento = [];
      estado.lineasComplemento.push({ nombre: nom, cantidad: cant || 1 });
    }
    notas.push(`🍗 Complementos agregados al pedido.`);
    if (!estado.pasoPedido) estado.pasoPedido = "D";
  }

  if (bebidas && typeof bebidas === "object") {
    estado.lineasBebida = estado.lineasBebida || [];
    for (const [nom, cant] of Object.entries(bebidas)) {
      estado.lineasBebida.push({ nombre: nom, cantidad: cant || 1 });
    }
    notas.push(`🥤 Bebidas agregadas.`);
  }

  return notas;
}

function planificarRespuesta(analisis, estado, textoClean) {
  const bloques = [];
  const intents = new Set(analisis.intents);

  if (intents.has("humano")) {
    return {
      texto:
        "😔 Lamento la molestia. Te conecto con el equipo — en un momento te escriben.\n_Si es urgente, vuelve a escribir *asesor*._",
      escalarHumano: true,
      intents: analisis.intents
    };
  }

  if (intents.has("saludo") && analisis.intents.length <= 2) {
    bloques.push(
      `😊 ¡Hola! Soy *Carly* de *${deps.getRestaurante?.()?.nombreNegocio || "Pizzas Carly"}* 🍕`
    );
  }

  for (const key of ORDEN_RESPUESTA) {
    if (!intents.has(key)) continue;
    if (key === "saludo" || key === "humano") continue;

    if (key === "horario") bloques.push(bloqueHorario());
    if (key === "domicilio") bloques.push(bloqueDomicilio());
    if (key === "promo") bloques.push(bloquePromos());
    if (key === "rebanadas") {
      const r = deps.responderConsultaRebanadas?.(textoClean);
      if (r) bloques.push(r);
    }
    if (key === "ingredientes") {
      const r = deps.textoDescripcionLocalPizza?.(textoClean);
      if (r) bloques.push(r);
    }
    if (key === "mitad_precio") {
      const r = bloqueMitadPrecio(analisis.slots, textoClean);
      if (r) bloques.push(r);
    }
    if (key === "precio" && !intents.has("mitad_precio")) {
      const r = bloquePrecio(analisis.slots, textoClean);
      if (r) bloques.push(r);
    }
    if (key === "menu") {
      const pizzas = Object.keys(deps.getMenu?.() || {}).slice(0, 12);
      bloques.push(
        `🍕 Algunos sabores: ${pizzas.map((p) => deps.capitalizar?.(p) || p).join(", ")}…\n¿Quieres *precio* de alguno o *hacer pedido*?`
      );
    }
    if (key === "carrito") {
      bloques.push(`🧺 *Tu pedido:*\n\n${deps.resumenDetalladoPedidoParaCliente?.(estado) || "—"}`);
    }
  }

  if (intents.has("pedido") || intents.has("complemento")) {
    const notas = aplicarSlotsAlEstado(estado, analisis.slots);
    for (const n of notas) {
      if (!bloques.some((b) => b.includes(n.slice(0, 12)))) bloques.push(n);
    }
  }

  const unicos = [];
  for (const b of bloques) {
    const s = String(b || "").trim();
    if (s && !unicos.includes(s)) unicos.push(s);
  }

  if (!unicos.length) return null;

  let cierre = "";
  if (
    intents.has("precio") &&
    analisis.slots.tamano &&
    analisis.slots.sabores.length === 0
  ) {
    cierre = ""; // ya preguntó sabor en bloque precio
  } else if (intents.has("pedido") && !estado?.ingredientes?.length) {
    cierre = "¿De qué *sabor* la pizza? 🍕";
  } else if (intents.has("pedido") && estado?.ingredientes?.length && !estado?.tamano) {
    cierre = "¿Qué *tamaño*? (mediana, grande, familiar…) 📏";
  } else if (unicos.length >= 2) {
    cierre = "¿Te armo el pedido o algo más? 😊";
  }

  const texto = cierre ? `${unicos.join("\n\n")}\n\n${cierre}` : unicos.join("\n\n");
  return { texto, escalarHumano: false, intents: analisis.intents };
}

function intentarRespuestaMulti(textoClean, estado) {
  const analisis = detectarIntenciones(textoClean, estado);
  if (!debeUsarMultiIntent(analisis)) return null;
  return planificarRespuesta(analisis, estado, textoClean);
}

function logInteraccion(entry) {
  if (!deps.appendLog) return;
  deps.appendLog(entry).catch(() => {});
}

module.exports = {
  init,
  detectarIntenciones,
  debeUsarMultiIntent,
  intentarRespuestaMulti,
  planificarRespuesta,
  logInteraccion
};
