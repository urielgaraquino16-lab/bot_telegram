/**
 * Persistencia de sesión Baileys en Firestore (misma forma que useMultiFileAuthState).
 */
const { initAuthCreds } = require("@whiskeysockets/baileys/lib/Utils/auth-utils");
const { BufferJSON } = require("@whiskeysockets/baileys/lib/Utils/generics");
const { proto } = require("@whiskeysockets/baileys/WAProto");

const { firestore } = require("./firebase");

const fixFileName = (file) =>
  file?.replace(/\//g, "__")?.replace(/:/g, "-");

async function leerCredencialesDesdeFirestore(colRef, file) {
  try {
    const id = fixFileName(file);
    const snap = await colRef.doc(id).get();
    if (!snap.exists) return null;
    const payload = snap.data()?.payload;
    if (typeof payload !== "string" || !payload) return null;
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
    await colRef.doc(id).set({ payload: json });
  } catch (err) {
    console.warn("Firestore guardarCredenciales:", err?.message || err);
  }
}

async function eliminarCredencialesEnFirestore(colRef, file) {
  try {
    const id = fixFileName(file);
    await colRef.doc(id).delete();
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
    saveCreds: () => writeData(creds, "creds.json")
  };
}

module.exports = {
  useFirestoreAuthState,
  leerCredencialesDesdeFirestore,
  guardarCredencialesEnFirestore,
  eliminarCredencialesEnFirestore
};
