# ORBIDI Review Intelligence

App local para analizar reseñas de ORBIDI, cruzarlas con HubSpot, clasificarlas con Gemini, revisar coincidencias con clientes y gestionar respuestas GMB mediante Zernio.

Para una explicacion completa del objetivo, funcionamiento, solucion y herramientas usadas, ver:

`docs/project-overview.md`

## Inicio rapido

1. Copia `.env.example` a `.env`.
2. Completa `GEMINI_API_KEY` para clasificar y analizar reseñas.
3. Completa `HUBSPOT_ACCESS_TOKEN` para leer tickets y clientes.
4. Completa `ZERNIO_API_KEY` para leer o responder reseñas de Google Business mediante Zernio.
5. Ejecuta:

```powershell
npm start
```

Abre `http://127.0.0.1:4173`.

## Fuentes de resenas

- `SerpApi`: usa la URL o nombre de la empresa para encontrar la ficha de Google Maps y paginar resenas publicas.
- `Zernio`: usa `/accounts/{accountId}/gmb-reviews` para traer todas las resenas Google Business conectadas a Zernio y contarlas en el panel.
- `Google Business Profile`: usa el endpoint oficial de reviews para perfiles verificados a los que tengas acceso.
- `Manual`: pega un JSON o CSV de resenas para clasificarlo con el mismo pipeline.
- `Muestra`: datos de prueba para validar la interfaz sin credenciales.

## Formato manual

JSON:

```json
[
  { "author": "Cliente", "rating": 5, "text": "Excelente servicio", "date": "2026-05-01" },
  { "author": "Cliente 2", "rating": 1, "text": "No lo recomiendo", "date": "2026-05-02" }
]
```

CSV simple:

```csv
author,rating,text,date
Cliente,5,Excelente servicio,2026-05-01
Cliente 2,1,No lo recomiendo,2026-05-02
```

## Notas

- La API oficial de Google Business Profile requiere OAuth con el scope `https://www.googleapis.com/auth/business.manage`.
- Referencia oficial de reviews: `https://developers.google.com/my-business/reference/rest/v4/accounts.locations.reviews/list`
- Guia oficial de OAuth para Business Profile: `https://developers.google.com/my-business/content/implement-oauth`
- El archivo `data/last-analysis.json` guarda el ultimo analisis completo.
- Si `GEMINI_API_KEY` no esta configurada y `ALLOW_LOCAL_CLASSIFIER=1`, la app usa un clasificador local solo para pruebas de interfaz.
