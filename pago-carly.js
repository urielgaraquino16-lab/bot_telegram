/**
 * Formas de pago Carly: efectivo / transferencia, cuentas en imagen.
 */

const promoImagenes = require("./promo-imagenes");

let deps = {
  getRestaurante: () => ({}),
  sinAcentos: (s) => String(s || ""),
  normalizarTextoPedido: (s) => String(s || "").trim()
};

function init(dependencies) {
  deps = { ...deps, ...dependencies };
}

function cfg() {
  const fp = deps.getRestaurante()?.formasPago || {};
  return {
    textoEfectivoTransferencia:
      fp.textoEfectivoTransferencia ||
      "💳 Aceptamos *efectivo* y *transferencia*.",
    textoNoTarjeta:
      fp.textoNoTarjeta ||
      "💳 No manejamos tarjeta; solo *efectivo* y *transferencia* 😊",
    textoNoFactura:
      fp.textoNoFactura ||
      "📄 No facturamos. El pago es *efectivo* o *transferencia*.",
    textoSiTransferencia:
      fp.textoSiTransferencia ||
      "✅ Sí, puedes pagar por *transferencia*. Te mando los datos de cuenta 👇",
    textoTransferenciaPedido:
      fp.textoTransferenciaPedido ||
      "✅ Transfiere y guarda tu comprobante; en un momento el equipo confirma tu pedido 🍕",
    textoPreguntaMetodo:
      fp.textoPreguntaMetodo ||
      "💳 ¿Tu pago será *efectivo* o *transferencia*?",
    textoPreguntaEfectivoMonto:
      fp.textoPreguntaEfectivoMonto ||
      "💵 ¿Con cuánto vas a pagar? (solo el número, ej. 500)",
    textoMetodoNoEntendido:
      fp.textoMetodoNoEntendido ||
      "Responde *efectivo* o *transferencia* 💳",
    textoMontoNoEntendido:
      fp.textoMontoNoEntendido ||
      "Escribe el monto en números (ej. 500 o $500).",
    textoMontoInsuficiente: (total) =>
      fp.textoMontoInsuficiente?.replace("{total}", String(total)) ||
      `El total es *$${total}*. Escribe un monto igual o mayor.`,
    cuentasImagenUrls: Array.isArray(fp.cuentasImagenUrls)
      ? fp.cuentasImagenUrls.filter((u) => String(u || "").trim())
      : []
  };
}

function norm(t) {
  return deps.sinAcentos(deps.normalizarTextoPedido(t));
}

function esConsultaFactura(textoClean) {
  const x = norm(textoClean);
  return /\b(factura|facturan|facturacion|facturar|cfdi|fiscal)\b/.test(x);
}

function esConsultaTarjeta(textoClean) {
  const x = norm(textoClean);
  return /\b(tarjeta|terminal|debito|credito|visa|mastercard|clip)\b/.test(x);
}

function esConsultaTransferenciaPago(textoClean) {
  const x = norm(textoClean);
  return /\b(transferencia|transferir|spei|clabe|deposito|numero de cuenta|datos de cuenta)\b/.test(
    x
  );
}

function esConsultaFormasPagoGeneral(textoClean) {
  const x = norm(textoClean);
  if (esConsultaFactura(textoClean) || esConsultaTarjeta(textoClean)) return false;
  if (esConsultaTransferenciaPago(textoClean)) return false;
  return (
    /\b(formas?\s+de\s+pago|como\s+pago|metodos?\s+de\s+pago)\b/.test(x) ||
    (/\b(efectivo)\b/.test(x) && /\b(aceptan|puedo|pagar|tienen)\b/.test(x))
  );
}

function detectarMetodoPagoEnTexto(textoClean) {
  const x = norm(textoClean);
  if (/\b(transferencia|transferir|spei|clabe|deposito)\b/.test(x)) return "transferencia";
  if (/\b(efectivo|cash|en efectivo)\b/.test(x)) return "efectivo";
  return null;
}

function parseMontoPago(textoClean) {
  const raw = String(textoClean || "");
  const t = norm(raw);
  const m =
    raw.match(/\$\s*(\d{2,5})/) ||
    t.match(/\b(\d{2,5})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 20 || n > 50000) return null;
  return n;
}

function textoResumenPagoEnPedido(estado, total) {
  if (estado?.formaPago === "transferencia") {
    return "💳 Pago: *transferencia*";
  }
  if (estado?.formaPago === "efectivo" && estado.pagoCon != null) {
    const pago = Number(estado.pagoCon) || 0;
    const tot = Number(total) || 0;
    const cambio = Math.max(0, pago - tot);
    return `💵 Pago: *efectivo* — con *$${pago}* — cambio *$${cambio}*`;
  }
  return "";
}

async function enviarImagenesCuentasTransferencia(sock, to) {
  const urls = cfg().cuentasImagenUrls;
  if (!urls.length) return { enviadas: 0 };
  let enviadas = 0;
  for (const url of urls.slice(0, 4)) {
    const ok = await promoImagenes.enviarUnaImagen(sock, to, url, "💳 Cuenta para transferencia");
    if (ok) enviadas++;
    await new Promise((r) => setTimeout(r, 600));
  }
  return { enviadas };
}

/**
 * Preguntas sueltas de pago (no durante paso H/I del pedido).
 * @returns {Promise<null|"__ENVIADO__"|string>}
 */
async function intentarRespuestaConsulta(sock, from, estado, textoClean, sendText) {
  const c = cfg();

  if (esConsultaFactura(textoClean)) {
    await sendText(sock, from, estado, c.textoNoFactura);
    return "__ENVIADO__";
  }

  if (esConsultaTarjeta(textoClean)) {
    await sendText(
      sock,
      from,
      estado,
      `${c.textoNoTarjeta}\n\n${c.textoEfectivoTransferencia}`
    );
    return "__ENVIADO__";
  }

  if (esConsultaTransferenciaPago(textoClean)) {
    await sendText(sock, from, estado, c.textoSiTransferencia);
    await enviarImagenesCuentasTransferencia(sock, from);
    return "__ENVIADO__";
  }

  if (esConsultaFormasPagoGeneral(textoClean)) {
    await sendText(sock, from, estado, c.textoEfectivoTransferencia);
    return "__ENVIADO__";
  }

  return null;
}

module.exports = {
  init,
  cfg,
  esConsultaFactura,
  esConsultaTarjeta,
  esConsultaTransferenciaPago,
  detectarMetodoPagoEnTexto,
  parseMontoPago,
  textoResumenPagoEnPedido,
  enviarImagenesCuentasTransferencia,
  intentarRespuestaConsulta
};
