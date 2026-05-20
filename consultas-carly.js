/**
 * Consultas por alias (typos → acción o FAQ), alimentación gradual vía JSON / Telegram / Firestore.
 */

const ACCIONES = {
  horario: "Horario de atención",
  domicilio: "Servicio a domicilio",
  servicio: "Igual que domicilio",
  pago_formas: "Efectivo y transferencia",
  pago_transferencia: "Sí transferencia + imágenes de cuenta",
  pago_tarjeta: "No tarjeta",
  pago_factura: "No factura",
  promos: "Lista promos del día (+ fotos)",
  combos: "Combos del día (+ fotos)",
  salsas: "Menú de salsas alitas/boneless (+ foto)"
};

let deps = {};
let indiceMem = [];

function init(dependencies) {
  deps = dependencies;
  reconstruirIndice();
}

function listaTriggersCsv(s) {
  return String(s || "")
    .split(",")
    .map((x) => deps.sinAcentos(deps.normalizarTextoPedido(x)))
    .filter(Boolean);
}

function reconstruirIndice() {
  const filas = [];
  const manual = deps.getRestaurante?.()?.consultasAliases || {};
  const cfgManual = deps.getConfig?.()?.consultasAliasesManual || {};
  const aprendidos = deps.getConfig?.()?.consultasAprendidas || {};

  const agregarGrupo = (accion, csv) => {
    const a = String(accion || "").toLowerCase().trim();
    if (!a || !ACCIONES[a]) return;
    for (const frag of listaTriggersCsv(csv)) {
      filas.push({ frag, accion: a, len: frag.length });
    }
  };

  for (const [accion, csv] of Object.entries(manual)) {
    agregarGrupo(accion, csv);
  }
  for (const [accion, csv] of Object.entries(cfgManual)) {
    agregarGrupo(accion, csv);
  }
  for (const [typo, info] of Object.entries(aprendidos)) {
    const accion = String(info?.accion || info?.canonico || "").toLowerCase().trim();
    if (typo && accion && ACCIONES[accion]) {
      filas.push({
        frag: deps.sinAcentos(deps.normalizarTextoPedido(typo)),
        accion,
        len: typo.length
      });
    }
  }

  indiceMem = filas.sort((a, b) => b.len - a.len);
}

function detectarAccion(textoClean) {
  const x = deps.sinAcentos(deps.normalizarTextoPedido(textoClean));
  if (!x) return null;
  for (const row of indiceMem) {
    if (row.frag && x.includes(row.frag)) return row.accion;
  }
  return null;
}

function textoListadoConsultas() {
  const lines = ["*Consultas por alias* (`/consulta add typo → accion`)\n"];
  for (const [k, desc] of Object.entries(ACCIONES)) {
    lines.push(`• \`${k}\` — ${desc}`);
  }
  const n = indiceMem.length;
  lines.push(`\n_${n} fragmentos en índice (JSON + Firestore)._`);
  return lines.join("\n");
}

/**
 * @returns {Promise<null|"__ENVIADO__">}
 */
async function ejecutarAccion(sock, from, estado, accion) {
  const r = deps.getRestaurante?.() || {};

  switch (accion) {
    case "horario": {
      let msg = `🕒 Horario: ${r.horarioTexto || "consulta en tienda"}`;
      if (deps.estaAbiertoEfectivo && !deps.estaAbiertoEfectivo()) {
        msg += "\n⏰ Ahorita estamos *cerrados* según este horario.";
      }
      await deps.sendText(sock, from, estado, msg);
      return "__ENVIADO__";
    }
    case "domicilio":
    case "servicio": {
      const msg = r.servicioDomicilio
        ? r.servicioDomicilioTexto || "Sí hay servicio a domicilio."
        : "Por el momento no tenemos servicio a domicilio.";
      await deps.sendText(sock, from, estado, msg);
      return "__ENVIADO__";
    }
    case "pago_formas":
      await deps.sendText(sock, from, estado, deps.pagoCarly.cfg().textoEfectivoTransferencia);
      return "__ENVIADO__";
    case "pago_transferencia":
      return deps.pagoCarly.intentarRespuestaConsulta(
        sock,
        from,
        estado,
        "aceptan transferencia",
        deps.sendText
      );
    case "pago_tarjeta":
      return deps.pagoCarly.intentarRespuestaConsulta(
        sock,
        from,
        estado,
        "aceptan tarjeta",
        deps.sendText
      );
    case "pago_factura":
      return deps.pagoCarly.intentarRespuestaConsulta(
        sock,
        from,
        estado,
        "facturan",
        deps.sendText
      );
    case "promos":
      await deps.enviarPromosAlCliente(sock, from, estado, deps.obtenerPromosVigentes());
      return "__ENVIADO__";
    case "combos":
      await deps.enviarCombosAlCliente(sock, from, estado);
      return "__ENVIADO__";
    case "salsas":
      await deps.enviarMenuSalsasAlCliente(sock, from, estado);
      return "__ENVIADO__";
    default:
      return null;
  }
}

/**
 * @returns {Promise<null|"__ENVIADO__">}
 */
async function intentarRespuesta(sock, from, estado, textoClean) {
  if (["G", "H", "I"].includes(estado?.pasoPedido)) return null;
  const accion = detectarAccion(textoClean);
  if (!accion) return null;
  return ejecutarAccion(sock, from, estado, accion);
}

module.exports = {
  ACCIONES,
  init,
  reconstruirIndice,
  detectarAccion,
  ejecutarAccion,
  intentarRespuesta,
  textoListadoConsultas,
  listaTriggersCsv
};
