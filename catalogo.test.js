'use strict';
/**
 * Prueba OFFLINE contra tu HAR (sin red, sin credenciales):
 *   node catalogo.test.js ruta/al/archivo.har
 *
 * 1) Reproduce el flujo completo con un "transporte falso" que responde con lo que el SIA devolvió en el HAR.
 * 2) Compara, parámetro por parámetro, cada POST que genera catalogo.js contra el POST real del navegador.
 * 3) Verifica lo parseado (asignaturas, grupos, profesores, cupos, horarios).
 */
const fs = require('fs');
const assert = require('assert');
const { createCatalogo, _internal } = require('./catalogo');

const file = process.argv[2] || process.env.HAR;
if (!file) { console.error('Uso: node catalogo.test.js archivo.har'); process.exit(2); }
const entries = JSON.parse(fs.readFileSync(file, 'utf8')).log.entries;

// --- Buscar en el HAR las piezas del flujo ---------------------------------------------------
const isCat = (e) => e.request.url.includes('/Catalogo/facespublico/public/servicioPublico.jsf');
const bridge = entries.find((e) => isCat(e) && /AdfLoopbackUtils\.runLoopback\(/.test(e.response.content.text || ''));
const page = entries.find((e) => isCat(e) && e.request.method === 'GET' && e.request.url.includes('_afrLoop='));
const pprs = new Map(); // event -> {req(URLSearchParams), res(text)}
for (const e of entries) {
  if (!isCat(e) || e.request.method !== 'POST' || !e.request.postData) continue;
  const p = new URLSearchParams(e.request.postData.text);
  if (p.get('event')) pprs.set(p.get('event'), { req: p, res: e.response.content.text });
}
assert(bridge && page && pprs.size >= 8, 'El HAR no contiene el flujo esperado');

// --- Transporte falso: sirve respuestas del HAR y compara lo que enviamos --------------------
const mismatches = [];
const sent = [];
function fakeTransport() {
  return {
    async send(method, url, { data } = {}) {
      if (method === 'GET') {
        const body = url.includes('_afrLoop=') ? page.response.content.text : bridge.response.content.text;
        return { status: 200, headers: {}, data: body };
      }
      const mine = new URLSearchParams(data);
      const ev = mine.get('event');
      const ref = pprs.get(ev);
      sent.push(ev);
      if (!ref) { mismatches.push(`POST con event=${ev} no existe en el HAR`); return { status: 200, headers: {}, data: '<partial-response><noop/></partial-response>' }; }
      const a = [...mine.entries()].filter(([k]) => k !== 'Adf-Window-Id').map(([k, v]) => `${k}=${v}`).sort();
      const b = [...ref.req.entries()].filter(([k]) => k !== 'Adf-Window-Id').map(([k, v]) => `${k}=${v}`).sort();
      const onlyMine = a.filter((x) => !b.includes(x)), onlyHar = b.filter((x) => !a.includes(x));
      if (onlyMine.length || onlyHar.length) mismatches.push({ event: ev, soloMio: onlyMine, soloHAR: onlyHar });
      return { status: 200, headers: {}, data: ref.res };
    }
  };
}

(async () => {
  const cat = createCatalogo({ transportFactory: fakeTransport });
  const filtros = { nivel: 'pregrado', sede: '1101', facultad: '2055', plan: '2549', tipologia: 'todas' };

  const r = await cat.getGrupos(filtros, ['1000003-B']);
  const g = r[0];
  if (g.error) { console.error('ERROR:', g); process.exit(1); }

  // 1) POSTs idénticos a los del navegador
  console.log('POSTs enviados:', sent.length);
  sent.forEach((e) => console.log('   ', e));
  assert.deepStrictEqual(mismatches, [], 'Algún POST difiere del que hizo el navegador:\n' + JSON.stringify(mismatches, null, 2));
  console.log('OK  todos los POST generados coinciden con los del HAR (salvo Adf-Window-Id, que lo asigna el servidor)');

  // 2) Selección resuelta por código -> índices correctos
  assert.strictEqual(g.seleccion.sede, '1101 SEDE BOGOTÁ');
  assert.strictEqual(g.seleccion.facultad, '2055 FACULTAD DE INGENIERÍA');
  assert.strictEqual(g.seleccion.plan, '2549 INGENIERÍA QUÍMICA');
  console.log('OK  sede/facultad/plan resueltos por código:', g.seleccion.sede, '|', g.seleccion.facultad, '|', g.seleccion.plan);

  // 3) Datos
  assert.strictEqual(g.asignatura.nombre, 'Álgebra Lineal');
  assert.strictEqual(g.asignatura.codigo, '1000003-B');
  assert.strictEqual(g.asignatura.creditos, 4);
  const grupos = g.tiposClase.flatMap((t) => t.grupos);
  assert.strictEqual(grupos.length, 21);
  const g1 = grupos.find((x) => x.grupo === '1');
  assert.deepStrictEqual(g1.profesores, ['Agustin Moreno Canadas']);
  assert.strictEqual(g1.cuposDisponibles, 2);
  assert.strictEqual(g1.horarios.length, 2);
  assert.strictEqual(g1.horarios[0].dia, 'LUNES');
  assert.strictEqual(g1.horarios[0].inicio, '07:00');
  assert.strictEqual(g1.horarios[0].ubicaciones[0].codigo, '453-111');
  const suma = grupos.find((x) => x.grupo === 'SUMA-01');
  assert.strictEqual(suma.profesores.length, 2, 'grupo con 2 profesores');
  assert(grupos.every((x) => x.profesores.length >= 1 && x.cuposDisponibles !== null));
  assert(g.prerrequisitos.length >= 1 && g.prerrequisitos[0].asignaturas.length === 2);
  console.log(`OK  ${grupos.length} grupos, ${g.resumen.gruposConCupo} con cupo, ${g.resumen.cuposDisponibles} cupos libres en total`);

  // 4) Listado
  const sent2 = sent.length;
  const lst = await cat.getAsignaturas(filtros);
  assert.strictEqual(lst.rowCount, 71);
  assert.strictEqual(lst.courses.length, 71);
  assert(lst.courses.some((c) => c.codigo === '1000003-B' && c.rowKey === 56));
  assert(lst.courses.filter((c) => c.sinProgramar).length === 6);
  console.log('OK  listado:', lst.courses.length, 'asignaturas (', lst.courses.filter((c) => c.sinProgramar).length, 'sin programar )');

  // 5) Errores útiles
  await assert.rejects(() => cat.getOpciones({ sede: 'xyz' }).catch((e) => { assert.strictEqual(e.status, 400); assert(e.opciones.length > 5); throw e; }));
  const { pickOption } = _internal;
  assert.throws(() => pickOption([{ value: '0', label: '2543 INGENIERÍA DE SISTEMAS' }], 'medicina', 'plan'), /No encontré/);
  console.log('OK  errores de selección devuelven la lista de opciones válidas');

  console.log('\nTODO OK');
})().catch((e) => { console.error('FALLÓ:', e.message || e); if (e.preview) console.error(e.preview); process.exit(1); });
