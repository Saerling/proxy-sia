const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Ruta de prueba
app.get('/', (req, res) => {
    res.send('¡Mi proxy está funcionando!');
});

// Host real del SIA al que vamos a reenviar las peticiones
const SIA_UPSTREAM = 'https://sia.gabotachak.dev';

// Todo lo que llegue a /api/sia/... se reenvía tal cual (mismo path y query string)
// a https://sia.gabotachak.dev/..., y devolvemos la respuesta con cabeceras CORS
// (ya activadas arriba con app.use(cors())) para que el navegador del usuario
// pueda leerla sin bloqueo.
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listo en http://localhost:${PORT}`));