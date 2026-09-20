const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const app = express();
app.use(cors());
app.use(express.json());

// Ruta de prueba
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
// LOGIN DIRECTO CONTRA EL SIA REAL (Oracle Access Manager)
// ==========================================
// Credenciales SOLO desde variables de entorno de Railway. Nunca en este archivo.
const SIA_USER = process.env.SIA_USERNAME;
const SIA_PASS = process.env.SIA_PASSWORD;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/140.0';

// Guardamos la sesión autenticada en memoria del proceso para reutilizarla entre
// peticiones (así no hacemos login en cada consulta de un visitante).
let siaSession = null; // { client, jar, loggedInAt }
const SESSION_MAX_AGE_MS = 10 * 60 * 1000; // Forzar relogin cada 10 min

async function loginToSia() {
    if (!SIA_USER || !SIA_PASS) {
        throw new Error('Faltan las variables de entorno SIA_USERNAME / SIA_PASSWORD en Railway.');
    }

    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        maxRedirects: 10,
        validateStatus: () => true, // manejamos nosotros los códigos, no queremos que axios lance error en 3xx/4xx
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin',
            'Sec-Fetch-User': '?1'
        }
    }));

    // Paso 1: pedir el recurso protegido sin sesión. Esto dispara toda la cadena de
    // redirecciones hasta la página de login de OAM y deja las cookies iniciales
    // (OAM_REQ_0, OAM_REQ_1, etc.) puestas en el jar.
    await client.get('https://sia.unal.edu.co/ServiciosApp');

    // Paso 2: enviar usuario y clave. axios sigue automáticamente TODA la cadena de
    // redirecciones que resulta de esto (validamos en el HAR: son 6 saltos entre
    // autenticasia.unal.edu.co y sia.unal.edu.co) gracias a maxRedirects + el cookie jar.
    const loginRes = await client.post(
        'https://autenticasia.unal.edu.co/oam/server/auth_cred_submit',
        new URLSearchParams({ username: SIA_USER, password: SIA_PASS, submit: 'Iniciar Sesión' }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const finalUrl = (loginRes.request && loginRes.request.res && loginRes.request.res.responseUrl) || '';
    const html = typeof loginRes.data === 'string' ? loginRes.data : '';
    const responseHeaders = loginRes.headers || {};

    // Señal de éxito: terminamos dentro de ServiciosApp (no de vuelta en la página de login)
    const ok = finalUrl.includes('/ServiciosApp') && loginRes.status < 400;

    return { ok, client, jar, finalUrl, status: loginRes.status, htmlPreview: html.slice(0, 3000), responseHeaders };
}

async function getSiaSession() {
    const stale = !siaSession || (Date.now() - siaSession.loggedInAt) > SESSION_MAX_AGE_MS;
    if (stale) {
        const result = await loginToSia();
        if (!result.ok) {
            siaSession = null;
            throw new Error('Login al SIA falló. finalUrl=' + result.finalUrl);
        }
        siaSession = { client: result.client, jar: result.jar, loggedInAt: Date.now() };
    }
    return siaSession;
}

// Endpoint temporal SOLO para probar que el login funciona de verdad.
// (lo quitamos o protegemos más adelante; por ahora nos sirve para depurar)
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