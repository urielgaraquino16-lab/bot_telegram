/**
 * Groq "lite" — prompt corto, hechos calculados en local, sin menú completo.
 */

let deps = {};

function init(dependencies) {
  deps = dependencies;
}

function construirSystemPromptLite(estado) {
  const nom = deps.getRestaurante?.()?.nombreNegocio || "Pizzas Carly";
  const extra = String(deps.getConfig?.()?.instruccionesCarly || "").trim();
  const extraBlock = extra ? `\nNOTA DEL DUEÑO (prioridad):\n${extra}\n` : "";

  return `Eres Carly, IA especializada SOLO en ${nom} (pizzería por WhatsApp).
No eres ChatGPT genérico: solo pedidos, menú, promos, horario y dudas del restaurante.
Tono: cálido, claro, breve (máx 3–4 líneas), 2–3 emojis 🍕😊
${extraBlock}
REGLAS ESTRICTAS:
- Los precios y totales vienen SOLO de HECHOS_VERIFICADOS abajo. Nunca inventes números.
- Si falta sabor para dar precio, pide UN solo dato (el sabor).
- Una pregunta a la vez. Simplifica al cliente, no lo confundas.
- Fuera del restaurante: redirige amable al pedido.
- Queja fuerte, reembolso, alergia grave: responde exactamente ESCALAR
- Paso G confirmación: si ya hay resumen, recuerda responder SÍ para pasar con el equipo.
- No listes todo el menú; menciona 2–3 sabores de ejemplo si hace falta.`;
}

function construirMensajeUsuarioLite(pregunta, hechos, estado) {
  const paso = estado?.pasoPedido
    ? `Paso actual: ${estado.pasoPedido} (${deps.etiquetaPasoPedido?.(estado.pasoPedido) || estado.pasoPedido})`
    : "Sin pedido iniciado";

  const bloqueHechos = (hechos || []).filter(Boolean).join("\n");

  return `${paso}

HECHOS_VERIFICADOS (obligatorio usar para precios y datos):
${bloqueHechos || "(sin hechos extra)"}

MENSAJE_DEL_CLIENTE:
${String(pregunta || "").trim() || "hola"}

Redacta la respuesta final para WhatsApp.`;
}

async function completar({
  groqClient,
  model,
  estado,
  pregunta,
  hechos,
  timeoutMs,
  timeoutSentinel
}) {
  const system = construirSystemPromptLite(estado);
  if (!Array.isArray(estado.historialGroq)) estado.historialGroq = [];
  const historial = estado.historialGroq.slice(-4);

  const messages = [{ role: "system", content: system }];
  for (const turn of historial) messages.push(turn);
  messages.push({
    role: "user",
    content: construirMensajeUsuarioLite(pregunta, hechos, estado)
  });

  let timeoutHandle;
  const timeoutPromise = new Promise((resolve) => {
    timeoutHandle = setTimeout(() => resolve(timeoutSentinel), timeoutMs);
  });

  const apiPromise = (async () => {
    const completion = await groqClient.chat.completions.create({
      model,
      messages,
      temperature: 0.45,
      max_tokens: 200
    });
    const text = String(completion?.choices?.[0]?.message?.content || "").trim();
    return text || "ESCALAR";
  })();

  const respuesta = await Promise.race([apiPromise, timeoutPromise]);
  clearTimeout(timeoutHandle);
  return respuesta;
}

module.exports = {
  init,
  construirSystemPromptLite,
  construirMensajeUsuarioLite,
  completar
};
