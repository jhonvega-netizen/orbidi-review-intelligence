# Respuestas a reseñas GMB desde HubSpot/Zernio

## Objetivo

El boton **Responder reseñas GMB** usa los tickets ya analizados en el panel HubSpot, busca su reseña equivalente en Zernio y responde las reseñas de Google Business encontradas en Zernio despues de un dry-run y una confirmacion explicita del usuario.

No responde Trustpilot ni UNKNOWN. No usa Google Business Profile directamente.

## Flujo

1. El front envia `POST /api/hubspot/reply-gmb-reviews` con `dryRun: true`.
2. El backend carga las reseñas GMB desde Zernio.
3. Por cada ticket:
   - valida que el origen sea `GMB`;
   - busca la reseña en Zernio por ID, URL, autor, rating, fecha y texto;
   - muestra la confianza del match antes de enviar;
   - revisa duplicados en `data/gmb-review-replies.json`;
   - prepara el mensaje segun sentimiento e identificacion del cliente.
4. El front muestra el resumen dry-run y pide confirmacion con `window.confirm`.
5. Solo si el usuario confirma, el front repite el POST con `dryRun: false`.
6. El backend envia la respuesta real mediante Zernio y persiste el resultado.

## Endpoint

`POST /api/hubspot/reply-gmb-reviews`

Body principal:

```json
{
  "dryRun": true,
  "tickets": [],
  "zernioAccountId": "opcional",
  "zernioLocationId": "opcional",
  "maxReviews": 5000
}
```

Respuesta:

```json
{
  "success": true,
  "dryRun": true,
  "summary": {
    "received": 22,
    "gmbTickets": 12,
    "eligible": 3,
    "ready": 3,
    "replied": 0,
    "skipped": 9,
    "errors": 0,
    "alreadyReplied": 0,
    "manualReview": 2
  },
  "results": [],
  "logs": []
}
```

## Endpoint Zernio usado

Segun la documentacion oficial de Zernio, el envio real se hace con el endpoint especifico de Google Business:

`POST /v1/accounts/{accountId}/gmb-reviews/{reviewId}/reply`

Body:

```json
{
  "comment": "texto de respuesta"
}
```

Antes de responder, el proyecto selecciona la ubicacion de la reseña con:

`PUT /v1/accounts/{accountId}/gmb-locations`

Body:

```json
{
  "selectedLocationId": "locations/123456789"
}
```

Esto es necesario porque Zernio asocia la respuesta a la ubicacion actualmente seleccionada de la cuenta.

## Mensajes

Positivas: alterna entre dos mensajes de agradecimiento para no repetir siempre el mismo texto.

Negativas identificables: usa un mensaje sin correo ni enlaces para reducir riesgo de moderacion en Google Maps:

```text
Hola, lamentamos que tu experiencia no haya sido la esperada. Hemos trasladado tu caso al equipo de Calidad para revisar lo ocurrido y poder ayudarte lo antes posible. Gracias por compartir tu experiencia.

Equipo ORBIDI
```

Negativas sin identificacion fiable: usa el mensaje con el formulario de Google Forms.

## Persistencia

Las respuestas reales y errores se guardan en:

`data/gmb-review-replies.json`

Este archivo evita duplicados por `ticketId` y `reviewId`, y permite que el front mantenga el estado tras recargar.

## Variables `.env`

```env
ZERNIO_API_KEY=
ZERNIO_BASE_URL=https://zernio.com/api/v1
ZERNIO_ACCOUNT_ID=
ZERNIO_LOCATION_ID=
HUBSPOT_PORTAL_ID=
```

`ZERNIO_ACCOUNT_ID` se puede dejar en blanco si las reseñas devueltas por Zernio ya traen `accountId` o si el usuario lo pasa desde el front.

## Limitaciones

- Solo se envia respuesta real despues del dry-run y la confirmacion del usuario.
- La confianza del match queda visible en el dry-run y en la tarjeta para QA.
- Si Zernio no devuelve `accountId` y no existe `ZERNIO_ACCOUNT_ID`, el intento queda como error.
- Si Zernio falla al leer reseñas, el sistema no publica respuestas nuevas sin lectura fresca.
- El boton no responde Trustpilot ni UNKNOWN.
