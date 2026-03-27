const admin = require("firebase-admin");
const path = require("path");

// Railway/producción: usar variable de entorno en vez de archivo local.
// - FIREBASE_SERVICE_ACCOUNT_JSON: JSON completo (string)
// - FIREBASE_SERVICE_ACCOUNT_BASE64: JSON completo en base64
// Local/dev: fallback a archivo "clave.json" en la raíz.
const clavePath = path.join(__dirname, "clave.json");

function cargarServiceAccount() {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  const rawB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

  if (rawJson) {
    try {
      return JSON.parse(rawJson);
    } catch (err) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_JSON no es JSON válido: ${err?.message || err}`
      );
    }
  }

  if (rawB64) {
    try {
      const decoded = Buffer.from(rawB64, "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch (err) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_BASE64 no es válido: ${err?.message || err}`
      );
    }
  }

  // eslint-disable-next-line import/no-dynamic-require
  return require(clavePath);
}

let serviceAccount = null;
try {
  serviceAccount = cargarServiceAccount();
} catch (err) {
  throw new Error(
    `No pude cargar credenciales de Firebase. ` +
      `Configura FIREBASE_SERVICE_ACCOUNT_JSON/BASE64 o agrega "clave.json" en: ${clavePath}. ` +
      `Detalle: ${err?.message || err}`
  );
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const firestore = admin.firestore();

module.exports = {
  firestore
};

