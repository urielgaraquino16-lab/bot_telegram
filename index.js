console.log("🔥 Bot iniciando...");

const QRCode = require("qrcode");
let ultimoQR = null;


const {
  default: makeWASocket,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");

const express = require("express");
const PORT = process.env.PORT || 3000;

// Opcional: número de WhatsApp del asesor/admin para alertas.
// Ejemplo: "5212838746081@s.whatsapp.net"
const NUMERO_ADMIN = process.env.NUMERO_ADMIN || "";

const fs = require("fs");
const axios = require("axios");

const XLSX = require("xlsx");
const fsp = fs.promises;
const fuzzyCarly = require("./fuzzy-carly");

// Firestore (opcional). Si falta clave.json o falla la inicialización, el bot
// sigue funcionando con persistencia local.
let firestore = null;
try {
  ({ firestore } = require("./firebase"));
} catch (err) {
  firestore = null;
  console.warn("Firestore no disponible, usando persistencia local. Detalle:", err?.message || err);
}
// 🤖 Groq (LLM). En package.json la dependencia se llama `groq` y apunta a groq-sdk (npm alias).
let GroqCtor = null;
try {
  GroqCtor = require("groq").Groq;
} catch {
  GroqCtor = null;
}

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL_NAME = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const MODO_HUMANO_TTL_MS = 30 * 60 * 1000;
const MENSAJE_FUERA_HORARIO =
  "😊 Hola! Estamos cerrados por el momento.\nAbrimos todos los días a las 12:00 PM.\n¡Te esperamos mañana! 🍕";
const MENSAJE_REACTIVACION_BOT =
  "😊 Hola de nuevo, soy Carly.\n¿Te puedo ayudar con algo? 🍕";
const PROCESANDO_MAX_MS = 45000;
const MENSAJE_PASO_A_HUMANO =
  "🙌 ¡Perfecto! Ya te paso con alguien del equipo para cerrar tu pedido.\nEn un momentito te escriben 👋🍕";

const USE_GROQ = !!(GroqCtor && GROQ_API_KEY);
const groqClient = USE_GROQ ? new GroqCtor({ apiKey: GROQ_API_KEY }) : null;
if (USE_GROQ) {
  console.log(`🤖 Groq activo (modelo: ${GROQ_MODEL_NAME})`);
} else {
  console.log("🤖 Groq inactivo (configura GROQ_API_KEY e instala el paquete groq)");
}

process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});




// 💲 PRECIOS (Google Sheet debe estar compartido: "Cualquier persona con el enlace")
const SHEET_ID = "1eFn39-QsH7IFjIneniztsV9MCyX1_Gdv3yhYMVVku4A";
const MENU_SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?usp=sharing`;

// Caché de 10 minutos para evitar pegarle a Google Sheets en cada arranque/recarga.
const SHEETS_CACHE_TTL_MS = 10 * 60 * 1000;
const sheetsCache = new Map();

function urlGoogleSheetGviz(sheetName) {
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
}

function valorCeldaGviz(cell) {
  if (cell == null) return "";
  if (cell.v === null || cell.v === undefined) return "";
  return cell.v;
}

/** Extrae JSON puro de la respuesta gviz (comentario O_o + setResponse). */
function extraerJsonDeRespuestaGviz(texto) {
  let s = String(texto ?? "").trim();
  s = s.replace(/^\/\*[\s\S]*?\*\/\s*/g, "");
  const marker = "google.visualization.Query.setResponse(";
  const idx = s.indexOf(marker);
  if (idx >= 0) {
    s = s.slice(idx + marker.length);
  } else {
    const idx2 = s.indexOf("setResponse(");
    if (idx2 >= 0) s = s.slice(idx2 + "setResponse(".length);
  }
  if (s.endsWith(");")) {
    s = s.slice(0, -2);
  } else if (s.endsWith(")")) {
    s = s.slice(0, -1);
  }
  return s.trim();
}

/**
 * Parsea respuesta gviz/tq. La primera fila de table.rows son headers (c[0].v, c[1].v…);
 * las siguientes filas son datos.
 */
function parsearRespuestaGvizJson(texto) {
  const jsonText = extraerJsonDeRespuestaGviz(texto);
  const payload = JSON.parse(jsonText);

  if (payload.status === "error") {
    const msg =
      payload.errors?.[0]?.detailed_message ||
      payload.errors?.[0]?.message ||
      "Error gviz";
    throw new Error(msg);
  }

  const table = payload.table;
  const allRows = table?.rows;
  if (!Array.isArray(allRows) || allRows.length === 0) return [];

  const headerCells = allRows[0]?.c || [];
  const headers = headerCells.map((cell, i) => {
    const fromCell = String(valorCeldaGviz(cell) || "")
      .toLowerCase()
      .trim();
    if (fromCell) return fromCell;
    const fromCol = table.cols?.[i];
    return String(fromCol?.label ?? fromCol?.id ?? `col${i}`)
      .toLowerCase()
      .trim();
  });

  const dataRows = allRows.slice(1);
  return dataRows.map((row) => {
    const obj = {};
    (row.c || []).forEach((cell, i) => {
      const key = headers[i] || `col${i}`;
      obj[key] = valorCeldaGviz(cell);
    });
    return obj;
  });
}

async function obtenerFilasDeHojaGoogleSheetsGviz(sheetName) {
  const cacheKey = `gviz:${sheetName}`;
  const cached = sheetsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SHEETS_CACHE_TTL_MS) {
    return cached.rows;
  }
  const url = urlGoogleSheetGviz(sheetName);
  const response = await axios.get(url, { responseType: "text" });
  const rows = parsearRespuestaGvizJson(response.data);
  sheetsCache.set(cacheKey, { at: Date.now(), rows });
  return rows;
}

function normalizarFilaGoogleSheet(row) {
  const out = {};
  if (!row || typeof row !== "object") return out;
  for (const [k, v] of Object.entries(row)) {
    out[String(k).toLowerCase().trim()] = v;
  }
  return out;
}

/** Lee una hoja por nombre vía gviz (menu, descripciones, complementos, bebida). */
async function obtenerFilasDeHojaGoogleSheets(sheetName) {
  return obtenerFilasDeHojaGoogleSheetsGviz(sheetName);
}

async function obtenerDatosMenuGoogleSheets() {
  return obtenerFilasDeHojaGoogleSheetsGviz("menu");
}

async function cargarMenu() {
  try {
    const data = await obtenerDatosMenuGoogleSheets();
    const menu = {};

    data.forEach((row) => {
      const r = normalizarFilaGoogleSheet(row);
      const pizza =
        r.pizza != null ? String(r.pizza).toLowerCase().trim() : "";
      const tamanoRaw = r.tamaño ?? r.tamano ?? r["tamaño"];
      const tamaño =
        tamanoRaw != null ? String(tamanoRaw).toLowerCase().trim() : "";
      const precio = Number(r.precio);
      if (!pizza || !tamaño || Number.isNaN(precio)) return;

      if (!menu[pizza]) {
        menu[pizza] = {};
      }

      menu[pizza][tamaño] = precio;
    });

    return menu;
  } catch (err) {
    console.warn("⚠️ cargarMenu error:", err?.message || err);
    return {};
  }
}

let menu = {};

// 🔄 Auto-recarga de Excel cuando cambie
let complementosItems = [];
let complementosMenu = {};
let bebidasItems = [];
let bebidasMenu = {};
let descripcionesMap = {};
let ultimoChequeoArchivosAt = 0;
const FILE_CHECK_INTERVAL_MS = 1500;

// ⚙️ Config replicable por restaurante (FAQ, horario, extras, escalamiento)
let restauranteMtimeMs = 0;

// Cachés de detección para evitar sort/normalización repetida en cada mensaje
const detectCache = {
  pizzasOrdenadas: [],
  pizzasNorm: [],
  aliasIngredientes: [],
  complementosOrdenados: [],
  bebidasOrdenadas: []
};

function rebuildDetectCache() {
  const pizzas = Object.keys(menu || {}).sort(
    (a, b) => (b?.length || 0) - (a?.length || 0)
  );
  detectCache.pizzasOrdenadas = pizzas;
  detectCache.pizzasNorm = pizzas.map((p) => ({
    raw: p,
    norm: sinAcentos(normalizarTextoPedido(p))
  }));

  const aliases = restaurante?.ingredientAliases || {};
  const aliasRows = [];
  for (const [canonical, words] of Object.entries(aliases)) {
    if (!menu?.[canonical]) continue;
    String(words)
      .split(",")
      .map((x) => sinAcentos(normalizarTextoPedido(x)))
      .filter(Boolean)
      .forEach((w) => aliasRows.push({ canonical, alias: w }));
  }
  detectCache.aliasIngredientes = aliasRows;

  detectCache.complementosOrdenados = [...(complementosItems || [])].sort(
    (a, b) => (b?.nombre?.length || 0) - (a?.nombre?.length || 0)
  );
  detectCache.bebidasOrdenadas = [...(bebidasItems || [])].sort(
    (a, b) => (b?.nombre?.length || 0) - (a?.nombre?.length || 0)
  );
}

function defaultRestaurante() {
  return {
    nombreNegocio: "Restaurante",
    horarioTexto: "Consulta horario con el negocio.",
    horarioAbierto: null,
    servicioDomicilio: true,
    servicioDomicilioTexto: "Sí tenemos servicio a domicilio (confirmar zona con el repartidor).",
    promocionesTexto: "Pregunta promociones del día.",
    combosTexto: "Tenemos combos según disponibilidad.",
    mitadMitad: {
      permitido: true,
      notaPrecio: "Mitad y mitad se cobra al precio del sabor más caro en ese tamaño."
    },
    rebanadasPorTamano: {
      mediana: 8,
      grande: 10,
      familiar: 12,
      jumbo: 20,
      mega: 40
    },
    ingredientAliases: {},
    faqs: [],
    extras: [],
    alitasBonelessSalsas: {
      aplicaA: "alitas, boneless",
      precioExtraMitadMitad: 0,
      lista: []
    },
    escalamientoHumano: { triggers: "" },
    alitasBonelessComplejo: { triggers: "" },
    promociones: [],
    upsell: {
      alConfirmarPizza: {
        activo: true,
        texto:
          "\n\n🍟 ¿Llevas *complementos* o 🥤 *bebidas*? Menú opción *4* o escribe lo que quieras agregar."
      }
    },
    recordatorioRefrescoGratis: {
      activo: true,
      diasSemana: [3], // 0=domingo ... 3=miércoles ... 6=sábado
      tamanosConRefresco: ["grande", "familiar", "jumbo", "mega"],
      mensajeCliente:
        "🥤 *Recuerda:* tu pizza *grande o mayor incluye refresco GRATIS*, _recuerda no aplica con otras promociones_.",
      mensajeSiNoHayTamano:
        "🥤 Si pediste pizza *grande o mayor*, puede aplicar *refresco gratis* según promo. *Conserva este chat* por si hace falta aclararlo en entrega."
    },
    aliasesAprendidos: {},
    fuzzy: { umbralAlto: 0.88, umbralMedio: 0.72, minVecesSiParaAviso: 5 }
  };
}

function cargarRestaurante() {
  try {
    const raw = fs.readFileSync("restaurant.json", "utf8");
    const parsed = JSON.parse(raw);
    const def = defaultRestaurante();
    return {
      ...def,
      ...parsed,
      mitadMitad: { ...def.mitadMitad, ...(parsed.mitadMitad || {}) },
      rebanadasPorTamano: {
        ...def.rebanadasPorTamano,
        ...(parsed.rebanadasPorTamano || {})
      },
      escalamientoHumano: {
        ...def.escalamientoHumano,
        ...(parsed.escalamientoHumano || {})
      },
      alitasBonelessComplejo: {
        ...def.alitasBonelessComplejo,
        ...(parsed.alitasBonelessComplejo || {})
      },
      alitasBonelessSalsas: {
        ...def.alitasBonelessSalsas,
        ...(parsed.alitasBonelessSalsas || {}),
        lista: parsed.alitasBonelessSalsas?.lista?.length
          ? parsed.alitasBonelessSalsas.lista
          : def.alitasBonelessSalsas.lista
      },
      promociones: Array.isArray(parsed.promociones)
        ? parsed.promociones
        : def.promociones,
      upsell: { ...def.upsell, ...(parsed.upsell || {}) },
      recordatorioRefrescoGratis: {
        ...def.recordatorioRefrescoGratis,
        ...(parsed.recordatorioRefrescoGratis || {})
      },
      aliasesAprendidos: {
        ...def.aliasesAprendidos,
        ...(parsed.aliasesAprendidos || {})
      },
      fuzzy: { ...def.fuzzy, ...(parsed.fuzzy || {}) }
    };
  } catch {
    return defaultRestaurante();
  }
}

let restaurante = cargarRestaurante();

function inicializarRestauranteCache() {
  try {
    const st = fs.statSync("restaurant.json");
    restauranteMtimeMs = st.mtimeMs || 0;
  } catch {
    restauranteMtimeMs = 0;
  }
}

async function recargarArchivosSiCambioThrottled() {
  const now = Date.now();
  if (now - ultimoChequeoArchivosAt < FILE_CHECK_INTERVAL_MS) return;
  ultimoChequeoArchivosAt = now;
  await recargarRestauranteSiCambioAsync();
}

async function recargarRestauranteSiCambioAsync() {
  try {
    const st = await fsp.stat("restaurant.json");
    const mtimeMs = st.mtimeMs || 0;
    if (mtimeMs && mtimeMs !== restauranteMtimeMs) {
      restauranteMtimeMs = mtimeMs;
      restaurante = cargarRestaurante();
      rebuildDetectCache();
      if (typeof initFuzzyCarly === "function") initFuzzyCarly();
      console.log("✅ restaurant.json recargado");
    }
  } catch {
    // ignorar
  }
}

function sinAcentos(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

// Ignorar chats que no son clientes (historias, newsletters, grupos, etc.)
function esJidSistema(remoteJid) {
  if (!remoteJid || typeof remoteJid !== "string") return true;
  const j = remoteJid.toLowerCase();
  if (j.endsWith("@g.us")) return true;
  if (j === "status@broadcast") return true;
  if (j.endsWith("@newsletter")) return true;
  if (j === "broadcast") return true;
  return false;
}

/** Solo procesar chats individuales, no grupos ni otros JIDs. */
function esChatIndividual(remoteJid) {
  if (!remoteJid || typeof remoteJid !== "string") return false;
  const j = remoteJid.toLowerCase();
  return j.endsWith("@s.whatsapp.net") || j.endsWith("@lid");
}

// Texto legible para Telegram / logs (+52..., grupo, etc.)
function etiquetaCliente(msg) {
  const from = msg.key?.remoteJid;
  if (!from) return "?";
  if (from.endsWith("@s.whatsapp.net")) {
    return `+${from.replace(/@s\.whatsapp\.net$/i, "")}`;
  }
  if (from.endsWith("@g.us")) {
    const part =
      msg.key?.participant ||
      msg.message?.extendedTextMessage?.contextInfo?.participant ||
      "";
    const who = part
      ? part.replace(/@s\.whatsapp\.net$/i, "")
      : "?";
    return `Grupo (${from}) de +${who}`;
  }
  if (from.endsWith("@lid")) return `LID ${from}`;
  return from;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

function capitalizar(s) {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// 🍟 COMPLEMENTOS (desde Google Sheets, hoja "complementos")
async function cargarComplementos() {
  const fallbackItems = [
    { nombre: "papas", precio: 50 },
    { nombre: "alitas", precio: 90 },
    { nombre: "boneless", precio: 100 }
  ];

  const fallback = () => {
    const menuFallback = {};
    fallbackItems.forEach((c) => (menuFallback[c.nombre] = c.precio));
    return { items: fallbackItems, menu: menuFallback };
  };

  try {
    const data = await obtenerFilasDeHojaGoogleSheetsGviz("complementos");
    const items = [];
    const menu = {};

    data.forEach((row) => {
      const r = normalizarFilaGoogleSheet(row);
      const rawNombre =
        r.complementos ?? r.complemento ?? r.nombre ?? r.item;
      const rawPrecio = r.precio;
      if (rawNombre == null) return;

      const nombre = String(rawNombre).toLowerCase().trim();
      const precio = Number(rawPrecio);
      if (!nombre || Number.isNaN(precio)) return;

      items.push({ nombre, precio });
      menu[nombre] = precio;
    });

    if (items.length === 0) return fallback();
    return { items, menu };
  } catch {
    return fallback();
  }
}

function textoListaComplementos() {
  return complementosItems
    .map((c, idx) => `${idx + 1}️⃣ ${capitalizar(c.nombre)} - $${c.precio}`)
    .join("  \n");
}

async function cargarBebidas() {
  const fallback = { items: [], menu: {} };
  try {
    const data = await obtenerFilasDeHojaGoogleSheetsGviz("bebida");
    const items = [];
    const menuMap = {};
    data.forEach((row) => {
      const r = normalizarFilaGoogleSheet(row);
      const rawNombre =
        r.bebidas ?? r.bebida ?? r.nombre ?? r.item;
      const rawPrecio = r.precio;
      if (rawNombre == null) return;
      const nombre = String(rawNombre).toLowerCase().trim();
      const precio = Number(rawPrecio);
      if (!nombre || Number.isNaN(precio)) return;
      items.push({ nombre, precio });
      menuMap[nombre] = precio;
    });
    return items.length ? { items, menu: menuMap } : fallback;
  } catch {
    return fallback;
  }
}

async function cargarDescripciones() {
  const map = {};
  const sheetName = "descripciones";
  const gvizUrl = urlGoogleSheetGviz(sheetName);

  console.log("📋 cargarDescripciones — SHEET_ID:", SHEET_ID);
  console.log("📋 cargarDescripciones — hoja:", sheetName);
  console.log("📋 cargarDescripciones — URL (gviz):", gvizUrl);

  try {
    const data = await obtenerFilasDeHojaGoogleSheetsGviz(sheetName);

    console.log(
      "📋 cargarDescripciones — datos crudos (pizza / descripcion):",
      JSON.stringify(data, null, 2)
    );

    let omitidasSinTexto = 0;
    data.forEach((row, idx) => {
      const r = normalizarFilaGoogleSheet(row);
      const pk =
        r.pizza != null && String(r.pizza).trim()
          ? String(r.pizza).toLowerCase().trim()
          : "";
      if (!pk) {
        console.warn(
          `📋 cargarDescripciones — fila ${idx + 1} sin columna pizza:`,
          row
        );
        return;
      }

      const descripcion =
        r.descripcion != null ? String(r.descripcion).trim() : "";
      const ingredientesTexto =
        r.ingredientestexto != null
          ? String(r.ingredientestexto).trim()
          : r.ingredientes != null
            ? String(r.ingredientes).trim()
            : descripcion;

      if (!descripcion && !ingredientesTexto) {
        omitidasSinTexto++;
        console.warn(
          `📋 cargarDescripciones — fila ${idx + 1} (${pk}) sin descripcion:`,
          r
        );
        return;
      }

      map[pk] = {
        descripcion,
        ingredientesTexto: ingredientesTexto || descripcion
      };
    });

    console.log(
      "📋 cargarDescripciones — resultado final mapa:",
      JSON.stringify(map, null, 2)
    );
    console.log(
      `📋 cargarDescripciones — resumen: ${Object.keys(map).length} pizzas, ${data.length} filas, ${omitidasSinTexto} omitidas sin texto`
    );
  } catch (err) {
    console.error("❌ cargarDescripciones — error al leer Google Sheets:", err?.message || err);
    if (err?.response) {
      console.error(
        "❌ cargarDescripciones — respuesta HTTP:",
        err.response.status,
        String(err.response.data ?? "").slice(0, 500)
      );
    }
    if (err?.stack) console.error(err.stack);
  }

  return map;
}

function textoListaComplementosYBebidas() {
  const c = textoListaComplementos();
  if (!bebidasItems.length) return c;
  const offset = complementosItems.length;
  const b = bebidasItems
    .map(
      (x, idx) =>
        `${offset + idx + 1}️⃣ ${capitalizar(x.nombre)} - $${x.precio}`
    )
    .join("  \n");
  return `${c}\n\n🥤 *BEBIDAS*\n${b}`;
}

function obtenerBebidaPorNombreEnTexto(textoClean) {
  const itemsOrdenados = detectCache.bebidasOrdenadas;
  const t = normalizarTextoPedido(textoClean);
  for (const it of itemsOrdenados) {
    const n = normalizarTextoPedido(it.nombre);
    if (n && t.includes(n)) return it.nombre;
  }
  return null;
}

function resolverItemCatalogoPorNumeroONombre(textoClean) {
  const n = Number.parseInt(String(textoClean).trim(), 10);
  if (!Number.isNaN(n) && n >= 1) {
    if (n <= complementosItems.length) {
      return { tipo: "comp", nombre: complementosItems[n - 1]?.nombre };
    }
    const bi = n - complementosItems.length - 1;
    if (bi >= 0 && bi < bebidasItems.length) {
      return { tipo: "bebida", nombre: bebidasItems[bi].nombre };
    }
  }
  const bd = obtenerBebidaPorNombreEnTexto(textoClean);
  if (bd) return { tipo: "bebida", nombre: bd };
  const comp = obtenerComplementoPorEntrada(textoClean);
  if (comp) return { tipo: "comp", nombre: comp };
  return null;
}

function totalYResumenBebidas(estado) {
  if (!Array.isArray(estado.lineasBebida) || estado.lineasBebida.length === 0) {
    return { total: 0, resumen: "" };
  }
  let total = 0;
  const partes = estado.lineasBebida.map((L) => {
    const base = Number(bebidasMenu[L.nombre] || 0);
    const sub = L.cantidad * base;
    total += sub;
    return `${L.nombre} x${L.cantidad}`;
  });
  return { total, resumen: partes.join(", ") };
}

function totalesComplementosYBebidas(estado) {
  const c = totalYResumenComplementos(estado);
  const b = totalYResumenBebidas(estado);
  return {
    total: c.total + b.total,
    resumen: [c.resumen, b.resumen].filter(Boolean).join(" | "),
    soloComp: c,
    soloBeb: b
  };
}

function complementoNombreCoincideUsuario(tNormalizado, nombreCatalogo) {
  const t = tNormalizado;
  const n = nombreCatalogo;
  if (!t || !n) return false;
  if (t.includes(n)) return true;
  if (t.length < 3) return false;
  return n.includes(t);
}

function obtenerComplementoPorEntrada(textoClean) {
  // por número
  const n = Number.parseInt(textoClean, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= complementosItems.length) {
    return complementosItems[n - 1]?.nombre || null;
  }

  const t = normalizarTextoPedido(textoClean);
  if (!t) return null;
  const ordenados = detectCache.complementosOrdenados;
  for (const c of ordenados) {
    const cn = normalizarTextoPedido(c.nombre);
    if (complementoNombreCoincideUsuario(t, cn)) return c.nombre;
  }
  return null;
}

function complementoRequiereSalsa(nombreComplemento) {
  const n = sinAcentos(normalizarTextoPedido(nombreComplemento));
  const lista = restaurante.alitasBonelessSalsas?.lista;
  if (!Array.isArray(lista) || lista.length === 0) return false;
  const raw = restaurante.alitasBonelessSalsas.aplicaA || "";
  const keys = raw
    .split(",")
    .map((x) => sinAcentos(x.trim()))
    .filter(Boolean);
  return keys.some((k) => k && n.includes(k));
}

/** Saca del mapa complementos un ítem que requiera salsa y aún no tenga línea en lineasComplemento. */
function extraerPrimeroComplementoQueRequiereSalsa(estado) {
  for (const [nom, cant] of Object.entries(estado.complementos || {})) {
    const c = Number(cant) || 0;
    if (c < 1) continue;
    if (!complementoRequiereSalsa(nom)) continue;
    const ya = (estado.lineasComplemento || []).some((L) => L.nombre === nom);
    if (ya) continue;
    delete estado.complementos[nom];
    return { nombre: nom, cantidad: c };
  }
  return null;
}

function textoMenuSalsasAlitas() {
  const lista = restaurante.alitasBonelessSalsas?.lista || [];
  const extra = Number(restaurante.alitasBonelessSalsas?.precioExtraMitadMitad) || 0;
  const head =
    extra > 0
      ? `🍗 *Elige la salsa* (mitad y mitad de salsa: *+$${extra}* por orden de 1/2 kilo):\n\n`
      : `🍗 *Elige la salsa:*\n\n`;
  const body = lista.map((s, i) => `${i + 1}️⃣ ${s.nombre}`).join("\n");
  const foot =
    "\n\n👉 Número o nombre. Mitad y mitad: ej. *mitad bbq y buffalo*";
  return head + body + foot;
}

function nombresSalsaCoincidenEnTexto(t, s) {
  const tokens = new Set();
  if (s.id) tokens.add(sinAcentos(String(s.id).toLowerCase()));
  if (s.nombre) tokens.add(sinAcentos(String(s.nombre).toLowerCase()));
  String(s.aliases || "")
    .split(",")
    .forEach((a) => {
      const x = sinAcentos(normalizarTextoPedido(a));
      if (x) tokens.add(x);
    });
  for (const tok of tokens) {
    if (tok.length >= 2 && t.includes(tok)) return s.nombre;
  }
  return null;
}

/** Dos salsas en el texto por ser *dos pedidos/órdenes*, no mitad y mitad en la misma. */
function textoSugiereDosPedidosSalsaDistintos(t) {
  const x = sinAcentos(normalizarTextoPedido(t));
  return (
    /\b(otra|otro)\s+(orden|pedido|porcion|bandeja)\b/.test(x) ||
    /\bdos\s+(ordenes|pedidos)\b/.test(x) ||
    /\bpedido\s+aparte\b/.test(x) ||
    /\bpor\s+separado\b/.test(x) ||
    /\s+y\s+otra(s)?\s+(de|con|orden)\b/.test(x) ||
    /\buna(s)?\s+.+\s+y\s+otra(s)?\s+(de|con|orden)\b/.test(x) ||
    /\bla\s+una(s)?\s+.+\s+y\s+la\s+otra\b/.test(x) ||
    /\b(una|uno|unas|unos)\s+\S.+\s+y\s+(una|uno|unas|unos)\s+\S/.test(x) ||
    /\bme\s+da(s|n)?\s+(una|uno)\s+.+\s+y\s+(una|uno)\b/.test(x)
  );
}

/** Mezcla explícita mitad + otra orden, o demasiadas "mitad" → mejor asesor. */
function textoSalsaRequiereAsesor(textoClean) {
  const t = sinAcentos(normalizarTextoPedido(textoClean));
  const mitads = (t.match(/\bmitad\b/g) || []).length;
  if (mitads >= 1 && /\botra\s+(orden|de|pedido)\b/.test(t)) return true;
  if (mitads >= 3) return true;
  return false;
}

function parseEleccionSalsa(textoClean) {
  const lista = restaurante.alitasBonelessSalsas?.lista || [];
  if (!lista.length) {
    return { resultado: "ok", label: "A elección", extraMitadSalsa: 0 };
  }
  const t = sinAcentos(normalizarTextoPedido(textoClean));
  const extraMitad = Number(restaurante.alitasBonelessSalsas?.precioExtraMitadMitad) || 0;

  if (textoSalsaRequiereAsesor(textoClean)) {
    return {
      resultado: "humano",
      detalle: "Combinación mitad / varias órdenes de salsa"
    };
  }

  const encontradas = [];
  for (const s of lista) {
    const hit = nombresSalsaCoincidenEnTexto(t, s);
    if (hit) encontradas.push(hit);
  }
  const unicas = [...new Set(encontradas)];

  if (unicas.length > 2) {
    return {
      resultado: "humano",
      detalle: "Tres o más salsas distintas en un mensaje"
    };
  }

  const pideMitad =
    /(mitad\s*y\s*mitad|dos\s*salsas|media\s*y\s*media)/.test(t) ||
    (t.match(/\bmitad\b/g) || []).length >= 2;

  if (unicas.length >= 2) {
    if (pideMitad) {
      return {
        resultado: "ok",
        label: `mitad ${unicas[0]} / ${unicas[1]}`,
        extraMitadSalsa: extraMitad
      };
    }
    if (textoSugiereDosPedidosSalsaDistintos(t)) {
      return {
        resultado: "ok",
        label: unicas[0],
        extraMitadSalsa: 0,
        notaCliente:
          `Tomé *${unicas[0]}* para *esta* orden. *${unicas[1]}* va en otra orden: cuando salga *¿algo más?* elige *1*, pide de nuevo el complemento y allí la salsa *${unicas[1]}*.`
      };
    }
    return { resultado: "preguntar", unicas, extraMitad };
  }

  if (pideMitad && unicas.length === 1) {
    return {
      resultado: "error",
      msg: `Para mitad y mitad necesito *dos* salsas (+$${extraMitad}).\n\n${textoMenuSalsasAlitas()}`
    };
  }

  if (pideMitad && unicas.length === 0) {
    return {
      resultado: "error",
      msg: `Di las dos salsas (+$${extraMitad}).\n\n${textoMenuSalsasAlitas()}`
    };
  }

  const n = Number.parseInt(String(textoClean).trim(), 10);
  if (!Number.isNaN(n) && n >= 1 && n <= lista.length) {
    return { resultado: "ok", label: lista[n - 1].nombre, extraMitadSalsa: 0 };
  }

  if (unicas.length === 1) {
    return { resultado: "ok", label: unicas[0], extraMitadSalsa: 0 };
  }

  return {
    resultado: "error",
    msg: `No reconocí la salsa.\n\n${textoMenuSalsasAlitas()}`
  };
}

function totalYResumenComplementos(estado) {
  if (
    Array.isArray(estado.lineasComplemento) &&
    estado.lineasComplemento.length > 0
  ) {
    let total = 0;
    const partes = estado.lineasComplemento.map((L) => {
      const base = Number(complementosMenu[L.nombre] || 0);
      const sub = L.cantidad * base + Number(L.extraMitadSalsa || 0);
      total += sub;
      const mx = L.extraMitadSalsa ? ` (+$${L.extraMitadSalsa} mix)` : "";
      return `${L.nombre} x${L.cantidad} (${L.salsaEtiqueta})${mx}`;
    });
    return { total, resumen: partes.join(", ") };
  }
  let total = 0;
  const partes = [];
  for (const [k, v] of Object.entries(estado.complementos || {})) {
    const p = Number(complementosMenu[k] || 0);
    total += p * v;
    partes.push(`${k} x${v}`);
  }
  return { total, resumen: partes.join(", ") };
}

function normalizarTextoPedido(t) {
  return (t || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function esAfirmacionSimple(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /^(si|sii+|claro|ok|oka+y?|va|dale|jalo|yes|1)$/.test(x);
}

function esNegacionSimple(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /^(no|nop|nel|2|listo|ya no)$/.test(x);
}

function textoPideVerCarrito(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return (
    /(carrito|resumen|total|cu[aá]nto\s+va|cuanto\s+llevo|que\s+llevo|pedido\s+actual)/.test(x)
  );
}

function textoPideAgregarMasNatural(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return (
    esAfirmacionSimple(x) ||
    /(agrega|agregame|agregale|tambien|y\s+una|y\s+un|quiero\s+otra|quiero\s+otro)/.test(x)
  );
}

function hayContenidoCarrito(estado) {
  return (
    (estado.ingredientes?.length || 0) > 0 ||
    Object.keys(estado.complementos || {}).length > 0 ||
    (estado.lineasComplemento?.length || 0) > 0 ||
    (estado.lineasBebida?.length || 0) > 0
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

function duplicarUltimoArticulo(estado) {
  if (Array.isArray(estado.lineasBebida) && estado.lineasBebida.length > 0) {
    const last = estado.lineasBebida[estado.lineasBebida.length - 1];
    last.cantidad = Number(last.cantidad || 0) + 1;
    return `✅ Sumé 1 más de *${last.nombre}* (ahora x${last.cantidad}).`;
  }
  if (Array.isArray(estado.lineasComplemento) && estado.lineasComplemento.length > 0) {
    const last = estado.lineasComplemento[estado.lineasComplemento.length - 1];
    last.cantidad = Number(last.cantidad || 0) + 1;
    if (estado.complementos && estado.complementos[last.nombre] != null) {
      estado.complementos[last.nombre] = Number(estado.complementos[last.nombre] || 0) + 1;
    }
    return `✅ Sumé 1 más de *${last.nombre}* (ahora x${last.cantidad}).`;
  }
  if (Array.isArray(estado.ingredientes) && estado.ingredientes.length > 0) {
    return "🍕 Para pizza no duplico automático; dime si quieres *otra pizza* y te la agrego con asesor.";
  }
  return null;
}

function aplicarEdicionCarritoNatural(estado, textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  if (!x || !hayContenidoCarrito(estado)) return null;

  // Cambiar tamaño de pizza por texto libre.
  if (/(cambia|cambiar|pon|quiero)\s+.*(mediana|grande|familiar|jumbo|mega)/.test(x)) {
    const t = detectarTamano(x);
    if (t) {
      estado.tamano = t;
      recalcularExtrasTotal(estado);
      return `✅ Tamaño actualizado a *${t}*.`;
    }
  }

  // Cambiar sabor de pizza en caliente (si ya hay pizza)
  if (/(cambia|mejor|pon|quiero)\b/.test(x) && /(pizza|sabor)/.test(x)) {
    const nuevos = detectarIngredientes(x);
    if (nuevos.length > 0) {
      estado.ingredientes = nuevos.slice(0, 2);
      return `✅ Actualicé el sabor a *${estado.ingredientes.join(" / ")}*.`;
    }
  }

  // Quitar elementos.
  if (/(quita|quitar|elimina|borrar|sin)\b/.test(x)) {
    const pick = resolverItemCatalogoPorNumeroONombre(x);
    if (pick?.tipo === "comp") {
      const ok = quitarComplementoDelEstado(estado, pick.nombre);
      if (ok) return `✅ Quité *${pick.nombre}* del pedido.`;
    }
    if (pick?.tipo === "bebida") {
      const ok = quitarBebidaDelEstado(estado, pick.nombre);
      if (ok) return `✅ Quité *${pick.nombre}* del pedido.`;
    }
    if (/(pizza|sabor)/.test(x) && estado.ingredientes?.length) {
      estado.ingredientes = [];
      estado.tamano = null;
      return "✅ Quité la pizza actual del pedido.";
    }
    if (/bebida/.test(x)) {
      if (Array.isArray(estado.lineasBebida) && estado.lineasBebida.length > 0) {
        estado.lineasBebida = [];
        return "✅ Quité las bebidas del pedido.";
      }
    }
    return "No encontré ese artículo para quitar. Dime el nombre exacto del producto.";
  }

  // Duplicar último artículo agregado.
  if (/(duplica|doble|otra igual|sumale una|sumale uno)/.test(x)) {
    return duplicarUltimoArticulo(estado);
  }

  return null;
}

async function sendText(sock, to, estado, text) {
  const t = String(text || "").trim();
  if (!t) return;
  if (estado && estado.lastBotMessageText === t) return;
  await sock.sendMessage(to, { text: t });
  if (estado) {
    estado.lastBotMessageText = t;
    estado.lastBotMessageAt = Date.now();
  }
}

function construirContextoCatalogo() {
  const menuLines = [];
  for (const [pizza, tamanos] of Object.entries(menu || {})) {
    if (!tamanos || typeof tamanos !== "object") continue;
    const partes = Object.entries(tamanos)
      .map(([t, p]) => `${t}: $${p}`)
      .join(", ");
    menuLines.push(`- ${pizza}: ${partes}`);
  }

  const complementosLines = (complementosItems || []).map(
    (c) => `- ${c.nombre}: $${c.precio}`
  );

  const descripcionesLines = [];
  for (const [pizza, d] of Object.entries(descripcionesMap || {})) {
    if (!d) continue;
    const partes = [];
    if (d.descripcion) partes.push(d.descripcion);
    if (d.ingredientesTexto) partes.push(`ingredientes: ${d.ingredientesTexto}`);
    if (partes.length) descripcionesLines.push(`- ${pizza}: ${partes.join(" | ")}`);
  }

  const promosTexto = restaurante?.promocionesTexto || "";
  const promosListaArr = Array.isArray(restaurante?.promociones)
    ? restaurante.promociones.map((p) => {
        const nombre = p?.nombre || p?.titulo || p?.id || "promo";
        const desc = p?.descripcion || p?.detalle || p?.texto || "";
        return desc ? `- ${nombre}: ${desc}` : `- ${nombre}`;
      })
    : [];

  return [
    "MENÚ DE PIZZAS (precios por tamaño):",
    menuLines.join("\n") || "(sin datos)",
    "",
    "COMPLEMENTOS Y BEBIDAS:",
    complementosLines.join("\n") || "(sin datos)",
    "",
    "DESCRIPCIONES DE PIZZAS:",
    descripcionesLines.join("\n") || "(sin datos)",
    "",
    "PROMOCIONES DEL DÍA:",
    promosTexto || "(sin texto)",
    promosListaArr.join("\n")
  ]
    .filter((x) => x !== "")
    .join("\n");
}

function construirTextoMenuParaPrompt() {
  const lines = [];
  for (const [pizza, tamanos] of Object.entries(menu || {})) {
    if (!tamanos || typeof tamanos !== "object") continue;
    const partes = Object.entries(tamanos)
      .map(([t, p]) => `${t}: $${p}`)
      .join(", ");
    lines.push(`- ${pizza}: ${partes}`);
  }
  return lines.join("\n") || "(sin datos)";
}

function construirTextoDescripcionesParaPrompt() {
  const lines = [];
  for (const [pizza, d] of Object.entries(descripcionesMap || {})) {
    if (!d) continue;
    const partes = [];
    if (d.descripcion) partes.push(d.descripcion);
    if (d.ingredientesTexto) partes.push(`ingredientes: ${d.ingredientesTexto}`);
    if (partes.length) lines.push(`- ${pizza}: ${partes.join(" | ")}`);
  }
  return lines.join("\n") || "(sin datos)";
}

function construirTextoComplementosParaPrompt() {
  return (complementosItems || [])
    .map((c) => `- ${c.nombre}: $${c.precio}`)
    .join("\n") || "(sin datos)";
}

function construirTextoPromosParaPrompt() {
  const promos = obtenerPromosVigentes();
  const general = String(restaurante?.promocionesTexto || "").trim();
  if (!promos.length) {
    if (general) return `(ninguna promo específica hoy)\nNota: ${general}`;
    return "(hoy no hay promociones activas para este día)";
  }
  const lines = promos.map((p, i) => {
    const titulo = p.titulo || p.nombre || p.id || `Promo ${i + 1}`;
    const detalle = formatearTextoPromoCliente(p).replace(/\n+/g, " ").trim();
    const notas = [];
    if (p.incluyeRefresco === true) notas.push("incluye refresco");
    if (p.incluyeRefresco === false) notas.push("no incluye refresco");
    if (Array.isArray(p.tamanosAplica) && p.tamanosAplica.length) {
      notas.push(`tamaños: ${p.tamanosAplica.join(", ")}`);
    }
    if (Array.isArray(p.saboresPermitidos) && p.saboresPermitidos.length) {
      notas.push(`sabores: ${p.saboresPermitidos.join(", ")}`);
    }
    const meta = notas.length ? ` [${notas.join("; ")}]` : "";
    return `- ${titulo}: ${detalle || "(ver detalle en sistema)"}${meta}`;
  });
  if (general) lines.push(`- General: ${general}`);
  return lines.join("\n");
}

function etiquetaPasoPedido(paso) {
  const map = {
    A: "elegir pizza",
    B: "elegir tamaño",
    C: "extras (orilla de queso / masa delgada)",
    D: "complementos",
    E: "domicilio o recoger",
    F: "dirección de entrega",
    G: "confirmación del pedido",
    H: "pedido confirmado"
  };
  return map[paso] || paso;
}

function serializarEstadoCliente(estado) {
  const lines = [];
  if (estado.modoHumano) {
    lines.push("- Modo: asesor humano (bot en pausa)");
  }
  if (estado.pasoPedido) {
    lines.push(`- Paso del pedido: ${estado.pasoPedido} (${etiquetaPasoPedido(estado.pasoPedido)})`);
  }
  if (estado.pizzaSugerida && !estado.ingredientes?.length) {
    lines.push(`- Pizza no reconocida; sugerencia: ${estado.pizzaSugerida}`);
  }
  if (estado.ingredientes?.length) {
    lines.push(`- Pizza: ${estado.ingredientes.join(" / ")}`);
  }
  if (estado.tamano) lines.push(`- Tamaño: ${estado.tamano}`);
  if (estado.extrasLineas?.length) {
    lines.push(`- Extras: ${estado.extrasLineas.join(", ")}`);
  }
  const cbTotales = totalesComplementosYBebidas(estado);
  if (cbTotales.resumen) lines.push(`- Complementos/bebidas: ${cbTotales.resumen}`);
  if (estado.tipoServicio) lines.push(`- Servicio: ${estado.tipoServicio}`);
  if (estado.dirCalle) lines.push(`- Calle y número: ${estado.dirCalle}`);
  if (estado.dirEntre) lines.push(`- Entre calles: ${estado.dirEntre}`);
  if (estado.dirReferencia) lines.push(`- Referencia: ${estado.dirReferencia}`);
  if (estado.subPasoDireccion === "calle") {
    lines.push("- Falta: calle y número");
  } else if (estado.subPasoDireccion === "entre") {
    lines.push("- Falta: entre qué calles");
  } else if (estado.subPasoDireccion === "referencia") {
    lines.push("- Falta: referencia o color de casa");
  }
  if (estado.pasoPedido === "G" || estado.pasoPedido === "H") {
    const resumen = resumenDetalladoPedidoParaCliente(estado);
    if (resumen) {
      lines.push("- Resumen actual:");
      lines.push(resumen);
    }
    const { total } = subtotalesPedidoActuales(estado);
    if (total > 0) lines.push(`- Total calculado: $${total}`);
  }
  return lines.length ? lines.join("\n") : "- Cliente nuevo / conversación general";
}

function textoConfirmacionPedidoCarly(estado) {
  const resumen = resumenDetalladoPedidoParaCliente(estado);
  const { total } = subtotalesPedidoActuales(estado);
  const cuerpo = resumen || "Tu pedido quedó anotado 🍕";
  return `✅ ¡Va! Te confirmo tu pedido:\n\n${cuerpo}\n\n💰 *Total: $${total}*\n\n¿Todo bien? Responde *SÍ* y te paso con alguien del equipo para cerrarlo 🍕😊`;
}

function construirSystemPromptCarly(estado) {
  return `Eres Carly, asistente amigable de Pizzas Carly 🍕
Hablas de forma natural, cálida, divertida y cercana (como una amiga en la pizzería).
Mensajes cortos, máximo 3 líneas.
Usa emojis con naturalidad (2 a 4 por mensaje: 🍕😊🛵✨).

MENÚ ACTUAL:
${construirTextoMenuParaPrompt()}

DESCRIPCIONES:
${construirTextoDescripcionesParaPrompt()}

COMPLEMENTOS:
${construirTextoComplementosParaPrompt()}

PROMOCIONES DE HOY (hora México; solo estas aplican hoy):
${construirTextoPromosParaPrompt()}

REBANADAS POR TAMAÑO (dato oficial):
${textoRebanadasParaPrompt()}

ESTADO ACTUAL DEL CLIENTE:
${serializarEstadoCliente(estado)}

REGLAS:
- Si el cliente quiere hacer un pedido, guíalo paso a paso: primero pizza, luego tamaño, luego complementos, luego dirección.
- Si preguntan ingredientes, responde directo.
- Si preguntan precio, responde directo.
- Si preguntan rebanadas o porciones por tamaño, usa REBANADAS POR TAMAÑO.
- Si preguntan promociones, ofertas o combos del día, responde solo con PROMOCIONES DE HOY (no inventes otras).
- Si no puedes ayudar, responde exactamente: ESCALAR
- Nunca inventes precios ni ingredientes.
- Nunca hagas más de una pregunta a la vez.
- Si el cliente se confunde, simplifica y guíalo con opciones numeradas.
- En paso B muestra tamaños con precios de la pizza elegida (1 mediana, 2 grande, etc.).
- En paso D muestra complementos con precios del menú.
- En paso G NO inventes el resumen: el bot ya envió "Te confirmo tu pedido"; si el cliente duda, aclara amablemente que debe responder SÍ para pasarlo con el equipo.
- Tono siempre positivo y con emojis, sin sonar robótica.`;
}

function sugerirPizzaSimilar(texto) {
  const ings = detectarIngredientes(texto);
  if (ings.length && menu[ings[0]]) return ings[0];
  const t = sinAcentos(normalizarTextoPedido(texto));
  const pizzas = Object.keys(menu || {});
  for (const p of pizzas) {
    const pn = sinAcentos(normalizarTextoPedido(p));
    if (pn.includes(t) || t.includes(pn)) return p;
  }
  let best = null;
  let bestLen = 0;
  for (const p of pizzas) {
    const pn = sinAcentos(normalizarTextoPedido(p));
    const common = pn.split("").filter((c) => t.includes(c)).length;
    if (common > bestLen) {
      bestLen = common;
      best = p;
    }
  }
  return best;
}

function detectarInicioPedido(textoClean) {
  return /(pedido|ordenar|quiero pizza|una pizza|hacer pedido|comprar pizza)/.test(
    textoClean
  );
}

function detectarCantidadEnTexto(textoClean) {
  const m = String(textoClean || "").match(/\b(\d{1,2})\b/);
  if (m) return Number.parseInt(m[1], 10);
  const map = { un: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6 };
  for (const [w, n] of Object.entries(map)) {
    if (new RegExp(`\\b${w}\\b`).test(textoClean)) return n;
  }
  return null;
}

function textoPreciosTamanoParaPizza(pizzaKey) {
  const por = menu[pizzaKey];
  if (!por) return TEXTO_MENU_TAMANOS;
  const filas = [
    ["1️⃣", "mediana"],
    ["2️⃣", "grande"],
    ["3️⃣", "familiar"],
    ["4️⃣", "jumbo"],
    ["5️⃣", "mega"]
  ];
  const lineas = ["📏 ¿Qué tamaño quieres?"];
  for (const [emoji, tam] of filas) {
    if (por[tam] != null) lineas.push(`${emoji} ${capitalizar(tam)} — $${por[tam]}`);
  }
  return lineas.join("\n");
}

function mensajeSeguimientoTrasFuzzy(estado, propuesta) {
  if (!propuesta) return "✅ Listo. ¿Qué más te gustaría? 🍕";
  if (propuesta.tipo === "mitad_mitad") {
    const [a, b] = propuesta.ingredientes || [];
    if (estado.tamano) {
      return `✅ Mitad *${capitalizar(a)}* y mitad *${capitalizar(b)}* (${estado.tamano}).\n¿Llevas complementos o bebidas? 🍟🥤`;
    }
    return `✅ Mitad *${capitalizar(a)}* y mitad *${capitalizar(b)}*.\n\n${textoPreciosTamanoParaPizza(a)}`;
  }
  if (propuesta.tipo === "pizza") {
    const p = propuesta.ingredientes?.[0];
    if (estado.tamano) {
      return `✅ Pizza *${capitalizar(p)}* (${estado.tamano}).\n¿Extras (orilla de queso, masa delgada) o pasamos a complementos? 🍕`;
    }
    return `✅ Pizza *${capitalizar(p)}*.\n\n${textoPreciosTamanoParaPizza(p)}`;
  }
  if (propuesta.tipo === "comp" || propuesta.tipo === "bebida") {
    return `✅ Agregué *${capitalizar(propuesta.nombre)}*${propuesta.cantidad > 1 ? ` x${propuesta.cantidad}` : ""}.\n¿Algo más? 🍕`;
  }
  if (propuesta.tipo === "promo") {
    const promos = obtenerPromosVigentes();
    const p = promos.find((x) => x.id === propuesta.promoId) || promos[0];
    if (p) {
      return `✅ Promo *${propuesta.titulo}*:\n${formatearTextoPromoCliente(p)}\n\n¿Quieres armar tu pedido con esta promo? 🍕`;
    }
    return `✅ Tomé nota de la promo *${propuesta.titulo}*. ¿Qué pizza o combo te gustaría? 🔥`;
  }
  if (propuesta.tipo === "extra") {
    recalcularExtrasTotal(estado);
    const exLineas = (estado.extrasLineas || []).join(", ");
    return `✅ Extras: ${exLineas || propuesta.nombre}.\n¿Seguimos con complementos o bebidas? 🍕`;
  }
  return "✅ Listo. ¿Qué más te gustaría? 🍕";
}

function registrarAprendizajeAsync(entry) {
  fuzzyCarly.registrarAprendizaje(entry).catch((err) => {
    console.warn("aprendizaje:", err?.message || err);
  });
}

async function guardarRestauranteAliases(aliases) {
  const raw = await fsp.readFile("restaurant.json", "utf8");
  const parsed = JSON.parse(raw);
  parsed.aliasesAprendidos = aliases;
  await fsp.writeFile("restaurant.json", JSON.stringify(parsed, null, 2) + "\n", "utf8");
  restaurante.aliasesAprendidos = aliases;
  try {
    const st = await fsp.stat("restaurant.json");
    restauranteMtimeMs = st.mtimeMs || restauranteMtimeMs;
  } catch {
    // ignorar
  }
}

function initFuzzyCarly() {
  fuzzyCarly.init({
    sinAcentos,
    normalizarTextoPedido,
    getMenu: () => menu,
    getComplementosItems: () => complementosItems,
    getBebidasItems: () => bebidasItems,
    getRestaurante: () => restaurante,
    obtenerPromosVigentes,
    capitalizar,
    detectarTamano,
    esConsultaPrecio,
    esPreguntaRebanadas,
    esPreguntaIngredientesPizza,
    detectarInicioPedido,
    mergeExtrasEnEstado,
    esAfirmacionSimple,
    esNegacionSimple,
    appendFile: (path, data) => fsp.appendFile(path, data, "utf8"),
    guardarRestauranteAliases,
    notificarTelegram: enviarTelegram,
    registrarAprendizaje: (entry) => registrarAprendizajeAsync(entry)
  });
}

async function intentarRespuestaLocalCarly(sock, from, estado, textoClean, texto) {
  const faq = buscarRespuestaFaq(textoClean);
  if (faq) return faq;

  const info = responderServicioHorarioPromoCombo(textoClean);
  if (info) return info;

  if (/(^hola$|^hola\s|buenas|buen dia|que tal|hey\b)/.test(textoClean) && !estado.pasoPedido) {
    return `😊 ¡Hola! Soy *Carly* de *${restaurante.nombreNegocio || "Pizzas Carly"}* 🍕\n\nPuedo ayudarte con *precios*, *promos*, *ingredientes* o armar tu *pedido*.\n¿Qué te gustaría hoy?`;
  }

  if (textoPideVerCarrito(textoClean) && hayContenidoCarrito(estado)) {
    return `🧺 *Tu pedido hasta ahora:*\n\n${resumenDetalladoPedidoParaCliente(estado)}`;
  }

  const edicion = aplicarEdicionCarritoNatural(estado, textoClean);
  if (edicion) return edicion;

  const precio = resolverConsultaPrecio(textoClean);
  if (precio) return precio;

  const descLocal = textoDescripcionLocalPizza(textoClean);
  if (descLocal) return descLocal;

  if (/(promo|promocion|oferta)\b/.test(textoClean) && !estado.pasoPedido) {
    const promos = obtenerPromosVigentes();
    if (!promos.length) {
      return `🔥 ${restaurante.promocionesTexto || "Hoy no hay promos activas en el sistema."}`;
    }
    const lineas = promos.map((p, i) => {
      const tit = p.titulo || p.id || `Promo ${i + 1}`;
      return `*${i + 1}.* ${tit}\n${formatearTextoPromoCliente(p)}`;
    });
    return `🔥 *Promos de hoy:*\n\n${lineas.join("\n\n")}\n\n¿Cuál te interesa o qué pizza quieres? 🍕`;
  }

  const analisis = fuzzyCarly.analizarMensaje(textoClean, estado);
  if (analisis.accion === "confirmar") {
    estado.confirmacionPendiente = {
      propuesta: analisis.propuesta,
      textoOriginal: textoClean
    };
    return analisis.mensaje;
  }
  if (analisis.accion === "aplicar") {
    fuzzyCarly.aplicarPropuesta(estado, analisis.propuesta);
    if (!estado.pasoPedido && (analisis.propuesta.tipo === "pizza" || analisis.propuesta.tipo === "mitad_mitad")) {
      estado.pasoPedido = estado.tamano ? "C" : "B";
    }
    return mensajeSeguimientoTrasFuzzy(estado, analisis.propuesta);
  }

  return null;
}

function actualizarEstadoDesdeMensaje(estado, texto, textoClean) {
  if (!textoClean) return;

  if (!estado.pasoPedido && detectarInicioPedido(textoClean)) {
    estado.pasoPedido = "A";
  }

  if (estado.pasoPedido === "A") {
    if (estado.pizzaSugerida && esAfirmacionSimple(textoClean)) {
      estado.ingredientes = [estado.pizzaSugerida];
      estado.pizzaSugerida = null;
      estado.pasoPedido = "B";
      return;
    }
    if (estado.pizzaSugerida && esNegacionSimple(textoClean)) {
      estado.pizzaSugerida = null;
      return;
    }
    const ings = detectarIngredientes(textoClean);
    if (ings.length) {
      const validos = ings.filter((i) => menu[i]);
      if (validos.length) {
        estado.ingredientes = validos.slice(0, 2);
        estado.pizzaSugerida = null;
        estado.pasoPedido = "B";
      } else {
        const sug = sugerirPizzaSimilar(textoClean);
        if (sug) {
          estado.pizzaSugerida = sug;
        }
      }
    }
    return;
  }

  if (estado.pasoPedido === "B") {
    const mapa = {
      "1": "mediana",
      "2": "grande",
      "3": "familiar",
      "4": "jumbo",
      "5": "mega"
    };
    const tam = mapa[textoClean] || detectarTamano(textoClean);
    const pizza = estado.ingredientes?.[0];
    if (tam && pizza && menu[pizza]?.[tam]) {
      estado.tamano = tam;
      estado.pasoPedido = "C";
    }
    return;
  }

  if (estado.pasoPedido === "C") {
    mergeExtrasEnEstado(estado, textoClean);
    if (textoClean.length > 0) estado.pasoPedido = "D";
    return;
  }

  if (estado.pasoPedido === "D") {
    if (/(^no$|ninguno|sin complemento|nada mas|siguiente|listo|asi esta)/.test(textoClean)) {
      estado.pasoPedido = "E";
      return;
    }
    const pick = resolverItemCatalogoPorNumeroONombre(textoClean);
    if (pick) {
      if (!estado.complementos) estado.complementos = {};
      estado.complementos[pick.nombre] = (estado.complementos[pick.nombre] || 0) + 1;
      if (pick.tipo === "bebida") {
        if (!Array.isArray(estado.lineasBebida)) estado.lineasBebida = [];
        estado.lineasBebida.push({ nombre: pick.nombre, cantidad: 1 });
      } else if (!Array.isArray(estado.lineasComplemento)) {
        estado.lineasComplemento = [];
      }
      if (pick.tipo === "comp") {
        estado.lineasComplemento.push({ nombre: pick.nombre, cantidad: 1 });
      }
    }
    const directo = detectarPedidoDirecto(textoClean);
    if (directo?.complementos) {
      for (const [nombre, cant] of Object.entries(directo.complementos)) {
        estado.complementos[nombre] = (estado.complementos[nombre] || 0) + (cant || 1);
      }
    }
    return;
  }

  if (estado.pasoPedido === "E") {
    if (/(domicilio|a domicilio|envio|envío|a casa|a mi casa)/.test(textoClean)) {
      estado.tipoServicio = "domicilio";
      estado.pasoPedido = "F";
      estado.subPasoDireccion = "calle";
    } else if (/(recoger|pickup|paso|tienda|local|recojo)/.test(textoClean)) {
      estado.tipoServicio = "recoger";
      marcarPasoConfirmacionPedido(estado);
    }
    return;
  }

  if (estado.pasoPedido === "F") {
    const sub = estado.subPasoDireccion || "calle";
    const t = String(texto || "").trim();
    if (sub === "calle" && t.length >= 4) {
      estado.dirCalle = t;
      estado.subPasoDireccion = "entre";
    } else if (sub === "entre" && t.length >= 3) {
      estado.dirEntre = t;
      estado.subPasoDireccion = "referencia";
    } else if (sub === "referencia" && t.length >= 2) {
      estado.dirReferencia = t;
      estado.direccionCompleta = `${estado.dirCalle} | Entre ${estado.dirEntre} | Ref: ${estado.dirReferencia}`;
      estado.subPasoDireccion = null;
      estado.pasoPedido = "G";
      estado.pendienteEnvioConfirmacion = true;
    }
  }
}

function marcarPasoConfirmacionPedido(estado) {
  estado.pasoPedido = "G";
  estado.pendienteEnvioConfirmacion = true;
}

function jidEsAdmin(jid) {
  if (!NUMERO_ADMIN || !jid) return false;
  const a = String(jid).split("@")[0].replace(/\D/g, "");
  const b = String(NUMERO_ADMIN).split("@")[0].replace(/\D/g, "");
  return a === b || a.endsWith(b) || b.endsWith(a);
}

function resolverJidClientePorNumero(numeroRaw) {
  const digits = String(numeroRaw || "").replace(/\D/g, "");
  if (!digits) return null;
  for (const jid of Object.keys(estados)) {
    const d = jid.split("@")[0].replace(/\D/g, "");
    if (d === digits || d.endsWith(digits) || digits.endsWith(d)) return jid;
  }
  const prefijos = [digits, `52${digits}`, `521${digits}`];
  for (const p of prefijos) {
    const cand = `${p}@s.whatsapp.net`;
    if (estados[cand]) return cand;
  }
  return `${digits}@s.whatsapp.net`;
}

async function manejarComandoAdmin(sock, from, texto) {
  if (!jidEsAdmin(from)) return false;
  const m = String(texto || "")
    .trim()
    .match(/^\/bot\s+(\d[\d\s]{6,14})/i);
  if (!m) return false;
  const jid = resolverJidClientePorNumero(m[1]);
  if (!estados[jid]) estados[jid] = nuevoEstadoCliente();
  estados[jid].modoHumano = false;
  estados[jid].tiempoEscalado = 0;
  await sock.sendMessage(from, {
    text: `✅ Bot reactivado para *${m[1].trim()}*`
  });
  return true;
}

async function procesarConversacionCarly(sock, msg, from, quien, estado, texto, textoClean, esNuevoCliente) {
  if (estado.modoHumano) {
    if (Date.now() - Number(estado.tiempoEscalado || 0) >= MODO_HUMANO_TTL_MS) {
      estado.modoHumano = false;
      estado.tiempoEscalado = 0;
      await sendText(sock, from, estado, MENSAJE_REACTIVACION_BOT);
    } else {
      return;
    }
  }

  if (!estaAbierto()) {
    await sendText(sock, from, estado, MENSAJE_FUERA_HORARIO);
    return;
  }

  await recargarArchivosSiCambioThrottled();

  if (textoClean.includes("cancelar")) {
    await registrarEventoMetricas("pedido_cancelado", { from, paso: estado.pasoPedido || "?" });
    resetEstadoCliente(from, estado);
    await sendText(
      sock,
      from,
      estado,
      "❌ Pedido cancelado.\n\n👋 Cuando quieras, escríbeme de nuevo 🍕"
    );
    return;
  }

  if (esNuevoCliente && !estado.notificadoInicio && textoClean) {
    estado.notificadoInicio = true;
    await registrarEventoMetricas("nuevo_cliente", { from, quien });
    await notificarUrgenteMovil(sock, {
      waTitulo: "NUEVO CLIENTE",
      waDetalle: `📞 ${quien}\nJID: ${from}\n💬 "${textoClean}"`,
      tgTexto: `🚨 NUEVO CLIENTE\n📞 ${quien}\nJID: ${from}\n💬 "${textoClean}"`
    });
  }

  if (msg.message?.locationMessage) {
    const lat = msg.message.locationMessage.degreesLatitude;
    const lng = msg.message.locationMessage.degreesLongitude;
    if (estado.pasoPedido === "F" || estado.tipoServicio === "domicilio") {
      estado.direccionCompleta = `Ubicación: https://maps.google.com/?q=${lat},${lng}`;
      marcarPasoConfirmacionPedido(estado);
      estado.subPasoDireccion = null;
    } else {
      await sendText(
        sock,
        from,
        estado,
        "📍 Recibí tu ubicación. Cuando hagas pedido a domicilio, la usamos 👍"
      );
      return;
    }
  }

  const confFuzzy = fuzzyCarly.manejarConfirmacionPendiente(estado, textoClean);
  if (confFuzzy.manejado) {
    if (confFuzzy.mensaje) {
      await sendText(sock, from, estado, confFuzzy.mensaje);
      return;
    }
    if (confFuzzy.aplicado) {
      await sendText(
        sock,
        from,
        estado,
        mensajeSeguimientoTrasFuzzy(estado, confFuzzy.propuesta)
      );
      return;
    }
  }

  actualizarEstadoDesdeMensaje(estado, texto, textoClean);

  if (estado.pizzaSugerida && estado.pasoPedido === "A" && !estado.confirmacionPendiente) {
    const prop = { tipo: "pizza", ingredientes: [estado.pizzaSugerida] };
    estado.confirmacionPendiente = { propuesta: prop, textoOriginal: textoClean };
    estado.pizzaSugerida = null;
    await sendText(sock, from, estado, fuzzyCarly.textoConfirmacion(prop));
    return;
  }

  if (estado.pendienteEnvioConfirmacion && estado.pasoPedido === "G") {
    estado.pendienteEnvioConfirmacion = false;
    await sendText(sock, from, estado, textoConfirmacionPedidoCarly(estado));
    return;
  }

  if (estado.pasoPedido === "G" && esAfirmacionSimple(textoClean)) {
    await confirmarPedidoYPasarAHumano(sock, from, estado, quien);
    return;
  }

  const respRebanadas = responderConsultaRebanadas(textoClean);
  if (respRebanadas) {
    await sendText(sock, from, estado, respRebanadas);
    return;
  }

  const respLocal = await intentarRespuestaLocalCarly(
    sock,
    from,
    estado,
    textoClean,
    texto
  );
  if (respLocal) {
    await sendText(sock, from, estado, respLocal);
    return;
  }

  if (!USE_GROQ) {
    await activarModoHumano(sock, from, estado, quien, "Groq no configurado");
    return;
  }

  const respuesta = await responderConGroqCarly(estado, textoClean || texto);

  if (respuesta === GROQ_TIMEOUT_SENTINEL || !respuesta || /^ESCALAR\b/i.test(respuesta)) {
    await activarModoHumano(sock, from, estado, quien, textoClean || texto);
    return;
  }

  await sendText(sock, from, estado, respuesta);
}

async function activarModoHumano(sock, from, estado, quien, motivo = "") {
  estado.modoHumano = true;
  estado.tiempoEscalado = Date.now();
  const detalle = String(motivo || "").trim();
  await notificarUrgenteMovil(sock, {
    waTitulo: "ESCALAR A ASESOR",
    waDetalle: `📞 ${quien}\nJID: ${from}${detalle ? `\n💬 ${detalle}` : ""}`,
    tgTexto: `🚨 *Cliente necesita asesor*\n📞 ${quien}\nJID: ${from}${detalle ? `\n💬 ${detalle}` : ""}`
  });
  await registrarEventoMetricas("escalado_humano", { from, motivo: detalle || "ESCALAR" });
}

async function confirmarPedidoYPasarAHumano(sock, from, estado, quien) {
  const resumen = resumenDetalladoPedidoParaCliente(estado);
  const { total } = subtotalesPedidoActuales(estado);
  const dir =
    estado.tipoServicio === "domicilio"
      ? estado.direccionCompleta ||
        [estado.dirCalle, estado.dirEntre, estado.dirReferencia].filter(Boolean).join(" | ")
      : "Recoger en tienda";

  const payload = `🍕 *PEDIDO — PASAR A COLABORADOR*\n\n📞 ${quien}\nJID: ${from}\n📍 ${dir}\n\n${resumen || "—"}\n💰 Total: $${total}`;

  try {
    const telefono = String(from || "").replace(/@.+$/, "");
    await guardarPedido({
      cliente: quien || "Cliente",
      telefono,
      pedido: `${resumen || lineaPizzaEmoji(estado) || "Pedido"} | ${dir}`,
      total: Number(total || 0)
    });
    const pedidoGuardar = `
------------------------
Cliente: ${from}
Pedido: ${resumen}
Dirección: ${dir}
Total: $${total}
Fecha: ${new Date().toLocaleString()}
`;
    await registrarPedidoEnStorage(pedidoGuardar);
    ultimoPedidoPorCliente[from] = snapshotPedido(estado);
  } catch (err) {
    console.error("❌ confirmarPedidoYPasarAHumano:", err?.message || err);
  }

  await sendText(sock, from, estado, MENSAJE_PASO_A_HUMANO);
  await notificarUrgenteMovil(sock, {
    waTitulo: "PEDIDO CONFIRMADO — ATENDER",
    waDetalle: payload,
    tgTexto: payload
  });
  await registrarEventoMetricas("pedido_confirmado_paso_humano", { from });

  estado.modoHumano = true;
  estado.tiempoEscalado = Date.now();
  estado.pasoPedido = null;
  estado.pendienteEnvioConfirmacion = false;
  estado.historialGroq = [];
}

const GROQ_TIMEOUT_MS = 15000;
const GROQ_INDICADOR_DELAY_MS = 2000;
const GROQ_TIMEOUT_SENTINEL = "__TIMEOUT__";
const GROQ_MANEJADO_SENTINEL = "__GROQ_MANEJADO__";

async function responderConGroqCarly(estado, pregunta, timeoutMs = GROQ_TIMEOUT_MS) {
  if (!USE_GROQ || !groqClient) return "ESCALAR";

  const system = construirSystemPromptCarly(estado);
  if (!Array.isArray(estado.historialGroq)) estado.historialGroq = [];
  const historial = estado.historialGroq.slice(-8);

  const messages = [{ role: "system", content: system }];
  for (const turn of historial) {
    messages.push(turn);
  }
  messages.push({ role: "user", content: String(pregunta || "").trim() || "hola" });

  console.log("🤖 Carly — cliente:", pregunta);
  console.log("🤖 Carly — paso:", estado.pasoPedido || "—");

  try {
    let timeoutHandle;
    const timeoutPromise = new Promise((resolve) => {
      timeoutHandle = setTimeout(() => resolve(GROQ_TIMEOUT_SENTINEL), timeoutMs);
    });
    const apiPromise = (async () => {
      const completion = await groqClient.chat.completions.create({
        model: GROQ_MODEL_NAME,
        messages,
        temperature: 0.5,
        max_tokens: 280
      });
      const text = String(completion?.choices?.[0]?.message?.content || "").trim();
      return text || "ESCALAR";
    })();
    const respuesta = await Promise.race([apiPromise, timeoutPromise]);
    clearTimeout(timeoutHandle);
    if (respuesta === GROQ_TIMEOUT_SENTINEL) {
      console.warn(`⚠️ Groq timeout (>${timeoutMs}ms)`);
      return "ESCALAR";
    }
    estado.historialGroq.push({ role: "user", content: String(pregunta || "").trim() });
    estado.historialGroq.push({ role: "assistant", content: respuesta });
    if (estado.historialGroq.length > 16) {
      estado.historialGroq = estado.historialGroq.slice(-16);
    }
    return respuesta;
  } catch (err) {
    console.error("❌ Groq error:", err?.message || err);
    return "ESCALAR";
  }
}

async function responderConGroq(pregunta, contexto, timeoutMs = GROQ_TIMEOUT_MS) {
  const stub = { historialGroq: [] };
  if (contexto) {
    return responderConGroqCarly(
      { ...stub, pasoPedido: null },
      `Contexto:\n${contexto}\n\nPregunta: ${pregunta}`,
      timeoutMs
    );
  }
  return responderConGroqCarly(stub, pregunta, timeoutMs);
}

// Indicador "consultando" diferido + timeout + escalamiento (misma logica que antes).
// Devuelve { manejado, texto } donde:
//   manejado=true -> ya enviamos mensaje/escalamos, el caller debe cortar el flujo
//   manejado=false, texto=string -> respuesta valida del LLM
//   manejado=false, texto=null -> ESCALAR / vacio, caller decide
async function preguntarAGroqConIndicador(sock, from, quien, pregunta, contexto) {
  // El indicador "Déjame consultar eso..." se envia solo si el LLM tarda
  // mas de GROQ_INDICADOR_DELAY_MS; asi evitamos mensajes dobles cuando
  // la respuesta llega rapido.
  let indicadorEnviado = false;
  const indicadorTimer = setTimeout(() => {
    indicadorEnviado = true;
    sock
      .sendMessage(from, { text: "🤔 Déjame consultar eso..." })
      .catch((err) =>
        console.warn("Groq indicador send error:", err?.message || err)
      );
  }, GROQ_INDICADOR_DELAY_MS);

  const respuesta = await responderConGroq(pregunta, contexto, GROQ_TIMEOUT_MS);
  clearTimeout(indicadorTimer);
  void indicadorEnviado;

  if (respuesta === GROQ_TIMEOUT_SENTINEL) {
    try {
      await sock.sendMessage(from, {
        text: "Un momento, déjame verificar eso con un asesor."
      });
    } catch (err) {
      console.warn("Groq timeout msg error:", err?.message || err);
    }
    try {
      await notificarUrgenteMovil(sock, {
        waTitulo: "ESCALAR (timeout Groq)",
        waDetalle: `Groq >${GROQ_TIMEOUT_MS}ms\n📞 ${quien || "?"}\nJID: ${from}\n💬 ${pregunta}`,
        tgTexto: `🚨 *Timeout Groq*\n📞 ${quien || "?"}\nJID: ${from}\n💬 ${pregunta}`
      });
    } catch (err) {
      console.warn("Groq timeout notify error:", err?.message || err);
    }
    return { manejado: true, texto: null };
  }

  if (!respuesta || /^ESCALAR\b/i.test(String(respuesta).trim())) {
    return { manejado: false, texto: null };
  }
  return { manejado: false, texto: String(respuesta).trim() };
}

function numeroDesdeTexto(t) {
  const x = normalizarTextoPedido(t);
  const n = Number.parseInt(x, 10);
  if (!Number.isNaN(n)) return n;
  const mapa = {
    un: 1,
    uno: 1,
    una: 1,
    dos: 2,
    tres: 3,
    cuatro: 4,
    cinco: 5,
    seis: 6,
    siete: 7,
    ocho: 8,
    nueve: 9,
    diez: 10
  };
  return mapa[x] ?? null;
}

function detectarDireccionEnTexto(textoClean) {
  const t = normalizarTextoPedido(textoClean);
  // heurística básica: si menciona una vialidad/dirección y tiene longitud “real”
  const tieneMarcador =
    t.includes("calle") ||
    t.includes("avenida") ||
    t.includes("av ") ||
    t.includes("col ") ||
    t.includes("colonia") ||
    t.includes("fracc") ||
    t.includes("entre ") ||
    t.includes("esquina") ||
    t.includes("#") ||
    /\bno\.?\s*\d+/.test(t);
  if (!tieneMarcador) return null;
  if (t.length < 12) return null;
  return textoClean.trim();
}

function detectarComplementosEnTexto(textoClean) {
  const t = normalizarTextoPedido(textoClean);
  const itemsOrdenados = detectCache.complementosOrdenados;

  const encontrados = {};
  const encontradosNombres = new Set();

  // 1) match por nombre completo o abreviado (ej. "alitas" ↔ "alitas 8 piezas")
  for (const it of itemsOrdenados) {
    const nombre = normalizarTextoPedido(it.nombre);
    if (!nombre) continue;
    if (!complementoNombreCoincideUsuario(t, nombre)) continue;
    encontradosNombres.add(nombre);

    // intenta leer cantidad antes del nombre: "2 papas a la francesa", "una papas..."
    const re = new RegExp(
      String.raw`(?:^|[\s,])(\d+|una|un|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:de\s+)?${nombre}\b`,
      "i"
    );
    const m = t.match(re);
    const qty = m ? numeroDesdeTexto(m[1]) : 1;
    encontrados[it.nombre] = (encontrados[it.nombre] || 0) + (qty || 1);
  }

  // 2) ambigüedad tipo "papas" cuando existen varias "papas ..."
  const ambiguedades = [];
  const posiblesPapas = complementosItems
    .map((x) => x.nombre)
    .filter((n) => normalizarTextoPedido(n).startsWith("papas "));

  const dijoPapas = /\bpapas\b/.test(t);
  const yaDijoTipoDePapas = posiblesPapas.some((n) =>
    encontradosNombres.has(normalizarTextoPedido(n))
  );
  if (dijoPapas && posiblesPapas.length >= 2 && !yaDijoTipoDePapas) {
    // intenta leer cantidad genérica: "2 papas"
    const m = t.match(
      /(?:^|[\s,])(\d+|una|un|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+papas\b/i
    );
    const qty = m ? numeroDesdeTexto(m[1]) : 1;
    ambiguedades.push({
      tipo: "papas",
      opciones: posiblesPapas,
      cantidad: qty || 1
    });
  }

  return { encontrados, ambiguedades };
}

function detectarBebidasEnTexto(textoClean) {
  const t = normalizarTextoPedido(textoClean);
  const orden = detectCache.bebidasOrdenadas;
  const encontrados = {};
  for (const it of orden) {
    const nombre = normalizarTextoPedido(it.nombre);
    if (!nombre || !t.includes(nombre)) continue;
    const re = new RegExp(
      String.raw`(?:^|[\s,])(\d+|una|un|uno|unos|unas|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez)\s+(?:de\s+)?${nombre}\b`,
      "i"
    );
    const m = t.match(re);
    const qty = m ? numeroDesdeTexto(m[1]) : 1;
    encontrados[it.nombre] = (encontrados[it.nombre] || 0) + (qty || 1);
  }
  return encontrados;
}

function detectarPedidoDirecto(textoClean) {
  if (esPreguntaIngredientesPizza(textoClean)) return null;

  const t = normalizarTextoPedido(textoClean);
  const pareceSoloConsulta =
    esConsultaPrecio(textoClean) &&
    !/\b(quiero|dame|pedir|ordenar|mandar|enviar|llevar|me da|me das|necesito|ponme|deseo)\b/.test(
      sinAcentos(t)
    );
  if (pareceSoloConsulta) return null;

  const ingredientes = detectarIngredientes(t);
  const tamano = detectarTamano(t);
  const direccion = detectarDireccionEnTexto(textoClean);
  const { encontrados: complementos, ambiguedades } = detectarComplementosEnTexto(t);
  const bebidasDet = detectarBebidasEnTexto(t);

  const hayAlgoDePedido =
    ingredientes.length > 0 ||
    Boolean(tamano) ||
    Object.keys(complementos).length > 0 ||
    Object.keys(bebidasDet).length > 0 ||
    ambiguedades.length > 0 ||
    Boolean(direccion);

  // no dispares con mensajes demasiado cortos tipo "hola"
  if (!hayAlgoDePedido) return null;
  if (t.length < 3) return null;

  return { ingredientes, tamano, complementos, bebidas: bebidasDet, ambiguedades, direccion };
}

// 🧠 MEMORIA
const SESSION_INACTIVITY_MS = 15 * 60 * 1000;

function nuevoEstadoCliente() {
  return {
    paso: "inicio",
    pasoPedido: null,
    ingredientes: [],
    complementos: {},
    avisoCierre: false,
    intentos: 0,
    notificadoInicio: false,
    extrasTotal: 0,
    extrasLineas: [],
    extrasActivos: {},
    lineasComplemento: [],
    lineasBebida: [],
    ultimaActividadAt: Date.now(),
    promoActivaId: null,
    upsellPizzaMostrado: false,
    tempEsBebida: false,
    desdePromoPedido: false,
    referenciaPromoCliente: null,
    tempCantidadPre: null,
    direccionPendienteTexto: null,
    salsaClarificarUnicas: null,
    salsaClarificarExtraMitad: null,
    lastBotMessageAt: 0,
    lastBotMessageText: "",
    lastUserMessageAt: 0,
    upsellHintsShown: {},
    marketingHintsShown: {},
    promoOpcionesIds: [],
    saludoInicialEnviado: false,
    esperandoHumanoHasta: 0,
    procesando: false,
    modoHumano: false,
    tiempoEscalado: 0,
    historialGroq: [],
    tipoServicio: null,
    dirCalle: null,
    dirEntre: null,
    dirReferencia: null,
    direccionCompleta: null,
    subPasoDireccion: null,
    pizzaSugerida: null,
    pendienteEnvioConfirmacion: false,
    confirmacionPendiente: null
  };
}

const estados = {};
const ultimoPedidoPorCliente = {};
let reconnectScheduled = false;
const TEXTO_MENU_TAMANOS = "📏 ¿Qué tamaño quieres?\n\n1️⃣ Mediana\n2️⃣ Grande\n3️⃣ Familiar\n4️⃣ Jumbo\n5️⃣ Mega";

function resetEstadoCliente(jid, prevEstado = null) {
  const keepNotif = !!(prevEstado?.notificadoInicio || estados[jid]?.notificadoInicio);
  estados[jid] = nuevoEstadoCliente();
  estados[jid].notificadoInicio = keepNotif;
}

setInterval(() => {
  const now = Date.now();
  for (const [jid, st] of Object.entries(estados)) {
    if (!st?.ultimaActividadAt) continue;
    if (now - st.ultimaActividadAt > SESSION_INACTIVITY_MS) {
      delete estados[jid];
    }
  }
}, 60 * 1000);

// 📩 TELEGRAM (notificaciones de pedidos)
// PowerShell:
// $env:TELEGRAM_BOT_TOKEN="..."; $env:TELEGRAM_CHAT_ID="..."; node index.js
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

async function enviarTelegram(texto) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: texto,
        disable_web_page_preview: true
      }
    );
  } catch (err) {
    console.error("❌ Error enviando Telegram:", err?.response?.data || err?.message || err);
  }
}

async function retryAsync(fn, { attempts = 3, baseDelayMs = 500 } = {}) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        const wait = baseDelayMs * (i + 1);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function sendWhatsAppAdminUrgente(sock, titulo, detalle = "") {
  if (!NUMERO_ADMIN) return;

  const t1 = `🚨 ${String(titulo || "ALERTA").trim()}`;
  const t2 = String(detalle || "").trim();
  await retryAsync(
    () => sock.sendMessage(NUMERO_ADMIN, { text: t1 }),
    { attempts: 3, baseDelayMs: 350 }
  );
  if (t2) {
    await retryAsync(
      () => sock.sendMessage(NUMERO_ADMIN, { text: t2 }),
      { attempts: 3, baseDelayMs: 350 }
    );
  }
}

async function notificarUrgenteMovil(sock, { waTitulo, waDetalle, tgTexto }) {
  const waTask = sendWhatsAppAdminUrgente(sock, waTitulo, waDetalle);
  const tgTask = tgTexto
    ? retryAsync(() => enviarTelegram(tgTexto), { attempts: 3, baseDelayMs: 700 })
    : Promise.resolve();
  const results = await Promise.allSettled([waTask, tgTask]);
  if (results[0].status === "rejected") {
    console.error("❌ Error enviando WhatsApp admin:", results[0].reason?.message || results[0].reason);
  }
}

// Punto único de persistencia: facilita migrar a Firestore después.
async function registrarPedidoEnStorage(textoRegistro) {
  await fsp.appendFile("pedidos.txt", textoRegistro, "utf8");
}

async function registrarEventoMetricas(evento, payload = {}) {
  try {
    const row = {
      ts: new Date().toISOString(),
      evento,
      ...payload
    };
    await fsp.appendFile("metricas.jsonl", JSON.stringify(row) + "\n", "utf8");

    // Métricas en Firestore: opt-in vía METRICAS_FIRESTORE=1.
    // Por defecto NO se escriben a Firestore para no consumir cuota
    // gratuita (siguen en metricas.jsonl local). Los pedidos confirmados
    // siguen guardándose vía guardarPedido().
    if (firestore && process.env.METRICAS_FIRESTORE === "1") {
      firestore
        .collection("metricas")
        .add(row)
        .catch((err) =>
          console.error("❌ Error escribiendo métricas en Firestore:", err?.message || err)
        );
    }
  } catch (err) {
    console.error("❌ Error guardando métricas:", err?.message || err);
  }
}

/**
 * Guarda un pedido confirmado en Firestore.
 * Estructura requerida:
 * cliente, telefono, pedido, total, estado("pendiente"), fecha(Timestamp actual)
 */
async function guardarPedido(pedido) {
  try {
    if (!firestore) {
      console.warn("⚠️ Firestore no disponible. No se guardó el pedido.");
      return null;
    }

    if (!pedido || typeof pedido !== "object") {
      console.warn("⚠️ guardarPedido: payload inválido (no es objeto).");
      return null;
    }

    const cliente = String(pedido.cliente || "").trim();
    const telefono = String(pedido.telefono || "").trim();
    const pedidoContenido = pedido.pedido;
    const total = Number(pedido.total);

    if (!cliente || !telefono) {
      console.warn("⚠️ guardarPedido: faltan campos cliente/telefono.");
      return null;
    }
    if (pedidoContenido == null || (typeof pedidoContenido === "string" && !pedidoContenido.trim())) {
      console.warn("⚠️ guardarPedido: campo pedido vacío.");
      return null;
    }
    if (!Number.isFinite(total) || total <= 0) {
      console.warn("⚠️ guardarPedido: total inválido o <= 0.");
      return null;
    }

    const doc = {
      cliente,
      telefono,
      pedido: pedidoContenido,
      total,
      estado: "pendiente",
      fecha: new Date()
    };

    const ref = await firestore.collection("pedidos").add(doc);
    console.log(`✅ Pedido guardado en Firestore (id=${ref.id}) para ${cliente}.`);
    return ref.id;
  } catch (err) {
    console.error("❌ guardarPedido: error guardando en Firestore:", err?.message || err);
    return null;
  }
}

function textoPideReporte(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /^(reporte|metricas|estadisticas|kpis|resumen\s+del\s+dia)$/.test(x);
}

async function construirReporteMetricasHoy() {
  let raw = "";
  try {
    raw = await fsp.readFile("metricas.jsonl", "utf8");
  } catch {
    return "📊 Aún no hay métricas registradas hoy.";
  }
  const hoy = diaLocalYyyyMmDd();
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "📊 Aún no hay métricas registradas hoy.";

  const rows = [];
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (!j?.ts || String(j.ts).slice(0, 10) !== hoy) continue;
      rows.push(j);
    } catch {
      // ignorar línea corrupta
    }
  }
  if (!rows.length) return "📊 Aún no hay métricas registradas hoy.";

  const count = (ev) => rows.filter((r) => r.evento === ev).length;
  const nuevos = count("nuevo_cliente");
  const confirmados = count("pedido_confirmado");
  const cancelados = count("pedido_cancelado");
  const upsells = count("upsell_mostrado");
  const directos = rows.filter((r) => r.evento === "pedido_confirmado" && r.tipo === "directo").length;
  const porUbicacion = rows.filter((r) => r.evento === "pedido_confirmado" && r.tipo === "ubicacion").length;
  const porDireccion = rows.filter((r) => r.evento === "pedido_confirmado" && r.tipo === "direccion_texto").length;

  const totales = rows
    .filter((r) => r.evento === "pedido_confirmado")
    .map((r) => Number(r.total ?? r.totalAprox))
    .filter((n) => Number.isFinite(n) && n > 0);
  const ticketProm = totales.length
    ? (totales.reduce((a, b) => a + b, 0) / totales.length).toFixed(2)
    : "0.00";

  const conversion = nuevos > 0 ? ((confirmados / nuevos) * 100).toFixed(1) : "0.0";

  return `📊 *Reporte de hoy (${hoy})*

👥 Nuevos clientes: *${nuevos}*
✅ Pedidos confirmados: *${confirmados}*
❌ Cancelados: *${cancelados}*
📈 Conversión: *${conversion}%*
💵 Ticket promedio: *$${ticketProm}*

🧾 Confirmados por tipo:
- Dirección texto: ${porDireccion}
- Directo: ${directos}
- Ubicación: ${porUbicacion}

🎯 Upsells mostrados: ${upsells}`;
}

// 👇 AQUÍ VA LA FUNCIÓN
function parseHorarioHHMM(s) {
  if (!s || typeof s !== "string") return null;
  const m = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (Number.isNaN(h) || Number.isNaN(min)) return null;
  return h * 60 + min;
}

function zonaHorariaNegocio() {
  return restaurante?.horarioAbierto?.zona || "America/Mexico_City";
}

function partesFechaEnZonaHoraria(zona) {
  const tz = zona || zonaHorariaNegocio();
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long"
    }).formatToParts(new Date());
  } catch {
    return null;
  }
}

function diaSemanaEnZonaHoraria(zona) {
  const parts = partesFechaEnZonaHoraria(zona);
  const nombre = parts?.find((p) => p.type === "weekday")?.value?.toLowerCase();
  const map = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6
  };
  if (nombre && map[nombre] != null) return map[nombre];
  return new Date().getDay();
}

function diaLocalYyyyMmDdEnZonaHoraria(zona) {
  const parts = partesFechaEnZonaHoraria(zona);
  if (parts) {
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  }
  return diaLocalYyyyMmDd();
}

function minutosEnZonaHoraria(zona) {
  const tz = zona || zonaHorariaNegocio();
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === "hour")?.value || 0);
    const m = Number(parts.find((p) => p.type === "minute")?.value || 0);
    return h * 60 + m;
  } catch {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  }
}

function estaAbierto() {
  const r = restaurante?.horarioAbierto;
  const inicio = r?.inicio || "12:00";
  const fin = r?.fin || "22:30";
  const a = parseHorarioHHMM(inicio);
  const b = parseHorarioHHMM(fin);
  if (a == null || b == null) return true;
  const cur = minutosEnZonaHoraria(r?.zona);
  if (b < a) return cur >= a || cur < b;
  return cur >= a && cur < b;
}

function porCerrar() {
  return false;
}

// 💰 PRECIO
// Calcula el precio usando la tabla cargada desde Google Sheets (hoja `menu`).
function calcularPrecio(ingredientes, tamano) {
  if (!Array.isArray(ingredientes) || ingredientes.length === 0) return 0;

  // Si no hay tamaño (caso raro), usa el máximo disponible entre todos los tamaños.
  if (!tamano) {
    let max = 0;
    ingredientes.forEach((i) => {
      const porPizza = menu?.[i];
      if (!porPizza) return;
      for (const v of Object.values(porPizza)) {
        const n = Number(v);
        if (!Number.isNaN(n) && n > max) max = n;
      }
    });
    return max;
  }

  let max = 0;
  ingredientes.forEach((i) => {
    const porPizza = menu?.[i];
    const precio = porPizza?.[tamano];
    const n = Number(precio);
    if (!Number.isNaN(n) && n > max) max = n;
  });

  return max;
}

function subtotalesPedidoActuales(estado) {
  const precioPizza = calcularPrecio(estado.ingredientes || [], estado.tamano);
  const cb = totalesComplementosYBebidas(estado);
  const ext = Number(estado.extrasTotal) || 0;
  const total = precioPizza + cb.total + ext;
  return { precioPizza, cb, ext, total };
}

function lineaPizzaEmoji(estado) {
  if (!estado.ingredientes?.length) return null;
  if (estado.ingredientes.length === 2) {
    return `🍕 Mitad ${estado.ingredientes[0]} / mitad ${estado.ingredientes[1]}`;
  }
  return `🍕 ${estado.ingredientes.join(" / ")}`;
}

function textoBloqueRecordatorioRefresco(estado) {
  const cfg = restaurante.recordatorioRefrescoGratis;
  if (!cfg?.activo) return "";
  const diasCfg = Array.isArray(cfg.diasSemana) ? cfg.diasSemana : [3];
  const hoyDow = new Date().getDay();
  if (diasCfg.length > 0 && !diasCfg.includes(hoyDow)) return "";
  const lista = cfg.tamanosConRefresco || [
    "grande",
    "familiar",
    "jumbo",
    "mega"
  ];
  const hayPizza = Array.isArray(estado.ingredientes) && estado.ingredientes.length > 0;
  const tam = estado.tamano;
  if (hayPizza && tam && lista.includes(tam)) {
    return cfg.mensajeCliente || cfg.mensajeSiNoHayTamano || "";
  }
  if (estado.desdePromoPedido && cfg.mensajeSiNoHayTamano) {
    return cfg.mensajeSiNoHayTamano;
  }
  return "";
}

function resumenDetalladoPedidoParaCliente(estado) {
  const { precioPizza, cb, ext, total } = subtotalesPedidoActuales(estado);
  const lines = [];

  if (estado.referenciaPromoCliente) {
    lines.push(`🏷 *Pedido / promo:* ${estado.referenciaPromoCliente}`);
  }

  const pizzaLine = lineaPizzaEmoji(estado);
  if (pizzaLine) {
    lines.push(pizzaLine);
    if (estado.tamano) lines.push(`📏 ${estado.tamano}`);
    if (estado.ingredientes?.length === 2 && restaurante?.mitadMitad?.notaPrecio) {
      lines.push(`_${restaurante.mitadMitad.notaPrecio}_`);
    }
    if (estado.tamano) lines.push(`💲 Pizza: $${precioPizza}`);
  }

  if (cb.resumen) {
    lines.push(`🍟🥤 ${cb.resumen}`);
    lines.push(`💲 Complementos y bebidas: $${cb.total}`);
  }

  if (ext) {
    lines.push(`✨ Extras: ${(estado.extrasLineas || []).join(", ")}`);
    lines.push(`💲 Extras: $${ext}`);
  }

  const hayCobro = precioPizza > 0 || cb.total > 0 || ext > 0;
  if (hayCobro) {
    lines.push("");
    lines.push(`💲 *Total: $${total}*`);
  } else if (estado.referenciaPromoCliente && !pizzaLine && !cb.resumen) {
    lines.push("");
    lines.push("_El detalle y cobro los confirma reparto o asesor._");
  }

  const ref = textoBloqueRecordatorioRefresco(estado);
  if (ref) {
    lines.push("");
    lines.push(ref);
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function sugerenciaVentaContextual(estado, contexto = "general") {
  estado.upsellHintsShown = estado.upsellHintsShown || {};
  if (estado.upsellHintsShown[contexto]) return "";

  const tienePizza = Array.isArray(estado.ingredientes) && estado.ingredientes.length > 0;
  const totalComp = Number(totalesComplementosYBebidas(estado).total || 0);
  const tieneCompOBeb = totalComp > 0;
  const bebidas = Array.isArray(estado.lineasBebida) ? estado.lineasBebida.length : 0;

  let msg = "";
  if (tienePizza && !tieneCompOBeb) {
    msg = "💡 Tip: agrega *papas* o *bebida* para cerrar tu pedido completo.";
  } else if (tieneCompOBeb && bebidas === 0) {
    msg = "💡 Tip: muchos clientes agregan una *bebida* para acompañar.";
  } else if (!tienePizza && tieneCompOBeb) {
    msg = "💡 Si quieres, también puedes agregar una *pizza* (opción 3).";
  }

  if (msg) estado.upsellHintsShown[contexto] = true;
  return msg;
}

function textoPidePromos(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /\b(promo|promocion|promociones|oferta|ofertas)\b/.test(x);
}

function textoPideRecomendacion(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /(recomiend|suger|que\s+me\s+recomiendas|que\s+me\s+sugieres)/.test(x);
}

function textoPidePedidoRapido(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /(pedido\s+rapido|rapido|express|pedido\s+express)/.test(x);
}

function textoPideFinalizar(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /(finalizar|terminar|cerrar\s+pedido|listo\s+para\s+pagar)/.test(x);
}

function textoPideRepetirUltimo(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /(repetir\s+ultimo|lo\s+mismo\s+de\s+siempre|el\s+mismo\s+pedido|repite\s+mi\s+pedido)/.test(x);
}

function textoPideVolverMenu(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /^(menu|inicio|volver|regresar|principal)$/.test(x);
}

function textoPideAyudaBot(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /^(ayuda|help|no\s+entiendo|como\s+funciona)$/.test(x);
}

function normalizarOpcionNumerica(textoClean) {
  const raw = String(textoClean || "").trim();
  const x = sinAcentos(normalizarTextoPedido(raw));
  const mapa = {
    "¹": "1",
    "²": "2",
    "³": "3",
    uno: "1",
    una: "1",
    dos: "2",
    tres: "3",
    cuatro: "4",
    cinco: "5"
  };
  if (/^[1-5]$/.test(x)) return x;
  return mapa[raw] || mapa[x] || null;
}

function detectarOpcionMenuPrincipal(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  const n = normalizarOpcionNumerica(textoClean);
  if (n) return n;
  if (/(menu|ver menu|pizzas|carta)/.test(x)) return "1";
  if (/(promo|promocion|oferta)/.test(x)) return "2";
  if (/(pedido|ordenar|comprar|quiero pizza)/.test(x)) return "3";
  if (/(complemento|bebida|papas|alitas|boneless)/.test(x)) return "4";
  if (/(asesor|humano|persona)/.test(x)) return "5";
  return null;
}

function textoMenuPrincipal() {
  const nom = restaurante.nombreNegocio || "Restaurante";
  return `👋 *${nom}*

1️⃣ Ver menú 🍕
2️⃣ Promociones 🔥
3️⃣ Hacer pedido 🛒
4️⃣ Complementos y bebidas 🍟🥤
5️⃣ Hablar con alguien 👨‍💼

Escribe número o texto (ej. "promos", "pedido").`;
}

function snapshotPedido(estado) {
  return {
    ingredientes: [...(estado.ingredientes || [])],
    tamano: estado.tamano || null,
    complementos: { ...(estado.complementos || {}) },
    lineasComplemento: Array.isArray(estado.lineasComplemento)
      ? estado.lineasComplemento.map((x) => ({ ...x }))
      : [],
    lineasBebida: Array.isArray(estado.lineasBebida)
      ? estado.lineasBebida.map((x) => ({ ...x }))
      : [],
    extrasActivos: { ...(estado.extrasActivos || {}) },
    extrasTotal: Number(estado.extrasTotal || 0),
    extrasLineas: [...(estado.extrasLineas || [])]
  };
}

function limpiarMetadatosPromoPedido(estado) {
  estado.desdePromoPedido = false;
  estado.referenciaPromoCliente = null;
}

// 🔍 INGREDIENTES / sabores (dinámico desde `menu` + alias en `restaurant.json`)
function detectarIngredientes(texto) {
  const t = sinAcentos(normalizarTextoPedido(texto));
  const pizzas = detectCache.pizzasOrdenadas;
  const encontrados = new Set();

  for (const row of detectCache.pizzasNorm) {
    if (row.norm && t.includes(row.norm)) encontrados.add(row.raw);
  }

  for (const row of detectCache.aliasIngredientes) {
    if (row.alias && t.includes(row.alias)) encontrados.add(row.canonical);
  }

  const tokens = t.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  for (const p of pizzas) {
    const pn = sinAcentos(p);
    if (encontrados.has(p)) continue;
    if (!pn || pn.length < 4) continue;
    for (const w of tokens) {
      if (Math.abs(w.length - pn.length) > 3) continue;
      if (levenshtein(w, pn) <= 2) {
        encontrados.add(p);
        break;
      }
    }
  }

  return [...encontrados];
}

// 📏 DETECTAR TAMAÑO
function detectarTamano(texto) {
  texto = texto.toLowerCase();

  if (texto.includes("mediana")) return "mediana";
  if (texto.includes("grande")) return "grande";
  if (texto.includes("familiar")) return "familiar";
  if (texto.includes("jumbo")) return "jumbo";
  if (texto.includes("mega")) return "mega";

  return null;
}

function esConsultaPrecio(t) {
  const x = sinAcentos(normalizarTextoPedido(t));
  return (
    /(\bcuanto\b|\bcuánto\b|precio|cuesta|vale|\bcosto\b|\$\s*\d)/.test(x) ||
    /(cuanto sale|a como)/.test(x)
  );
}

function esPreguntaHorarioServicioPromoCombo(t) {
  const x = sinAcentos(normalizarTextoPedido(t));
  return (
    /(horario|abren|abre|cierran|cierra|^\s*hola\s*horario)/.test(x) ||
    /(domicilio|repart(o|en)|entreg(an|a)|servicio)/.test(x) ||
    /(promo|promocion|oferta)/.test(x) ||
    /(combo|paquete)/.test(x)
  );
}

function listaTriggersCsv(s) {
  return String(s || "")
    .split(",")
    .map((x) => sinAcentos(normalizarTextoPedido(x)))
    .filter(Boolean);
}

function buscarRespuestaFaq(t) {
  const x = sinAcentos(normalizarTextoPedido(t));
  const faqs = restaurante?.faqs || [];
  for (const f of faqs) {
    const triggers = listaTriggersCsv(f.triggers);
    for (const tr of triggers) {
      if (tr && x.includes(tr)) return f.respuesta ?? f.resuesta ?? null;
    }
  }
  return null;
}

function responderServicioHorarioPromoCombo(t) {
  const x = sinAcentos(normalizarTextoPedido(t));
  const partes = [];
  if (/(horario|abren|abre|cierran|cierra)/.test(x)) {
    partes.push(`🕒 Horario: ${restaurante.horarioTexto}`);
    if (!estaAbierto()) {
      partes.push("⏰ Ahorita estamos *cerrados* según este horario.");
    }
  }
  if (/(domicilio|repart(o|en)|entreg(an|a)|servicio)/.test(x)) {
    partes.push(
      restaurante.servicioDomicilio
        ? restaurante.servicioDomicilioTexto
        : "Por el momento no tenemos servicio a domicilio."
    );
  }
  if (/(promo|promocion|oferta)/.test(x)) partes.push(`🔥 Promos: ${restaurante.promocionesTexto}`);
  if (/(combo|paquete)/.test(x)) partes.push(`🧺 Combos: ${restaurante.combosTexto}`);
  if (!partes.length) return null;
  return partes.join("\n\n");
}

function obtenerCombosVigentesHoy(fecha = new Date()) {
  const promos = obtenerPromosVigentes(fecha);
  const isCombo = (p) => {
    const id = String(p?.id || "");
    const titulo = String(p?.titulo || "");
    const texto = String(p?.textoCliente || "");
    return /combo/i.test(id) || /combo/i.test(titulo) || /combo/i.test(texto) || /paquete/i.test(id);
  };
  return promos.filter(isCombo);
}

function detectarNumeroEnTexto(textoClean) {
  const raw = String(textoClean || "");
  const m = raw.match(/(?:^|\D)(\d{1,2})(?:\D|$)/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function detectarComboPorPalabras(textoClean, combo) {
  const x = String(textoClean || "");
  const t = sinAcentos(String(combo?.titulo || "").toLowerCase());
  const tc = sinAcentos(String(combo?.textoCliente || "").toLowerCase());
  const includes = Array.isArray(combo?.incluye) ? combo.incluye.join(" ").toLowerCase() : "";
  const ti = sinAcentos(includes);

  const has = (w) => x.includes(w);
  const containsCombo = (w) => t.includes(w) || tc.includes(w) || ti.includes(w);

  const grupos = [
    { key: "alitas", kws: ["alitas", "wings"] },
    { key: "nuggets", kws: ["nuggets", "nugget"] },
    { key: "boneless", kws: ["boneless"] },
    { key: "papas", kws: ["papas", "francesa", "friet"] }
  ];

  let score = 0;
  for (const g of grupos) {
    const msgHit = g.kws.some((k) => has(k));
    if (!msgHit) continue;
    if (g.kws.some((k) => containsCombo(k))) score += 2;
    else score += 0;
  }
  return score;
}

function detectarComboSeleccion(textoClean, combosHoy) {
  const n = detectarNumeroEnTexto(textoClean);
  if (n && n >= 1 && n <= combosHoy.length) return { index: n - 1, combo: combosHoy[n - 1] };

  let best = { score: 0, index: null, combo: null };
  for (let i = 0; i < combosHoy.length; i++) {
    const score = detectarComboPorPalabras(textoClean, combosHoy[i]);
    if (score > best.score) {
      best = { score, index: i, combo: combosHoy[i] };
    }
  }
  if (best.combo && best.score > 0) return best;
  return null;
}

function diaLocalYyyyMmDd(d = new Date()) {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

function promoFechaVigente(p, hoyStr) {
  const v = p?.vigencia;
  if (!v) return true;
  const hoy = hoyStr || diaLocalYyyyMmDdEnZonaHoraria();
  if (v.desde && hoy < String(v.desde).trim()) return false;
  if (v.hasta && hoy > String(v.hasta).trim()) return false;
  return true;
}

function obtenerPromosVigentes() {
  const list = restaurante.promociones;
  if (!Array.isArray(list) || !list.length) return [];
  const dow = diaSemanaEnZonaHoraria();
  const hoyStr = diaLocalYyyyMmDdEnZonaHoraria();
  return list.filter((p) => {
    if (!p || !promoFechaVigente(p, hoyStr)) return false;
    const dias = p.diasSemana;
    if (!Array.isArray(dias) || dias.length === 0) return true;
    return dias.includes(dow);
  });
}

function formatearTextoPromoCliente(p) {
  if (!p) return "";
  const partes = [];
  const incluye = Array.isArray(p.incluye) ? p.incluye.filter(Boolean) : [];
  const precioNum = Number(p.precio);

  if (incluye.length) {
    partes.push("✅ Incluye:");
    partes.push(...incluye.map((x) => `• ${x}`));
  }
  if (Number.isFinite(precioNum) && precioNum > 0) {
    partes.push(`💲 Precio: *$${precioNum}*`);
  }
  if (p.nota) {
    partes.push(`📝 ${String(p.nota).trim()}`);
  }

  // Compatibilidad: si no hay estructura nueva, usa textoCliente tal cual.
  if (!partes.length) {
    const txt = String(p.textoCliente || "").trim();
    return txt;
  }
  // Si también hay textoCliente, lo agrega al final como detalle extra.
  const txt = String(p.textoCliente || "").trim();
  if (txt) partes.push(txt);
  return partes.join("\n");
}

function buscarRespuestaPromoActiva(estado, textoClean) {
  if (estado.paso !== "promo" || !estado.promoActivaId) return null;
  const p = (restaurante.promociones || []).find((x) => x.id === estado.promoActivaId);
  if (!p) return null;
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  if (
    /(refresco|bebida|coca|agua|soda|jugo)/.test(x) &&
    /(lleva|incluye|trae|vienen|dan|tiene)/.test(x)
  ) {
    if (p.incluyeRefresco === true) {
      return "✅ Sí: según esta promo *sí incluye refresco* (confírmanos al armar el pedido).";
    }
    if (p.incluyeRefresco === false) {
      return "ℹ️ Esta promo *no indica refresco incluido*; te lo confirmamos al pedir o con un asesor.";
    }
    return "ℹ️ El refresco depende de cómo esté armada la promo; confirma al hacer tu pedido.";
  }
  if (
    /(aplica|puedo|vale\s+con|sirve\s+con)/.test(x) &&
    /(pastor|hawaian|peperon|pepperon|vegetar)/.test(x)
  ) {
    const ings = detectarIngredientes(textoClean);
    const exc = (p.saboresExcluidos || []).map((s) => sinAcentos(String(s).toLowerCase()));
    for (const ing of ings) {
      if (exc.includes(sinAcentos(ing))) {
        return `ℹ️ *${ing}* aparece como *no incluido* en esta promo. Puedes pedir otra pizza o armar pedido normal (opción 3).`;
      }
    }
    const inc = p.saboresPermitidos;
    if (Array.isArray(inc) && inc.length && ings.length) {
      const permitido = (nom) =>
        inc.some((i) => sinAcentos(String(i).toLowerCase()) === sinAcentos(nom));
      const mal = ings.filter((i) => !permitido(i));
      if (mal.length) {
        return `ℹ️ En esta promo los sabores van acotados. *${mal[0]}* puede no aplicar; revisa el texto de la promo o pide con un asesor.`;
      }
    }
  }
  if (/(tamano|talla|medida|mediana|grande|familiar|jumbo|mega)/.test(x)) {
    const t = p.tamanosAplica;
    if (!Array.isArray(t) || !t.length) {
      return "ℹ️ Esta promo aplica en tamaños habituales; al pedir te confirmamos el tuyo.";
    }
    return `ℹ️ Tamaños señalados para esta promo: *${t.join(", ")}*.`;
  }
  return null;
}

function detectarSaludoOMenu(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  if (!x) return false;
  if (x === "menu" || x === "inicio") return true;
  return (
    /^hola\b/.test(x) ||
    /^hey\b/.test(x) ||
    /^buenas\b/.test(x) ||
    /^saludos\b/.test(x) ||
    /^buenos\b/.test(x) ||
    /\bque\s+tal\b/.test(x) ||
    /^buen\s+dia\b/.test(x) ||
    /^buenos\s+dias\b/.test(x) ||
    /^buenas\s+tardes\b/.test(x) ||
    /^buenas\s+noches\b/.test(x) ||
    /^que\s+hay\b/.test(x)
  );
}

function esPreguntaIngredientesPizza(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return /(?:que\s+lleva|que\s+tiene|lleva\s+que|ingredientes?\s+(?:de|del|de\s+la)?|de\s+que\s+(?:es|esta)|descripcion|describe|con\s+que\s+viene)/.test(
    x
  );
}

function mapaRebanadasPorTamano() {
  const m = restaurante?.rebanadasPorTamano;
  if (!m || typeof m !== "object") {
    return { mediana: 8, grande: 10, familiar: 12, jumbo: 20, mega: 40 };
  }
  return m;
}

function textoRebanadasParaPrompt() {
  const map = mapaRebanadasPorTamano();
  const orden = ["mediana", "grande", "familiar", "jumbo", "mega"];
  return orden
    .filter((t) => map[t] != null)
    .map((t) => `- ${t}: ${map[t]} rebanadas`)
    .join("\n");
}

function esPreguntaRebanadas(textoClean) {
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  return (
    /\b(rebanada|rebanadas|porcion|porciones|pedazo|pedazos|tajada|tajadas)\b/.test(x) ||
    /\bcuantas?\s+.*(rebanada|porcion|pedazo)/.test(x) ||
    /\b(trae|vienen|tiene)\s+.*(rebanada|porcion|pedazo)/.test(x) ||
    /\bde\s+cuantas?\s+(rebanada|porcion)/.test(x)
  );
}

function responderConsultaRebanadas(textoClean) {
  if (!esPreguntaRebanadas(textoClean)) return null;
  const map = mapaRebanadasPorTamano();
  const orden = ["mediana", "grande", "familiar", "jumbo", "mega"];
  const tam = detectarTamano(textoClean);
  if (tam && map[tam] != null) {
    return `🍕 La pizza *${tam}* trae *${map[tam]} rebanadas* 😊\n\n¿Te armo un pedido?`;
  }
  const lineas = orden
    .filter((t) => map[t] != null)
    .map((t) => `• *${capitalizar(t)}*: ${map[t]} rebanadas`);
  if (!lineas.length) return null;
  return `🍕 *Rebanadas por tamaño:*\n${lineas.join("\n")}\n\n¿Quieres ordenar? Dime sabor y tamaño 🍕😊`;
}

const PASOS_SIN_CONSULTA_DESCRIPCION = new Set([
  "cantidad_complemento",
  "agregar_mas",
  "confirmar",
  "confirmar_complementos",
  "elegir_salsa_complemento",
  "clarificar_salsa_mitad_o_dos",
  "resolver_ambiguedad_complemento",
  "direccion",
  "esperando_humano"
]);

function puedeResponderConsultaDescripcion(paso) {
  return !PASOS_SIN_CONSULTA_DESCRIPCION.has(paso);
}

/** Respuesta local desde descripcionesMap si hay una sola pizza detectada. */
function textoDescripcionLocalPizza(textoClean) {
  const ings = detectarIngredientes(textoClean);
  if (ings.length !== 1) return null;
  const d = descripcionesMap[ings[0]];
  if (!d || (!d.ingredientesTexto && !d.descripcion)) return null;
  const tit = capitalizar(ings[0]);
  let msg = `🍕 *${tit}*`;
  if (d.ingredientesTexto) msg += `\n📋 ${d.ingredientesTexto}`;
  if (d.descripcion) msg += `\n_${d.descripcion}_`;
  return msg;
}

/**
 * Pregunta de ingredientes/descripción: Groq con contexto del menú.
 * No pide tamaño ni entra al flujo de pedido.
 * @returns {Promise<boolean>} true si ya respondió al cliente
 */
async function manejarConsultaDescripcionPizza(sock, from, quien, textoClean) {
  if (!esPreguntaIngredientesPizza(textoClean)) return false;

  const local = textoDescripcionLocalPizza(textoClean);
  if (local) {
    await sock.sendMessage(from, { text: local });
    return true;
  }

  const contexto = construirContextoCatalogo();
  const r = await preguntarAGroqConIndicador(sock, from, quien, textoClean, contexto);
  if (r.manejado) return true;
  if (r.texto) {
    await sock.sendMessage(from, { text: r.texto });
    return true;
  }

  const ings = detectarIngredientes(textoClean);
  if (ings.length === 0) {
    await sock.sendMessage(from, {
      text: "🍕 Dime el *nombre de la pizza* (ej. ¿qué lleva la hawaiana?)"
    });
    return true;
  }
  return false;
}

async function responderDescripcionPizza(textoClean, sock, from, quien) {
  if (!esPreguntaIngredientesPizza(textoClean)) return null;

  const local = textoDescripcionLocalPizza(textoClean);
  if (local) return local;

  const contexto = construirContextoCatalogo();
  if (sock && from) {
    const r = await preguntarAGroqConIndicador(sock, from, quien, textoClean, contexto);
    if (r.manejado) return GROQ_MANEJADO_SENTINEL;
    if (r.texto) return r.texto;
    return null;
  }

  const respGroq = await responderConGroq(textoClean, contexto);
  if (respGroq && respGroq.trim() && !/^ESCALAR\b/i.test(respGroq.trim())) {
    return respGroq.trim();
  }
  if (detectarIngredientes(textoClean).length === 0) {
    return "🍕 Dime el *nombre de la pizza* (ej. ¿qué lleva la hawaiana?)";
  }
  return null;
}

function precioDeExtra(ex, tamano) {
  const por = ex?.precioPorTamano;
  if (por && typeof por === "object" && tamano) {
    const k = sinAcentos(String(tamano).toLowerCase());
    if (por[k] != null && !Number.isNaN(Number(por[k]))) return Number(por[k]);
  }
  const b = Number(ex?.precio);
  return Number.isNaN(b) ? 0 : b;
}

function coincidenciaExtraEnTexto(ex, tNormalizado) {
  const clave = sinAcentos(String(ex.nombre || "").toLowerCase());
  if (!clave) return false;
  const als = String(ex.aliases || "")
    .split(",")
    .map((a) => sinAcentos(normalizarTextoPedido(a)))
    .filter(Boolean);
  const candidatos = [clave, ...als];
  return candidatos.some((c) => c && tNormalizado.includes(c));
}

function detectarExtrasEnTexto(textoClean, tamano) {
  const t = sinAcentos(normalizarTextoPedido(textoClean));
  const lineas = [];
  let total = 0;
  const extras = restaurante?.extras || [];
  const vistos = new Set();
  for (const ex of extras) {
    const clave = sinAcentos(String(ex.nombre || "").toLowerCase());
    if (!clave || !coincidenciaExtraEnTexto(ex, t)) continue;
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    const precio = precioDeExtra(ex, tamano);
    total += precio;
    lineas.push(`${ex.nombre}${precio ? ` +$${precio}` : ""}`);
  }
  return { total, lineas };
}

function recalcularExtrasTotal(estado) {
  const extras = restaurante?.extras || [];
  const tam = estado.tamano || null;
  estado.extrasActivos = estado.extrasActivos || {};
  let total = 0;
  const lineas = [];
  for (const ex of extras) {
    const clave = sinAcentos(String(ex.nombre || "").toLowerCase());
    if (!clave || !estado.extrasActivos[clave]) continue;
    const precio = precioDeExtra(ex, tam);
    total += precio;
    lineas.push(`${ex.nombre}${precio ? ` +$${precio}` : ""}`);
  }
  estado.extrasTotal = total;
  estado.extrasLineas = lineas;
}

function mergeExtrasEnEstado(estado, textoClean) {
  const t = sinAcentos(normalizarTextoPedido(textoClean));
  estado.extrasActivos = estado.extrasActivos || {};
  for (const ex of restaurante?.extras || []) {
    if (!coincidenciaExtraEnTexto(ex, t)) continue;
    const clave = sinAcentos(String(ex.nombre || "").toLowerCase());
    estado.extrasActivos[clave] = true;
  }
  recalcularExtrasTotal(estado);
}

function resolverConsultaPrecio(textoClean) {
  const t = sinAcentos(normalizarTextoPedido(textoClean));
  if (!esConsultaPrecio(textoClean)) return null;

  for (const c of complementosItems) {
    const cn = sinAcentos(normalizarTextoPedido(c.nombre));
    if (cn && t.includes(cn)) {
      return `💲 *${capitalizar(c.nombre)}*: $${c.precio}`;
    }
  }

  for (const b of bebidasItems) {
    const bn = sinAcentos(normalizarTextoPedido(b.nombre));
    if (bn && t.includes(bn)) {
      return `🥤 *${capitalizar(b.nombre)}*: $${b.precio}`;
    }
  }

  const tam = detectarTamano(textoClean);
  const ings = detectarIngredientes(textoClean);
  const extrasInfo = detectarExtrasEnTexto(textoClean, tam);
  const mitadFrase =
    /(mitad\s*y\s*mitad|media\s*y\s*media|dos\s*sabores|combinad(a|o))/.test(
      t
    );

  if (mitadFrase) {
    if (!restaurante?.mitadMitad?.permitido) {
      return "🍕 Mitad y mitad: mejor confírmalo con un asesor para tu caso.";
    }
    if (ings.length >= 2 && tam) {
      const p = calcularPrecio(ings.slice(0, 2), tam);
      const ex = extrasInfo.total ? `\n\nExtras: ${extrasInfo.lineas.join(", ")} (≈ +$${extrasInfo.total})` : "";
      return `🍕 Mitad *${ings[0]}* y mitad *${ings[1]}* (${tam}): *$${p}*\n_${restaurante.mitadMitad?.notaPrecio || ""}_${ex}`;
    }
    if (ings.length === 1 && tam) {
      return `🍕 Para mitad y mitad necesito el *segundo sabor* (ya tengo: ${ings[0]}, ${tam}).`;
    }
    if (ings.length >= 2 && !tam) {
      return "📏 Para mitad y mitad dime también el *tamaño* (mediana, grande, etc.).";
    }
    if (mitadFrase && ings.length < 2) {
      return `🍕 Sí se puede mitad y mitad: dime *los 2 sabores* y el *tamaño*.\n_${restaurante.mitadMitad?.notaPrecio || ""}_`;
    }
  }

  if (tam && ings.length === 0) {
    // Si el cliente solo pide "precio de la grande" sin sabor,
    // pedimos el ingrediente para responder exacto.
    return `💲 Sí: ¿de qué *sabor* quieres la *${tam}*? (ej. *hawaiana*, *peperoni*)`;
  }

  if (ings.length === 1 && !tam) {
    const por = menu[ings[0]];
    if (!por) return null;
    const lineas = Object.entries(por).map(([k, v]) => `${k}: $${v}`);
    let msg = `💲 *${capitalizar(ings[0])}*:\n${lineas.join("\n")}`;
    if (extrasInfo.lineas.length) {
      msg += `\n\nExtras detectados: ${extrasInfo.lineas.join(", ")}`;
    }
    return msg;
  }

  if (ings.length === 1 && tam) {
    const pr = menu[ings[0]]?.[tam];
    if (pr == null) return null;
    let msg = `💲 *${capitalizar(ings[0])}* ${tam}: *$${pr}*`;
    if (extrasInfo.total) {
      msg += `\nExtras: ${extrasInfo.lineas.join(", ")} → total aprox *$${pr + extrasInfo.total}*`;
    }
    return msg;
  }

  if (ings.length === 0 && !tam) {
    return "💰 Dime *sabor* o *tamaño* (ej. “grande hawaiana” o “precio de alitas”).";
  }

  return null;
}

function esConsultaMitadMitadSoloPregunta(textoClean) {
  const t = sinAcentos(normalizarTextoPedido(textoClean));
  const mitadFrase =
    /(mitad\s*y\s*mitad|media\s*y\s*media|dos\s*sabores)/.test(t);
  if (!mitadFrase) return false;
  if (!/(puedo|se puede|aceptan|hacen|tienen|permiten|hay|opcion)/.test(t)) {
    return false;
  }
  const ings = detectarIngredientes(textoClean);
  return ings.length < 2;
}

function requiereHumPorTriggers(textoClean) {
  const t = sinAcentos(normalizarTextoPedido(textoClean));
  const tr = listaTriggersCsv(restaurante?.escalamientoHumano?.triggers);
  for (const p of tr) {
    if (p && t.includes(p)) return true;
  }
  return false;
}

function requiereHumPorAlitasComplejas(textoClean) {
  const t = sinAcentos(normalizarTextoPedido(textoClean));
  const tr = listaTriggersCsv(restaurante?.alitasBonelessComplejo?.triggers);
  if (!/\b(alitas|boneless|wings)\b/.test(t)) return false;
  for (const p of tr) {
    if (p && t.includes(p)) return true;
  }
  return false;
}

async function procesarConsultasPorComas(sock, from, textoClean, quien) {
  if (!textoClean.includes(",")) return false;
  const partes = textoClean
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (partes.length < 2) return false;

  const salidas = [];
  for (const p of partes) {
    const rPrecio = resolverConsultaPrecio(p);
    const rFaq = !rPrecio ? buscarRespuestaFaq(p) : null;
    let rDesc = null;
    if (!rPrecio && !rFaq) {
      rDesc = await responderDescripcionPizza(p, sock, from, quien);
      if (rDesc === GROQ_MANEJADO_SENTINEL) return true;
    }
    let out =
      rPrecio || rFaq || rDesc || responderServicioHorarioPromoCombo(p);
    if (!out && esPreguntaHorarioServicioPromoCombo(p)) {
      out = responderServicioHorarioPromoCombo(p);
    }
    if (out) salidas.push(out);
  }

  if (!salidas.length) return false;
  await sock.sendMessage(from, {
    text: salidas.join("\n\n────────\n\n")
  });
  return true;
}

async function derivarPedidoAHumano(sock, from, estado, quien, detalle = "") {
  const resumen = resumenDetalladoPedidoParaCliente(estado);
  const extra = String(detalle || "").trim();
  await sendText(
    sock,
    from,
    estado,
    `✅ *¡Listo!* Ya tomé tu pedido.\n\nTe paso con un asesor para confirmar los últimos detalles.`
  );
  const payload = `👨‍💼 *CONFIRMAR PEDIDO (HUMANO)*\n\n📞 ${quien}\nJID: ${from}\n\n${resumen || "(sin resumen)"}${extra ? `\n\n📌 Nota: ${extra}` : ""}`;
  await notificarUrgenteMovil(sock, {
    waTitulo: "CONFIRMAR PEDIDO HUMANO",
    waDetalle: payload,
    tgTexto: payload
  });
  await registrarEventoMetricas("pedido_derivado_humano", {
    from,
    paso: estado.paso || "?",
    conPizza: Array.isArray(estado.ingredientes) && estado.ingredientes.length > 0,
    lineasComplemento: (estado.lineasComplemento || []).length,
    lineasBebida: (estado.lineasBebida || []).length
  });

  // Persistimos el pedido en Firestore (sin dirección; lo confirma el asesor).
  try {
    const { precioPizza, cb, ext, total } = subtotalesPedidoActuales(estado);
    const telefono = String(from || "").replace(/@.+$/, "");
    await guardarPedido({
      cliente: quien || "Cliente",
      telefono,
      pedido: resumen || lineaPizzaEmoji(estado) || "Pedido",
      total: Number(total || precioPizza || 0)
    });
  } catch (err) {
    console.error("❌ Error guardando pedido derivado en Firestore:", err?.message || err);
  }

  // Persistencia local (mantener tu comportamiento actual).
  try {
    const { precioPizza, cb, ext, total } = subtotalesPedidoActuales(estado);
    const pedidoGuardar = `
------------------------
Cliente: ${from}
Referencia: ${estado.referenciaPromoCliente || ""}
Pedido: ${lineaPizzaEmoji(estado) || "—"}
Complementos: ${cb.resumen || ""}
Extras: ${(estado.extrasLineas || []).join("; ")}
Precio total: $${total}
Nota asesor: ${extra || "Pendiente de confirmación por asesor"}
Fecha: ${new Date().toLocaleString()}
`;
    await registrarPedidoEnStorage(pedidoGuardar);
    ultimoPedidoPorCliente[from] = snapshotPedido(estado);
  } catch (err) {
    console.error("❌ Error guardando pedido derivado local:", err?.message || err);
  }

  // Pausa el bot esperando confirmación del humano.
  estado.paso = "esperando_humano";
  estado.esperandoHumanoHasta = Date.now() + 8 * 60 * 1000; // 8 min
}

async function aplicarPostEleccionSalsa(sock, from, estado, quien) {
  const salsaInfo = estado.tempSalsa;
  if (!salsaInfo) return;

  if (estado.tempCantidadPre != null) {
    const cantidad = estado.tempCantidadPre;
    delete estado.tempCantidadPre;
    const comp = estado.tempComplemento;
    if (!estado.lineasComplemento) estado.lineasComplemento = [];
    estado.lineasComplemento.push({
      nombre: comp,
      cantidad,
      salsaEtiqueta: salsaInfo.label,
      extraMitadSalsa: Number(salsaInfo.extraMitadSalsa) || 0
    });
    delete estado.tempSalsa;
    estado.complementos[comp] = (estado.complementos[comp] || 0) + cantidad;

    const extraTxt = salsaInfo.extraMitadSalsa
      ? ` +$${salsaInfo.extraMitadSalsa} mix`
      : "";
    await sock.sendMessage(from, {
      text: `✅ ${cantidad} *${comp}* (${salsaInfo.label})${extraTxt}`
    });

    const sig = extraerPrimeroComplementoQueRequiereSalsa(estado);
    if (sig) {
      estado.tempComplemento = sig.nombre;
      estado.tempCantidadPre = sig.cantidad;
      estado.paso = "elegir_salsa_complemento";
      await sock.sendMessage(from, {
        text: textoMenuSalsasAlitas()
      });
      return;
    }

    if (estado.direccionPendienteTexto) {
      const td = estado.direccionPendienteTexto;
      delete estado.direccionPendienteTexto;
      await derivarPedidoAHumano(sock, from, estado, quien, td);
      return;
    }

    const mencionoPizza =
      (estado.ingredientes?.length > 0) || Boolean(estado.tamano);
    if (!mencionoPizza) {
      estado.paso = "confirmar";
      const rd = resumenDetalladoPedidoParaCliente(estado);
      await sock.sendMessage(from, {
      text: `✅ *¡Listo!*\n\n${rd}\n\nEscribe *confirmar* y te paso con un asesor para cerrar tu pedido.`
      });
      return;
    }
    if (!estado.ingredientes?.length) {
      estado.paso = "pedido";
      await sock.sendMessage(from, {
        text: "🍕 ¿De qué sabor la pizza? (peperoni, hawaiana, etc)"
      });
      return;
    }
    if (!estado.tamano) {
      estado.paso = "tamano";
      await sock.sendMessage(from, {
        text: TEXTO_MENU_TAMANOS
      });
      return;
    }
    estado.paso = "confirmar";
    const rd2 = resumenDetalladoPedidoParaCliente(estado);
    await sock.sendMessage(from, {
      text: `✅ *Checa tu pedido*\n\n${rd2}\n\nEscribe *confirmar* y te paso con un asesor para cerrarlo.`
    });
    return;
  }

  estado.paso = "cantidad_complemento";
  await sock.sendMessage(from, {
    text: `🔢 ¿Cuántas ${estado.tempComplemento} deseas?`
  });
}

async function startBot() {
  const { useFirestoreAuthState } = require("./baileys-firestore-auth-state");
  menu = await cargarMenu();
  const comp = await cargarComplementos();
  complementosItems = comp.items;
  complementosMenu = comp.menu;
  const beb = await cargarBebidas();
  bebidasItems = beb.items;
  bebidasMenu = beb.menu;
  descripcionesMap = await cargarDescripciones();
  rebuildDetectCache();
  initFuzzyCarly();
  inicializarRestauranteCache();
  const { state, saveCreds } = await useFirestoreAuthState();

  const sock = makeWASocket({
    auth: state,
    browser: ["Windows", "Chrome", "120.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    ultimoQR = qr;
    console.log(" Escanea este QR:");
    qrcode.generate(qr, { small: true });
  }

  if (connection === "open") {
    console.log("✅ BOT CONECTADO");
  }

  if (connection === "close") {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const errMsg = String(
      lastDisconnect?.error?.message ||
      lastDisconnect?.error?.output?.payload?.message ||
      ""
    ).toLowerCase();

    const esConflictOReplaced =
      statusCode === DisconnectReason?.connectionReplaced ||
      statusCode === DisconnectReason?.connectionLost ||
      /conflict|replaced/.test(errMsg);

    const esLoggedOut =
      statusCode === DisconnectReason?.loggedOut || statusCode === 401;

    console.log(
      `❌ Conexión cerrada (statusCode=${statusCode || "?"}, msg="${errMsg}")`
    );

    if (esLoggedOut) {
      // Sesión revocada: no reconectar automáticamente.
      // Las credenciales en Firestore se conservan; sólo se requiere re-escaneo de QR.
      console.log("🚫 Sesión cerrada (logout), necesitas escanear QR otra vez");
      return;
    }

    if (!reconnectScheduled) {
      reconnectScheduled = true;
      // Otra sesión abrió WhatsApp con este número: esperamos 5s y reintentamos
      // sin tocar las credenciales en Firestore.
      const delayMs = esConflictOReplaced ? 5000 : 1500;
      console.log(
        esConflictOReplaced
          ? `🔄 Conflict/replaced detectado, reintentando en ${delayMs}ms (creds intactas)...`
          : `🔄 Reintentando conexión en ${delayMs}ms...`
      );
      setTimeout(() => {
        reconnectScheduled = false;
        startBot();
      }, delayMs);
    }
  }
});

sock.ev.on("messages.upsert", async ({ messages }) => {
  try {
  const msg = messages[0];
  if (!msg.message) return;

  // ❌ IGNORAR MENSAJES DEL BOT
  if (msg.key.fromMe) return;

  const from = msg.key.remoteJid;
  // Solo chats 1:1; ignorar grupos (@g.us) y cualquier otro JID.
  if (!esChatIndividual(from)) return;
  if (esJidSistema(from)) return;

  const quien = etiquetaCliente(msg);

  if (
    estados[from]?.ultimaActividadAt &&
    Date.now() - estados[from].ultimaActividadAt > SESSION_INACTIVITY_MS
  ) {
    resetEstadoCliente(from, estados[from]);
  }

  const esNuevoCliente = !estados[from];
  if (!estados[from]) {
    estados[from] = nuevoEstadoCliente();
  }

  const estado = estados[from];
  estado.ultimaActividadAt = Date.now();

  const texto =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    "";

  const textoLower = texto.toLowerCase();
  const textoClean = sinAcentos(textoLower.trim());

  console.log("📩", from, textoClean);
  estado.lastUserMessageAt = Date.now();

  if (await manejarComandoAdmin(sock, from, texto)) return;

  const st = estados[from];
  if (!st) return;
  if (st.procesando) return;

  st.procesando = true;
  const liberarProcesando = () => {
    if (estados[from]) estados[from].procesando = false;
  };
  const watchdog = setTimeout(liberarProcesando, PROCESANDO_MAX_MS);

  try {
    await procesarConversacionCarly(
      sock,
      msg,
      from,
      quien,
      st,
      texto,
      textoClean,
      esNuevoCliente
    );
  } finally {
    clearTimeout(watchdog);
    liberarProcesando();
  }
  return;
  } catch (err) {
    console.error("❌ Error en messages.upsert:", err?.message || err);
  }

  });
}



const app = express();
app.get("/", (_req, res) => res.status(200).send("Bot activo"));

app.get("/qr", async (_req, res) => {
  try {
    if (!ultimoQR) return res.send("<h2>QR no listo, recarga en 5 segundos...</h2><script>setTimeout(()=>location.reload(),5000)</script>");
    const img = await QRCode.toDataURL(ultimoQR);
    res.send(`<img src="${img}" style="width:300px"/>`);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🌐 Servidor activo en puerto ${PORT}`);
  startBot();
});

