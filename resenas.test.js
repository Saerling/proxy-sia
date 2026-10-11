'use strict';
/** Pruebas offline (sin red, sin base de datos):  node resenas.test.js */
const assert = require('assert');
const express = require('express');
const { crearApi, MemoryStore, claveProfesor, reglasLocales } = require('./resenas');

// --- Unidades ---------------------------------------------------------------
assert.strictEqual(claveProfesor('Agustin Moreno Canadas'), claveProfesor('MORENO CAÑADAS, Agustín'));
assert.strictEqual(claveProfesor('María de los Ángeles Pérez'), claveProfesor('perez maria angeles'));
console.log('OK  claves de profesor normalizadas');

const pasan = [
  'El profesor explica muy bien, pero los parciales son largos y difíciles.',
  'Nota promedio 3.5 3.5 4.0, la carga es alta pero justa.',
  'Muy buena clase, aprendí mucho y siempre atiende dudas.'
];
const fallan = [
  ['Escríbeme a juan@gmail.com y te paso los apuntes', /correo/i],
  ['Mira los apuntes en https://drive.google.com/abc muy buenos', /enlaces/i],
  ['Llámame al 300 123 4567 si quieres el taller', /teléfono/i],
  ['Este profesor es un IMBÉCIL y no sabe explicar nada', /groser/i],
  ['Es una p u t a clase, no se entiende nada de nada', /groser/i],
  ['Es un malpariiido que no explica nada en clase', /groser/i],
  ['ESTE PROFESOR NO SABE NADA Y SIEMPRE LLEGA TARDE A CLASE', /mayúsculas/i],
  ['jajajajajajajaja', /corto|repetir/i]
];
pasan.forEach((t) => assert.strictEqual(reglasLocales(t), null, 'No debió rechazar: ' + t));
fallan.forEach(([t, re]) => { const r = reglasLocales(t); assert(r && re.test(r), `Debió rechazar (${re}): ${t} -> ${r}`); });
console.log('OK  reglas locales: pasan', pasan.length, '/ rechazan', fallan.length);

// --- API completa con un moderador falso ------------------------------------
(async () => {
  const store = new MemoryStore();
  let veredicto = { decision: 'aprobar', motivo: '' };
  let llamadasIA = 0;
  const moderar = async () => { llamadasIA++; return veredicto; };
  const requireAdmin = (req, res, next) => req.get('x-admin-key') === 'secreta' ? next() : res.status(401).json({ error: 'no' });
  const api = crearApi({ store, moderar, requireAdmin, limites: { resenas: 1000, reportes: 1000 } });

  const app = express();
  app.use(express.json());
  app.use('/api/resenas', api.router);
  app.use('/api/admin/resenas', api.admin);
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  };
  const tok = (n) => 'token-de-prueba-' + String(n).padStart(4, '0');
  const PROF = 'Agustin Moreno Canadas';

  // Solo se reseñan profesores que vinieron del catálogo
  let r = await call('POST', '/api/resenas', { profesor: PROF, calificacion: 5, token: tok(1) });
  assert.strictEqual(r.status, 404);
  await api.registrarDesdeCatalogo({ resultados: [{ tiposClase: [{ grupos: [{ profesores: [PROF, 'Otra Profesora'] }] }] }] });
  console.log('OK  profesor desconocido rechazado; el catálogo registra profesores');

  // Publicación normal
  r = await call('POST', '/api/resenas', { profesor: 'MORENO CAÑADAS Agustín', asignatura: '1000003-B', calificacion: 5, dificultad: 3, comentario: 'Explica muy bien y atiende dudas después de clase.', token: tok(1) });
  assert.strictEqual(r.status, 201); assert.strictEqual(r.json.estado, 'publicada');
  console.log('OK  reseña publicada (la clave ignora orden/tildes)');

  // Una por navegador y profesor
  r = await call('POST', '/api/resenas', { profesor: PROF, calificacion: 1, token: tok(1) });
  assert.strictEqual(r.status, 409);

  // Validaciones
  assert.strictEqual((await call('POST', '/api/resenas', { profesor: PROF, calificacion: 9, token: tok(2) })).status, 400);
  assert.strictEqual((await call('POST', '/api/resenas', { profesor: PROF, calificacion: 3, token: 'x' })).status, 400);
  assert.strictEqual((await call('POST', '/api/resenas', { profesor: PROF, calificacion: 3, comentario: 'corto', token: tok(2) })).status, 400);

  // Reglas locales cortan antes de gastar IA
  const antes = llamadasIA;
  r = await call('POST', '/api/resenas', { profesor: PROF, calificacion: 1, comentario: 'Es un idiota que no sabe explicar nada', token: tok(2) });
  assert.strictEqual(r.status, 422); assert.strictEqual(llamadasIA, antes);
  console.log('OK  reglas locales rechazan sin llamar a la IA');

  // IA rechaza
  veredicto = { decision: 'rechazar', motivo: 'Contiene un ataque personal.' };
  r = await call('POST', '/api/resenas', { profesor: PROF, calificacion: 1, comentario: 'Se nota que vive amargado y debería renunciar ya', token: tok(3) });
  assert.strictEqual(r.status, 422); assert(/ataque personal/.test(r.json.error));

  // IA duda -> pendiente (no se ve)
  veredicto = { decision: 'revisar', motivo: 'Acusación grave.' };
  r = await call('POST', '/api/resenas', { profesor: PROF, calificacion: 1, comentario: 'Dicen que vende las notas a quien le pague bien', token: tok(4) });
  assert.strictEqual(r.status, 201); assert.strictEqual(r.json.estado, 'pendiente');
  const idPend = r.json.id;
  let lst = await call('GET', '/api/resenas?profesor=' + encodeURIComponent(PROF));
  assert.strictEqual(lst.json.resenas.length, 1);

  // Si la IA falla -> pendiente, no publicada
  veredicto = { decision: 'error', motivo: 'timeout' };
  r = await call('POST', '/api/resenas', { profesor: PROF, calificacion: 2, comentario: 'Los talleres son muy largos para el tiempo dado', token: tok(5) });
  assert.strictEqual(r.json.estado, 'pendiente');
  console.log('OK  IA rechaza / duda / falla -> rechazada, pendiente, pendiente');

  // Admin
  assert.strictEqual((await call('GET', '/api/admin/resenas/pendientes')).status, 401);
  const pend = await call('GET', '/api/admin/resenas/pendientes', null, { 'x-admin-key': 'secreta' });
  assert.strictEqual(pend.json.resenas.length, 2);
  await call('POST', `/api/admin/resenas/${idPend}/rechazar`, null, { 'x-admin-key': 'secreta' });
  assert.strictEqual((await call('GET', '/api/admin/resenas/pendientes', null, { 'x-admin-key': 'secreta' })).json.resenas.length, 1);
  console.log('OK  panel de administración protegido y funcional');

  // Reportes: 3 distintos ocultan; el mismo navegador no cuenta doble
  veredicto = { decision: 'aprobar' };
  r = await call('POST', '/api/resenas', { profesor: PROF, calificacion: 1, dificultad: 5, comentario: 'Califica con criterios que nunca explica a la clase', token: tok(6) });
  const id = r.json.id;
  await call('POST', `/api/resenas/${id}/reportar`, { token: tok(10) });
  assert.strictEqual((await call('POST', `/api/resenas/${id}/reportar`, { token: tok(10) })).json.ya, true);
  await call('POST', `/api/resenas/${id}/reportar`, { token: tok(11) });
  lst = await call('GET', '/api/resenas?profesor=' + encodeURIComponent(PROF));
  assert(lst.json.resenas.some((x) => x.id === id), 'con 2 reportes sigue visible');
  await call('POST', `/api/resenas/${id}/reportar`, { token: tok(12) });
  lst = await call('GET', '/api/resenas?profesor=' + encodeURIComponent(PROF));
  assert(!lst.json.resenas.some((x) => x.id === id), 'con 3 reportes se oculta sola');
  // Un humano la restaura y ya no se vuelve a ocultar por reportes
  await call('POST', `/api/admin/resenas/${id}/aprobar`, null, { 'x-admin-key': 'secreta' });
  await call('POST', `/api/resenas/${id}/reportar`, { token: tok(13) });
  lst = await call('GET', '/api/resenas?profesor=' + encodeURIComponent(PROF));
  assert(lst.json.resenas.some((x) => x.id === id));
  console.log('OK  3 reportes ocultan; el admin puede restaurar');

  // Resumen y privacidad de la respuesta
  const res = await call('GET', '/api/resenas/resumen?p=' + encodeURIComponent(PROF) + '&p=' + encodeURIComponent('Otra Profesora'));
  assert.strictEqual(res.json.resumenes[PROF].n, 2);
  assert.strictEqual(res.json.resumenes[PROF].calificacion, 3);
  assert.strictEqual(res.json.resumenes['Otra Profesora'].n, 0);
  assert(!JSON.stringify(lst.json).includes('token'), 'la API pública no expone tokens');
  console.log('OK  resumen:', JSON.stringify(res.json.resumenes[PROF]));

  // Honeypot
  const n0 = store.rows.length;
  r = await call('POST', '/api/resenas', { profesor: PROF, calificacion: 5, token: tok(20), web: 'http://spam' });
  assert.strictEqual(r.status, 201); assert.strictEqual(store.rows.length, n0);
  console.log('OK  honeypot descarta bots sin guardar nada');

  // Límite por IP
  const api2 = crearApi({ store, moderar, requireAdmin, limites: { resenas: 2 } });
  const app2 = express(); app2.use(express.json()); app2.use('/api/resenas', api2.router);
  const s2 = await new Promise((rr) => { const s = app2.listen(0, () => rr(s)); });
  const url2 = `http://127.0.0.1:${s2.address().port}/api/resenas`;
  const codigos = [];
  for (let i = 0; i < 3; i++) codigos.push((await fetch(url2, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  assert.deepStrictEqual(codigos, [400, 400, 429]);
  console.log('OK  límite de intentos por IP');

  server.close(); s2.close();
  console.log('\nTODO OK');
})().catch((e) => { console.error('FALLÓ:', e); process.exit(1); });
