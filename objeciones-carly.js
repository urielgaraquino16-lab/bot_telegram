/**
 * Detección corta de objeciones / contradicciones de precio (sin IA).
 */

function esObjecionPrecioContradiccion(textoClean, sinAcentos, normalizarTextoPedido) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return (
    /(pero\s+me\s+dijiste|no\s+era|hab[ií]as\s+dicho|antes\s+dijiste|pens[eé]\s+que|seg[uú]n\s+(t[uú]|lo)|me\s+cobr|dijiste\s+que|eso\s+no\s+era|no\s+me\s+cuadra)/.test(
      x
    ) || /\b(215|220|250|300|350)\b/.test(x) && /(pero|no|dijiste|era)/.test(x)
  );
}

function extraerMontoEnTexto(textoClean) {
  const m = String(textoClean || "").match(/\$?\s*(\d{2,4})\b/);
  return m ? Number.parseInt(m[1], 10) : null;
}

function intentarRespuestaObjecion(estado, textoClean, deps) {
  if (!esObjecionPrecioContradiccion(textoClean, deps.sinAcentos, deps.normalizarTextoPedido)) {
    return null;
  }

  const rec = estado.precioConsultaReciente;
  const monto = extraerMontoEnTexto(textoClean);
  const { total } = deps.subtotalesPedidoActuales(estado) || { total: 0 };
  const cap = deps.capitalizar;

  let msg = "😊 ";

  if (rec?.precio != null) {
    const nom = cap(rec.sabor || "pizza");
    const tam = rec.tamano ? ` ${rec.tamano}` : "";
    if (monto != null && monto === rec.precio) {
      msg += `Los *$${rec.precio}* eran solo la pizza *${nom}*${tam}.`;
    } else if (monto != null) {
      msg += `Te había dicho *$${rec.precio}* por *${nom}*${tam}.`;
      if (total > rec.precio) msg += ` Con todo el pedido el total es *$${total}*.`;
    } else {
      msg += `El precio *$${rec.precio}* era para *${nom}*${tam}.`;
      if (total > rec.precio) msg += ` Con complementos el total va en *$${total}*.`;
    }
  } else if (monto != null && total > 0) {
    if (total !== monto) {
      msg += `El *$${monto}* puede ser solo parte del pedido; el total con todo es *$${total}*.`;
    } else {
      msg += `El total del pedido sigue en *$${total}*.`;
    }
  } else if (total > 0) {
    msg += `Tu pedido va en *$${total}* con lo que llevas anotado.`;
  } else {
    msg += `Te aclaro el precio: dime qué producto quieres revisar (ej. *hawaiana grande*).`;
  }

  msg += " 🍕";
  if (deps.botLogger?.objecion) {
    deps.botLogger.objecion("contradiccion_precio", {
      monto,
      reciente: rec?.precio,
      total
    });
  }
  return msg;
}

module.exports = {
  esObjecionPrecioContradiccion,
  intentarRespuestaObjecion
};
