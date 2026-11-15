# Seguridad — proxy-sia

Backend Express (Render) para catálogo SIA, reseñas y comentarios de MallaIQ.

| # | Punto | Estado |
|---|---|---|
| 1 | Ocultar API keys | ✅ Todo por variables de entorno (`DATABASE_URL`, `ADMIN_KEY`, `RESENAS_PEPPER`, `ALLOWED_ORIGINS`). Nada en el código. |
| 2 | Secretos fuera de Git | ✅ Historial revisado: sin secretos. `.gitignore` cubre `.env` y `.har`. |
| 3 | Key pública para DB | ✅ El navegador nunca habla con la DB: solo con esta API. |
| 4 | Row-Level Security | ✅ RLS activado en `profesores`, `resenas`, `resenas_reportes` y `REVOKE ALL FROM PUBLIC`. |
| 5 | Encriptar datos sensibles | ✅ Identificadores de autores con hash + pepper; no se guardan IPs en claro. TLS hacia Neon. |
| 6 | Forzar autenticación | ✅ Rutas de admin exigen `x-admin-key` (solo cabecera, comparación en tiempo constante). |
| 7 | Restringir acceso a registros | ✅ `debug`/`preview` y moderación solo con clave de admin. |
| 8 | Bloquear manipulación de campos | ✅ Solo se leen campos permitidos; los parámetros de SIA pasan por lista blanca/regex. |
| 9 | Session cookies | N/A — no hay cookies ni sesiones. La clave del panel vive en `sessionStorage`. |
| 10 | Hashear contraseñas | ✅ No hay contraseñas de usuarios; la clave admin se compara como hash SHA-256. |
| 11 | Rate limiting | ✅ Global 300/10 min, catálogo 120/10 min, reseñas/comentarios propios, bloqueo tras 10 fallos de admin. |
| 12 | Protección contra bots | ✅ Honeypot en comentarios + límites por IP. |
| 13 | Queries parametrizadas | ✅ Todo SQL usa `$1…$n`. |
| 14 | Validar inputs | ✅ Longitudes, tipos y formatos validados en servidor. |
| 15 | Sanitizar contenido | ✅ `textoLimpio` elimina control/HTML; el frontend además escapa al pintar. |
| 16 | Restringir archivos | N/A — no hay subida de archivos. |
| 17 | Devolver solo lo necesario | ✅ Errores 5xx genéricos, sin trazas; sin `x-powered-by`. |
| 18 | Security headers | ✅ HSTS, CSP, nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy, COOP/CORP. |
| 19 | Forzar HTTPS | ✅ Redirección 308 si llega por HTTP. |
| 20 | Escanear dependencias | ✅ Dependabot semanal + `npm audit` en CI (0 vulnerabilidades). |

**Acción pendiente del dueño (Render → Environment):** definir `RESENAS_PEPPER` (texto aleatorio largo) y `ADMIN_KEY` fuerte; opcional `ALLOWED_ORIGINS`.
