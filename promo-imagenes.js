/**
 * Envío de imágenes de promos (Firebase Storage u URL directa).
 */

const axios = require("axios");

const MAX_IMAGENES_POR_RESPUESTA = 4;

function extraerIdGoogleDrive(url) {
  const m = String(url || "").match(/\/file\/d\/([^/]+)/i);
  return m ? m[1] : null;
}

/** Convierte links viejos de Drive /view a descarga directa (respaldo). */
function normalizarUrlImagenPromo(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;
  const id = extraerIdGoogleDrive(raw);
  if (id) {
    return `https://drive.google.com/uc?export=view&id=${id}`;
  }
  return raw;
}

function urlPareceImagen(url) {
  const u = String(url || "").toLowerCase();
  return (
    /firebasestorage\.googleapis\.com/i.test(u) ||
    /googleusercontent\.com/i.test(u) ||
    /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(u) ||
    /cloudinary\.com/i.test(u)
  );
}

async function descargarImagenBuffer(url) {
  const res = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
    maxRedirects: 5,
    headers: { "User-Agent": "Mozilla/5.0 (compatible; CarlyBot/1.0)" }
  });
  const ct = String(res.headers["content-type"] || "");
  if (ct.includes("text/html")) {
    throw new Error("URL devolvió HTML, no imagen");
  }
  return Buffer.from(res.data);
}

async function enviarUnaImagen(sock, to, url, caption) {
  const link = normalizarUrlImagenPromo(url);
  if (!link) return false;
  const cap = String(caption || "").trim().slice(0, 900);

  try {
    await sock.sendMessage(to, {
      image: { url: link },
      caption: cap || undefined
    });
    return true;
  } catch (err1) {
    console.warn("⚠️ imagen URL directa falló:", err1?.message || err1);
  }

  try {
    const buf = await descargarImagenBuffer(link);
    await sock.sendMessage(to, {
      image: buf,
      caption: cap || undefined
    });
    return true;
  } catch (err2) {
    console.warn("⚠️ imagen buffer falló:", err2?.message || err2);
    return false;
  }
}

/**
 * Envía hasta N imágenes de promos con caption corto (título).
 */
async function enviarImagenesDePromos(sock, to, promos, opts = {}) {
  if (!sock || !to || !Array.isArray(promos)) return { enviadas: 0, fallidas: 0 };
  const max = opts.max ?? MAX_IMAGENES_POR_RESPUESTA;
  let enviadas = 0;
  let fallidas = 0;

  for (const p of promos.slice(0, max)) {
    const url = p?.imagenUrl;
    if (!url || !String(url).trim()) continue;
    const titulo = p.titulo || p.id || "Promo";
    const ok = await enviarUnaImagen(sock, to, url, `🔥 ${titulo}`);
    if (ok) enviadas++;
    else fallidas++;
    await new Promise((r) => setTimeout(r, 600));
  }

  return { enviadas, fallidas };
}

function promoTieneImagen(p) {
  return Boolean(String(p?.imagenUrl || "").trim());
}

module.exports = {
  normalizarUrlImagenPromo,
  urlPareceImagen,
  enviarImagenesDePromos,
  enviarUnaImagen,
  promoTieneImagen,
  MAX_IMAGENES_POR_RESPUESTA
};
