const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('¡Mi proxy está funcionando!');
});

// ==========================================
// PROXY VIEJO HACIA sia.gabotachak.dev
// (lo dejamos tal cual, por si ese servicio se recupera más adelante)
// ==========================================
const SIA_UPSTREAM = 'https://sia.gabotachak.dev';

app.use('/api/sia', async (req, res) => {
    const upstreamUrl = SIA_UPSTREAM + req.url;
    try {
        const upstreamRes = await fetch(upstreamUrl);
        const body = await upstreamRes.text();
        res.status(upstreamRes.status);
        res.set('Content-Type', upstreamRes.headers.get('content-type') || 'application/json');
        res.send(body);
    } catch (err) {
        res.status(502).json({ error: 'No se pudo conectar con el SIA', detalle: String(err) });
    }
});

// ==========================================
// LOGIN DIRECTO CONTRA EL SIA REAL (Oracle Access Manager), sobre HTTP/2
// ==========================================
const SIA_USER = process.env.SIA_USERNAME;
const SIA_PASS = process.env.SIA_PASSWORD;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

// Cabeceras "de huella de navegador" que vimos en la captura real (HAR) exitosa.
function browserHeaders() {
    return {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1'
    };
}

// Una sola petición HTTP/2, inyectando y capturando cookies a mano en el jar
// (no usamos axios-cookiejar-support: preferimos control total y explícito).
async function http2Request(jar, method, url, data, extraHeaders = {}) {
    const cookieHeader = await jar.getCookieString(url);
    const headers = {
        ...browserHeaders(),
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...extraHeaders
    };

    const res = await axios({
        method,
        url,
        data,
        headers,
        httpVersion: 2,
        maxRedirects: 0,          // las redirecciones las seguimos nosotros abajo
        validateStatus: () => true // nunca lanzar excepción por 3xx/4xx/5xx; las inspeccionamos
    });

    const setCookieHeaders = res.headers['set-cookie'];
    if (setCookieHeaders) {
        for (const sc of setCookieHeaders) {
            try { await jar.setCookie(sc, url); } catch (e) { /* cookie no aplicable a este dominio/path, se ignora */ }
        }
    }

    return res;
}

// Sigue manualmente la cadena de redirecciones 3xx (como haría un navegador),
// preservando el jar de cookies entre cada salto.
async function requestFollowingRedirects(jar, method, url, data, extraHeaders = {}, maxHops = 15) {
    let currentUrl = url;
    let currentMethod = method;
    let currentData = data;

    for (let hop = 0; hop < maxHops; hop++) {
        const res = await http2Request(jar, currentMethod, currentUrl, currentData, hop === 0 ? extraHeaders : {});

        if (res.status >= 300 && res.status < 400 && res.headers.location) {
            currentUrl = new URL(res.headers.location, currentUrl).toString();
            if (currentMethod !== 'GET') {
                currentMethod = 'GET';
                currentData = undefined;
            }
            continue;
        }

        return { res, finalUrl: currentUrl };
    }

    throw new Error(`Demasiadas redirecciones (más de ${maxHops}) sin llegar a una respuesta final.`);
}

async function loginToSia() {
    if (!SIA_USER || !SIA_PASS) {
        throw new Error('Faltan las variables de entorno SIA_USERNAME / SIA_PASSWORD en Railway.');
    }

    const jar = new CookieJar();

    // Paso 1: pedir el recurso protegido sin sesión -> dispara la cadena de redirecciones
    // hasta el login de OAM, dejando las cookies iniciales puestas en el jar.
    await requestFollowingRedirects(jar, 'GET', 'https://sia.unal.edu.co/ServiciosApp');

    // Paso 2: enviar usuario y clave, siguiendo manualmente TODA la cadena de
    // redirecciones resultante.
    const { res: finalRes, finalUrl } = await requestFollowingRedirects(
        jar,
        'POST',
        'https://autenticasia.unal.edu.co/oam/server/auth_cred_submit',
        new URLSearchParams({ username: SIA_USER, password: SIA_PASS, submit: 'Iniciar Sesión' }).toString(),
        { 'Content-Type': 'application/x-www-form-urlencoded' }
    );

    const html = typeof finalRes.data === 'string' ? finalRes.data : JSON.stringify(finalRes.data);
    const ok = finalUrl.includes('/ServiciosApp') && finalRes.status < 400;

    return {
        ok,
        jar,
        finalUrl,
        status: finalRes.status,
        htmlPreview: html.slice(0, 3000),
        responseHeaders: finalRes.headers
    };
}

let siaSession = null;
const SESSION_MAX_AGE_MS = 10 * 60 * 1000;

async function getSiaSession() {
    const stale = !siaSession || (Date.now() - siaSession.loggedInAt) > SESSION_MAX_AGE_MS;
    if (stale) {
        const result = await loginToSia();
        if (!result.ok) {
            siaSession = null;
            throw new Error('Login al SIA falló. finalUrl=' + result.finalUrl + ' status=' + result.status);
        }
        siaSession = { jar: result.jar, loggedInAt: Date.now() };
    }
    return siaSession;
}

app.get('/api/sia-directo/debug-login', async (req, res) => {
    try {
        const result = await loginToSia();
        res.json({
            ok: result.ok,
            status: result.status,
            finalUrl: result.finalUrl,
            responseHeaders: result.responseHeaders,
            htmlPreview: result.htmlPreview
        });
    } catch (err) {
        res.status(500).json({ error: String(err.message || err) });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listo en http://localhost:${PORT}`));