/**
 * Ediciones al carrito en lenguaje natural (misma lógica, respuestas con confirmación suave).
 */

const mensajesCarly = require("./mensajes-carly");

let deps = {};

function init(dependencies) {
  deps = { ...dependencies };
}

function xNorm(textoClean) {
  return deps.sinAcentos(deps.normalizarTextoPedido(textoClean));
}

function resumenTotalCorto(estado) {
  const { total } = deps.subtotalesPedidoActuales(estado);
  return total > 0 ? `💰 Total ahora: *$${total}*` : "";
}

function logCarrito(evento, payload) {
  if (deps.botLogger?.carrito) deps.botLogger.carrito(evento, payload);
}

function hayContenidoCarrito(estado) {
  return (
    (estado.ingredientes?.length || 0) > 0 ||
    Object.keys(estado.complementos || {}).length > 0 ||
    (estado.lineasComplemento?.length || 0) > 0 ||
    (estado.lineasBebida?.length || 0) > 0
  );
}

function textoPideVerCarrito(textoClean) {
  const x = xNorm(textoClean);
  return (
    /(carrito|resumen|total|cu[aá]nto\s+va|cuanto\s+llevo|que\s+llevo|pedido\s+actual)/.test(x)
  );
}

function textoPideAgregarMasNatural(textoClean) {
  const x = xNorm(textoClean);
  return (
    deps.esAfirmacionSimple?.(x) ||
    /(agrega|agregame|agregale|tambien|y\s+una|y\s+un|quiero\s+otra|quiero\s+otro)/.test(x)
  );
}

function quitarComplementoDelEstado(estado, nombre) {
  let removido = false;
  if (estado.complementos && estado.complementos[nombre]) {
    delete estado.complementos[nombre];
    removido = true;
  }
  if (Array.isArray(estado.lineasComplemento)) {
    const before = estado.lineasComplemento.length;
    estado.lineasComplemento = estado.lineasComplemento.filter((L) => L.nombre !== nombre);
    removido = removido || before !== estado.lineasComplemento.length;
  }
  return removido;
}

function quitarBebidaDelEstado(estado, nombre) {
  if (!Array.isArray(estado.lineasBebida)) return false;
  const before = estado.lineasBebida.length;
  estado.lineasBebida = estado.lineasBebida.filter((L) => L.nombre !== nombre);
  return before !== estado.lineasBebida.length;
}

function quitarPorNombreEnTexto(estado, x, textoClean) {
  if (!/(quita|quitar|elimina|borrar|sin|no\s+quiero)\b/.test(x)) return null;

  const pick = deps.resolverItemCatalogoPorNumeroONombre(textoClean);
  if (pick?.tipo === "comp") {
    const ok = quitarComplementoDelEstado(estado, pick.nombre);
    if (ok) {
      logCarrito("quitar_comp", { nombre: pick.nombre });
      return mensajesCarly.mensajeEntendiCambio(
        [`Quité *${pick.nombre}*`],
        resumenTotalCorto(estado)
      );
    }
  }
  if (pick?.tipo === "bebida") {
    const ok = quitarBebidaDelEstado(estado, pick.nombre);
    if (ok) {
      logCarrito("quitar_bebida", { nombre: pick.nombre });
      return mensajesCarly.mensajeEntendiCambio(
        [`Quité *${pick.nombre}*`],
        resumenTotalCorto(estado)
      );
    }
  }

  for (const c of deps.getComplementosItems?.() || []) {
    const cn = deps.sinAcentos(deps.normalizarTextoPedido(c.nombre));
    if (cn.length >= 4 && x.includes(cn)) {
      const ok = quitarComplementoDelEstado(estado, c.nombre);
      if (ok) {
        logCarrito("quitar_comp_texto", { nombre: c.nombre });
        return mensajesCarly.mensajeEntendiCambio(
          [`Quité *${c.nombre}*`],
          resumenTotalCorto(estado)
        );
      }
    }
  }

  if (/(pizza|sabor)/.test(x) && estado.ingredientes?.length) {
    const antes = estado.ingredientes.join(" / ");
    estado.ingredientes = [];
    estado.tamano = null;
    logCarrito("quitar_pizza", { antes });
    return mensajesCarly.mensajeEntendiCambio([`Quité la pizza (*${antes}*)`]);
  }

  if (/bebida/.test(x) && estado.lineasBebida?.length) {
    estado.lineasBebida = [];
    logCarrito("quitar_todas_bebidas", {});
    return mensajesCarly.mensajeEntendiCambio(["Quité las bebidas"]);
  }

  return null;
}

function duplicarUltimoArticulo(estado) {
  if (Array.isArray(estado.lineasBebida) && estado.lineasBebida.length > 0) {
    const last = estado.lineasBebida[estado.lineasBebida.length - 1];
    last.cantidad = Number(last.cantidad || 0) + 1;
    logCarrito("duplicar_bebida", { nombre: last.nombre, cantidad: last.cantidad });
    return mensajesCarly.mensajeEntendiCambio(
      [`Otra *${last.nombre}* (x${last.cantidad})`],
      resumenTotalCorto(estado)
    );
  }
  if (Array.isArray(estado.lineasComplemento) && estado.lineasComplemento.length > 0) {
    const last = estado.lineasComplemento[estado.lineasComplemento.length - 1];
    last.cantidad = Number(last.cantidad || 0) + 1;
    if (estado.complementos && estado.complementos[last.nombre] != null) {
      estado.complementos[last.nombre] = Number(estado.complementos[last.nombre] || 0) + 1;
    }
    logCarrito("duplicar_comp", { nombre: last.nombre, cantidad: last.cantidad });
    return mensajesCarly.mensajeEntendiCambio(
      [`Otra *${last.nombre}* (x${last.cantidad})`],
      resumenTotalCorto(estado)
    );
  }
  if (estado.ingredientes?.length > 0) {
    return "🍕 Para otra pizza dime el *sabor* y *tamaño*; te lo anoto con cuidado 🍕";
  }
  return null;
}

function cambiarTamanoEnCarrito(estado, x) {
  const t = deps.detectarTamano(x);
  if (!t) return null;
  if (
    !/(cambia|cambiar|pon|ponla|ponle|quiero|que\s+sea|tamaño|tamano|mediana|grande|familiar|jumbo|mega)/.test(
      x
    )
  ) {
    return null;
  }
  if (!estado.ingredientes?.length) return null;
  if (deps.hayContextoPizzaClaro && !deps.hayContextoPizzaClaro(estado)) return null;
  const antes = estado.tamano || "sin tamaño";
  estado.tamano = t;
  deps.recalcularExtrasTotal(estado);
  logCarrito("cambiar_tamano", { de: antes, a: t });
  return mensajesCarly.mensajeEntendiCambio(
    [`Tamaño: *${t}*`],
    resumenTotalCorto(estado)
  );
}

function cambiarSaborEnCarrito(estado, x) {
  if (!/(que sea|pero|pero era|cambia|cambiar|mejor|pon|ponla|sabor|quiero)\b/.test(x)) {
    return null;
  }
  const nuevos = deps.detectarIngredientes(x, { permitirFuzzy: true });
  if (nuevos.length !== 1 || !deps.getMenu()?.[nuevos[0]]) return null;
  const antes = estado.ingredientes?.join(" / ") || "—";
  estado.ingredientes = nuevos.slice(0, 2);
  deps.recalcularExtrasTotal(estado);
  logCarrito("cambiar_sabor", { de: antes, a: estado.ingredientes.join(" / ") });
  return mensajesCarly.mensajeEntendiCambio(
    [`Pizza: *${estado.ingredientes.join(" / ")}*`],
    resumenTotalCorto(estado)
  );
}

function aplicarEdicionCarritoNatural(estado, textoClean) {
  const x = xNorm(textoClean);
  if (!x || !hayContenidoCarrito(estado)) return null;

  return (
    cambiarTamanoEnCarrito(estado, x) ||
    cambiarSaborEnCarrito(estado, x) ||
    quitarPorNombreEnTexto(estado, x, textoClean) ||
    (/(duplica|doble|otra igual|sumale una|sumale uno|otra mas)/.test(x)
      ? duplicarUltimoArticulo(estado)
      : null)
  );
}

module.exports = {
  init,
  hayContenidoCarrito,
  textoPideVerCarrito,
  textoPideAgregarMasNatural,
  aplicarEdicionCarritoNatural
};
