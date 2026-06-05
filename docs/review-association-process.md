# Proceso de asociación de reseñas con clientes — ORBIDI Review Intelligence

## 1. Objetivo

Asociar cada reseña (de GMB, Trustpilot u otra fuente) con el contacto, empresa y negocio/deal correcto en HubSpot, usando evidencia verificable y sin forzar asociaciones cuando la información es insuficiente.

---

## 2. Flujo de decisión

### Prioridad 1 — Email exacto
Si la reseña, el ticket o las propiedades asociadas contienen un email:
- Se busca el contacto en HubSpot por email exacto.
- Si se encuentra: `matchStatus = "matched"`, `matchReason = "email_exact_match"`, `matchConfidence = "high"`.
- Si no se encuentra: se continúa con búsqueda por nombre.

### Prioridad 2 — Nombre y apellido (único candidato)
Si no hay email pero sí nombre completo:
- Se buscan contactos por nombre y apellido en HubSpot.
- Si aparece un único candidato con alta coincidencia: `matchStatus = "matched"`, `matchReason = "single_name_match"`.
- Si la coincidencia es parcial: `matchStatus = "possible_match"`, `matchConfidence = "medium"`.

### Prioridad 3 — Varios candidatos posibles
Si hay 2+ candidatos con scores similares (diferencia < 0.2 en score local):
- Se revisan actividades recientes (notas, llamadas, emails, reuniones).
- Se revisa la empresa asociada y su campo `productos_contratados`/`servicios_subvencionados`/`servicio_producido`.
- Si un candidato destaca claramente por actividad o productos: `matchStatus = "possible_match"` o `"matched"`.
- Si no se puede distinguir: `matchStatus = "multiple_possible_matches"`, `matchReason = "ambiguous_multiple_matches"`.
  - En este caso **no se fuerza ninguna asociación**.
  - El front muestra un selector para que el usuario elija manualmente.

### Prioridad 4 — Sin datos suficientes
Si no hay email, nombre completo ni candidatos relevantes:
- `matchStatus = "unidentifiable"`, `matchReason = "insufficient_data"`.
- No se crea ninguna asociación automática.

---

## 3. Reglas para NO forzar asociación

**No se debe asociar automáticamente cuando:**
- Solo coincide el nombre pero hay varios contactos posibles con ese nombre.
- No hay email y la coincidencia de nombre es débil.
- Las actividades no aportan evidencia clara.
- Los productos contratados no coinciden con el texto de la reseña.
- La reseña es ambigua o muy corta.
- `matchStatus` es `multiple_possible_matches`, `not_matched` o `unidentifiable`.

En esos casos la asociación queda pendiente hasta confirmación manual.

---

## 4. Tratamiento de reseñas negativas no identificables

Si una reseña es **negativa** y:
- No tiene email.
- No hay cliente claro (`matchStatus` ≠ `matched` con `matchConfidence = "high"`).
- O el match es ambiguo (`multiple_possible_matches`, `possible_match` con confianza baja).

El sistema marca la fila con:
```json
{
  "requiresInfoRequest": true,
  "infoRequestReason": "negative_review_unidentified | negative_review_ambiguous_match | insufficient_customer_data",
  "suggestedMessage": "Te enviamos este formulario. Por favor respóndelo para que podamos conocer más sobre ti y ayudarte mejor.",
  "formConfigured": true | false,
  "formId": "string | null"
}
```

La columna **"Solicitud info"** en el front muestra el indicador y el mensaje sugerido.

> ⚠️ Por ahora **no se envía ningún formulario automáticamente**. El mensaje es solo sugerido para acción manual futura.

---

## 5. Uso del formulario de reseñas

El sistema busca un formulario de HubSpot configurado como origen de las reseñas.

**Configuración:**
```
HUBSPOT_REVIEW_FORM_ID=<id-del-formulario>
```

Si está configurado: al analizar HubSpot se inspeccionan los campos del formulario y se usan para mejorar la detección de origen, cliente y servicio.

Si no está configurado: el análisis continúa normalmente, se logguea la limitación y se expone vía `GET /api/hubspot/review-form-config`.

**Helper disponible:** `getReviewInfoFormConfig(formSummary)` devuelve:
```json
{
  "formId": "string | null",
  "formUrl": null,
  "fields": [],
  "relevantFields": [],
  "isConfigured": true | false,
  "message": "descripción del estado"
}
```

---

## 6. Cómo se confirma una asociación manualmente

### Un único match claro
1. El front muestra el nombre del cliente con link a HubSpot.
2. Hacer clic en **"Confirmar asociación"**.
3. El sistema:
   - Asocia el ticket con contacto, empresa y deals en HubSpot (`PUT /crm/v4/objects/tickets/{id}/associations/default/...`).
   - No cambia el stage del ticket automaticamente; el cambio de estado queda bajo control del equipo.
   - Rellena el campo `en_que_plataforma_aparece_la_resena_` con "Google" o "Trustpilot".
   - Guarda la confirmación localmente en `data/confirmed-review-associations.json`.

### Múltiples posibles matches
1. La columna "Cliente" muestra un **selector desplegable** con todos los candidatos posibles y su nivel de confianza.
2. El usuario selecciona uno.
3. El botón **"Confirmar selección"** se habilita.
4. Al confirmar, se registra la selección manual con `matchStatus = "matched"` y `matchReason` indicando selección manual.

---

## 7. Variables de entorno necesarias

| Variable | Descripción | Por defecto |
|---|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Token de acceso HubSpot | Requerido |
| `HUBSPOT_PORTAL_ID` | ID del portal HubSpot | 25808060 |
| `HUBSPOT_REVIEW_PIPELINE_LABEL` | Nombre del pipeline | `customer success` |
| `HUBSPOT_REVIEW_STAGE_LABEL` | Nombre del stage fuente | `inbox` |
| `HUBSPOT_REVIEW_STAGE_ID` | ID del stage fuente | `1932423374` |
| `HUBSPOT_REVIEW_CATEGORY_PROPERTY` | Propiedad de categoría | `categoria_del_ticket` |
| `HUBSPOT_REVIEW_CATEGORY_VALUE` | Valor de categoría reseña | `Reseña` |
| `HUBSPOT_REVIEW_FORM_ID` | ID del form de reseñas | Opcional |
| `HUBSPOT_CONTACTING_STAGE_ID` | Legacy/diagnostico de stage "Intentando Contactar"; el flujo actual no cambia estados automaticamente | Opcional |
| `HUBSPOT_CONTACTING_STAGE_LABEL` | Legacy/diagnostico de nombre stage destino; el flujo actual no cambia estados automaticamente | Opcional |
| `HUBSPOT_PLATFORM_VALUE_GMB` | Valor enum plataforma Google | `Google` |
| `HUBSPOT_PLATFORM_VALUE_TRUSTPILOT` | Valor enum plataforma Trustpilot | `Trustpilot` |
| `GEMINI_API_KEY` | API key de Google Gemini | Requerido |
| `GEMINI_MODEL` | Modelo Gemini a usar | `gemini-2.5-flash` |
| `ZERNIO_API_KEY` | API key de Zernio | Para análisis GMB |

---

## 8. Limitaciones conocidas

- **HubSpot Forms**: requiere scopes adicionales (`forms`). Sin ellos `formConfigured = false` y el análisis continúa sin el formulario.
- **Emails de actividad**: requieren scope `crm.objects.emails.read`. Sin permisos el sistema continúa con notas, llamadas y reuniones.
- **`productos_contratados`**: es un campo personalizado. Si no existe en el portal, `joinProps` devuelve string vacío sin error.
- **Caché Gemini**: las entradas cacheadas antes de este release no tienen `matchReason`. Se regeneran la próxima vez que el input cambie.
- **Reseñas negativas**: el mensaje sugerido es solo texto; no hay envío automático de formularios.
- **Stages de HubSpot**: el flujo actual no cambia estados automaticamente. `GET /api/hubspot/debug/stages` queda disponible solo para diagnostico.

---

## 9. Cómo probar manualmente

### Verificar detección de stages
```
GET http://127.0.0.1:4173/api/hubspot/debug/stages
```

### Verificar config del formulario
```
GET http://127.0.0.1:4173/api/hubspot/review-form-config
```

### Ejecutar análisis HubSpot
1. Hacer clic en **"Analizar HubSpot"** en el front.
2. Esperar que termine (terminal muestra progress).
3. Verificar columnas: Cliente, Coincidencia, Solicitud info, Fuente actividad.

### Confirmar asociación con un match claro
1. Filtrar por "Coinciden".
2. Hacer clic en **"Confirmar asociación"** en la fila.
3. El log mostrará: contactos asociados + plataforma/campos rellenados, sin cambiar el estado del ticket.

### Confirmar asociación con múltiples posibles
1. Buscar fila con estado "Múltiples posibles".
2. En la columna "Cliente", usar el selector para elegir el contacto correcto.
3. Hacer clic en **"Confirmar selección"**.

### Verificar reseña negativa no identificada
1. Filtrar por "Negativas".
2. Buscar fila con columna "Solicitud info" ≠ "-".
3. Hacer clic en el indicador para ver el mensaje sugerido.

---

## 10. Iniciativas relacionadas (pendientes de validación de fechas)

| Iniciativa | Estado | Responsable | Fecha |
|---|---|---|---|
| Match de reseñas por email | Implementado | — | — |
| Match por nombre y apellido | Implementado | — | — |
| Validación con actividades del contacto | Implementado | — | — |
| Validación con empresa y productos contratados | Implementado | — | — |
| Formulario de solicitud de información | Preparado (sin envío auto) | — | Pendiente validación |
| Responder reseñas negativas no identificables | Pendiente | — | Pendiente validación |
| Envío automático de formulario | No implementado | — | Requiere aprobación |
| Optimización de análisis HubSpot (caché ticketId) | Parcial (Gemini cacheado) | — | — |
