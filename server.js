const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
    res.send('¡Mi proxy está funcionando!');
});

// ==========================================
// PROXY VIEJO HACIA sia.gabotachak.dev
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
// CLIENTE HTTP CON SOPORTE DE COOKIES
// ==========================================
const SIA_USER = process.env.SIA_USERNAME;
const SIA_PASS = process.env.SIA_PASSWORD;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function createSiaClient() {
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9',
            'Upgrade-Insecure-Requests': '1'
        },
        maxRedirects: 10,
        validateStatus: () => true
    }));
    return { client, jar };
}

async function loginToSia() {
    if (!SIA_USER || !SIA_PASS) {
        throw new Error('Faltan las variables de entorno SIA_USERNAME / SIA_PASSWORD en Railway.');
    }

    const { client, jar } = createSiaClient();

    // 1. Cargar inicio de ServiciosApp para detonar cookies iniciales OAM
    await client.get('https://sia.unal.edu.co/ServiciosApp');

    // 2. Enviar credenciales
    const postData = new URLSearchParams({ username: SIA_USER, password: SIA_PASS, submit: 'Iniciar Sesión' }).toString();
    const loginRes = await client.post(
        'https://autenticasia.unal.edu.co/oam/server/auth_cred_submit',
        postData,
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const html = typeof loginRes.data === 'string' ? loginRes.data : JSON.stringify(loginRes.data);
    const finalUrl = loginRes.request?.res?.responseUrl || loginRes.config?.url || '';
    const ok = loginRes.status < 400 && !html.includes('auth_cred_submit');

    return { ok, client, jar, finalUrl, status: loginRes.status, htmlPreview: html.slice(0, 1000) };
}

async function loadRealPage(jar, steps) {
    const mediaParams = '_afrFS=16&_afrMT=screen&_afrMFW=1920&_afrMFH=1080&_afrMFDW=1920&_afrMFDH=1080&_afrMFC=24&_afrMFCI=0&_afrMFM=0&_afrMFR=96&_afrMFG=0&_afrMFS=0&_afrMFO=0';
    let windowId = randomWindowId();
    let windowMode = 0;

    for (let attempt = 1; attempt <= 5; attempt++) {
        const afrLoop = Date.now().toString() + Math.floor(Math.random() * 1000);
        const url = `https://sia.unal.edu.co/ServiciosApp/?_afrLoop=${afrLoop}&_afrWindowMode=${windowMode}&Adf-Window-Id=${windowId}&_afrPage=0&${mediaParams}`;
        
        // Simular la cookie que ADF espera tras la ejecución del script puente
        try {
            await jar.setCookie(`_afrLoop=${afrLoop}; path=/; domain=sia.unal.edu.co`, 'https://sia.unal.edu.co');
        } catch (e) {}

        const res = await http2Request(jar, 'GET', url);
        const body = typeof res.data === 'string' ? res.data : '';
        const viewState = extractViewState(body);

        steps.push({
            name: `1.${attempt}-cargar-pagina(windowMode=${windowMode})`,
            status: res.status,
            length: body.length,
            isLoopback: body.includes('AdfLoopbackUtils.runLoopback'),
            viewStateEncontrado: !!viewState,
            preview: body.length <= 2000 ? body : body.slice(0, 800)
        });

        if (viewState) return { viewState, windowId };

        const parsed = parseLoopbackArgs(body);
        if (!parsed) return { viewState: null, windowId };

        windowId = parsed.windowId;
        windowMode = windowMode === 0 ? 2 : 0;
    }

    return { viewState: null, windowId };
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
        siaSession = { client: result.client, loggedInAt: Date.now() };
    }
    return siaSession;
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

async function fetchCourseDataDebug(session) {
    const { client } = session;
    const steps = [];

    // Bypass del loopback ADF haciendo la petición directa a inicioServicios
    const mainPageRes = await client.get('https://sia.unal.edu.co/ServiciosApp/faces/inicioServicios');
    const bodyMain = typeof mainPageRes.data === 'string' ? mainPageRes.data : '';
    let viewState = extractViewState(bodyMain);

    steps.push({
        name: '1-cargar-inicioServicios',
        status: mainPageRes.status,
        length: bodyMain.length,
        viewStateEncontrado: !!viewState,
        preview: bodyMain.slice(0, 500)
    });

    if (!viewState) {
        return { ok: false, steps, error: 'No se pudo obtener el ViewState inicial de Oracle ADF' };
    }

    const baseUrl = 'https://sia.unal.edu.co/ServiciosApp/faces/inicioServicios';

    async function pprPost(name, formFields) {
        const body = new URLSearchParams({
            'org.apache.myfaces.trinidad.faces.FORM': 'f1',
            'javax.faces.ViewState': viewState,
            'Adf-Page-Id': '0',
            ...formFields
        }).toString();

        const res = await client.post(baseUrl, body, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' }
        });

        const resBody = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
        const newVs = extractViewState(resBody);
        if (newVs) viewState = newVs;

        steps.push({
            name,
            status: res.status,
            length: resBody.length,
            preview: resBody.slice(0, 500)
        });
        return resBody;
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

    const finalHtml = await pprPost('7-clic-mostrar', {
        'pt1:r1:1:soc3': '0',
        'pt1:r1:1:soc2': '0',
        'pt1:r1:1:soc4': '0',
        event: 'pt1:r1:1:pt_cb1',
        'event.pt1:r1:1:pt_cb1': '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>',
        'oracle.adf.view.rich.PROCESS': 'pt1:r1,pt1:r1:1:pt_cb1'
    });

    const courses = parseCoursesFromXml(finalHtml);
    return { ok: true, steps, courses, coursesCount: courses.length };
}

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