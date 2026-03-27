console.log("🔥 Bot iniciando...");

const { default: makeWASocket } = require("@whiskeysockets/baileys");
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

// Firestore (opcional). Si falta clave.json o falla la inicialización, el bot
// sigue funcionando con persistencia local.
let firestore = null;
try {
  ({ firestore } = require("./firebase"));
} catch (err) {
  firestore = null;
  console.warn("Firestore no disponible, usando persistencia local. Detalle:", err?.message || err);
}
let dialogflow = null;
try {
  dialogflow = require("@google-cloud/dialogflow");
} catch {
  dialogflow = null;
}

const DIALOGFLOW_PROJECT_ID = process.env.DIALOGFLOW_PROJECT_ID || "";
const DIALOGFLOW_LANGUAGE_CODE = process.env.DIALOGFLOW_LANGUAGE_CODE || "es";
const DIALOGFLOW_CONFIDENCE_MIN = Number(process.env.DIALOGFLOW_CONFIDENCE_MIN || 0.72);
const USE_DIALOGFLOW = !!(dialogflow && DIALOGFLOW_PROJECT_ID);
const dialogflowSessionClient = USE_DIALOGFLOW ? new dialogflow.SessionsClient() : null;
if (USE_DIALOGFLOW) {
  console.log(`🤖 Dialogflow activo (project: ${DIALOGFLOW_PROJECT_ID})`);
} else {
  console.log("🤖 Dialogflow inactivo (configura DIALOGFLOW_PROJECT_ID para activarlo)");
}

process.on("unhandledRejection", (reason) => {
  console.error("❌ unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("❌ uncaughtException:", err);
});




// 💲 PRECIOS
const MENU_SHEET_URL = "https://docs.google.com/spreadsheets/d/1NVibDl4n3VYDa5ZJbR9Rr1yX6vSrzJxAwRE0DrxMD38/edit?usp=sharing";

async function obtenerDatosMenuGoogleSheets() {
  const sheetIdMatch = MENU_SHEET_URL.match(/\/d\/([a-zA-Z0-9-_]+)/);
  const sheetId = sheetIdMatch?.[1] || "";
  if (!sheetId) return [];

  const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&sheet=menu`;
  const response = await axios.get(csvUrl, { responseType: "text" });
  const workbook = XLSX.read(response.data, { type: "string" });
  const sheet = workbook.Sheets["menu"] || workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json(sheet);
}

async function cargarMenu() {
  try {
    const data = await obtenerDatosMenuGoogleSheets();
    const menu = {};

    data.forEach((row) => {
      const pizza = row.pizza.toLowerCase().trim();
      const tamaño = row.tamaño.toLowerCase().trim();
      const precio = Number(row.precio);

      if (!menu[pizza]) {
        menu[pizza] = {};
      }

      menu[pizza][tamaño] = precio;
    });

    return menu;
  } catch {
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
let menuExcelMtimeMs = 0;
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
    }
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
      }
    };
  } catch {
    return defaultRestaurante();
  }
}

let restaurante = cargarRestaurante();

function inicializarExcelCache() {
  try {
    const st = fs.statSync("menu.xlsx");
    menuExcelMtimeMs = st.mtimeMs || 0;
  } catch {
    menuExcelMtimeMs = 0;
  }
}

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
  await Promise.all([recargarExcelSiCambioAsync(), recargarRestauranteSiCambioAsync()]);
}

async function recargarRestauranteSiCambioAsync() {
  try {
    const st = await fsp.stat("restaurant.json");
    const mtimeMs = st.mtimeMs || 0;
    if (mtimeMs && mtimeMs !== restauranteMtimeMs) {
      restauranteMtimeMs = mtimeMs;
      restaurante = cargarRestaurante();
      rebuildDetectCache();
      console.log("✅ restaurant.json recargado");
    }
  } catch {
    // ignorar
  }
}

async function recargarExcelSiCambioAsync() {
  try {
    const st = await fsp.stat("menu.xlsx");
    const mtimeMs = st.mtimeMs || 0;
    if (mtimeMs && mtimeMs !== menuExcelMtimeMs) {
      menuExcelMtimeMs = mtimeMs;
      menu = await cargarMenu();
      const comp = cargarComplementos();
      complementosItems = comp.items;
      complementosMenu = comp.menu;
      const beb = cargarBebidas();
      bebidasItems = beb.items;
      bebidasMenu = beb.menu;
      descripcionesMap = cargarDescripciones();
      rebuildDetectCache();
      console.log("✅ Excel recargado: menú, complementos, bebidas y descripciones actualizados");
    }
  } catch {
    // Si no se puede leer el archivo (por ejemplo, Excel lo tiene bloqueado),
    // simplemente se sigue usando la versión anterior en memoria.
  }
}

function sinAcentos(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
}

// Ignorar chats que no son clientes (historias, newsletters, etc.)
function esJidSistema(remoteJid) {
  if (!remoteJid || typeof remoteJid !== "string") return true;
  const j = remoteJid.toLowerCase();
  if (j === "status@broadcast") return true;
  if (j.endsWith("@newsletter")) return true;
  if (j === "broadcast") return true;
  return false;
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

// 🍟 COMPLEMENTOS (desde Excel)
function cargarComplementos() {
  const fallbackItems = [
    { nombre: "papas", precio: 50 },
    { nombre: "alitas", precio: 90 },
    { nombre: "boneless", precio: 100 }
  ];

  try {
    const workbook = XLSX.readFile("menu.xlsx");
    const sheet = workbook.Sheets["complementos"];
    if (!sheet) {
      const menuFallback = {};
      fallbackItems.forEach((c) => (menuFallback[c.nombre] = c.precio));
      return { items: fallbackItems, menu: menuFallback };
    }

    const data = XLSX.utils.sheet_to_json(sheet);
    const items = [];
    const menu = {};

    data.forEach((row) => {
      const rawNombre =
        row.complementos ?? row.complemento ?? row.nombre ?? row.item;
      const rawPrecio = row.precio;
      if (rawNombre == null) return;

      const nombre = String(rawNombre).toLowerCase().trim();
      const precio = Number(rawPrecio);
      if (!nombre || Number.isNaN(precio)) return;

      items.push({ nombre, precio });
      menu[nombre] = precio;
    });

    if (items.length === 0) {
      const menuFallback = {};
      fallbackItems.forEach((c) => (menuFallback[c.nombre] = c.precio));
      return { items: fallbackItems, menu: menuFallback };
    }

    return { items, menu };
  } catch {
    const menuFallback = {};
    fallbackItems.forEach((c) => (menuFallback[c.nombre] = c.precio));
    return { items: fallbackItems, menu: menuFallback };
  }
}

{
  const comp = cargarComplementos();
  complementosItems = comp.items;
  complementosMenu = comp.menu;
  const beb = cargarBebidas();
  bebidasItems = beb.items;
  bebidasMenu = beb.menu;
  descripcionesMap = cargarDescripciones();
  rebuildDetectCache();
}

function textoListaComplementos() {
  return complementosItems
    .map((c, idx) => `${idx + 1}️⃣ ${capitalizar(c.nombre)} - $${c.precio}`)
    .join("  \n");
}

function cargarBebidas() {
  const fallback = { items: [], menu: {} };
  try {
    const workbook = XLSX.readFile("menu.xlsx");
    const sheet = workbook.Sheets["bebidas"];
    if (!sheet) return fallback;
    const data = XLSX.utils.sheet_to_json(sheet);
    const items = [];
    const menuMap = {};
    data.forEach((row) => {
      const rawNombre =
        row.bebida ?? row.bebidas ?? row.nombre ?? row.item;
      const rawPrecio = row.precio;
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

function cargarDescripciones() {
  const map = {};
  try {
    const workbook = XLSX.readFile("menu.xlsx");
    const sheet = workbook.Sheets["descripciones"];
    if (!sheet) return map;
    const data = XLSX.utils.sheet_to_json(sheet);
    data.forEach((row) => {
      const pk =
        row.pizza != null
          ? String(row.pizza).toLowerCase().trim()
          : "";
      if (!pk || !menu[pk]) return;
      const ing =
        row.ingredientesTexto != null
          ? String(row.ingredientesTexto).trim()
          : row.ingredientes != null
            ? String(row.ingredientes).trim()
            : "";
      map[pk] = {
        descripcion:
          row.descripcion != null ? String(row.descripcion).trim() : "",
        ingredientesTexto: ing
      };
    });
  } catch {
    // vacío
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
  // Evita repetir el mismo bloque largo en segundos seguidos.
  const now = Date.now();
  if (
    estado &&
    estado.lastBotMessageText === t &&
    now - Number(estado.lastBotMessageAt || 0) < 2500
  ) {
    return;
  }
  await sock.sendMessage(to, { text: t });
  if (estado) {
    estado.lastBotMessageText = t;
    estado.lastBotMessageAt = now;
  }
}

async function detectarIntentDialogflow(sessionId, texto) {
  if (!USE_DIALOGFLOW || !dialogflowSessionClient) return null;
  const txt = String(texto || "").trim();
  if (!txt) return null;
  try {
    const sessionPath = dialogflowSessionClient.projectAgentSessionPath(
      DIALOGFLOW_PROJECT_ID,
      sessionId
    );
    const request = {
      session: sessionPath,
      queryInput: {
        text: { text: txt, languageCode: DIALOGFLOW_LANGUAGE_CODE }
      }
    };
    const [response] = await dialogflowSessionClient.detectIntent(request);
    const qr = response?.queryResult || {};
    const confidence = Number(qr.intentDetectionConfidence || 0);
    if (!qr.intent?.displayName || confidence < DIALOGFLOW_CONFIDENCE_MIN) return null;
    return {
      intent: qr.intent.displayName,
      confidence,
      fulfillment: String(qr.fulfillmentText || "").trim()
    };
  } catch (err) {
    console.error("❌ Dialogflow detectIntent error:", err?.message || err);
    return null;
  }
}

async function responderIntentDialogflow(sock, from, estado, textoClean) {
  const sessionId = String(from || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120);
  const hit = await detectarIntentDialogflow(sessionId, textoClean);
  if (!hit) return false;
  const i = sinAcentos(hit.intent.toLowerCase());

  if (/asesor|humano/.test(i)) {
    await sendText(sock, from, estado, "👨‍💼 Te paso con alguien del equipo en un momentito.");
    return true;
  }
  if (/carrito|resumen|total/.test(i)) {
    const rd = resumenDetalladoPedidoParaCliente(estado);
    await sendText(sock, from, estado, rd ? `🧾 *Así va tu pedido*\n\n${rd}` : "Todavía no tienes nada en el pedido.");
    return true;
  }
  if (/cancel/.test(i)) {
    resetEstadoCliente(from, estado);
    await sendText(sock, from, estado, "❌ Pedido cancelado.\n\nEscribe *hola* para empezar de nuevo.");
    return true;
  }
  if (hit.fulfillment) {
    await sendText(sock, from, estado, hit.fulfillment);
    return true;
  }
  return false;
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
    esperandoHumanoHasta: 0
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

    if (firestore) {
      // Best-effort: no bloquea el flujo del bot.
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

function estaAbierto() {
  const r = restaurante?.horarioAbierto;
  if (!r || !r.inicio || !r.fin) return true;
  const a = parseHorarioHHMM(r.inicio);
  const b = parseHorarioHHMM(r.fin);
  if (a == null || b == null) return true;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  if (b < a) return cur >= a || cur < b;
  return cur >= a && cur < b;
}

function porCerrar() {
  return false;
}

// 💰 PRECIO
// Calcula el precio usando la tabla cargada desde `menu.xlsx`.
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

function promoFechaVigente(p) {
  const v = p?.vigencia;
  if (!v) return true;
  const hoyStr = diaLocalYyyyMmDd();
  if (v.desde && hoyStr < String(v.desde).trim()) return false;
  if (v.hasta && hoyStr > String(v.hasta).trim()) return false;
  return true;
}

function obtenerPromosVigentes(fecha = new Date()) {
  const list = restaurante.promociones;
  if (!Array.isArray(list) || !list.length) return [];
  const dow = fecha.getDay();
  return list.filter((p) => {
    if (!p || !promoFechaVigente(p)) return false;
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
  return /(que\s+lleva|lleva\s+que|que\s+tiene|ingredientes|de\s+que\s+esta|descripcion|describe)/.test(
    x
  );
}

function responderDescripcionPizza(textoClean) {
  if (!esPreguntaIngredientesPizza(textoClean)) return null;
  const ings = detectarIngredientes(textoClean);
  if (ings.length >= 2) return null;
  if (ings.length === 1) {
    const d = descripcionesMap[ings[0]];
    const tit = capitalizar(ings[0]);
    if (d && (d.ingredientesTexto || d.descripcion)) {
      let msg = `🍕 *${tit}*`;
      if (d.ingredientesTexto) msg += `\n📋 ${d.ingredientesTexto}`;
      if (d.descripcion) msg += `\n_${d.descripcion}_`;
      return msg;
    }
    return `🍕 *${tit}*: aún no tengo la descripción en el Excel (hoja *descripciones*); pregunta con un asesor.`;
  }
  return "🍕 Dime el *nombre de la pizza* (ej. ¿qué lleva la hawaiana?)";
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

async function procesarConsultasPorComas(sock, from, textoClean) {
  if (!textoClean.includes(",")) return false;
  const partes = textoClean
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (partes.length < 2) return false;

  const salidas = [];
  for (const p of partes) {
    let out =
      resolverConsultaPrecio(p) ||
      buscarRespuestaFaq(p) ||
      responderDescripcionPizza(p) ||
      responderServicioHorarioPromoCombo(p);
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
  rebuildDetectCache();
  inicializarExcelCache();
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
    console.log("📱 Escanea este QR:");
    qrcode.generate(qr, { small: true });
  }

  if (connection === "open") {
    console.log("✅ BOT CONECTADO");
  }

  if (connection === "close") {
    const shouldReconnect =
      lastDisconnect?.error?.output?.statusCode !== 401;

    console.log("❌ Conexión cerrada");

    if (shouldReconnect) {
      if (!reconnectScheduled) {
        reconnectScheduled = true;
        console.log("🔄 Reintentando conexión...");
        setTimeout(() => {
          reconnectScheduled = false;
          startBot(); // reconexión controlada
        }, 1500);
      }
    } else {
      console.log("🚫 Sesión cerrada, necesitas escanear QR otra vez");
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

  // 📩 TEXTO PRIMERO
const texto =
  msg.message?.conversation ||
  msg.message?.extendedTextMessage?.text ||
  "";

const textoLower = texto.toLowerCase();
const textoClean = sinAcentos(textoLower.trim());

console.log("📩", textoClean);
estado.lastUserMessageAt = Date.now();

// 🤖 Saludo inicial (solo primera vez) - sin importar qué escriba el cliente.
if (esNuevoCliente && !estado.saludoInicialEnviado && textoClean) {
  estado.saludoInicialEnviado = true;
  const eco = (texto || "").trim().slice(0, 220);
  await sendText(
    sock,
    from,
    estado,
    `🤖 Soy un bot de Pizzas Carly.\n\nVi tu mensaje: "${eco}".\n\nEscríbeme: *menú*, *promos*, *pedido* o lo que quieras hacer.`
  );
}

// ⏸ Pausa: cuando el bot ya derivó al humano, ignoramos mensajes del chat
// hasta que el asesor responda (por TTL).
if (estado.paso === "esperando_humano" && estado.esperandoHumanoHasta) {
  if (Date.now() < estado.esperandoHumanoHasta) {
    if (textoClean.includes("cancelar")) {
      resetEstadoCliente(from, estado);
      await sendText(
        sock,
        from,
        estado,
        "❌ Pedido cancelado. Escribe *hola* o *menu* para comenzar de nuevo."
      );
    }
    return;
  }
  // expiró la pausa
  resetEstadoCliente(from, estado);
}

// 🔄 Si editaste archivos de catálogo/config, recarga sin reiniciar
await recargarArchivosSiCambioThrottled();

if (textoPideVolverMenu(textoClean)) {
  estado.paso = "menu";
  estado.intentos = 0;
  await sendText(sock, from, estado, textoMenuPrincipal());
  return;
}

if (textoPideAyudaBot(textoClean)) {
  const ayudaPorPaso = {
    menu: "🧭 Elige una opción: menú, promos, pedido, complementos o asesor.",
    pedido: "🍕 Escribe sabor y si puedes tamaño. Ej: *hawaiana grande*.",
    tamano: "📏 Responde con 1-5 o escribe: mediana, grande, familiar, jumbo, mega.",
    solo_complementos: "🍟 Escribe el número o nombre del artículo (ej. alitas, coca).",
    cantidad_complemento: "🔢 Aquí solo necesito la *cantidad* (ej. 1, 2, 3).",
    direccion: "Escribe *confirmar* para pasarte con asesor y cerrar tu pedido."
  };
  const h = ayudaPorPaso[estado.paso] || "Escribe *menu* para volver al inicio, *carrito* para ver total o *asesor* para ayuda humana.";
  await sendText(sock, from, estado, `🤝 ${h}`);
  return;
}

if (textoPideReporte(textoClean)) {
  const rep = await construirReporteMetricasHoy();
  await sendText(sock, from, estado, rep);
  return;
}

// 🚨 ALERTA URGENTE A TELEGRAM: primer mensaje del cliente
if (esNuevoCliente && !estado.notificadoInicio && textoClean) {
  estado.notificadoInicio = true;
  await registrarEventoMetricas("nuevo_cliente", { from, quien });
  await notificarUrgenteMovil(sock, {
    waTitulo: "NUEVO CLIENTE",
    waDetalle: `📞 ${quien}\nJID: ${from}\n💬 "${textoClean}"`,
    tgTexto: `🚨 NUEVO CLIENTE\n📞 ${quien}\nJID: ${from}\n💬 "${textoClean}"`
  });
}


// ❌ CANCELAR PEDIDO
if (textoClean.includes("cancelar")) {
  await registrarEventoMetricas("pedido_cancelado", { from, paso: estado.paso || "?" });
  resetEstadoCliente(from, estado);

  await sendText(sock, from, estado, `❌ Pedido cancelado

👋 Puedes escribir *hola* para comenzar de nuevo`
  );

  return;
}

// 🛒 Mostrar resumen/total en cualquier momento sin romper el flujo.
if (textoPideVerCarrito(textoClean)) {
  const rdCarrito = resumenDetalladoPedidoParaCliente(estado);
  if (rdCarrito) {
    await sendText(
      sock,
      from,
      estado,
      `🧾 *Así va tu pedido*\n\n${rdCarrito}\n\nSi quieres, agrega algo más o escribe *confirmar* para pasarte con asesor.`
    );
    return;
  }
}

if (textoPidePedidoRapido(textoClean)) {
  await registrarEventoMetricas("atajo_pedido_rapido", { from });
  estado.paso = "pedido";
  await sendText(
    sock,
    from,
    estado,
    "⚡ *Pedido rápido*\n\nEscríbeme todo en una sola línea: *sabor + tamaño + extras/complementos*.\nEj: *hawaiana grande con papas y coca*"
  );
  return;
}

if (textoPideRepetirUltimo(textoClean)) {
  const prev = ultimoPedidoPorCliente[from];
  if (!prev) {
    await registrarEventoMetricas("atajo_repetir_ultimo_sin_historial", { from });
    await sendText(sock, from, estado, "Aún no tengo un pedido previo tuyo para repetir.");
    return;
  }
  await registrarEventoMetricas("atajo_repetir_ultimo_ok", { from });
  estado.ingredientes = [...(prev.ingredientes || [])];
  estado.tamano = prev.tamano || null;
  estado.complementos = { ...(prev.complementos || {}) };
  estado.lineasComplemento = Array.isArray(prev.lineasComplemento)
    ? prev.lineasComplemento.map((x) => ({ ...x }))
    : [];
  estado.lineasBebida = Array.isArray(prev.lineasBebida)
    ? prev.lineasBebida.map((x) => ({ ...x }))
    : [];
  estado.extrasActivos = { ...(prev.extrasActivos || {}) };
  estado.extrasTotal = Number(prev.extrasTotal || 0);
  estado.extrasLineas = [...(prev.extrasLineas || [])];
  estado.paso = "confirmar";

  const rdRepeat = resumenDetalladoPedidoParaCliente(estado);
  await sendText(
    sock,
    from,
    estado,
    `🔁 *¡Listo! Repetí tu último pedido*\n\n${rdRepeat}\n\nEscribe *confirmar* y te paso con asesor para cerrarlo.`
  );
  return;
}

if (textoPideFinalizar(textoClean) && hayContenidoCarrito(estado)) {
  if (estado.paso !== "confirmar") {
    await registrarEventoMetricas("atajo_finalizar", { from, paso: estado.paso || "?" });
    estado.paso = "confirmar";
    const rdFin = resumenDetalladoPedidoParaCliente(estado);
    await sendText(
      sock,
      from,
      estado,
      `✅ *Va, ya casi terminamos*\n\n${rdFin}\n\nEscribe *confirmar* y te paso con asesor para terminar.`
    );
    return;
  }
}

// 📣 Marketing asistido (sin spam)
if (textoPidePromos(textoClean)) {
  await registrarEventoMetricas("consulta_promos", { from });
  estado.marketingHintsShown = estado.marketingHintsShown || {};
  const promos = obtenerPromosVigentes();
  estado.marketingHintsShown.promos = true;
  if (promos.length) {
    const top = promos
      .slice(0, 2)
      .map((p) => `• *${p.titulo || "Promo"}* — ${formatearTextoPromoCliente(p).replace(/\n+/g, " ").trim()}`)
      .join("\n");
    await sendText(
      sock,
      from,
      estado,
      `🔥 *Promos de hoy*\n${top}\n\nSi te late una, escribe: *quiero esa promo*.`
    );
  } else {
    await sendText(
      sock,
      from,
      estado,
      `🔥 Hoy conviene revisar combos del día.\nSi quieres, te ayudo a armar pedido rápido: sabor + tamaño + extras.`
    );
  }
  return;
}

if (textoPideRecomendacion(textoClean)) {
  await registrarEventoMetricas("consulta_recomendacion", { from });
  estado.marketingHintsShown = estado.marketingHintsShown || {};
  if (!estado.marketingHintsShown.recomendacion) {
    estado.marketingHintsShown.recomendacion = true;
    const tienePizza = Array.isArray(estado.ingredientes) && estado.ingredientes.length > 0;
    const hayComp = Number(totalesComplementosYBebidas(estado).total || 0) > 0;
    const suger = tienePizza && !hayComp
      ? "Te recomiendo *pizza + papas + bebida* para cerrar completo."
      : "Te recomiendo una *pizza grande* y agregar *papas* o *alitas*.";
    await sendText(
      sock,
      from,
      estado,
      `💡 ${suger}\n\nSi quieres, te lo armo aquí mismo: escribe sabor y tamaño (ej. *hawaiana grande*).`
    );
  } else {
    await sendText(sock, from, estado, "Si gustas, te ayudo a cerrar tu pedido con sabor, tamaño y extras.");
  }
  return;
}

// ✏️ Editar carrito con lenguaje natural (quitar/cambiar tamaño/duplicar)
{
  const edicionMsg = aplicarEdicionCarritoNatural(estado, textoClean);
  if (edicionMsg) {
    const rdPostEdit = resumenDetalladoPedidoParaCliente(estado);
    await sendText(
      sock,
      from,
      estado,
      rdPostEdit
        ? `${edicionMsg}\n\n🧾 *Así va tu pedido:*\n${rdPostEdit}`
        : edicionMsg
    );
    return;
  }
}

// 🍕 Completar sabores para mitad y mitad (solo pregunta)
if (estado.paso === "esperando_dos_sabores_mitad") {
  const ings = detectarIngredientes(textoClean);
  const tamD = detectarTamano(textoClean);
  if (tamD) estado.tamano = tamD;

  if (ings.length >= 2) {
    estado.ingredientes = ings.slice(0, 2);
    if (!estado.tamano) {
      estado.paso = "tamano";
      await sock.sendMessage(from, {
        text: TEXTO_MENU_TAMANOS
      });
      return;
    }
    const precio = calcularPrecio(estado.ingredientes, estado.tamano);
    const ex = detectarExtrasEnTexto(textoClean, estado.tamano);
    await sock.sendMessage(from, {
      text: `🍕 Mitad *${estado.ingredientes[0]}* y mitad *${estado.ingredientes[1]}*
📏 ${estado.tamano}
💲 *$${precio + ex.total}*${ex.total ? `\nExtras: ${ex.lineas.join(", ")}` : ""}

_${restaurante.mitadMitad?.notaPrecio || ""}_

👉 ¿Confirmas? Escribe *confirmar* y te paso con asesor para cerrar.`
    });
    estado.paso = "inicio";
    return;
  }

  await sock.sendMessage(from, {
    text: "🍕 Necesito *2 sabores* claros (ej. *hawaiana y peperoni*) y el *tamaño* si aún no lo dijiste."
  });
  return;
}

if (
  estado.paso !== "elegir_salsa_complemento" &&
  estado.paso !== "clarificar_salsa_mitad_o_dos" &&
  (requiereHumPorAlitasComplejas(textoClean) || requiereHumPorTriggers(textoClean))
) {
  await sock.sendMessage(from, {
    text: "👨‍💼 Para eso te enlazo con un asesor (salsas mixtas, naturales, etc.). En un momento te atienden."
  });
  await notificarUrgenteMovil(sock, {
    waTitulo: "ASESOR REQUERIDO",
    waDetalle: `Asesor (alitas/trigger)\n📞 ${quien}\nJID: ${from}\n💬 ${textoClean}`,
    tgTexto: `🚨 *URGENTE — Asesor (alitas / trigger)*\n📞 ${quien}\nJID: ${from}\n💬 ${textoClean}`
  });
  return;
}

if (await procesarConsultasPorComas(sock, from, textoClean)) return;

if (esConsultaMitadMitadSoloPregunta(textoClean)) {
  estado.paso = "esperando_dos_sabores_mitad";
  await sock.sendMessage(from, {
    text: `🍕 Sí: mitad y mitad se puede.\n_${restaurante.mitadMitad?.notaPrecio || ""}_\n\nDime los *2 sabores* (y el *tamaño*, ej. grande).`
  });
  return;
}

{
  const rPrecio = resolverConsultaPrecio(textoClean);
  const rFaq = buscarRespuestaFaq(textoClean);
  const rDesc = responderDescripcionPizza(textoClean);
  const preguntaCombo =
    (/(combo|paquete)/.test(textoClean) && (estado.paso === "inicio" || estado.paso === "menu"));
  if (preguntaCombo) {
    const combosHoy = obtenerCombosVigentesHoy();
    if (combosHoy.length) {
      // Detecta si el cliente ya pide uno en específico (ej. "combo 2" o "combo de alitas")
      const sel = detectarComboSeleccion(textoClean, combosHoy);
      estado.paso = "promo";
      estado.promoOpcionesIds = combosHoy.map((p) => p.id);

      const generalUrl = String(restaurante?.combosImagenGeneralUrl || "").trim();

      if (sel?.combo) {
        estado.promoActivaId = sel.combo.id;
        const cap = `✅ ${sel.combo.titulo || "Combo"}\n\n${formatearTextoPromoCliente(sel.combo)}\n\nSi te late, escribe *quiero la promo*.`;
        if (sel.combo.imagenUrl && String(sel.combo.imagenUrl).trim()) {
          await sock.sendMessage(from, {
            image: { url: String(sel.combo.imagenUrl).trim() },
            caption: cap
          });
        } else {
          await sock.sendMessage(from, { text: cap });
        }
        return;
      }

      // Si no especificó cuál: manda imagen general + lista de opciones disponibles hoy.
      estado.promoActivaId = combosHoy[0]?.id || null;
      const textoOps = combosHoy
        .map((p, idx) => `${idx + 1}️⃣ ${p.titulo || "Combo"}`)
        .join("\n");
      const capGeneral = `🔥 Sí, hoy tenemos combos:\n\n${textoOps}\n\n👉 Elige número (1, 2, 3...) o escribe *quiero la promo*.`;

      if (generalUrl) {
        await sock.sendMessage(from, { image: { url: generalUrl }, caption: capGeneral });
      } else {
        await sock.sendMessage(from, { text: capGeneral });
      }
      return;
    }
  }
  const rHs = esPreguntaHorarioServicioPromoCombo(textoClean)
    ? responderServicioHorarioPromoCombo(textoClean)
    : null;
  if (rPrecio || rFaq || rDesc || rHs) {
    await sock.sendMessage(from, {
      text: [rPrecio, rFaq, rDesc, rHs].filter(Boolean).join("\n\n")
    });
    return;
  }
}

// 🧠 PEDIDO DIRECTO EN UN SOLO MENSAJE (pizza + complementos + dirección)
// Ej: "quiero 2 papas a la francesa y una pizza grande de peperoni a la calle 18..."
if (
  ![
    "cantidad_complemento",
    "agregar_mas",
    "confirmar",
    "confirmar_complementos",
    "elegir_salsa_complemento",
    "clarificar_salsa_mitad_o_dos"
  ].includes(estado.paso)
) {
  const pedidoDirecto = detectarPedidoDirecto(textoClean);
  if (pedidoDirecto) {
    // ambigüedad de papas
    if (pedidoDirecto.ambiguedades?.length) {
      const amb = pedidoDirecto.ambiguedades[0];
      estado.paso = "resolver_ambiguedad_complemento";
      estado.ambOpciones = amb.opciones;
      estado.ambCantidad = amb.cantidad || 1;

      const lista = amb.opciones
        .map((n, idx) => `${idx + 1}️⃣ ${capitalizar(n)}`)
        .join("\n");

      await sock.sendMessage(from, {
        text: `🍟 ¿Cuáles papas quieres?\n\n${lista}\n\n👉 Escribe el número`
      });
      return;
    }

    // merge de complementos detectados
    if (!estado.complementos) estado.complementos = {};
    for (const [nombre, cant] of Object.entries(pedidoDirecto.complementos || {})) {
      estado.complementos[nombre] = (estado.complementos[nombre] || 0) + (cant || 1);
    }

    if (pedidoDirecto.bebidas && Object.keys(pedidoDirecto.bebidas).length > 0) {
      if (!Array.isArray(estado.lineasBebida)) estado.lineasBebida = [];
      for (const [nombre, cant] of Object.entries(pedidoDirecto.bebidas)) {
        estado.lineasBebida.push({ nombre, cantidad: cant || 1 });
      }
    }

    // merge de pizza detectada
    if (pedidoDirecto.ingredientes?.length) estado.ingredientes = pedidoDirecto.ingredientes;
    if (pedidoDirecto.tamano) estado.tamano = pedidoDirecto.tamano;

    const salsaPend = extraerPrimeroComplementoQueRequiereSalsa(estado);
    if (salsaPend) {
      if (pedidoDirecto.direccion) {
        estado.direccionPendienteTexto = String(pedidoDirecto.direccion).trim();
      }
      estado.tempComplemento = salsaPend.nombre;
      estado.tempCantidadPre = salsaPend.cantidad;
      estado.paso = "elegir_salsa_complemento";
      await sock.sendMessage(from, {
        text: textoMenuSalsasAlitas()
      });
      return;
    }

    const faltaIngrediente = !estado.ingredientes || estado.ingredientes.length === 0;
    const faltaTamano = !estado.tamano;

    // si pidió pizza pero le falta algo, pregunta lo que falta
    const mencionoPizza = pedidoDirecto.ingredientes.length > 0 || Boolean(pedidoDirecto.tamano) || /pizza\b/.test(textoClean);
    if (mencionoPizza && (faltaIngrediente || faltaTamano)) {
      if (faltaIngrediente) {
        estado.paso = "pedido";
        await sock.sendMessage(from, { text: "🍕 ¿De qué sabor la pizza? (peperoni, hawaiana, etc)" });
        return;
      }
      if (faltaTamano) {
        estado.paso = "tamano";
        await sock.sendMessage(from, {
          text: TEXTO_MENU_TAMANOS
        });
        return;
      }
    }

    // si ya trae dirección y hay algo que pedir, se deriva a humano
    if (pedidoDirecto.direccion && (!faltaIngrediente || !mencionoPizza) && (!faltaTamano || !mencionoPizza)) {
      await derivarPedidoAHumano(sock, from, estado, quien, `Dirección detectada: ${pedidoDirecto.direccion}`);
      return;
    }

    // si no trae dirección pero ya tiene algo que pedir, pasa a confirmación humana
    const hayComplementos =
      Object.keys(estado.complementos || {}).length > 0 ||
      (estado.lineasComplemento?.length || 0) > 0 ||
      (estado.lineasBebida?.length || 0) > 0;
    const pizzaCompleta = !faltaIngrediente && !faltaTamano && (estado.ingredientes?.length > 0);
    if (pizzaCompleta || hayComplementos) {
      estado.paso = "confirmar";
      const rd = resumenDetalladoPedidoParaCliente(estado);
      await sock.sendMessage(from, {
        text: `✅ *Checa tu pedido*\n\n${rd}\n\nSi está bien, escribe *confirmar* para pasarte con asesor.`
      });
      return;
    }
  }
}

// Resolver ambigüedad de complemento (ej. papas)
if (estado.paso === "resolver_ambiguedad_complemento") {
  const idx = Number.parseInt(textoClean, 10);
  const opciones = Array.isArray(estado.ambOpciones) ? estado.ambOpciones : [];
  if (!Number.isNaN(idx) && idx >= 1 && idx <= opciones.length) {
    const elegido = opciones[idx - 1];
    const cant = Number(estado.ambCantidad || 1);
    if (!estado.complementos) estado.complementos = {};
    estado.complementos[elegido] = (estado.complementos[elegido] || 0) + (Number.isNaN(cant) ? 1 : cant);
    estado.paso = "confirmar";
    delete estado.ambOpciones;
    delete estado.ambCantidad;
    const rAmb = resumenDetalladoPedidoParaCliente(estado);
    await sock.sendMessage(from, {
      text: `✅ *Perfecto*\n\n${rAmb}\n\nSi está bien, escribe *confirmar* para pasarte con asesor.`
    });
    return;
  }
  await sock.sendMessage(from, { text: "❌ Escribe el número de la opción" });
  return;
}

if (
  estado.paso === "confirmar" &&
  (
    textoClean === "1" ||
    esAfirmacionSimple(textoClean) ||
    textoClean.includes("confirmar")
  )
) {
  await derivarPedidoAHumano(sock, from, estado, quien, "Cliente confirmó pedido en bot.");
  return;
}

if (estado.paso === "confirmar" || estado.paso === "confirmar_complementos" || estado.paso === "decision") {
  const editOnConfirm = aplicarEdicionCarritoNatural(estado, textoClean);
  if (editOnConfirm) {
    const rdEdit = resumenDetalladoPedidoParaCliente(estado);
    await sendText(
      sock,
      from,
      estado,
      `${editOnConfirm}\n\n🧾 *Pedido actualizado*\n${rdEdit}\n\nResponde *sí* para confirmar o *no* para cancelar.`
    );
    return;
  }
}

// Cancelar confirmación con opción numérica
if (
  estado.paso === "confirmar" &&
  (textoClean === "2" || esNegacionSimple(textoClean) || textoClean.includes("cancelar"))
) {
  resetEstadoCliente(from, estado);

  await sock.sendMessage(from, {
    text: `❌ Pedido cancelado

👋 Puedes escribir *hola* para comenzar de nuevo`
  });

  return;
}

if (!estados[from]) {
  estados[from] = nuevoEstadoCliente();
}

  // 📍 DETECTAR UBICACIÓN
if (msg.message.locationMessage) {

  const lat = msg.message.locationMessage.degreesLatitude;
  const lng = msg.message.locationMessage.degreesLongitude;

  const estado = estados[from];

  // 👉 si NO está en proceso de pedido
if (!estado || !["direccion", "promo", "confirmar"].includes(estado.paso)) {
    await sock.sendMessage(from, {
      text: `📍 Recibí tu ubicación 👍

Primero cuéntame qué deseas pedir 🍕`
    });

    return;
  }

  await derivarPedidoAHumano(
    sock,
    from,
    estado,
    quien,
    `Ubicación cliente: https://maps.google.com/?q=${lat},${lng}`
  );
  return;
}


// 👨‍💼 HABLAR CON HUMANO
if (
  textoClean.includes("humano") ||
  textoClean.includes("asesor") ||
  textoClean.includes("persona")
) {
  if (estado.paso === "clarificar_salsa_mitad_o_dos") {
    estado.salsaClarificarUnicas = null;
    estado.salsaClarificarExtraMitad = null;
    estado.paso = "solo_complementos";
  }
  await sock.sendMessage(from, {
    text: "👨‍💼 Te paso con alguien del equipo en un momentito."
  });
  await notificarUrgenteMovil(sock, {
    waTitulo: "CLIENTE PIDE ASESOR",
    waDetalle: `📞 ${quien}\nJID: ${from}\n💬 "${(texto || "").trim()}"`,
    tgTexto: `🚨 *URGENTE — Cliente pide asesor*\n📞 ${quien}\nJID: ${from}\n💬 "${(texto || "").trim()}"`
  });

  return;
}

  // ⚠️ AVISO DE CIERRE (SOLO UNA VEZ)
  if (porCerrar() && !estado.avisoCierre) {
    estado.avisoCierre = true;

    await sock.sendMessage(from, {
      text: `⚠️ Estamos por cerrar en 15 minutos (10:30 PM)

🍔 Si gustas hacer pedido, este es el momento`
    });
  }

  // ⛔ VALIDAR HORARIO
  if (!estaAbierto()) {
    await sock.sendMessage(from, {
      text: `⏰ Estamos cerrados en este momento.

🕒 Horario:
${restaurante.horarioTexto}`
    });

    return;
  }

  // 👇 aquí sigue tu lógica normal del bot

  if (!estados[from]) {
    estados[from] = nuevoEstadoCliente();
  }

// 👋 SALUDO / MENÚ
if (detectarSaludoOMenu(textoClean)) {
  estado.paso = "menu";
  estado.intentos = 0;
  estado.promoActivaId = null;
  await sendText(sock, from, estado, textoMenuPrincipal());

  return;
}

if (estado.paso === "menu") {
  const opMenu = detectarOpcionMenuPrincipal(textoClean);

  // 👉 OPCIÓN 1
  if (opMenu === "1") {
    estado.paso = "menu_visto";

    await sock.sendMessage(from, {
      image: { url: "https://picsum.photos/500/500" },
      caption: `🍔 *Menú El Barón Burger*

1️⃣ Ordenar  
2️⃣ Hablar con alguien`
    });

    return;
  }

  // 👉 OPCIÓN 2
  if (opMenu === "2") {
    const promos = obtenerPromosVigentes();
    estado.paso = "promo";
    estado.promoActivaId = promos[0]?.id || null;
    estado.promoOpcionesIds = promos.map((p) => p.id);

    if (!promos.length) {
      await sock.sendMessage(from, {
        text: `🔥 *Promociones*\n\n${restaurante.promocionesTexto}\n\n👉 Para pedir: opción *3* o escribe tu pedido.`
      });
      estado.paso = "menu";
      estado.promoActivaId = null;
      return;
    }

    const caption = promos
      .map((p, idx) => `${idx + 1}️⃣ *${p.titulo || "Promo"}*\n${formatearTextoPromoCliente(p)}`)
      .join("\n\n────────\n\n");
    const conImg = promos.find((p) => p.imagenUrl && String(p.imagenUrl).trim());

    if (conImg) {
      await sock.sendMessage(from, {
        image: { url: String(conImg.imagenUrl).trim() },
        caption: `${caption.slice(0, 1024)}\n\n👉 Elige una opción con número (ej. 1, 2).`
      });
    } else {
      await sock.sendMessage(from, {
        text: `🔥 *Promos de hoy*\n\n${caption}\n\n👉 Elige número (1, 2, 3...) o escribe *quiero la promo*. Dudas: *¿incluye refresco?*, *¿qué tamaños?*`
      });
    }

    return;
  }

  // 👉 OPCIÓN 3
  if (opMenu === "3") {
    estado.paso = "pedido";
    estado.ingredientes = [];
    estado.tamano = null;
    estado.extrasActivos = {};
    estado.extrasTotal = 0;
    estado.extrasLineas = [];
    estado.upsellPizzaMostrado = false;
    limpiarMetadatosPromoPedido(estado);

    await sock.sendMessage(from, {
      text: "🍕 Dime el sabor"
    });

    return;
  }

  // 👉 OPCIÓN 4
  if (opMenu === "4") {
    estado.paso = "solo_complementos";
    // Mantener acumulado existente para no perder artículos ya agregados.
    if (!estado.complementos || typeof estado.complementos !== "object") {
      estado.complementos = {};
    }
    if (!Array.isArray(estado.lineasComplemento)) {
      estado.lineasComplemento = [];
    }
    if (!Array.isArray(estado.lineasBebida)) {
      estado.lineasBebida = [];
    }

    await sock.sendMessage(from, {
      image: { url: "https://picsum.photos/500/600" },
      caption: `🍟 *COMPLEMENTOS Y BEBIDAS*

${textoListaComplementosYBebidas()}

👉 Número o nombre`
    });

    return;
  }

  // 👉 OPCIÓN 5
  if (opMenu === "5") {
    await sock.sendMessage(from, {
      text: "👨‍💼 Te paso con alguien del equipo en un momentito."
    });
    await notificarUrgenteMovil(sock, {
      waTitulo: "MENÚ OPCIÓN 5",
      waDetalle: `Hablar con asesor\n📞 ${quien}\nJID: ${from}`,
      tgTexto: `🚨 *URGENTE — Menú opción 5 (hablar con alguien)*\n📞 ${quien}\nJID: ${from}`
    });

    return;
  }
}

// 🍟 SOLO COMPLEMENTOS (+ bebidas del Excel)
if (estado.paso === "solo_complementos") {
  const pick = resolverItemCatalogoPorNumeroONombre(textoClean);
  if (pick) {
    estado.tempComplemento = pick.nombre;
    estado.tempEsBebida = pick.tipo === "bebida";
    if (!estado.tempEsBebida && complementoRequiereSalsa(pick.nombre)) {
      estado.paso = "elegir_salsa_complemento";
      await sock.sendMessage(from, {
        text: textoMenuSalsasAlitas()
      });
      return;
    }
    estado.paso = "cantidad_complemento";
    await sock.sendMessage(from, {
      text: `🔢 ¿Cuántas *${pick.nombre}* deseas?`
    });
    return;
  }
}

// Mitad y mitad vs dos órdenes (misma elección de salsa ambigua)
if (estado.paso === "clarificar_salsa_mitad_o_dos") {
  const uni = estado.salsaClarificarUnicas;
  const ex = Number(estado.salsaClarificarExtraMitad) || 0;
  if (!Array.isArray(uni) || uni.length < 2) {
    estado.paso = "elegir_salsa_complemento";
    await sock.sendMessage(from, {
      text: "Volvamos a elegir salsa.\n\n" + textoMenuSalsasAlitas()
    });
    return;
  }
  const x = sinAcentos(normalizarTextoPedido(textoClean));
  const esMitad =
    textoClean === "1" ||
    /^uno$/.test(x.trim()) ||
    /\bmitad\s+y\s+mitad\b/.test(x) ||
    /(misma|mismo)\s+(orden|pedido)/.test(x);
  const esDos =
    textoClean === "2" ||
    /^dos$/.test(x.trim()) ||
    /\b(orden|pedido)s?\s+separad/.test(x) ||
    /\bdos\s+orden/.test(x);

  if (esMitad && !esDos) {
    estado.salsaClarificarUnicas = null;
    estado.salsaClarificarExtraMitad = null;
    estado.tempSalsa = {
      label: `mitad ${uni[0]} / ${uni[1]}`,
      extraMitadSalsa: ex
    };
    estado.paso = "elegir_salsa_complemento";
    await aplicarPostEleccionSalsa(sock, from, estado, quien);
    return;
  }
  if (esDos && !esMitad) {
    estado.salsaClarificarUnicas = null;
    estado.salsaClarificarExtraMitad = null;
    estado.tempSalsa = { label: uni[0], extraMitadSalsa: 0 };
    await sock.sendMessage(from, {
      text: `Perfecto: *dos órdenes*. Esta lleva *${uni[0]}*. Para *${uni[1]}*, después en *¿algo más?* agrega otra vez el complemento y eliges esa salsa.`
    });
    estado.paso = "elegir_salsa_complemento";
    await aplicarPostEleccionSalsa(sock, from, estado, quien);
    return;
  }

  await sock.sendMessage(from, {
    text: `👨‍💼 No capté si quieres *mitad y mitad* o *dos órdenes*. Un asesor te lo confirma.\n\nResponde *1* = mitad y mitad en una orden, *2* = dos órdenes separadas. O escribe *asesor*.`
  });
  await notificarUrgenteMovil(sock, {
    waTitulo: "ASESOR SALSA AMBIGUA",
    waDetalle: `📞 ${quien}\nJID: ${from}\n💬 "${textoClean}"\nSalsas: ${uni.join(" | ")}`,
    tgTexto: `🚨 *URGENTE — Asesor (salsa ambigua)*\n📞 ${quien}\nJID: ${from}\n💬 "${textoClean}"\nSalsas: ${uni.join(" | ")}`
  });
  estado.paso = "solo_complementos";
  estado.salsaClarificarUnicas = null;
  estado.salsaClarificarExtraMitad = null;
  return;
}

// 🍗 Elegir salsa (alitas / boneless / nuggets configurados en restaurant.json)
if (estado.paso === "elegir_salsa_complemento") {
  const r = parseEleccionSalsa(textoClean);

  if (r.resultado === "humano") {
    await sock.sendMessage(from, {
      text: "👨‍💼 Ese pedido de salsas está enredado; te enlazo con un asesor para anotarlo bien."
    });
    await notificarUrgenteMovil(sock, {
      waTitulo: "ASESOR SALSA COMPLEJA",
      waDetalle: `📞 ${quien}\nJID: ${from}\n💬 "${textoClean}"\n${r.detalle || ""}`,
      tgTexto: `🚨 *URGENTE — Asesor (salsa compleja)*\n📞 ${quien}\nJID: ${from}\n💬 "${textoClean}"\n_${r.detalle || ""}_`
    });
    estado.paso = "solo_complementos";
    return;
  }

  if (r.resultado === "preguntar") {
    estado.paso = "clarificar_salsa_mitad_o_dos";
    estado.salsaClarificarUnicas = r.unicas;
    estado.salsaClarificarExtraMitad = r.extraMitad;
    await sock.sendMessage(from, {
      text:
        `Leí *${r.unicas[0]}* y *${r.unicas[1]}*.\n\n¿Cómo lo armamos?\n\n` +
        `1️⃣ *Mitad y mitad* — una sola orden, mitad una salsa y mitad la otra (+$${r.extraMitad || 0} si aplica)\n` +
        `2️⃣ *Dos órdenes* — una orden con una salsa y otra orden con la otra\n\n` +
        `Responde *1* o *2*.`
    });
    return;
  }

  if (r.resultado === "error") {
    await sock.sendMessage(from, { text: r.msg });
    return;
  }

  estado.tempSalsa = {
    label: r.label,
    extraMitadSalsa: r.extraMitadSalsa || 0
  };
  if (r.notaCliente) {
    await sock.sendMessage(from, { text: r.notaCliente });
  }
  await aplicarPostEleccionSalsa(sock, from, estado, quien);
  return;
}

// 🔢 CANTIDAD DE COMPLEMENTO / BEBIDA
if (estado.paso === "cantidad_complemento") {

  const cantidad = parseInt(textoClean);

  if (!isNaN(cantidad) && cantidad > 0) {

    const comp = estado.tempComplemento;
    const salsaInfo = estado.tempSalsa || { label: "—", extraMitadSalsa: 0 };
    const esBeb = !!estado.tempEsBebida;
    delete estado.tempEsBebida;

    if (esBeb) {
      delete estado.tempSalsa;
      if (!estado.lineasBebida) estado.lineasBebida = [];
      estado.lineasBebida.push({ nombre: comp, cantidad });
    } else {
      if (!estado.lineasComplemento) estado.lineasComplemento = [];
      estado.lineasComplemento.push({
        nombre: comp,
        cantidad,
        salsaEtiqueta: salsaInfo.label,
        extraMitadSalsa: Number(salsaInfo.extraMitadSalsa) || 0
      });
      delete estado.tempSalsa;
      if (!estado.complementos[comp]) {
        estado.complementos[comp] = 0;
      }
      estado.complementos[comp] += cantidad;
    }

    const extraTxt =
      !esBeb && salsaInfo.extraMitadSalsa
        ? ` +$${salsaInfo.extraMitadSalsa} mix`
        : "";
    const salsaTxt = esBeb ? "" : ` (${salsaInfo.label})`;

    await sock.sendMessage(from, {
      text: `✅ Agregado: ${cantidad} ${comp}${salsaTxt}${extraTxt}

👉 ¿Deseas agregar algo más?

1️⃣ Sí
2️⃣ No`
    });

    estado.paso = "agregar_mas";
    return;
  } else {
    await sock.sendMessage(from, {
      text: "❌ Escribe un número válido"
    });
    return;
  }
}

// ➕ AGREGAR MÁS COMPLEMENTOS
if (estado.paso === "agregar_mas") {

  if (textoClean === "1" || textoPideAgregarMasNatural(textoClean)) {

    estado.paso = "solo_complementos";
    // Si el cliente ya escribió el artículo directamente, saltamos menú y lo tomamos.
    const pickDirecto = resolverItemCatalogoPorNumeroONombre(textoClean);
    if (pickDirecto) {
      estado.tempComplemento = pickDirecto.nombre;
      estado.tempEsBebida = pickDirecto.tipo === "bebida";
      if (!estado.tempEsBebida && complementoRequiereSalsa(pickDirecto.nombre)) {
        estado.paso = "elegir_salsa_complemento";
        await sendText(sock, from, estado, textoMenuSalsasAlitas());
        return;
      }
      estado.paso = "cantidad_complemento";
      await sendText(sock, from, estado, `🔢 ¿Cuántas *${pickDirecto.nombre}* deseas?`);
      return;
    }

    await sendText(sock, from, estado, `🍟 Elige otro artículo:\n\n${textoListaComplementosYBebidas()}`);

    return;
  }

 if (textoClean === "2" || esNegacionSimple(textoClean)) {

if (!estado.complementos) {
  estado.complementos = {};
}

    const { total, resumen } = totalesComplementosYBebidas(estado);
    const tipVenta = sugerenciaVentaContextual(estado, "resumen_comp");
    if (tipVenta) {
      await registrarEventoMetricas("upsell_mostrado", {
        from,
        contexto: "resumen_comp"
      });
    }

    await sendText(sock, from, estado, `📄 RESUMEN

🍟🥤 ${resumen}

💲 Total: $${total}

👉 Escribe "confirmar" o "cancelar"${tipVenta ? `\n\n${tipVenta}` : ""}`);

    estado.paso = "confirmar_complementos";
    return;
  }

  // Entrada directa de artículo sin responder 1/2.
  const pickNatural = resolverItemCatalogoPorNumeroONombre(textoClean);
  if (pickNatural) {
    estado.tempComplemento = pickNatural.nombre;
    estado.tempEsBebida = pickNatural.tipo === "bebida";
    if (!estado.tempEsBebida && complementoRequiereSalsa(pickNatural.nombre)) {
      estado.paso = "elegir_salsa_complemento";
      await sendText(sock, from, estado, textoMenuSalsasAlitas());
      return;
    }
    estado.paso = "cantidad_complemento";
    await sendText(sock, from, estado, `🔢 ¿Cuántas *${pickNatural.nombre}* deseas?`);
    return;
  }
}


    // 🔥 OPCIONES DESPUÉS DEL MENÚ
    if (estado.paso === "menu_visto") {

      if (textoClean === "1") {
        estado.paso = "pedido";
        estado.ingredientes = [];
        estado.tamano = null;
        estado.extrasActivos = {};
        estado.extrasTotal = 0;
        estado.extrasLineas = [];
        estado.upsellPizzaMostrado = false;
        limpiarMetadatosPromoPedido(estado);

        await sock.sendMessage(from, {
          text: "🍕 Dime el sabor (peperoni, hawaiana, etc)"
        });

        return;
      }

      if (textoClean === "2") {
        await sock.sendMessage(from, {
          text: "👨‍💼 Te paso con alguien del equipo en un momentito."
        });

        return;
      }
    }


// ✅ CONFIRMAR SOLO COMPLEMENTOS
if (estado.paso === "confirmar_complementos") {
  if (textoClean === "1" || esAfirmacionSimple(textoClean) || textoClean.includes("confirmar")) {
    await derivarPedidoAHumano(sock, from, estado, quien, "Cliente confirmó complemento/bebida.");
    return;
  }

  if (textoClean === "2" || esNegacionSimple(textoClean) || textoClean.includes("cancelar")) {
    delete estados[from];

    await sock.sendMessage(from, {
      text: "❌ Pedido cancelado\n\n👉 Escribe *hola* para comenzar de nuevo"
    });

    return;
  }
}

    // 🍕 PEDIDO

// ✅ DECISIÓN (PONLO ARRIBA)
if (estado.paso === "decision") {

  if (textoClean === "1" || esAfirmacionSimple(textoClean) || textoClean.includes("confirmar")) {
    await derivarPedidoAHumano(sock, from, estado, quien, "Cliente confirmó en paso decision.");
    return;
  }

  if (textoClean === "2" || esNegacionSimple(textoClean) || textoClean.includes("cancelar")) {
    delete estados[from];

    await sock.sendMessage(from, {
      text: "❌ Pedido cancelado\n\n👉 Escribe *hola* para comenzar de nuevo"
    });

    return;
  }
}

// 🍕 PEDIDO INTELIGENTE
if (estado.paso === "pedido") {

  const ingredientesDetectados = detectarIngredientes(textoClean);
  const tamanoDetectado = detectarTamano(textoClean);
  const tNorm = sinAcentos(normalizarTextoPedido(textoClean));
  const pideMitad =
    /(mitad\s*y\s*mitad|media\s*y\s*media|dos\s*sabores)/.test(tNorm);

  // guardar ingredientes
  if (ingredientesDetectados.length > 0) {
    let ing = ingredientesDetectados;
    if (pideMitad && ing.length > 2) ing = ing.slice(0, 2);
    estado.ingredientes = ing;
  }

  // guardar tamaño si viene en el mensaje
  if (tamanoDetectado) {
    estado.tamano = tamanoDetectado;
  }

  mergeExtrasEnEstado(estado, textoClean);

  // 🔥 CASO 1: tiene TODO
  if (estado.ingredientes.length > 0 && estado.tamano) {

    const up = restaurante?.upsell?.alConfirmarPizza;
    let upsTxt = "";
    if (up?.activo && !estado.upsellPizzaMostrado) {
      upsTxt = up.texto || "";
      estado.upsellPizzaMostrado = true;
    }

    const cuerpo = resumenDetalladoPedidoParaCliente(estado);
    const tipVenta = sugerenciaVentaContextual(estado, "confirmar_pizza");
    if (tipVenta) {
      await registrarEventoMetricas("upsell_mostrado", {
        from,
        contexto: "confirmar_pizza"
      });
    }
    await sock.sendMessage(from, {
      text: `${cuerpo}

👉 ¿Deseas continuar?

1️⃣ Confirmar pedido
2️⃣ Cancelar${upsTxt}${tipVenta ? `\n\n${tipVenta}` : ""}`
    });

    estado.paso = "confirmar";
    return;
  }

  // 🔥 CASO 2: tiene ingrediente pero NO tamaño
  if (estado.ingredientes.length > 0 && !estado.tamano) {

    estado.paso = "tamano";

    await sock.sendMessage(from, {
      image: { url: "https://picsum.photos/500/600" },
      caption: `📏 ¿Qué tamaño quieres?

1️⃣ Mediana  
2️⃣ Grande  
3️⃣ Familiar  
4️⃣ Jumbo  
5️⃣ Mega`
    });

    return;
  }

  // ❌ no entendió
  await sock.sendMessage(from, {
      text: "🍕 Cuéntame el sabor de tu pizza (ej. hawaiana, peperoni)."
  });

  return;
}

// 📏 SELECCIÓN DE TAMAÑO
if (estado.paso === "tamano") {

  const mapa = {
    "1": "mediana",
    "2": "grande",
    "3": "familiar",
    "4": "jumbo",
    "5": "mega"
  };

  const tamano = mapa[textoClean];

  if (tamano) {
    estado.tamano = tamano;

    mergeExtrasEnEstado(estado, textoClean);

    const up2 = restaurante?.upsell?.alConfirmarPizza;
    let upsTxt2 = "";
    if (up2?.activo && !estado.upsellPizzaMostrado) {
      upsTxt2 = up2.texto || "";
      estado.upsellPizzaMostrado = true;
    }

    const cuerpo2 = resumenDetalladoPedidoParaCliente(estado);
    const tipVenta2 = sugerenciaVentaContextual(estado, "confirmar_tamano");
    if (tipVenta2) {
      await registrarEventoMetricas("upsell_mostrado", {
        from,
        contexto: "confirmar_tamano"
      });
    }
    await sock.sendMessage(from, {
      text: `${cuerpo2}

👉 ¿Deseas continuar?

1️⃣ Confirmar pedido
2️⃣ Cancelar${upsTxt2}${tipVenta2 ? `\n\n${tipVenta2}` : ""}`
    });

    estado.paso = "confirmar";
    return;
  }
}

    // ✅ CONFIRMAR
    if (textoClean.includes("decision")) {
      estado.paso = "confirmar";

      await sock.sendMessage(from, {
        text: "✅ Perfecto. Escribe *confirmar* para pasarte con asesor y cerrar tu pedido."
      });

      return;
    }

    // 📍 DIRECCIÓN
if (estado.paso === "direccion") {
  await derivarPedidoAHumano(sock, from, estado, quien, texto.trim());
  return;
}

// 🍕 PEDIR PROMO
if (estado.paso === "promo") {
  const nPromo = detectarNumeroEnTexto(textoClean);
  if (nPromo && nPromo >= 1) {
    const ids = Array.isArray(estado.promoOpcionesIds) ? estado.promoOpcionesIds : [];
    const selId = ids[nPromo - 1];
    if (selId) {
      estado.promoActivaId = selId;
      const pSel = (restaurante.promociones || []).find((x) => x.id === selId);
      if (pSel) {
        const cap = `✅ Elegiste: *${pSel.titulo || "Promo"}*\n\n${formatearTextoPromoCliente(pSel)}\n\nSi te gusta, escribe *quiero la promo*.`;
        if (pSel.imagenUrl && String(pSel.imagenUrl).trim()) {
          await sock.sendMessage(from, { image: { url: String(pSel.imagenUrl).trim() }, caption: cap });
        } else {
          await sock.sendMessage(from, { text: cap });
        }
        return;
      }
    }
  }

  const rPromoChat = buscarRespuestaPromoActiva(estado, textoClean);
  if (rPromoChat) {
    await sock.sendMessage(from, { text: rPromoChat });
    return;
  }

  if (
    textoClean.includes("quiero") ||
    textoClean.includes("dame") ||
    textoClean.includes("si") ||
    textoClean.includes("ok") ||
    textoClean.includes("va")
  ) {
    estado.paso = "confirmar";
    estado.desdePromoPedido = true;
    const p = (restaurante.promociones || []).find(
      (x) => x.id === estado.promoActivaId
    );
    estado.referenciaPromoCliente = p?.titulo
      ? `${p.titulo} (promo)`
      : "Promoción del día";

    const rPr = resumenDetalladoPedidoParaCliente(estado);
    await sock.sendMessage(from, {
      text: `✅ *¡Listo, promo registrada!*\n\n${rPr}\n\nSi está bien, escribe *confirmar* para pasarte con asesor.`
    });

    return;
  }

  if (textoClean.length > 10) {
    estado.paso = "confirmar";
    estado.desdePromoPedido = true;
    estado.referenciaPromoCliente = texto.trim().slice(0, 400);

    const rLargo = resumenDetalladoPedidoParaCliente(estado);
    await sock.sendMessage(from, {
      text: `✅ *¡Pedido registrado!*\n\n${rLargo}\n\nSi está bien, escribe *confirmar* para pasarte con asesor.\n\n⏱ Entrega aprox. 30–40 min`
    });

    return;
  }
}

// 🤖 Fallback NLU (Dialogflow) para lenguaje libre sin romper flujo principal
if (await responderIntentDialogflow(sock, from, estado, textoClean)) {
  return;
}

    // 🤖 DEFAULT
    estado.intentos++;

if (estado.intentos >= 2) {
  await sock.sendMessage(from, {
    text: "👨‍💼 No estoy seguro de entender eso. Te paso con un asesor para que te ayude mejor."
  });
  await notificarUrgenteMovil(sock, {
    waTitulo: "DERIVACIÓN A ASESOR",
    waDetalle: `Bot no entendió\n📞 ${quien}\nJID: ${from}\n💬 ${textoClean}`,
    tgTexto: `🚨 *URGENTE — Derivación (bot no entendió)*\n📞 ${quien}\nJID: ${from}\n💬 ${textoClean}`
  });
  estado.intentos = 0;
} else {
  await sock.sendMessage(from, {
    text: "🤖 No te caché bien.\n\nEscribe *menu* para empezar, *carrito* para ver total o *ayuda*."
  });
}
  } catch (err) {
    console.error("❌ Error en messages.upsert:", err?.message || err);
  }

  });
}



const app = express();
app.get("/", (_req, res) => res.status(200).send("Bot activo"));

app.listen(PORT, () => {
  console.log(`🌐 Servidor activo en puerto ${PORT}`);
  startBot();
});