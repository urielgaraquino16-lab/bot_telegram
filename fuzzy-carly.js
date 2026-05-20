/**
 * Motor de similitudes Carly — catálogo unificado, confirmación sí/no, aprendizaje de aliases.
 * Se inicializa desde index.js con dependencias del negocio.
 */

let deps = {};
let catalogoFuzzy = [];
let aliasesAprendidosMem = {};

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectarCantidadEnTexto(textoClean) {
  const m = String(textoClean || "").match(/\b(\d{1,2})\b/);
  if (m) return Number.parseInt(m[1], 10);
  const map = { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
  for (const [w, n] of Object.entries(map)) {
    if (new RegExp(`\\b${escapeRegExp(w)}\\b`).test(textoClean)) return n;
  }
  return null;
}

const TYPO_GLOBAL = {
  pitza: "pizza",
  piza: "pizza",
  pitzas: "pizza",
  megicana: "mexicana",
  mexicna: "mexicana",
  jawaiana: "hawaiana",
  hawaianna: "hawaiana",
  jawaianana: "hawaiana",
  peperony: "peperoni",
  peperonni: "peperoni",
  jumno: "jumbo",
  familar: "familiar",
  boneles: "boneless",
  bonelesss: "boneless",
  coac: "coca",
  refresko: "refresco"
};

function init(dependencies) {
  deps = dependencies;
  aliasesAprendidosMem = { ...(deps.getRestaurante()?.aliasesAprendidos || {}) };
  rebuildCatalogo();
}

function getUmbrales() {
  const f = deps.getRestaurante()?.fuzzy || {};
  return {
    alta: Number(f.umbralAlto) || 0.88,
    media: Number(f.umbralMedio) || 0.72,
    minSiAviso: Number(f.minVecesSiParaAviso) || 5
  };
}

function normFuzzy(texto) {
  let t = deps.sinAcentos(deps.normalizarTextoPedido(texto || ""));
  for (const [k, v] of Object.entries(TYPO_GLOBAL)) {
    t = t.replace(new RegExp(`\\b${escapeRegExp(k)}\\b`, "g"), v);
  }
  return t.replace(/\s+/g, " ").trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = i - 1;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      const cost = a[i - 1] === b[j - 1] ? prev : Math.min(prev, row[j], row[j - 1]) + 1;
      prev = cur;
      row[j] = cost;
    }
  }
  return row[b.length];
}

function similitudTexto(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length >= 3 && b.includes(a)) return 0.92;
  if (b.length >= 3 && a.includes(b)) return 0.9;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length, 1);
}

function aliasesDeItem(tipo, canonico) {
  const set = new Set();
  const n = normFuzzy(canonico);
  if (n) set.add(n);
  const rest = deps.getRestaurante() || {};
  if (tipo === "pizza" && rest.ingredientAliases?.[canonico]) {
    String(rest.ingredientAliases[canonico])
      .split(",")
      .map((x) => normFuzzy(x))
      .filter(Boolean)
      .forEach((a) => set.add(a));
  }
  for (const [typo, info] of Object.entries(aliasesAprendidosMem)) {
    if (!info) continue;
    if (info.canonico === canonico && (info.tipo === tipo || !info.tipo)) {
      set.add(normFuzzy(typo));
    }
  }
  return [...set];
}

function rebuildCatalogo() {
  const items = [];
  const menu = deps.getMenu() || {};
  for (const p of Object.keys(menu)) {
    items.push({
      tipo: "pizza",
      canonico: p,
      aliases: aliasesDeItem("pizza", p),
      meta: menu[p]
    });
  }
  for (const c of deps.getComplementosItems() || []) {
    if (!c?.nombre) continue;
    items.push({
      tipo: "comp",
      canonico: c.nombre,
      aliases: aliasesDeItem("comp", c.nombre),
      meta: { precio: c.precio }
    });
  }
  for (const b of deps.getBebidasItems() || []) {
    if (!b?.nombre) continue;
    items.push({
      tipo: "bebida",
      canonico: b.nombre,
      aliases: aliasesDeItem("bebida", b.nombre),
      meta: { precio: b.precio }
    });
  }
  for (const ex of deps.getRestaurante()?.extras || []) {
    if (!ex?.nombre) continue;
    const extraAls = String(ex.aliases || "")
      .split(",")
      .map((x) => normFuzzy(x))
      .filter(Boolean);
    items.push({
      tipo: "extra",
      canonico: ex.nombre,
      aliases: [...new Set([...aliasesDeItem("extra", ex.nombre), ...extraAls])],
      meta: ex
    });
  }
  for (const promo of deps.obtenerPromosVigentes() || []) {
    const tit = promo.titulo || promo.id || "promo";
    const als = [normFuzzy(tit), normFuzzy(promo.id || "")].filter(Boolean);
    if (promo.textoCliente) als.push(normFuzzy(String(promo.textoCliente).slice(0, 40)));
    items.push({
      tipo: "promo",
      canonico: tit,
      aliases: [...new Set(als)],
      meta: { promoId: promo.id, promo }
    });
  }
  catalogoFuzzy = items;
}

function mejorMatchEnTexto(textoNorm, item) {
  let best = 0;
  for (const al of item.aliases) {
    best = Math.max(best, similitudTexto(textoNorm, al));
    if (textoNorm.includes(al) && al.length >= 4) best = Math.max(best, 0.93);
  }
  const words = textoNorm.split(/\s+/).filter((w) => w.length >= 3);
  for (const w of words) {
    for (const al of item.aliases) {
      best = Math.max(best, similitudTexto(w, al));
    }
  }
  return best;
}

function buscarMatches(textoClean) {
  const t = normFuzzy(textoClean);
  if (!t || t.length < 2) return [];
  const matches = [];
  for (const item of catalogoFuzzy) {
    const score = mejorMatchEnTexto(t, item);
    if (score >= getUmbrales().media - 0.05) {
      matches.push({ ...item, score });
    }
  }
  matches.sort((a, b) => b.score - a.score);
  return matches;
}

function pareceMitadMitad(textoNorm, pizzas) {
  if (pizzas.length < 2) return false;
  if (/(mitad\s*y\s*mitad|media\s*y\s*media|dos\s*sabores)/.test(textoNorm)) return true;
  if (/\b(una|un)\s+\w+.+\s+(y|con)\s+(una|un)?\s*\w+/.test(textoNorm)) return true;
  if (/\b\w+\s+y\s+\w+/.test(textoNorm) && pizzas.length >= 2) {
    const menu = deps.getMenu() || {};
    if (pizzas[0].canonico in menu && pizzas[1].canonico in menu) return true;
  }
  return false;
}

function textoConfirmacion(propuesta) {
  const cap = deps.capitalizar;
  if (propuesta.tipo === "mitad_mitad") {
    const [a, b] = propuesta.ingredientes;
    return `🤔 ¿Quisiste *mitad ${cap(a)}* y *mitad ${cap(b)}*?\n\nResponde *sí* o *no* 🍕`;
  }
  if (propuesta.tipo === "pizza") {
    return `🤔 ¿Quisiste la pizza *${cap(propuesta.ingredientes[0])}*?\n\nResponde *sí* o *no* 🍕`;
  }
  if (propuesta.tipo === "comp" || propuesta.tipo === "bebida") {
    const q = propuesta.cantidad > 1 ? `${propuesta.cantidad} ` : "";
    return `🤔 ¿Quisiste ${q}*${cap(propuesta.nombre)}*?\n\nResponde *sí* o *no* 🍕`;
  }
  if (propuesta.tipo === "promo") {
    return `🤔 ¿Te refieres a la promo *${propuesta.titulo}*?\n\nResponde *sí* o *no* 🔥`;
  }
  if (propuesta.tipo === "extra") {
    return `🤔 ¿Quisiste *${cap(propuesta.nombre)}*?\n\nResponde *sí* o *no* 🍕`;
  }
  return `🤔 ¿Es esto correcto?\nResponde *sí* o *no*`;
}

function textoNoEntendido() {
  return `👍 Sin problema. Escríbelo más claro, por ejemplo:\n• *hawaiana grande*\n• *mitad mexicana y hawaiana*\n• *2 alitas*\n• *promos*\n\n¿Qué te gustaría? 🍕😊`;
}

function construirPropuestaDesdeMatches(textoClean, matches) {
  const t = normFuzzy(textoClean);
  const pizzas = matches.filter((m) => m.tipo === "pizza" && m.score >= getUmbrales().media);
  const uniqPizza = [];
  for (const p of pizzas) {
    if (!uniqPizza.find((x) => x.canonico === p.canonico)) uniqPizza.push(p);
  }

  if (uniqPizza.length >= 2 && pareceMitadMitad(t, uniqPizza)) {
    return {
      tipo: "mitad_mitad",
      ingredientes: [uniqPizza[0].canonico, uniqPizza[1].canonico],
      confianza: Math.min(uniqPizza[0].score, uniqPizza[1].score)
    };
  }

  const comp = matches.find((m) => m.tipo === "comp" && m.score >= getUmbrales().media);
  const beb = matches.find((m) => m.tipo === "bebida" && m.score >= getUmbrales().media);
  const promo = matches.find((m) => m.tipo === "promo" && m.score >= getUmbrales().media);
  const extra = matches.find((m) => m.tipo === "extra" && m.score >= getUmbrales().media);

  if (promo && /(promo|oferta|combo)/.test(t)) {
    return {
      tipo: "promo",
      titulo: promo.canonico,
      promoId: promo.meta?.promoId,
      confianza: promo.score
    };
  }

  if (comp && comp.score >= beb?.score) {
    const cant = detectarCantidadEnTexto(t) || 1;
    return { tipo: "comp", nombre: comp.canonico, cantidad: cant, confianza: comp.score };
  }
  if (beb) {
    const cant = detectarCantidadEnTexto(t) || 1;
    return { tipo: "bebida", nombre: beb.canonico, cantidad: cant, confianza: beb.score };
  }
  if (extra) {
    return { tipo: "extra", nombre: extra.canonico, confianza: extra.score };
  }

  if (uniqPizza.length === 1) {
    return {
      tipo: "pizza",
      ingredientes: [uniqPizza[0].canonico],
      confianza: uniqPizza[0].score
    };
  }

  return null;
}

function analizarMensaje(textoClean, estado, opts = {}) {
  if (!textoClean || estado?.confirmacionPendiente) {
    return { accion: "ninguna" };
  }
  if (estado?.pasoPedido === "G") return { accion: "ninguna" };

  const pareceSoloConsulta =
    deps.esConsultaPrecio?.(textoClean) ||
    deps.esPreguntaRebanadas?.(textoClean) ||
    deps.esPreguntaIngredientesPizza?.(textoClean);
  const parecePedido =
    deps.detectarInicioPedido?.(textoClean) ||
    estado?.pasoPedido ||
    /\b(quiero|dame|pedir|ordenar|me da|ponme|necesito)\b/.test(textoClean);

  const matches = buscarMatches(textoClean);
  if (!matches.length) return { accion: "ninguna" };

  const propuesta = construirPropuestaDesdeMatches(textoClean, matches);
  if (!propuesta) return { accion: "ninguna" };
  propuesta.textoOriginal = textoClean;

  const { alta, media } = getUmbrales();

  if (!parecePedido && pareceSoloConsulta && propuesta.tipo === "pizza") {
    return { accion: "ninguna" };
  }

  if (propuesta.confianza >= alta) {
    return { accion: "aplicar", propuesta, matches };
  }
  if (propuesta.confianza >= media) {
    return { accion: "confirmar", propuesta, mensaje: textoConfirmacion(propuesta) };
  }
  if (propuesta.tipo === "pizza" && propuesta.confianza >= media - 0.08) {
    return { accion: "confirmar", propuesta, mensaje: textoConfirmacion(propuesta) };
  }

  return { accion: "ninguna" };
}

function aplicarPropuesta(estado, propuesta) {
  if (!propuesta) return;
  if (propuesta.tipo === "mitad_mitad" || propuesta.tipo === "pizza") {
    estado.ingredientes = [...(propuesta.ingredientes || [])].slice(0, 2);
    estado.pizzaSugerida = null;
    if (!estado.pasoPedido) estado.pasoPedido = "A";
    estado.pasoPedido = "B";
    const tam = deps.detectarTamano?.(propuesta.textoOriginal || "");
    if (tam && estado.ingredientes[0] && deps.getMenu()?.[estado.ingredientes[0]]?.[tam]) {
      estado.tamano = tam;
      estado.pasoPedido = "C";
    }
    return;
  }
  if (propuesta.tipo === "comp") {
    if (!estado.complementos) estado.complementos = {};
    const n = propuesta.nombre;
    const q = propuesta.cantidad || 1;
    estado.complementos[n] = (estado.complementos[n] || 0) + q;
    if (!Array.isArray(estado.lineasComplemento)) estado.lineasComplemento = [];
    estado.lineasComplemento.push({ nombre: n, cantidad: q });
    if (!estado.pasoPedido) estado.pasoPedido = "D";
    return;
  }
  if (propuesta.tipo === "bebida") {
    if (!Array.isArray(estado.lineasBebida)) estado.lineasBebida = [];
    estado.lineasBebida.push({
      nombre: propuesta.nombre,
      cantidad: propuesta.cantidad || 1
    });
    if (!estado.pasoPedido) estado.pasoPedido = "D";
    return;
  }
  if (propuesta.tipo === "promo") {
    estado.promoActivaId = propuesta.promoId || null;
    estado.referenciaPromoCliente = propuesta.titulo;
    return;
  }
  if (propuesta.tipo === "extra") {
    const txt = propuesta.textoOriginal || propuesta.nombre || "";
    deps.mergeExtrasEnEstado?.(estado, txt);
  }
}

async function registrarAprendizaje(entry) {
  try {
    await deps.appendFile(
      "aprendizaje_aliases.jsonl",
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
    );
  } catch (err) {
    console.warn("aprendizaje log:", err?.message || err);
  }

  if (entry.respuesta !== "si" || !entry.propuesta) return;

  const prop = entry.propuesta;
  let typo = normFuzzy(entry.textoOriginal || "");
  let canonico = "";
  let tipo = prop.tipo === "mitad_mitad" ? "pizza" : prop.tipo;
  if (prop.tipo === "mitad_mitad" || prop.tipo === "pizza") {
    canonico = prop.ingredientes?.[0] || "";
    const words = typo.split(/\s+/).filter((w) => w.length >= 4);
    for (const w of words) {
      if (similitudTexto(w, normFuzzy(canonico)) < 0.85) {
        typo = w;
        break;
      }
    }
  } else {
    canonico = prop.nombre || prop.titulo || "";
  }

  if (!typo || !canonico || typo === normFuzzy(canonico)) return;

  const prev = aliasesAprendidosMem[typo] || { canonico, tipo, veces_si: 0, veces_no: 0 };
  if (prev.canonico === canonico) {
    prev.veces_si = (prev.veces_si || 0) + 1;
  } else {
    prev.canonico = canonico;
    prev.tipo = tipo;
    prev.veces_si = 1;
  }
  aliasesAprendidosMem[typo] = prev;

  try {
    const rest = deps.getRestaurante() || {};
    rest.aliasesAprendidos = { ...aliasesAprendidosMem };
    await deps.guardarRestauranteAliases(rest.aliasesAprendidos);
    rebuildCatalogo();

    const minAviso = getUmbrales().minSiAviso;
    if (prev.veces_si === minAviso && deps.notificarTelegram) {
      await deps.notificarTelegram(
        `📚 *Alias aprendido* (${prev.veces_si}× sí)\n"${typo}" → *${canonico}* (${tipo})\nYa está activo en el bot.`
      );
    }
  } catch (err) {
    console.warn("guardar alias:", err?.message || err);
  }
}

function manejarConfirmacionPendiente(estado, textoClean) {
  if (!estado?.confirmacionPendiente) return { manejado: false };

  if (deps.esAfirmacionSimple(textoClean)) {
    const prop = estado.confirmacionPendiente.propuesta;
    aplicarPropuesta(estado, { ...prop, textoOriginal: estado.confirmacionPendiente.textoOriginal });
    deps.registrarAprendizaje?.({
      textoOriginal: estado.confirmacionPendiente.textoOriginal,
      propuesta: prop,
      respuesta: "si"
    });
    estado.confirmacionPendiente = null;
    return { manejado: true, aplicado: true, propuesta: prop };
  }

  if (deps.esNegacionSimple(textoClean) || textoClean === "no") {
    deps.registrarAprendizaje?.({
      textoOriginal: estado.confirmacionPendiente.textoOriginal,
      propuesta: estado.confirmacionPendiente.propuesta,
      respuesta: "no"
    });
    estado.confirmacionPendiente = null;
    return { manejado: true, mensaje: textoNoEntendido() };
  }

  if (textoClean.includes("cancelar")) {
    estado.confirmacionPendiente = null;
    return { manejado: false };
  }

  return {
    manejado: true,
    mensaje: "😊 Primero dime *sí* o *no* a lo que te pregunté.\n(Si quieres empezar de nuevo: *cancelar*)"
  };
}

module.exports = {
  init,
  rebuildCatalogo,
  analizarMensaje,
  aplicarPropuesta,
  manejarConfirmacionPendiente,
  registrarAprendizaje,
  textoNoEntendido,
  textoConfirmacion
};
