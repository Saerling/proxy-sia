const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Ruta de prueba
app.get('/', (req, res) => {
    res.send('¡Mi proxy está funcionando!');
});

// Ruta donde luego conectaremos el SIA
app.get('/api/sia', (req, res) => {
    res.json({ mensaje: 'Aquí configuraremos la conexión al SIA' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy listo en http://localhost:${PORT}`));