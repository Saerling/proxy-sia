'use strict';
/**
 * Cliente del "Catálogo de asignaturas" PÚBLICO del SIA (sia.unal.edu.co/Catalogo).
 * No requiere login. Replica el flujo capturado en el HAR:
 *
 *   GET  servicioPublico.jsf?taskflowId=task-flow-AC_CatalogoAsignaturas   (302 + página puente "loopback")
 *   GET  ...&_afrLoop=<id del servidor>&_afrWindowMode=0&Adf-Window-Id=... (página real + ViewState)
 *   POST soc1 (nivel) -> soc9 (sede) -> soc2 (facultad) -> soc3 (plan) -> soc4 (tipología)
 *   POST cb1 (botón Buscar)                      -> tabla de asignaturas (pt1:r1:0:t4)
 *   POST t4 "selection" + POST t4:<rowKey>:cl2   -> detalle: grupos, profesores, horarios, cupos
 *
 * IMPORTANTE: los <option value="..."> de los selectores son ÍNDICES de posición dentro de una lista
 * que cambia según la selección anterior (no códigos). Por eso se resuelven leyendo las listas que
 * devuelve cada paso, nunca con valores fijos.
 */

const ORIGIN = 'https://sia.unal.edu.co';
const ENTRY_URL = `${ORIGIN}/Catalogo/facespublico/public/servicioPublico.jsf`;
const TASKFLOW = 'task-flow-AC_CatalogoAsignaturas';
const START_URL = `${ENTRY_URL}?taskflowId=${TASKFLOW}`;
const UA = process.env.SIA_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0';
const USE_HTTP2 = process.env.CATALOGO_HTTP2 !== '0';
const F = 'pt1:r1:0:'; // prefijo de los componentes del formulario de búsqueda

const MEDIA = {
  _afrFS: '16', _afrMT: 'screen', _afrMFW: '1920', _afrMFH: '1080', _afrMFDW: '1920', _afrMFDH: '1080',
  _afrMFC: '24', _afrMFCI: '0', _afrMFM: '0', _afrMFR: '96', _afrMFG: '0', _afrMFS: '0', _afrMFO: '0'
};

const EV_VALUE_CHANGE = '<m xmlns="http://oracle.com/richClient/comm"><k v="autoSubmit"><b>1</b></k><k v="suppressMessageShow"><s>true</s></k><k v="type"><s>valueChange</s></k></m>';
const EV_ACTION = '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>action</s></k></m>';
const EV_SELECTION = '<m xmlns="http://oracle.com/richClient/comm"><k v="type"><s>selection</s></k></m>';

// Orden canónico de los campos del formulario, tal como los envía el navegador.
const CHOSEN_ORDER = ['soc1', 'soc9', 'soc2', 'soc3', 'soc4'];

// ---------------------------------------------------------------------------
// Utilidades de texto
// ---------------------------------------------------------------------------
const ENT = {
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  uuml: 'ü', Uuml: 'Ü', iquest: '¿', iexcl: '¡', amp: '&', lt: '<', gt: '>',
  quot: '"', apos: "'", nbsp: ' ', ordm: 'º', ordf: 'ª', deg: '°'
};
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, n) => {
    if (n[0] === '#') {
      const cp = n[1].toLowerCase() === 'x' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch (_) { return m; }
    }
    return n in ENT ? ENT[n] : m;
  });
}
const clean = (s) => decode(String(s ?? '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
const stripDot = (s) => clean(s).replace(/[.\s]+$/, '');
const norm = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

function httpError(status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

// ---------------------------------------------------------------------------
// Parsers (puros, se prueban contra el HAR sin red)
// ---------------------------------------------------------------------------
function extractViewState(text) {
  let m = text.match(/name="javax\.faces\.ViewState"[^>]*value="([^"]*)"/);
  if (m) return m[1];
  m = text.match(/<update id="javax\.faces\.ViewState"><!\[CDATA\[([^\]]*)\]\]>/);
  return m ? m[1] : null;
}

// Selectores (<select id="pt1:r1:0:socN::content">) -> { socN: [{value,label}] }
function parseSelects(text) {
  const out = {};
  const re = /<select\b[^>]*\bid="pt1:r1:0:(soc\d+)::content"[^>]*>([\s\S]*?)<\/select>/g;
  let m;
  while ((m = re.exec(text))) {
    const opts = [];
    const ore = /<option\b[^>]*\bvalue="([^"]*)"[^>]*>([^<]*)/g;
    let o;
    while ((o = ore.exec(m[2]))) opts.push({ value: o[1], label: decode(o[2]).trim() });
    out[m[1]] = opts;
  }
  return out;
}

function pickOption(opts, wanted, what) {
  const real = (opts || []).filter((o) => o.label !== '');
  const w = norm(wanted);
  let hit = real.filter((o) => norm(o.label).split(' ')[0] === w);   // por código ("2055")
  if (!hit.length) hit = real.filter((o) => norm(o.label) === w);    // por nombre exacto
  if (!hit.length) hit = real.filter((o) => norm(o.label).includes(w)); // por fragmento
  if (hit.length === 1) return hit[0];
  throw httpError(400,
    hit.length ? `"${wanted}" es ambiguo para ${what}` : `No encontré "${wanted}" en ${what}`,
    { opciones: real.map((o) => o.label) });
}

const splitCodeName = (label) => {
  const m = label.match(/^(\S+)\s+(.*)$/);
  return m ? { codigo: m[1], nombre: m[2].trim() } : { codigo: '', nombre: label };
};
// Sedes, facultades y planes empiezan con un código ("2055 FACULTAD DE..."); las tipologías no.
const toOptionList = (opts, conCodigo = true) => (opts || []).filter((o) => o.label !== '')
  .map((o) => (conCodigo ? { ...splitCodeName(o.label), label: o.label } : { nombre: o.label, label: o.label }));

// Puente "loopback" de ADF: extrae el _afrLoop y el Adf-Window-Id que asigna el servidor.
function parseLoopback(html) {
  const m = html.match(/AdfLoopbackUtils\.runLoopback\(([\s\S]*?)\);\s*<\/script>/);
  if (!m) return null;
  const s = m[1];
  const tokens = [];
  let depth = 0, inStr = false, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === "'" && s[i - 1] !== '\\') inStr = false; }
    else if (c === "'") { inStr = true; cur += c; }
    else if (c === '{') { depth++; cur += c; }
    else if (c === '}') { depth--; cur += c; }
    else if (c === ',' && depth === 0) { tokens.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  if (cur.trim()) tokens.push(cur.trim());
  const unq = (t) => (t && t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1) : t);
  if (tokens.length < 8) return null;
  return { loopId: unq(tokens[2]), windowId: unq(tokens[7]) };
}

// Tabla de resultados (pt1:r1:0:t4)
function parseCourses(xml) {
  const total = Number((xml.match(/rowCount="(\d+)"/) || [])[1] || 0);
  const courses = [];
  const rowRe = /<tr\b[^>]*_afrRK="(\d+)"[^>]*>([\s\S]*?)<\/tr>/gi;
  let r;
  while ((r = rowRe.exec(xml))) {
    const cells = {};
    const cre = /<td\b[^>]*id="pt1:r1:0:t4:\d+:(c\d+)"[^>]*>([\s\S]*?)<\/td>/g;
    let c;
    while ((c = cre.exec(r[2]))) cells[c[1]] = c[2];
    if (!cells.c1) continue;
    const nameCell = cells.c2 || '';
    const firstSpan = (nameCell.match(/<span\b[^>]*>([^<]*)<\/span>/) || [])[1];
    const extra = clean(nameCell.replace(/<span\b[^>]*>[^<]*<\/span>/, ''));
    courses.push({
      rowKey: Number(r[1]),
      codigo: clean(cells.c1),
      nombre: clean(firstSpan ?? nameCell),
      creditos: Number(clean(cells.c5)) || null,
      tipologia: clean(cells.c6),
      sinProgramar: /SIN PROGRAMAR/i.test(extra)
    });
  }
  return { rowCount: total || courses.length, courses };
}

// Detalle de una asignatura: grupos, profesores, horarios, cupos, prerrequisitos
function parseDetail(xml) {
  const m = xml.match(/<update id="pt1:r1"><!\[CDATA\[([\s\S]*?)\]\]><\/update>/);
  const h = m ? m[1] : xml;

  const out = { asignatura: {}, tiposClase: [], prerrequisitos: [], resumen: {} };

  const t = clean((h.match(/id="pt1:r1:1:t2:w-titulo"[\s\S]*?<h2>([^<]*)<\/h2>/) || [])[1] || '');
  const tm = t.match(/^(.*)\s\(([^)]+)\)$/);
  out.asignatura = {
    nombre: tm ? tm[1].trim() : t,
    codigo: tm ? tm[2].trim() : '',
    tipologia: clean((h.match(/id="pt1:r1:1:ot2">([^<]*)</) || [])[1]),
    creditos: Number(clean((h.match(/id="pt1:r1:1:ot1">([^<]*)</) || [])[1])) || null,
    plan: clean((h.match(/id="pt1:r1:1:ot18">([^<]*)</) || [])[1]),
    facultad: clean(((h.match(/id="pt1:r1:1:pgl13"[^>]*>([^<]*)</) || [])[1] || '').replace(/^\s*Facultad:/i, ''))
  };

  // Títulos de tipo de clase (p. ej. "CLASE TEORICA 1000003 (21000003)")
  const types = {};
  const tre = /id="pt1:r1:1:i2:(\d+):t3:w-titulo"[^>]*>[\s\S]*?<h3>([^<]*)<\/h3>/g;
  let x;
  while ((x = tre.exec(h))) types[x[1]] = clean(x[2]);

  // Título de cada grupo, en orden de aparición
  const groups = new Map(); // "T:G" -> grupo
  const gre = /id="pt1:r1:1:i2:(\d+):i3:(\d+):sdh2::_afrTtxt"[^>]*><div title="([^"]*)"/g;
  while ((x = gre.exec(h))) {
    const titulo = clean(x[3]);
    const gm = titulo.match(/^\(([^)]+)\)\s*(.*)$/);
    groups.set(`${x[1]}:${x[2]}`, {
      _t: x[1], _g: x[2],
      tipoClase: null,
      grupo: gm ? gm[1] : titulo,
      nombre: gm ? gm[2].trim() : titulo,
      profesores: [],
      facultadProfesor: '',
      duracion: '',
      jornada: '',
      cuposDisponibles: null,
      horarios: [],
      _periodos: new Map()
    });
  }

  // Todas las hojas <span id="...">texto</span>, clasificadas por id
  const leaf = /<span\b[^>]*\bid="([^"]+)"[^>]*>([^<]*)<\/span>/g;
  while ((x = leaf.exec(h))) {
    const id = x[1];
    const txt = x[2];

    const g = id.match(/^pt1:r1:1:i2:(\d+):i3:(\d+):(.+)$/);
    if (g) {
      const grp = groups.get(`${g[1]}:${g[2]}`);
      if (!grp) continue;
      const rest = g[3];
      let r;
      if (/^i4:\d+:ot8$/.test(rest)) { const p = stripDot(txt); if (p) grp.profesores.push(p); }
      else if (rest === 'ot53') grp.facultadProfesor = clean(txt);
      else if (rest === 'ot24') { const n = parseInt(clean(txt), 10); grp.cuposDisponibles = Number.isNaN(n) ? null : n; }
      else if (rest === 'ot26') grp.jornada = clean(txt);
      else if (rest === 'ot15') grp.duracion = clean(txt).replace(/^Duraci[oó]n:\s*/i, '');
      else if ((r = rest.match(/^i5:(\d+):ot12$/))) periodo(grp, r[1]).desde = clean(txt);
      else if ((r = rest.match(/^i5:(\d+):ot14$/))) periodo(grp, r[1]).hasta = clean(txt);
      else if ((r = rest.match(/^i5:(\d+):i111:(\d+):ot10$/))) {
        const ses = sesion(periodo(grp, r[1]), r[2]);
        ses.texto = clean(txt);
      } else if ((r = rest.match(/^i5:(\d+):i111:(\d+):i6:(\d+):(ot27|ot28|ot29|ot30)$/))) {
        const ses = sesion(periodo(grp, r[1]), r[2]);
        const loc = (ses._loc[r[3]] = ses._loc[r[3]] || {});
        const key = { ot27: 'descripcion', ot28: 'codigo', ot29: 'edificio', ot30: 'tipo' }[r[4]];
        loc[key] = stripDot(txt);
      }
      continue;
    }

    const p = id.match(/^pt1:r1:1:i7:(\d+):(?:i8:(\d+):)?(ot\d+)$/);
    if (p) {
      const ci = Number(p[1]);
      const cond = (out.prerrequisitos[ci] = out.prerrequisitos[ci] || { asignaturas: [] });
      if (p[2] === undefined) {
        const v = clean(txt);
        if (p[3] === 'ot32') cond.condicion = v;
        else if (p[3] === 'ot34') cond.tipo = v;
        else if (p[3] === 'ot36') cond.todas = v.replace(/[[\]]/g, '');
        else if (p[3] === 'ot38') cond.numeroAsignaturas = Number(v.replace(/[[\]]/g, '')) || v;
      } else {
        const ai = Number(p[2]);
        const a = (cond.asignaturas[ai] = cond.asignaturas[ai] || {});
        if (p[3] === 'ot39') a.codigo = clean(txt);
        else if (p[3] === 'ot40') a.nombre = clean(txt);
      }
    }
  }

  function periodo(grp, k) {
    if (!grp._periodos.has(k)) grp._periodos.set(k, { desde: '', hasta: '', _ses: new Map() });
    return grp._periodos.get(k);
  }
  function sesion(per, k) {
    if (!per._ses.has(k)) per._ses.set(k, { texto: '', _loc: {} });
    return per._ses.get(k);
  }

  // Aplanar: periodos/sesiones -> horarios[]
  const grupos = [];
  for (const grp of groups.values()) {
    for (const per of grp._periodos.values()) {
      for (const ses of per._ses.values()) {
        const tm2 = ses.texto.match(/^(\S+)\s+de\s+(\d{1,2}:\d{2})\s+a\s+(\d{1,2}:\d{2})/i);
        grp.horarios.push({
          dia: tm2 ? tm2[1] : null,
          inicio: tm2 ? tm2[2] : null,
          fin: tm2 ? tm2[3] : null,
          texto: ses.texto,
          desde: per.desde,
          hasta: per.hasta,
          ubicaciones: Object.keys(ses._loc).sort((a, b) => a - b).map((k) => ses._loc[k])
        });
      }
    }
    grp.tipoClase = types[grp._t] || null;
    delete grp._periodos; delete grp._t; delete grp._g;
    grupos.push(grp);
  }

  out.tiposClase = [...new Set(grupos.map((g) => g.tipoClase))].map((nombre) => ({
    nombre,
    grupos: grupos.filter((g) => g.tipoClase === nombre)
  }));
  out.prerrequisitos = out.prerrequisitos.filter(Boolean);
  out.resumen = {
    grupos: grupos.length,
    gruposConCupo: grupos.filter((g) => (g.cuposDisponibles || 0) > 0).length,
    cuposDisponibles: grupos.reduce((s, g) => s + (g.cuposDisponibles || 0), 0)
  };
  return out;
}

// ---------------------------------------------------------------------------
// Transporte HTTP (con cookie jar propio por sesión)
// ---------------------------------------------------------------------------
function createHttpTransport() {
  const axios = require('axios');                  // lazy: así los parsers se pueden probar sin dependencias
  const { CookieJar } = require('tough-cookie');
  const jar = new CookieJar();
  async function send(method, url, { data, headers = {} } = {}) {
    const cookie = await jar.getCookieString(url);
    const res = await axios({
      method, url, data,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers
      },
      ...(USE_HTTP2 ? { httpVersion: 2 } : {}),
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 30000,
      responseType: 'text',
      transformResponse: [(d) => d]
    });
    for (const sc of [].concat(res.headers['set-cookie'] || [])) {
      try { await jar.setCookie(sc, url); } catch (_) { /* cookie no aplicable */ }
    }
    return { status: res.status, headers: res.headers, data: typeof res.data === 'string' ? res.data : String(res.data ?? '') };
  }
  return { send };
}

const navHeaders = (site, referer) => ({
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': site,
  ...(referer ? { Referer: referer } : {})
});

function fail(msg, res, extra = {}) {
  return httpError(502, msg, { preview: res && res.data ? String(res.data).slice(0, 300) : undefined, ...extra });
}

async function navigate(t, url, headers, trace, name) {
  let cur = url;
  for (let hop = 0; hop < 8; hop++) {
    const t0 = Date.now();
    const res = await t.send('GET', cur, { headers });
    trace.push({ paso: name, hop, status: res.status, ms: Date.now() - t0, bytes: res.data.length });
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      cur = new URL(res.headers.location, cur).toString();
      continue;
    }
    if (res.status >= 400) {
      throw fail(`El SIA respondió HTTP ${res.status} en ${name}` +
        (res.status === 403 ? ' (¿bloqueo por IP de datacenter / WAF?)' : ''), res);
    }
    return { res, url: cur };
  }
  throw httpError(502, `Demasiadas redirecciones en ${name}`);
}

// ---------------------------------------------------------------------------
// Sesión ADF
// ---------------------------------------------------------------------------
async function openSession(transportFactory, trace) {
  const t = transportFactory();
  let { res, url } = await navigate(t, START_URL, navHeaders('none'), trace, '1-inicio');
  let html = res.data;
  let windowId = null;
  let mode = 0;

  // Normalmente basta una vuelta; dejamos hasta 4 por si el servidor rebota otra vez.
  for (let i = 1; i <= 4; i++) {
    const lb = parseLoopback(html);
    if (!lb) break;
    windowId = windowId || lb.windowId; // se fija la primera vez (como window.name en un navegador)
    const qs = new URLSearchParams({
      taskflowId: TASKFLOW, _afrLoop: lb.loopId, _afrWindowMode: String(mode),
      'Adf-Window-Id': windowId, _afrPage: '0', ...MEDIA
    });
    ({ res, url } = await navigate(t, `${ENTRY_URL}?${qs}`, navHeaders('same-origin', url), trace, `2.${i}-pagina(mode=${mode})`));
    html = res.data;
    mode = mode === 0 ? 2 : 0;
  }

  const viewState = extractViewState(html);
  if (!viewState) throw fail('No encontré el ViewState en la página del catálogo', res);
  if (!windowId) windowId = ((url.match(/Adf-Window-Id=([^&]+)/) || [])[1]) || Math.random().toString(36).slice(2, 11);
  const pageId = (html.match(/setPageId\('(\d+)'\)/) || [])[1] || '0';

  const adf = {
    windowId, viewState, pageId,
    selects: parseSelects(html),
    chosen: {}
  };

  const postUrl = `${ENTRY_URL}?Adf-Window-Id=${windowId}&Adf-Page-Id=0`;

  // Un POST "PPR" (partial page rendering) como los que hace el navegador.
  adf.post = async function post(name, extra) {
    const body = new URLSearchParams();
    for (const k of CHOSEN_ORDER) if (k in adf.chosen) body.append(F + k, adf.chosen[k]);
    body.append(F + 'soc5', '');
    body.append(F + 'soc10', '0');
    body.append(F + 'it10', '');
    body.append(F + 'it11', '');
    body.append('org.apache.myfaces.trinidad.faces.FORM', 'f1');
    body.append('Adf-Window-Id', adf.windowId);
    body.append('javax.faces.ViewState', adf.viewState);
    body.append('Adf-Page-Id', '0');
    for (const [k, v] of Object.entries(extra)) body.append(k, v);

    const t0 = Date.now();
    const r = await t.send('POST', postUrl, {
      data: body.toString(),
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Adf-Ads-Page-Id': adf.pageId,
        'Adf-Rich-Message': 'true',
        Origin: ORIGIN,
        Referer: START_URL,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin'
      }
    });
    trace.push({ paso: name, status: r.status, ms: Date.now() - t0, bytes: r.data.length });
    if (r.status !== 200 || !/<partial-response/.test(r.data)) {
      throw fail(`Paso "${name}": respuesta inesperada del SIA (HTTP ${r.status})`, r);
    }
    const vs = extractViewState(r.data);
    if (vs) adf.viewState = vs;
    Object.assign(adf.selects, parseSelects(r.data));
    return r.data;
  };

  adf.valueChange = (name, comp) => adf.post(name, {
    event: F + comp,
    [`event.${F}${comp}`]: EV_VALUE_CHANGE,
    'oracle.adf.view.rich.PROCESS': F + comp
  });

  return adf;
}

// Baja por la cascada nivel > sede > facultad > plan > tipología hasta donde se pida.
async function cascade(adf, f, upTo, trace) {
  const res = {};
  const nivel = pickOption(adf.selects.soc1, f.nivel || 'pregrado', 'nivel de estudio');
  adf.chosen = { soc1: nivel.value };
  res.nivel = nivel.label;
  if (upTo === 'sede') return res;
  await adf.valueChange('3-nivel', 'soc1');

  const sede = pickOption(adf.selects.soc9, f.sede, 'sede');
  adf.chosen.soc9 = sede.value;
  adf.chosen.soc2 = ''; // el navegador ya envía soc2 vacío en este paso
  res.sede = sede.label;
  if (upTo === 'facultad') return res;
  await adf.valueChange('4-sede', 'soc9');

  const fac = pickOption(adf.selects.soc2, f.facultad, 'facultad');
  adf.chosen.soc2 = fac.value;
  res.facultad = fac.label;
  if (upTo === 'plan') return res;
  await adf.valueChange('5-facultad', 'soc2');

  const plan = pickOption(adf.selects.soc3, f.plan, 'plan de estudios');
  adf.chosen.soc3 = plan.value;
  res.plan = plan.label;
  if (upTo === 'tipologia') return res;
  await adf.valueChange('6-plan', 'soc3');

  const tip = pickOption(adf.selects.soc4, f.tipologia || 'todas', 'tipología');
  adf.chosen.soc4 = tip.value;
  res.tipologia = tip.label;
  await adf.valueChange('7-tipologia', 'soc4');
  return res;
}

async function search(adf, f, trace) {
  const sel = await cascade(adf, f, 'buscar', trace);
  const xml = await adf.post('8-buscar', {
    event: F + 'cb1',
    [`event.${F}cb1`]: EV_ACTION,
    'oracle.adf.view.rich.PROCESS': `pt1:r1,${F}cb1`
  });
  if (!xml.includes('id="pt1:r1:0:t4"')) {
    return { seleccion: sel, rowCount: 0, courses: [] }; // consulta sin resultados
  }
  return { seleccion: sel, ...parseCourses(xml) };
}

async function openDetail(adf, course, rowCount) {
  const rk = course.rowKey;
  await adf.post('9-seleccionar-fila', {
    'oracle.adf.view.rich.DELTAS': `{${F}t4={viewportSize=${rowCount + 1},rows=${rowCount},selectedRowKeys=${rk}}}`,
    event: `${F}t4`,
    [`event.${F}t4`]: EV_SELECTION,
    'oracle.adf.view.rich.PROCESS': `${F}t4`
  });
  const xml = await adf.post('10-abrir-detalle', {
    'oracle.adf.view.rich.RENDER': 'pt1:r1',
    event: `${F}t4:${rk}:cl2`,
    [`event.${F}t4:${rk}:cl2`]: EV_ACTION,
    'oracle.adf.view.rich.PROCESS': `pt1:r1,${F}t4:${rk}:cl2`
  });
  if (!xml.includes('pt1:r1:1:')) throw fail('No llegó la vista de detalle de la asignatura', { data: xml });
  return parseDetail(xml);
}

function findCourse(courses, code) {
  const c = String(code).trim().toUpperCase();
  let hit = courses.filter((x) => x.codigo.toUpperCase() === c);
  if (!hit.length) hit = courses.filter((x) => x.codigo.toUpperCase().split('-')[0] === c);
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) throw httpError(409, `El código "${code}" coincide con varias asignaturas`, { candidatos: hit.map((h) => h.codigo) });
  const sim = courses.filter((x) => norm(x.nombre).includes(norm(code))).slice(0, 8).map((x) => `${x.codigo} ${x.nombre}`);
  throw httpError(404, `No encontré la asignatura "${code}" en esa búsqueda`, { similares: sim, totalAsignaturas: courses.length });
}

// ---------------------------------------------------------------------------
// Caché, deduplicación de peticiones y límite de concurrencia
// ---------------------------------------------------------------------------
function createLimiter(max) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= max || !q.length) return;
    active++;
    const { fn, resolve, reject } = q.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { q.push({ fn, resolve, reject }); next(); });
}

function createMemo() {
  const cache = new Map();
  const inflight = new Map();
  return async function memo(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && hit.exp > Date.now()) return { value: hit.value, cached: true };
    if (inflight.has(key)) return { value: await inflight.get(key), cached: false };
    const p = fn().then((v) => { cache.set(key, { value: v, exp: Date.now() + ttlMs }); return v; })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
    return { value: await p, cached: false };
  };
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------
function createCatalogo({ transportFactory = createHttpTransport } = {}) {
  const limit = createLimiter(Number(process.env.CATALOGO_CONCURRENCY || 2));
  const memo = createMemo();
  const TTL_LIST = Number(process.env.CATALOGO_TTL_LISTA_MS || 15 * 60 * 1000);
  const TTL_DETAIL = Number(process.env.CATALOGO_TTL_DETALLE_MS || 3 * 60 * 1000);
  const key = (f) => [f.nivel || 'pregrado', f.sede, f.facultad, f.plan, f.tipologia || 'todas'].map((v) => norm(v ?? '')).join('|');

  async function withRetry(fn, tries = 2) {
    let last;
    for (let i = 0; i < tries; i++) {
      try { return await fn(); }
      catch (e) { last = e; if (e.status && e.status < 500) throw e; }
    }
    throw last;
  }

  async function getOpciones(f) {
    const trace = [];
    return limit(() => withRetry(async () => {
      trace.length = 0;
      const adf = await openSession(transportFactory, trace);
      let siguiente, lista;
      if (!f.sede) { siguiente = 'sede'; lista = adf.selects.soc9; }
      else {
        const upTo = !f.facultad ? 'facultad' : !f.plan ? 'plan' : 'tipologia';
        const sel = await cascade(adf, f, upTo, trace);
        // Tras elegir hasta X, el servidor ya devolvió la lista siguiente.
        if (upTo === 'facultad') { await adf.valueChange('4-sede', 'soc9'); siguiente = 'facultad'; lista = adf.selects.soc2; }
        else if (upTo === 'plan') { await adf.valueChange('5-facultad', 'soc2'); siguiente = 'plan'; lista = adf.selects.soc3; }
        else { await adf.valueChange('6-plan', 'soc3'); siguiente = 'tipologia'; lista = adf.selects.soc4; }
        return { seleccion: sel, siguiente, opciones: toOptionList(lista, siguiente !== 'tipologia'), trace: [...trace] };
      }
      return { seleccion: {}, siguiente, opciones: toOptionList(lista), trace: [...trace] };
    }));
  }

  async function getAsignaturas(f) {
    const trace = [];
    const { value, cached } = await memo('lst|' + key(f), TTL_LIST, () => limit(() => withRetry(async () => {
      trace.length = 0;
      const adf = await openSession(transportFactory, trace);
      return search(adf, f, trace);
    })));
    return { ...value, cached, trace };
  }

  async function getGrupos(f, codigos) {
    const out = [];
    for (const code of codigos) {
      const trace = [];
      try {
        const { value, cached } = await memo(`det|${key(f)}|${norm(code)}`, TTL_DETAIL, () => limit(() => withRetry(async () => {
          trace.length = 0;
          const adf = await openSession(transportFactory, trace);
          const s = await search(adf, f, trace);
          const course = findCourse(s.courses, code);
          const detalle = await openDetail(adf, course, s.rowCount);
          return { seleccion: s.seleccion, ...detalle };
        })));
        out.push({ consulta: code, cached, ...value, trace });
      } catch (e) {
        out.push({ consulta: code, error: e.message, status: e.status || 502, similares: e.similares, candidatos: e.candidatos, preview: e.preview, trace });
      }
    }
    return out;
  }

  return { getOpciones, getAsignaturas, getGrupos };
}

// ---------------------------------------------------------------------------
// Rutas Express
// ---------------------------------------------------------------------------
function register(app, opts) {
  const cat = createCatalogo(opts);
  const readF = (q) => ({ nivel: q.nivel, sede: q.sede, facultad: q.facultad, plan: q.plan, tipologia: q.tipologia });
  const need = (f, ...ks) => {
    const miss = ks.filter((k) => !f[k]);
    if (miss.length) throw httpError(400, `Faltan parámetros: ${miss.join(', ')}. Usa /api/catalogo/opciones para ver los valores válidos.`);
  };
  const wrap = (fn) => async (req, res) => {
    const debug = req.query.debug === '1';
    try {
      const data = await fn(req);
      if (!debug && data && typeof data === 'object') {
        if (Array.isArray(data.resultados)) data.resultados.forEach((r) => delete r.trace);
        delete data.trace;
      }
      res.json({ generadoEn: new Date().toISOString(), ...data });
    } catch (e) {
      res.status(e.status || 502).json({
        generadoEn: new Date().toISOString(), error: e.message, opciones: e.opciones, preview: e.preview
      });
    }
  };

  // Valores válidos para cada filtro, en cascada: /opciones -> ?sede= -> &facultad= -> &plan=
  app.get('/api/catalogo/opciones', wrap(async (req) => cat.getOpciones(readF(req.query))));

  // Todas las asignaturas de un plan (código, nombre, créditos, tipología). ?q= filtra por nombre/código.
  app.get('/api/catalogo/asignaturas', wrap(async (req) => {
    const f = readF(req.query);
    need(f, 'sede', 'facultad', 'plan');
    const r = await cat.getAsignaturas(f);
    const q = req.query.q ? norm(req.query.q) : null;
    const courses = q ? r.courses.filter((c) => norm(c.nombre).includes(q) || norm(c.codigo).includes(q)) : r.courses;
    return { seleccion: r.seleccion, total: r.rowCount, devueltas: courses.length, cached: r.cached, asignaturas: courses, trace: r.trace };
  }));

  // Grupos, profesores, horarios y cupos. ?codigo=1000003-B  o  ?codigos=1000003-B,2015707 (máx. 8)
  app.get('/api/catalogo/grupos', wrap(async (req) => {
    const f = readF(req.query);
    need(f, 'sede', 'facultad', 'plan');
    const codigos = String(req.query.codigos || req.query.codigo || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!codigos.length) throw httpError(400, 'Falta ?codigo= (o ?codigos=A,B,C).');
    if (codigos.length > 8) throw httpError(400, 'Máximo 8 códigos por petición.');
    const resultados = await cat.getGrupos(f, codigos);
    return { resultados };
  }));
}

module.exports = {
  register, createCatalogo,
  _internal: { parseSelects, parseCourses, parseDetail, parseLoopback, pickOption, openSession, search, openDetail, findCourse }
};
