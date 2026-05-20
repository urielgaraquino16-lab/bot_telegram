/**
 * Panel admin por Telegram (polling). No se ejecuta por mensaje de WhatsApp.
 * Firestore solo al cambiar config o al arranque (vía bot-config-store).
 */

const axios = require("axios");

let deps = {};
let pollOffset = 0;
let polling = false;

function parseAdminIds(envVal) {
  return new Set(
    String(envVal || "")
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean)
  );
}

function esAdminTelegram(msg) {
  const userId = String(msg?.from?.id ?? "");
  const chatId = String(msg?.chat?.id ?? "");
  const allowed = deps.adminUserIds;
  if (allowed.size > 0) {
    return allowed.has(userId);
  }
  if (deps.fallbackChatId && chatId === deps.fallbackChatId) return true;
  return false;
}

async function tgApi(method, body = {}) {
  const token = deps.token;
  if (!token) return null;
  try {
    const r = await axios.post(`https://api.telegram.org/bot${token}/${method}`, body, {
      timeout: 35000
    });
    return r.data;
  } catch (err) {
    console.warn(`telegram ${method}:`, err?.response?.data || err?.message);
    return null;
  }
}

async function responderAdmin(chatId, text) {
  await tgApi("sendMessage", {
    chat_id: chatId,
    text: String(text || "").slice(0, 4000),
    disable_web_page_preview: true
  });
}

function textoHelp() {
  return `🛠 *Panel Carly*

*Bot*
/bot — estado global y chats pausados
/bot on — activar para todos
/bot off — pausar para todos (no borra aliases)
/bot on 521234567890 — activar un chat
/bot off 521234567890 — pausar un chat

*Groq*
/groq — estado
/groq on | /groq off

*Horario*
/abierto — estado
/abierto on — forzar abierto
/abierto off — forzar cerrado
/abierto auto — horario del JSON

*Promos*
/promos — vigentes hoy
/promo — promo destacada (panel)
/promo off — quitar destacada
/promo set Título | Texto del cliente

*Aliases*
/alias — listar aprendidos + manuales
/alias add typo → canonico
/alias del typo
/alias manual typo → canonico (ingredientAliases)

*Otros*
/status — resumen
/nota — ver instrucciones extra para Carly
/nota texto — personalidad o reglas (Firestore, sin código)

/help — esta ayuda`;
}

function parsePromoSetArgs(rest) {
  const s = String(rest || "").trim();
  const pipe = s.indexOf("|");
  if (pipe >= 0) {
    return {
      titulo: s.slice(0, pipe).trim(),
      textoCliente: s.slice(pipe + 1).trim()
    };
  }
  return { titulo: s.slice(0, 80) || "Promo destacada", textoCliente: s };
}

async function manejarComando(texto, chatId) {
  const line = String(texto || "").trim();
  const low = line.toLowerCase();
  const cfg = deps.getConfig();

  if (low === "/help" || low === "/start" || low === "/panel") {
    return textoHelp();
  }

  if (low === "/status") {
    return deps.textoStatus();
  }

  if (low === "/groq" || low === "/groq status") {
    return deps.textoGroqStatus();
  }
  if (low === "/groq on") {
    await deps.setConfig({ groqActivo: true });
    return "✅ Groq *activado* (sigue hace falta GROQ_API_KEY en el servidor).";
  }
  if (low === "/groq off") {
    await deps.setConfig({ groqActivo: false });
    return "✅ Groq *desactivado*. Carly usará solo respuestas locales + escalamiento.";
  }

  if (low === "/bot" || low === "/bot status") {
    return deps.textoBotStatus();
  }
  if (low === "/bot on") {
    await deps.setConfig({ botActivoGlobal: true });
    return "✅ Bot *activo* para todos los chats (salvo los pausados uno a uno).";
  }
  if (low === "/bot off") {
    await deps.setConfig({ botActivoGlobal: false });
    return "⏸ Bot *pausado* globalmente. Los clientes verán mensaje corto. Config guardada en Firestore.";
  }
  const mBotChat = line.match(/^\/bot\s+(on|off)\s+(\d[\d\s]{8,14})/i);
  if (mBotChat) {
    const jid = deps.resolverJid(mBotChat[2]);
    const chats = { ...(cfg.chatsDesactivados || {}) };
    if (mBotChat[1].toLowerCase() === "off") {
      chats[jid] = true;
      await deps.setConfig({ chatsDesactivados: chats });
      return `⏸ Chat pausado: *${mBotChat[2].trim()}*\n${jid}`;
    }
    delete chats[jid];
    await deps.setConfig({ chatsDesactivados: chats });
    if (deps.reactivarChat) deps.reactivarChat(jid);
    return `✅ Chat reactivado: *${mBotChat[2].trim()}*`;
  }

  if (low === "/abierto" || low === "/abierto status") {
    return deps.textoAbiertoStatus();
  }
  if (low === "/abierto on") {
    await deps.setConfig({ overrideAbierto: true });
    return "✅ Negocio marcado como *ABIERTO* (override manual).";
  }
  if (low === "/abierto off") {
    await deps.setConfig({ overrideAbierto: false });
    return "🔒 Negocio marcado como *CERRADO* (override manual).";
  }
  if (low === "/abierto auto") {
    await deps.setConfig({ overrideAbierto: null });
    return "🕒 Horario vuelve a *automático* (restaurant.json).";
  }

  if (low === "/promos") {
    return deps.textoPromosHoy();
  }
  if (low === "/promo" || low === "/promo status") {
    const p = cfg.promoDestacada;
    if (!p?.activa) return "ℹ️ No hay promo destacada del panel. Usa:\n/promo set Título | Texto";
    return `🔥 *Promo destacada*\n*${p.titulo || "Promo"}*\n${p.textoCliente || ""}`;
  }
  if (low === "/promo off") {
    await deps.setConfig({ promoDestacada: null });
    return "✅ Promo destacada desactivada.";
  }
  const mPromo = line.match(/^\/promo\s+set\s+(.+)$/i);
  if (mPromo) {
    const { titulo, textoCliente } = parsePromoSetArgs(mPromo[1]);
    await deps.setConfig({
      promoDestacada: {
        activa: true,
        id: "panel_destacada",
        titulo,
        textoCliente,
        diasSemana: [0, 1, 2, 3, 4, 5, 6]
      }
    });
    return `✅ Promo destacada guardada:\n*${titulo}*\n${textoCliente}`;
  }

  if (low === "/nota" || low === "/nota status") {
    const n = String(cfg.instruccionesCarly || "").trim();
    return n
      ? `📝 *Instrucciones Carly:*\n${n}`
      : "📝 Sin instrucciones extra. Usa:\n/nota Eres breve y siempre ofrece promos del día";
  }
  const mNota = line.match(/^\/nota\s+(.+)$/i);
  if (mNota) {
    await deps.setConfig({ instruccionesCarly: mNota[1].trim() });
    return "✅ Instrucciones guardadas (Groq lite las usará, sin tocar el menú).";
  }

  if (low === "/alias" || low === "/alias list") {
    return deps.textoAliasList();
  }
  const mAdd = line.match(/^\/alias\s+add\s+(.+?)\s*→\s*(.+)$/i);
  if (mAdd) {
    return deps.aliasAddAprendido(mAdd[1].trim(), mAdd[2].trim());
  }
  const mMan = line.match(/^\/alias\s+manual\s+(.+?)\s*→\s*(.+)$/i);
  if (mMan) {
    return deps.aliasAddManual(mMan[1].trim(), mMan[2].trim());
  }
  const mDel = line.match(/^\/alias\s+del\s+(.+)$/i);
  if (mDel) {
    return deps.aliasDel(mDel[1].trim());
  }

  return "❓ Comando no reconocido. Escribe /help";
}

async function procesarUpdate(update) {
  const msg = update?.message;
  if (!msg?.text) return;
  if (!esAdminTelegram(msg)) {
    if (String(msg.text).startsWith("/")) {
      await responderAdmin(msg.chat.id, "⛔ No autorizado para este panel.");
    }
    return;
  }
  const reply = await manejarComando(msg.text, msg.chat.id);
  if (reply) await responderAdmin(msg.chat.id, reply);
}

async function loopPolling() {
  if (!deps.token || polling) return;
  polling = true;
  console.log("📲 Panel Telegram activo (polling)");

  while (polling) {
    try {
      const r = await axios.get(`https://api.telegram.org/bot${deps.token}/getUpdates`, {
        params: { offset: pollOffset, timeout: 25 },
        timeout: 35000
      });
      const updates = r.data?.result || [];
      for (const u of updates) {
        pollOffset = Math.max(pollOffset, (u.update_id || 0) + 1);
        await procesarUpdate(u);
      }
    } catch (err) {
      console.warn("telegram poll:", err?.message || err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function start(dependencies) {
  deps = dependencies;
  if (!deps.token) {
    console.log("📲 Panel Telegram: sin TELEGRAM_BOT_TOKEN");
    return;
  }
  if (deps.enabled === false) {
    console.log("📲 Panel Telegram desactivado (TELEGRAM_PANEL=0)");
    return;
  }
  loopPolling().catch((err) => console.error("telegram panel:", err));
}

function stop() {
  polling = false;
}

module.exports = { start, stop, manejarComando, esAdminTelegram };
