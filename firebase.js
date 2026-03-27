const admin = require("firebase-admin");

/**
 * Credenciales solo por variable de entorno (recomendado en Railway y CI).
 *
 * - FIREBASE_SERVICE_ACCOUNT_JSON: contenido completo del JSON de la cuenta de servicio (string).
 * - FIREBASE_SERVICE_ACCOUNT_BASE64: el mismo JSON codificado en base64 (útil si el JSON tiene comillas que rompen el .env).
 */
function cargarServiceAccount() {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  const rawB64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64?.trim();

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

  throw new Error(
    "Falta credencial de Firebase. Define FIREBASE_SERVICE_ACCOUNT_JSON (string JSON) " +
      "o FIREBASE_SERVICE_ACCOUNT_BASE64 (JSON en base64)."
  );
}

let serviceAccount = null;
try {
  serviceAccount = cargarServiceAccount();
} catch (err) {
  throw new Error(`No pude inicializar Firebase: ${err?.message || err}`);
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
