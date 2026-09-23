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
// PROXY HACIA SIA.GABOTACHAK.DEV
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
// LOGIN DIRECTO CONTRA EL SIA REAL
// ==========================================
const SIA_USER = process.env.SIA_USERNAME;
const SIA_PASS = process.env.SIA_PASSWORD;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

function browserHeaders() {
    return {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-User': '?1'
    };
}

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
        maxRedirects: 0,
        validateStatus: () => true
    });
    const setCookieHeaders = res.headers['set-cookie'];
    if (setCookieHeaders) {
        for (const sc of setCookieHeaders) {
            try { await jar.setCookie(sc, url); } catch (e) { /* cookie no aplicable */ }
        }
    }
    return res;
}

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
    throw new Error(`Demasiadas redirecciones (más de ${maxHops}).`);
}

function parseLoopbackArgs(scriptText) {
    const m = scriptText.match(/AdfLoopbackUtils\.runLoopback\(([\s\S]*?)\);/);
    if (!m) return null;
    const argsStr = m[1];
    const tokens = [];
    let depth = 0, inString = false, current = '';
    for (let i = 0; i < argsStr.length; i++) {
        const c = argsStr[i];
        if (inString) {
            current += c;
            if (c === "'" && argsStr[i - 1] !== '\\') inString = false;
        } else if (c === "'") {
            inString = true;
            current += c;
        } else if (c === '{') { depth++; current += c; }
        else if (c === '}') { depth--; current += c; }
        else if (c === ',' && depth === 0) { tokens.push(current.trim()); current = ''; }
        else { current += c; }
    }
    if (current.trim()) tokens.push(current.trim());
    const unquote = (t) => (t && t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
    if (tokens.length < 8) return null;
    return { windowId: unquote(tokens[7]) };
}

function extractViewState(html) {
    const m = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/);
    return m ? m[1] : null;
}

async function resolveAdfLoopback(jar, initialHtml) {
    let body = initialHtml;
    let windowMode = 0;
    for (let attempt = 1; attempt <= 5; attempt++) {
        const viewState = extractViewState(body);
        if (viewState) return { viewState, body };

        const parsed = parseLoopbackArgs(body);
        if (!parsed) break;

        const windowId = parsed.windowId;
        const afrLoop = Date.now().toString() + Math.floor(Math.random() * 1000);
        const mediaParams = '_afrFS=16&_afrMT=screen&_afrMFW=1920&_afrMFH=1080&_afrMFDW=1920&_afrMFDH=1080&_afrMFC=24&_afrMFCI=0&_afrMFM=0&_afrMFR=96&_afrMFG=0&_afrMFS=0&_afrMFO=0';
        const url = `https://sia.unal.edu.co/ServiciosApp/?_afrLoop=${afrLoop}&_afrWindowMode=${windowMode}&Adf-Window-Id=${windowId}&_afrPage=0&${mediaParams}`;
        
        const res = await http2Request(jar, 'GET', url);
        body = typeof res.data === 'string' ? res.data : '';
        windowMode = windowMode === 0 ? 2 : 0;
    }
    return { viewState: null, body };
}

async function loginToSia() {
    if (!SIA_USER || !SIA_PASS) {
        throw new Error('Faltan las variables de entorno SIA_USERNAME / SIA_PASSWORD en Railway.');
    }
    const jar = new CookieJar();

    // Paso 1: Obtener cookies e identificar el OAM_REQ_INFO del formulario
    const step1 = await requestFollowingRedirects(jar, 'GET', 'https://sia.unal.edu.co/ServiciosApp');
    const firstHtml = typeof step1.res.data === 'string' ? step1.res.data : '';
    
    const reqInfoMatch = firstHtml.match(/name="request_id"\s+value="([^"]+)"/);
    const requestId = reqInfoMatch ? reqInfoMatch[1] : '';

    // Paso 2: Enviar credenciales
    const formData = new URLSearchParams({
        username: SIA_USER,
        password: SIA_PASS,
        submit: 'Iniciar Sesión'
    });
    if (requestId) formData.append('request_id', requestId);

    const step2 = await requestFollowingRedirects(
        jar,
        'POST',
        'https://autenticasia.unal.edu.co/oam/server/auth_cred_submit',
        formData.toString(),
        { 
            'Content-Type': 'application/x-www-form-urlencoded',
            'Referer': step1.finalUrl
        }
    );

    const rawHtml = typeof step2.res.data === 'string' ? step2.res.data : JSON.stringify(step2.res.data);
    
    // Paso 3: Resolver Loopback de ADF
    const { viewState, body: finalHtml } = await resolveAdfLoopback(jar, rawHtml);

    const ok = step2.finalUrl.includes('/ServiciosApp') && !!viewState;

    return {
        ok,
        jar,
        finalUrl: step2.finalUrl,
        status: step2.res.status,
        hasViewState: !!viewState,
        htmlPreview: finalHtml.slice(0, 3000),
        responseHeaders: step2.res.headers
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
            generatedAt: new Date().toISOString(),
            ok: result.ok,
            status: result.status,
            finalUrl: result.finalUrl,
            hasViewState: result.hasViewState,
            responseHeaders: result.responseHeaders,
            htmlPreview: result.htmlPreview
        });
    } catch (err) {
        res.status(500).json({ generatedAt: new Date().toISOString(), error: String(err.message || err) });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listo en http://localhost:${PORT}`));