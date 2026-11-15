// Seguridad común del servidor: HTTPS, cabeceras, límites por IP y limpieza de texto.
// Sin dependencias: Express puro.

/** Páginas que pueden llamar a la API desde el navegador (CORS). ALLOWED_ORIGINS en Render la reemplaza. */
const ORIGENES_POR_DEFECTO = [
  'https://mallaiq.vercel.app',
  'https://saerling.github.io',
];

/** 19. Forzar HTTPS: Render termina TLS y avisa con x-forwarded-proto. En local (sin cabecera) no hace nada. */
function forzarHttps(req, res, next) {
  const proto = req.get('x-forwarded-proto');
  if (proto && proto.split(',')[0].trim() === 'http') {
    if (req.method === 'GET' || req.method === 'HEAD') return res.redirect(308, 'https://' + req.get('host') + req.originalUrl);
    return res.status(403).json({ error: 'Usa HTTPS.' });
  }
  next();
}

/** 18. Cabeceras de seguridad. La API solo devuelve JSON: se bloquea todo lo demás. */
function cabeceras(req, res, next) {
  res.set({
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'X-Permitted-Cross-Domain-Policies': 'none',
  });
  // El panel de moderación es una página propia con su script y estilos dentro; el resto, nada de HTML ejecutable.
  if (req.path.startsWith('/admin/')) {
    res.set('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  } else {
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  }
  next();
}

/** 11. Límite de peticiones por IP en una ventana de tiempo (memoria; se limpia sola). */
function limitador(max, ventanaMs, nombre = '') {
  const hits = new Map();
  setInterval(() => {
    const ahora = Date.now();
    for (const [ip, a] of hits) if (!a.some((t) => ahora - t < ventanaMs)) hits.delete(ip);
  }, Math.min(ventanaMs, 600e3)).unref();
  return (req, res, next) => {
    const ahora = Date.now();
    const arr = (hits.get(req.ip) || []).filter((t) => ahora - t < ventanaMs);
    if (arr.length >= max) {
      res.set('Retry-After', String(Math.ceil(ventanaMs / 1000)));
      return res.status(429).json({ error: 'Demasiadas peticiones. Prueba de nuevo en un rato.' + (nombre ? '' : '') });
    }
    arr.push(ahora); hits.set(req.ip, arr);
    next();
  };
}

/** Cuenta intentos fallidos (p. ej. clave de administrador) y bloquea la IP un tiempo. */
function contadorFallos(max, bloqueoMs) {
  const fallos = new Map(); // ip -> { n, hasta }
  setInterval(() => { const a = Date.now(); for (const [ip, f] of fallos) if (f.hasta < a && f.n < max) fallos.delete(ip); }, 600e3).unref();
  return {
    bloqueada: (ip) => { const f = fallos.get(ip); return !!f && f.n >= max && f.hasta > Date.now(); },
    fallo: (ip) => { const f = fallos.get(ip) || { n: 0, hasta: 0 }; f.n += 1; f.hasta = Date.now() + bloqueoMs; fallos.set(ip, f); },
    limpiar: (ip) => fallos.delete(ip),
  };
}

/** 15. Texto limpio: cadena, sin caracteres de control ni marcas invisibles, espacios normalizados y con tope. */
function textoLimpio(v, max) {
  return String(v == null ? '' : v)
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .slice(0, max);
}

module.exports = { ORIGENES_POR_DEFECTO, forzarHttps, cabeceras, limitador, contadorFallos, textoLimpio };
