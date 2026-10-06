const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const puppeteer = require('puppeteer');

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
            generatedAt: new Date().toISOString(),
            ok: result.ok,
            status: result.status,
            finalUrl: result.finalUrl,
            responseHeaders: result.responseHeaders,
            htmlPreview: result.htmlPreview
        });
    } catch (err) {
        res.status(500).json({ generatedAt: new Date().toISOString(), error: String(err.message || err) });
    }
});

// ==========================================
// NAVEGAR HASTA "ASIGNATURAS DISPONIBLES PARA CURSAR" Y LEER LA TABLA DE CUPOS
// ==========================================
function randomWindowId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)];
    return id;
}

function extractViewState(html) {
    const m = html.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/);
    return m ? m[1] : null;
}

const HTML_ENTITY_MAP = {
    aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
    Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
    amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"'
};
function decodeHtmlEntities(str) {
    return str.replace(/&(\w+);/g, (m, name) => (name in HTML_ENTITY_MAP ? HTML_ENTITY_MAP[name] : m));
}

// Extrae la tabla real de materias/cupos del HTML incrustado en la respuesta PPR
// (confirmado con datos reales: cada fila trae nombre+código, tipología, créditos y cupos).
function parseCoursesFromXml(xml) {
    const rows = [];
    const rowRegex = /<tr role="row" _afrRK="\d+" class="af_table_data-row">([\s\S]*?)<\/tr>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(xml)) !== null) {
        const rowHtml = rowMatch[1];
        const spanRegex = /<span[^>]*>([^<]*)<\/span>/g;
        const spans = [];
        let m;
        while ((m = spanRegex.exec(rowHtml)) !== null) spans.push(decodeHtmlEntities(m[1]));
        if (spans.length >= 4) {
            const nameCode = spans[0];
            const nm = nameCode.match(/^(.*)\s\(([^)]+)\)\s*$/);
            rows.push({
                name: nm ? nm[1].trim() : nameCode,
                code: nm ? nm[2].trim() : '',
                typology: spans[1],
                credits: spans[2],
                available: spans[3]
            });
        }
    }
    return rows;
}

// Parsea los argumentos de AdfLoopbackUtils.runLoopback(...) de la página puente,
// respetando el literal de objeto {..} que contiene comas propias.
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
    return { windowId: unquote(tokens[7]) }; // 8º argumento (k): el window id que asigna el servidor
}

// Sigue el "loopback" de cookies de ADF: la página puente redirige a sí misma
// alternando _afrWindowMode entre 0 y 2, usando el window id que el propio
// servidor asigna (no el que nosotros inventamos al principio). Confirmado con
// datos reales: hacen falta 2-3 vueltas antes de recibir la página real con ViewState.
async function loadRealPage(jar, steps) {
    const mediaParams = '_afrFS=16&_afrMT=screen&_afrMFW=1920&_afrMFH=1080&_afrMFDW=1920&_afrMFDH=1080&_afrMFC=24&_afrMFCI=0&_afrMFM=0&_afrMFR=96&_afrMFG=0&_afrMFS=0&_afrMFO=0';

    // Intento 0: acceso directo a la ruta interna de la app (sin pasar por la
    // página puente de /ServiciosApp/). Si esto solo devuelve otra vez la misma
    // página puente, seguimos con la danza de rebotes como respaldo (abajo).
    {
        const directUrl = `https://sia.unal.edu.co/ServiciosApp/faces/inicioServicios?${mediaParams}`;
        const res = await http2Request(jar, 'GET', directUrl, undefined, { 'Pragma': 'no-cache' });
        const body = typeof res.data === 'string' ? res.data : '';
        const viewState = extractViewState(body);
        const parsed = parseLoopbackArgs(body);
        steps.push({
            name: '0-acceso-directo-inicioServicios',
            status: res.status,
            length: body.length,
            isLoopback: !!parsed,
            viewStateEncontrado: !!viewState,
            preview: body.length <= 2000 ? body : body.slice(0, 800)
        });
        if (viewState) return { viewState, windowId: randomWindowId() };
    }

    let windowMode = 0;
    // Simula "window.name": en un navegador real se fija UNA sola vez en el primer
    // rebote y de ahí en adelante se reutiliza siempre, ignorando cualquier otro id
    // que el servidor vuelva a ofrecer en rebotes posteriores.
    let lockedWindowId = null;

    for (let attempt = 1; attempt <= 8; attempt++) {
        const idToSend = lockedWindowId || randomWindowId();
        const afrLoop = Date.now().toString() + Math.floor(Math.random() * 100000);

        try { await jar.setCookie(`Adf-Window-Id=${idToSend}; path=/`, 'https://sia.unal.edu.co'); } catch (e) {}

        const url = `https://sia.unal.edu.co/ServiciosApp/?_afrLoop=${afrLoop}&_afrWindowMode=${windowMode}&Adf-Window-Id=${idToSend}&_afrPage=0&${mediaParams}`;
        const res = await http2Request(jar, 'GET', url, undefined, { 'Pragma': 'no-cache' });
        const body = typeof res.data === 'string' ? res.data : '';
        const viewState = extractViewState(body);
        const parsed = parseLoopbackArgs(body);
        const nonceMatch = body.match(/nonce="([^"]+)"/);

        steps.push({
            name: `1.${attempt}-cargar-pagina(windowMode=${windowMode})`,
            requestedWindowId: idToSend,
            serverAssignedWindowId: parsed ? parsed.windowId : null,
            lockedWindowId,
            nonce: nonceMatch ? nonceMatch[1] : null,
            cacheHeader: res.headers['x-cache'] || null,
            status: res.status,
            length: body.length,
            isLoopback: !!parsed,
            viewStateEncontrado: !!viewState,
            preview: body.length <= 2000 ? body : body.slice(0, 800)
        });

        if (viewState) return { viewState, windowId: idToSend };
        if (!parsed) return { viewState: null, windowId: idToSend }; // ni loopback ni ViewState: algo inesperado

        if (!lockedWindowId) lockedWindowId = parsed.windowId; // fijar solo la PRIMERA vez
        windowMode = windowMode === 0 ? 2 : 0;
    }

    return { viewState: null, windowId: lockedWindowId };
}

// Replica paso a paso la navegación real capturada en el HAR: cargar la página,
// abrir el menú, entrar a "Asignaturas disponibles para cursar", fijar los filtros
// (mismos valores por defecto de la cuenta: plan/periodo/tipo ya vienen preseleccionados)
// y hacer clic en "Mostrar". Cada paso queda registrado en `steps` para depurar si algo falla.
async function fetchCourseDataDebug(session) {
    const { jar } = session;
    const steps = [];

    function record(name, res) {
        const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        const vsIdx = body.indexOf('ViewState');
        steps.push({
            name,
            status: res.status,
            length: body.length,
            preview: body.length <= 8000 ? body : body.slice(0, 400),
            viewStateContext: vsIdx !== -1 ? body.slice(Math.max(0, vsIdx - 60), vsIdx + 150) : null
        });
        return body;
    }

    const { viewState, windowId } = await loadRealPage(jar, steps);
    if (!viewState) return { ok: false, steps };

    const baseUrl = `https://sia.unal.edu.co/ServiciosApp/faces/inicioServicios?Adf-Window-Id=${windowId}&Adf-Page-Id=0`;

    async function pprPost(name, formFields) {
        const body = new URLSearchParams({
            'org.apache.myfaces.trinidad.faces.FORM': 'f1',
            'Adf-Window-Id': windowId,
            'javax.faces.ViewState': viewState,
            'Adf-Page-Id': '0',
            ...formFields
        }).toString();
        const res = await http2Request(jar, 'POST', baseUrl, body, { 'Content-Type': 'application/x-www-form-urlencoded' });
        return record(name, res);
    }

    await pprPost('2-expandir-menu', {
        event: 'pt1:men-portlets:j_idt25',
        'event.pt1:men-portlets:j_idt25': '<m xmlns="http://oracle.com/richClient/comm"><k v="expand"><b>1</b></k><k v="type"><s>disclosure</s></k></m>',
        'oracle.adf.view.rich.PROCESS': 'pt1:men-portlets:j_idt25'
    });

    await pprPost('3-clic-asignaturas-disponibles', {
        event: 'pt1:men-portlets:j_idt29',
        'event.pt1:men-portlets:j_idt29': '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>',
        'oracle.adf.view.rich.PROCESS': 'f1,pt1:men-portlets:j_idt29'
    });

    await pprPost('4-seleccionar-periodo', {
        'pt1:r1:1:soc3': '0', 'pt1:r1:1:descPlanLibreId': '', 'pt1:r1:1:soc1': '',
        event: 'pt1:r1:1:soc3',
        'event.pt1:r1:1:soc3': '<m xmlns="http://oracle.com/richClient/comm"><k v="autoSubmit"><b>1</b></k><k v="suppressMessageShow"><s>true</s></k><k v="type"><s>valueChange</s></k></m>',
        'oracle.adf.view.rich.PROCESS': 'pt1:r1:1:soc3'
    });

    await pprPost('5-seleccionar-plan', {
        'pt1:r1:1:soc3': '0', 'pt1:r1:1:soc2': '0', 'pt1:r1:1:soc4': '', 'pt1:r1:1:descPlanLibreId': '', 'pt1:r1:1:soc1': '',
        event: 'pt1:r1:1:soc2',
        'event.pt1:r1:1:soc2': '<m xmlns="http://oracle.com/richClient/comm"><k v="autoSubmit"><b>1</b></k><k v="suppressMessageShow"><s>true</s></k><k v="type"><s>valueChange</s></k></m>',
        'oracle.adf.view.rich.PROCESS': 'pt1:r1:1:soc2'
    });

    await pprPost('6-seleccionar-tipo', {
        'pt1:r1:1:soc3': '0', 'pt1:r1:1:soc2': '0', 'pt1:r1:1:soc4': '0', 'pt1:r1:1:descPlanLibreId': '', 'pt1:r1:1:soc1': '',
        event: 'pt1:r1:1:soc4',
        'event.pt1:r1:1:soc4': '<m xmlns="http://oracle.com/richClient/comm"><k v="autoSubmit"><b>1</b></k><k v="suppressMessageShow"><s>true</s></k><k v="type"><s>valueChange</s></k></m>',
        'oracle.adf.view.rich.PROCESS': 'pt1:r1:1:soc4'
    });

    const finalHtml = await pprPost('7-clic-mostrar', {
        'pt1:r1:1:soc3': '0', 'pt1:r1:1:soc2': '0', 'pt1:r1:1:soc4': '0', 'pt1:r1:1:descPlanLibreId': '', 'pt1:r1:1:soc1': '',
        event: 'pt1:r1:1:pt_cb1',
        'event.pt1:r1:1:pt_cb1': '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>',
        'oracle.adf.view.rich.PROCESS': 'pt1:r1,pt1:r1:1:pt_cb1'
    });

    const courses = parseCoursesFromXml(finalHtml);
    return { ok: true, steps, courses, coursesCount: courses.length };
}

// ==========================================
// MISMA TAREA, PERO CON UN NAVEGADOR REAL (Puppeteer) QUE SÍ EJECUTA JAVASCRIPT
// ==========================================
// Convierte las cookies ya logueadas (obtenidas con el login HTTP/2 manual) al
// formato que espera Puppeteer, para no tener que volver a loguear dentro del navegador.
async function jarToPuppeteerCookies(jar, urls) {
    const cookies = [];
    for (const url of urls) {
        const jarCookies = await jar.getCookies(url);
        for (const c of jarCookies) {
            cookies.push({
                name: c.key,
                value: c.value,
                domain: c.domain,
                path: c.path || '/',
                httpOnly: !!c.httpOnly,
                secure: !!c.secure
            });
        }
    }
    return cookies;
}

async function fetchCourseDataPuppeteer(session) {
    const { jar } = session;
    const steps = [];
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        });
        const page = await browser.newPage();
        await page.setUserAgent(UA);
        await page.setViewport({ width: 1920, height: 1080 });

        const cookies = await jarToPuppeteerCookies(jar, [
            'https://sia.unal.edu.co',
            'https://autenticasia.unal.edu.co'
        ]);
        if (cookies.length > 0) await page.setCookie(...cookies);
        steps.push({ name: '0-cookies-inyectadas', cantidad: cookies.length });

        await page.goto('https://sia.unal.edu.co/ServiciosApp/', { waitUntil: 'networkidle0', timeout: 30000 });
        steps.push({ name: '1-cargar-pagina', url: page.url(), title: await page.title() });

        // Diagnóstico: listar todos los frames (el menú/contenido de ADF suele vivir
        // dentro de un <iframe>, no en el documento principal) y si cada uno contiene
        // el texto "men-portlets" (parte del menú que buscamos).
        const frames = page.frames();
        const frameInfo = [];
        for (const f of frames) {
            let hasMenu = false;
            try {
                hasMenu = await f.evaluate(() => document.body && document.body.innerHTML.includes('men-portlets'));
            } catch (e) { /* frame cross-origin o no accesible */ }
            frameInfo.push({ url: f.url(), hasMenuText: hasMenu });
        }
        steps.push({ name: '1b-frames-encontrados', frames: frameInfo });

        // Diagnóstico: en vez de asumir el ID exacto del menú (capturado en una sesión
        // vieja), buscamos todos los elementos cuyo id contenga "men-portlets" o el
        // texto visible mencione "Asignaturas", para ver los IDs reales de ahora mismo.
        const menuElements = await page.evaluate(() => {
            const results = [];
            document.querySelectorAll('[id*="men-portlets"]').forEach(el => {
                results.push({ id: el.id, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 60) });
            });
            return results;
        });
        steps.push({ name: '1c-elementos-menu-reales', menuElements });

        // Busca un elemento por id en TODOS los frames y devuelve el frame donde está.
        async function findFrameWithElement(elementId) {
            for (const f of frames) {
                try {
                    const found = await f.evaluate((id) => !!document.getElementById(id), elementId);
                    if (found) return f;
                } catch (e) { /* ignorar frames no accesibles */ }
            }
            return null;
        }

        // "Asignaturas disponibles para cursar" vive bajo "Proceso de inscripción"
        // (confirmado en la captura real del portal), no bajo "Información académica".
        // Buscamos la sección por su TEXTO (el "::head"), no por un id fijo, porque
        // el sufijo j_idtNN cambia entre sesiones -- y de ahí derivamos su "::disAcr".
        const expandClicked = await page.evaluate(() => {
            const heads = document.querySelectorAll('[id$="::head"]');
            for (const h of heads) {
                if ((h.textContent || '').trim() === 'Proceso de inscripción') {
                    const prefix = h.id.replace(/::head$/, '');
                    const el = document.getElementById(prefix + '::disAcr')
                        || document.getElementById(prefix + '::btn')
                        || h;
                    el.click();
                    return el.id;
                }
            }
            return null;
        });
        steps.push({ name: '2a-expandir-proceso-inscripcion', expandClicked });
        await new Promise(r => setTimeout(r, 1500));

        // Listar lo que apareció nuevo (el submenú), para encontrar el id real de
        // "Asignaturas disponibles para cursar" sin volver a adivinar.
        const submenuItems = await page.evaluate(() => {
            const els = document.querySelectorAll('[id*="men-portlets"] a, [id*="men-portlets"] td');
            return Array.from(els)
                .map(el => ({ id: el.id, tag: el.tagName, text: (el.textContent || '').trim() }))
                .filter(x => x.text && x.text.length > 0);
        });
        steps.push({ name: '2b-items-del-submenu', cantidad: submenuItems.length, elementos: submenuItems.slice(0, 60) });

        const asignaturasItem = submenuItems.find(x => /asignaturas disponibles/i.test(x.text));
        steps.push({ name: '2c-item-asignaturas-encontrado', encontrado: !!asignaturasItem, item: asignaturasItem || null });

        const clickedMenuItem = asignaturasItem ? await page.evaluate((id) => {
            const el = document.getElementById(id);
            if (el) { el.click(); return true; }
            return false;
        }, asignaturasItem.id) : false;
        steps.push({ name: '2-clic-asignaturas-disponibles', clickedMenuItem });
        await new Promise(r => setTimeout(r, 2000));

        // Los filtros (plan/periodo/tipo) ya vienen con los valores por defecto de la
        // cuenta, así que vamos directo al clic en "Mostrar". Puede estar en OTRO frame
        // si "Asignaturas disponibles" abrió contenido nuevo, así que volvemos a buscar.
        const framesAfterNav = page.frames();
        let mostrarFrame = null;
        for (const f of framesAfterNav) {
            try {
                const found = await f.evaluate(() => !!document.getElementById('pt1:r1:1:pt_cb1'));
                if (found) { mostrarFrame = f; break; }
            } catch (e) { /* ignorar */ }
        }
        steps.push({ name: '2b-frame-de-mostrar', encontrado: !!mostrarFrame, url: mostrarFrame ? mostrarFrame.url() : null, totalFrames: framesAfterNav.length });

        // Diagnóstico del botón antes de tocarlo (por si está deshabilitado o ni
        // siquiera es el botón "Mostrar" real).
        const botonInfo = mostrarFrame ? await mostrarFrame.evaluate(() => {
            const el = document.getElementById('pt1:r1:1:pt_cb1');
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const real = document.elementFromPoint(cx, cy);
            return {
                tag: el.tagName,
                text: (el.textContent || '').trim(),
                disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
                visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
                innerHTML: el.innerHTML.slice(0, 600),
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                elementoEnEsasCoordenadas: real ? { tag: real.tagName, id: real.id, class: real.className } : null
            };
        }) : null;
        steps.push({ name: '2c-boton-mostrar-info', botonInfo });

        // Clic REAL con el mouse de Puppeteer (no un .click() disparado desde JS),
        // por si el botón necesita un evento de usuario "de verdad" para activarse.
        let clickedMostrar = false;
        if (mostrarFrame) {
            try {
                const handle = await mostrarFrame.$('#pt1\\:r1\\:1\\:pt_cb1') || await mostrarFrame.evaluateHandle(
                    () => document.getElementById('pt1:r1:1:pt_cb1')
                );
                if (handle) {
                    await handle.click();
                    clickedMostrar = true;
                }
            } catch (e) {
                steps.push({ name: '3-clic-mostrar-error', message: String(e.message || e) });
            }
        }
        steps.push({ name: '3-clic-mostrar', clickedMostrar });
        await new Promise(r => setTimeout(r, 6000));

        const contentFrame = mostrarFrame || page.mainFrame();
        const html = await contentFrame.content();
        steps.push({ name: '4-contenido-final', frameUrl: contentFrame.url(), length: html.length });

        // Leemos la tabla directamente del DOM ya renderizado (más confiable que
        // parsear el HTML serializado, que el navegador puede reordenar).
        const rowCount = await contentFrame.evaluate(() => document.querySelectorAll('tr.af_table_data-row').length);
        steps.push({ name: '5-filas-encontradas-en-dom', rowCount });

        if (rowCount === 0) {
            // Diagnóstico amplio: ¿hay AL MENOS alguna tabla/fila en el DOM? ¿aparece
            // el texto "CUPOS" en algún lado? ¿qué clases tienen los <tr> que sí existen?
            const diag = await contentFrame.evaluate(() => {
                const bodyText = document.body ? document.body.textContent || '' : '';
                const allTr = Array.from(document.querySelectorAll('tr'));
                const trClasses = [...new Set(allTr.map(tr => tr.className).filter(c => c))].slice(0, 20);
                const hasCuposText = bodyText.includes('CUPOS') || bodyText.includes('Cupos');
                const hasAsignaturaText = bodyText.includes('ASIGNATURA') || bodyText.includes('Asignatura');
                const anyTableIds = Array.from(document.querySelectorAll('table')).map(t => t.id).filter(Boolean).slice(0, 20);
                return { totalTr: allTr.length, trClasses, hasCuposText, hasAsignaturaText, anyTableIds };
            });
            steps.push({ name: '5b-diagnostico-tabla', ...diag });
        }

        const courses = await contentFrame.evaluate(() => {
            const rows = document.querySelectorAll('tr.af_table_data-row');
            const result = [];
            rows.forEach(row => {
                const spans = row.querySelectorAll('span');
                if (spans.length >= 4) {
                    const nameCode = (spans[0].textContent || '').trim();
                    const m = nameCode.match(/^(.*)\s\(([^)]+)\)\s*$/);
                    result.push({
                        name: m ? m[1].trim() : nameCode,
                        code: m ? m[2].trim() : '',
                        typology: (spans[1].textContent || '').trim(),
                        credits: (spans[2].textContent || '').trim(),
                        available: (spans[3].textContent || '').trim()
                    });
                }
            });
            return result;
        });

        return { ok: courses.length > 0, steps, courses, coursesCount: courses.length };
    } catch (err) {
        steps.push({ name: 'error', message: String(err.message || err) });
        return { ok: false, steps, error: String(err.message || err) };
    } finally {
        if (browser) await browser.close();
    }
}

app.get('/api/sia-directo/cupos-puppeteer', async (req, res) => {
    try {
        const session = await getSiaSession();
        const result = await fetchCourseDataPuppeteer(session);
        res.json({ generatedAt: new Date().toISOString(), ...result });
    } catch (err) {
        res.status(500).json({ generatedAt: new Date().toISOString(), error: String(err.message || err) });
    }
});

app.get('/api/sia-directo/cupos-debug', async (req, res) => {
    try {
        const session = await getSiaSession();
        const result = await fetchCourseDataDebug(session);
        res.json({ generatedAt: new Date().toISOString(), ...result });
    } catch (err) {
        res.status(500).json({ generatedAt: new Date().toISOString(), error: String(err.message || err) });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listo en http://localhost:${PORT}`));