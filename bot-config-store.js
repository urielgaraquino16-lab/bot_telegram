/**
 * Configuración persistente del bot (Firestore doc config/carly).
 * Se carga al arranque y al guardar desde el panel — NO por cada mensaje de WhatsApp.
 */

const CONFIG_COLLECTION = "config";
const CONFIG_DOC_ID = "carly";

const DEFAULT_CONFIG = {
  botActivoGlobal: true,
  groqActivo: true,
  overrideAbierto: null,
  chatsDesactivados: {},
  aliasesAprendidos: {},
  ingredientAliases: {},
  promoDestacada: null,
  updatedAt: null
};

let mem = { ...DEFAULT_CONFIG };
let firestoreRef = null;
let saveChain = Promise.resolve();

function init({ firestore }) {
  firestoreRef = firestore || null;
}

function getConfig() {
  return mem;
}

function normalizarChatsDesactivados(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!k) continue;
    const jid = String(k).includes("@") ? k : `${String(k).replace(/\D/g, "")}@s.whatsapp.net`;
    if (v === true || v === "true" || v === 1) out[jid] = true;
  }
  return out;
}

function mergeConfig(parsed) {
  const base = { ...DEFAULT_CONFIG, ...(parsed || {}) };
  base.chatsDesactivados = normalizarChatsDesactivados(base.chatsDesactivados);
  base.aliasesAprendidos =
    base.aliasesAprendidos && typeof base.aliasesAprendidos === "object"
      ? base.aliasesAprendidos
      : {};
  base.ingredientAliases =
    base.ingredientAliases && typeof base.ingredientAliases === "object"
      ? base.ingredientAliases
      : {};
  if (base.promoDestacada && typeof base.promoDestacada !== "object") {
    base.promoDestacada = null;
  }
  if (base.overrideAbierto !== true && base.overrideAbierto !== false) {
    base.overrideAbierto = null;
  }
  mem = base;
  return mem;
}

async function loadFromFirestore() {
  if (!firestoreRef) {
    console.log("📦 bot-config: sin Firestore, solo restaurant.json / memoria local");
    return mem;
  }
  try {
    const snap = await firestoreRef.collection(CONFIG_COLLECTION).doc(CONFIG_DOC_ID).get();
    if (!snap.exists) {
      console.log("📦 bot-config: documento nuevo, se creará al primer guardado");
      return mem;
    }
    mergeConfig(snap.data());
    console.log(
      `📦 bot-config Firestore OK — bot:${mem.botActivoGlobal} groq:${mem.groqActivo} aliases:${Object.keys(mem.aliasesAprendidos).length} chatsOff:${Object.keys(mem.chatsDesactivados).length}`
    );
    return mem;
  } catch (err) {
    console.warn("⚠️ bot-config load:", err?.message || err);
    return mem;
  }
}

function persistFirestore(data) {
  if (!firestoreRef) return Promise.resolve(false);
  const payload = {
    ...data,
    updatedAt: new Date().toISOString()
  };
  return firestoreRef
    .collection(CONFIG_COLLECTION)
    .doc(CONFIG_DOC_ID)
    .set(payload, { merge: true })
    .then(() => true)
    .catch((err) => {
      console.warn("⚠️ bot-config save:", err?.message || err);
      return false;
    });
}

async function savePartial(partial) {
  mergeConfig({ ...mem, ...partial });
  saveChain = saveChain.then(() => persistFirestore(mem));
  await saveChain;
  return mem;
}

async function setAliasesAprendidos(aliases) {
  return savePartial({ aliasesAprendidos: aliases || {} });
}

async function setIngredientAliases(ingredientAliases) {
  return savePartial({ ingredientAliases: ingredientAliases || {} });
}

module.exports = {
  init,
  getConfig,
  mergeConfig,
  loadFromFirestore,
  savePartial,
  setAliasesAprendidos,
  setIngredientAliases,
  DEFAULT_CONFIG
};
