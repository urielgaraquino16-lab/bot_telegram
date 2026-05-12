/**
 * Persistencia de sesión Baileys en Firestore (misma forma que useMultiFileAuthState).
 * Optimizado para minimizar escrituras: caché en memoria + comparación, omisión
 * de no-ops y debounce de 30 s en saveCreds para no exceder la cuota gratuita.
 */
const { initAuthCreds } = require("@whiskeysockets/baileys/lib/Utils/auth-utils");
const { BufferJSON } = require("@whiskeysockets/baileys/lib/Utils/generics");
const { proto } = require("@whiskeysockets/baileys/WAProto");

const { firestore } = require("./firebase");

const fixFileName = (file) =>
  file?.replace(/\//g, "__")?.replace(/:/g, "-");

// Marca un archivo como "no existe en Firestore" en la caché. Sirve para evitar
// emitir un .delete() repetidamente sobre algo que ya borramos antes.
const TOMBSTONE = "__TOMBSTONE__";

// file -> último payload (string JSON) que efectivamente escribimos/leímos,
// o TOMBSTONE si confirmamos que no existe.
const cacheValores = new Map();

async function leerCredencialesDesdeFirestore(colRef, file) {
  try {
    const id = fixFileName(file);
    const snap = await colRef.doc(id).get();
    if (!snap.exists) {
      cacheValores.set(file, TOMBSTONE);
      return null;
    }
    const payload = snap.data()?.payload;
    if (typeof payload !== "string" || !payload) {
      cacheValores.set(file, TOMBSTONE);
      return null;
    }
    cacheValores.set(file, payload);
    return JSON.parse(payload, BufferJSON.reviver);
  } catch (err) {
    console.warn("Firestore leerCredenciales:", err?.message || err);
    return null;
  }
}

async function guardarCredencialesEnFirestore(colRef, data, file) {
  try {
    const id = fixFileName(file);
    const json = JSON.stringify(data, BufferJSON.replacer);
    // Si el valor serializado es idéntico al último que escribimos, no
    // emitimos otra operación (ahorra cuota de Firestore).
    if (cacheValores.get(file) === json) return;
    await colRef.doc(id).set({ payload: json });
    cacheValores.set(file, json);
  } catch (err) {
    console.warn("Firestore guardarCredenciales:", err?.message || err);
  }
}

async function eliminarCredencialesEnFirestore(colRef, file) {
  try {
    // Ya está marcado como borrado: no emitimos otro delete.
    if (cacheValores.get(file) === TOMBSTONE) return;
    const id = fixFileName(file);
    await colRef.doc(id).delete();
    cacheValores.set(file, TOMBSTONE);
  } catch (err) {
    console.warn("Firestore eliminarCredenciales:", err?.message || err);
  }
}

/**
 * @returns {Promise<{ state: import('@whiskeysockets/baileys').AuthenticationState, saveCreds: () => Promise<void> }>}
 */
async function useFirestoreAuthState() {
  const collectionName =
    process.env.FIRESTORE_BAILEYS_AUTH_COLLECTION || "baileys_auth";
  const colRef = firestore.collection(collectionName);

  const writeData = (data, file) =>
    guardarCredencialesEnFirestore(colRef, data, file);
  const readData = (file) => leerCredencialesDesdeFirestore(colRef, file);
  const removeData = (file) => eliminarCredencialesEnFirestore(colRef, file);

  let creds;
  try {
    creds = (await readData("creds.json")) || initAuthCreds();
  } catch {
    creds = initAuthCreds();
  }

  // 🕒 Debounce de 30 s para saveCreds: aunque Baileys lo invoque muchas veces,
  // a lo mucho escribimos una vez cada 30 s. Como `creds` se actualiza por
  // referencia, el flush siempre persiste la versión más reciente.
  const SAVE_CREDS_INTERVAL_MS = 30 * 1000;
  let saveCredsTimer = null;
  let saveCredsLastFlushAt = 0;

  const flushCredsAhora = async () => {
    saveCredsLastFlushAt = Date.now();
    await writeData(creds, "creds.json");
  };

  const saveCreds = () => {
    // Si ya hay un flush pendiente, no agendamos otro: el actual escribirá
    // la versión más reciente de `creds` cuando dispare.
    if (saveCredsTimer) return Promise.resolve();

    const sinceLast = Date.now() - saveCredsLastFlushAt;
    if (sinceLast >= SAVE_CREDS_INTERVAL_MS) {
      return flushCredsAhora();
    }

    const esperar = SAVE_CREDS_INTERVAL_MS - sinceLast;
    saveCredsTimer = setTimeout(() => {
      saveCredsTimer = null;
      flushCredsAhora().catch((err) =>
        console.warn("Firestore saveCreds (flush):", err?.message || err)
      );
    }, esperar);
    return Promise.resolve();
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          try {
            await Promise.all(
              ids.map(async (id) => {
                let value = await readData(`${type}-${id}.json`);
                if (type === "app-state-sync-key" && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                data[id] = value;
              })
            );
          } catch (err) {
            console.warn("Firestore keys.get:", err?.message || err);
          }
          return data;
        },
        set: async (data) => {
          try {
            const tasks = [];
            for (const category in data) {
              for (const id in data[category]) {
                const value = data[category][id];
                const file = `${category}-${id}.json`;
                tasks.push(
                  value ? writeData(value, file) : removeData(file)
                );
              }
            }
            await Promise.all(tasks);
          } catch (err) {
            console.warn("Firestore keys.set:", err?.message || err);
          }
        }
      }
    },
    saveCreds
  };
}

module.exports = {
  useFirestoreAuthState,
  leerCredencialesDesdeFirestore,
  guardarCredencialesEnFirestore,
  eliminarCredencialesEnFirestore
};
