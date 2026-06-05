# ORBIDI Review Intelligence

## Por que se hizo este proyecto

ORBIDI necesitaba una forma centralizada de revisar, clasificar y gestionar reseñas de clientes sin depender de revisar manualmente Google, Trustpilot, HubSpot y Zernio por separado.

Antes del proyecto, el proceso tenia varios problemas:

- Las reseñas llegaban desde diferentes fuentes y no siempre era claro si venian de Google, Trustpilot u otro origen.
- Era dificil saber rapidamente cuantas reseñas eran positivas, negativas, nuevas, pendientes o ya gestionadas.
- Los tickets de HubSpot no siempre estaban relacionados con el cliente correcto.
- El equipo necesitaba distinguir si la reseña estaba relacionada con servicios de KD MARKETING, KD PC o ambos.
- Responder reseñas de Google desde Zernio podia generar errores si no se validaba bien la reseña, la ubicacion o el estado de publicacion.
- Faltaba una vista simple para auditar que hizo el sistema y por que tomo cada decision.

El objetivo fue crear un panel operativo para que el equipo pueda analizar reseñas, cruzarlas con clientes, registrar gestion y responder reseñas de Google de forma controlada.

## Que solucion brinda

El proyecto funciona como un panel local llamado **ORBIDI Review Intelligence**.

Desde una sola pantalla permite:

- Ver reseñas y tickets de HubSpot relacionados con reseñas.
- Clasificar reseñas como positivas o negativas.
- Detectar si la reseña viene de Google Business Profile, Trustpilot o una fuente desconocida.
- Identificar si el problema corresponde a KD MARKETING, KD PC o no se puede determinar.
- Buscar coincidencias entre la reseña y clientes existentes en HubSpot.
- Sugerir el contacto, empresa y negocio/deal que podrian estar relacionados.
- Confirmar manualmente una asociacion cuando el usuario lo decide.
- Rellenar campos de gestion en tickets de HubSpot despues del analisis.
- Responder reseñas de Google usando Zernio, con validacion previa.
- Ver en una terminal visual lo que el sistema va haciendo paso a paso.

La solucion no busca reemplazar al equipo. Su funcion es acelerar la revision, reducir errores y dejar trazabilidad clara para que una persona tome mejores decisiones.

## Como funciona, explicado facil

### 1. El sistema carga las reseñas y tickets

Cuando se presiona **Analizar HubSpot**, el sistema revisa la vista de tickets de reseñas en HubSpot.

Actualmente toma los tickets de la vista de reseñas del pipeline **Customer Success**, incluyendo estados como:

- INBOX
- INTENTANDO CONTACTAR
- ESPERANDO CLIENTE

Luego filtra los tickets que realmente son de categoria **Reseña**.

### 2. Detecta de donde viene cada reseña

El sistema revisa la informacion disponible del ticket:

- asunto
- descripcion
- enlace de reseña
- categoria
- campos personalizados
- texto de la reseña
- URL

Con eso determina el origen:

- **GMB**: reseña de Google Business / Google Maps
- **Trustpilot**: reseña de Trustpilot
- **UNKNOWN**: no hay señales suficientes

Esto permite ver conteos separados por origen.

### 3. Clasifica si la reseña es positiva o negativa

El sistema usa Gemini para leer el texto de la reseña y tomar en cuenta:

- cantidad de estrellas
- palabras usadas por el cliente
- tono del mensaje
- queja o felicitacion
- contexto del ticket

Con eso la marca como:

- positiva
- negativa

Tambien guarda una explicacion breve de por que la clasifico asi.

### 4. Detecta si habla de KD MARKETING o KD PC

El sistema revisa señales del texto de la reseña y de HubSpot.

Ejemplos de señales de **KD PC**:

- ordenador
- portatil
- dispositivo
- entrega del PC
- equipo tecnologico

Ejemplos de señales de **KD MARKETING**:

- web
- ecommerce
- redes sociales
- RRSS
- SEO
- facturacion
- proyecto digital

El resultado puede ser:

- KD MARKETING
- KD PC
- KD PC + KD MARKETING
- UNKNOWN

### 5. Busca si la reseña coincide con un cliente de HubSpot

El sistema cruza la reseña con contactos, empresas y negocios en HubSpot.

Usa señales como:

- nombre del autor
- email si aparece
- telefono
- empresas relacionadas
- negocios/deals asociados
- productos contratados
- actividad reciente
- notas, llamadas y contexto del cliente

Luego clasifica el match como:

- **matched**: coincide con bastante seguridad
- **possible_match**: parece coincidir, pero necesita validacion
- **multiple_possible_matches**: hay varios posibles
- **not_matched**: no se encontro coincidencia
- **unidentifiable**: no hay datos suficientes

El front muestra el cliente sugerido y la explicacion del match.

### 6. El usuario confirma la asociacion solo cuando lo decide

El sistema no asocia contactos, empresas ni negocios automaticamente apenas analiza.

Primero muestra la sugerencia. Si el usuario esta de acuerdo, presiona **Confirmar asociacion**.

Solo en ese momento se conectan en HubSpot:

- ticket
- contacto
- empresa
- negocio/deal

Tambien se guarda una copia local de la confirmacion para que el front recuerde que esa asociacion ya fue confirmada.

### 7. Rellena campos utiles del ticket

Despues de analizar HubSpot, el sistema puede rellenar campos del ticket para facilitar la gestion:

- plataforma de la reseña
- comentario de gestion
- motivo de reseña negativa
- tipo de proyecto MKT cuando aplica

Esto ayuda a que el equipo tenga la informacion ordenada dentro de HubSpot.

Importante: el sistema no debe cambiar estados de tickets por si solo en este flujo. La gestion de estados queda bajo control del equipo.

### 8. Responde reseñas de Google usando Zernio

El boton **Responder reseñas GMB** trabaja solo con reseñas detectadas como Google.

El proceso tiene dos pasos:

1. **Dry-run o simulacion**: revisa cuales reseñas puede responder sin publicar nada.
2. **Confirmacion del usuario**: solo si el usuario confirma, envia respuestas reales por Zernio.

Antes de publicar, el sistema intenta:

- encontrar la reseña real en Zernio
- validar que corresponde al ticket correcto
- revisar si ya fue respondida
- seleccionar la ubicacion correcta de Google Business en Zernio
- evitar duplicados

Las respuestas publicadas o intentadas quedan registradas en `data/gmb-review-replies.json`.

### 9. Muestra una terminal visual

El front incluye una terminal visual donde se ve:

- inicio del analisis
- tickets encontrados
- origen detectado
- sentimiento detectado
- servicio detectado
- coincidencias encontradas
- respuestas enviadas
- errores de Zernio o HubSpot
- confirmaciones realizadas

Esto permite auditar el proceso sin abrir logs tecnicos.

## Herramientas utilizadas

### HubSpot

Se usa como fuente principal de tickets, clientes, empresas y negocios.

Sirve para:

- leer tickets de reseñas
- buscar contactos
- buscar empresas
- buscar negocios/deals
- asociar tickets con clientes cuando se confirma
- rellenar campos de gestion

### Zernio

Se usa para trabajar con reseñas de Google Business conectadas al perfil de ORBIDI.

Sirve para:

- leer reseñas de Google Business
- obtener el `reviewId` real de Google
- seleccionar la ubicacion de Google Business
- publicar respuestas a reseñas de Google
- validar si una reseña ya tiene respuesta

### Google Business Profile / Google Maps

Es la fuente publica de reseñas de Google.

El proyecto no depende directamente del panel de Google para operar todos los flujos, porque Zernio actua como intermediario conectado al perfil de ORBIDI.

### Gemini

Se usa para interpretar textos de reseñas y contexto de HubSpot.

Ayuda a:

- clasificar sentimiento
- entender si una reseña es positiva o negativa
- detectar si habla de KD PC o KD MARKETING
- analizar posibles coincidencias con clientes

### Frontend local

Es la interfaz que usa el equipo.

Permite:

- ver metricas
- filtrar reseñas
- confirmar asociaciones
- responder reseñas GMB
- revisar logs en terminal visual
- exportar CSV

### Backend local en Node.js

Coordina todo el proceso.

Hace de puente entre:

- front
- HubSpot
- Zernio
- Gemini
- archivos locales de persistencia

### Archivos JSON locales

Se usan para guardar estado y trazabilidad sin montar una base de datos pesada.

Archivos importantes:

- `data/hubspot-new-ticket-matches.json`: ultimo analisis de HubSpot
- `data/confirmed-review-associations.json`: asociaciones confirmadas
- `data/gmb-review-replies.json`: respuestas GMB enviadas o verificadas
- `data/last-analysis.json`: ultimo analisis general de reseñas
- `data/hubspot-gemini-cache.json`: cache de analisis Gemini

## Que ve el usuario en el front

El panel muestra:

- total de reseñas/tickets
- positivas
- negativas
- GMB
- Trustpilot
- UNKNOWN
- KD PC
- KD Marketing
- coincidencias
- posibles coincidencias
- no coincidencias
- asociaciones confirmadas
- respuestas GMB publicadas
- errores de respuesta GMB

Cada tarjeta o fila muestra:

- origen
- sentimiento
- servicio
- cliente sugerido
- explicacion del match
- estado de asociacion
- estado de respuesta GMB
- URL de la reseña cuando existe
- boton para confirmar asociacion cuando aplica

## Controles importantes

### Analizar HubSpot

Actualiza el analisis de tickets de reseñas.

### Responder reseñas GMB

Primero simula, luego pide confirmacion antes de publicar respuestas reales en Google por Zernio.

### Confirmar asociacion

Conecta el ticket con el contacto, empresa y negocio/deal sugeridos.

### Actualizar

Recarga el ultimo reporte guardado.

### Exportar CSV

Permite descargar informacion para revision externa.

## Seguridad y control

El proyecto incluye varias medidas para evitar acciones incorrectas:

- no responde Trustpilot desde el boton GMB
- no publica respuestas sin confirmacion del usuario
- no asocia clientes automaticamente sin click del usuario
- no debe cambiar estados de ticket automaticamente en este flujo
- evita duplicar respuestas ya registradas
- si Zernio falla al leer reseñas, no publica respuestas sin validacion fresca
- si una URL de Google no tiene `reviewId` compatible con Zernio, se omite para revision manual

## Limitaciones conocidas

### Google Maps puede tardar en mostrar respuestas

Aunque Zernio/Google Business devuelva `reviewReply`, la respuesta puede tardar en aparecer en el enlace publico de Google Maps por cache, revision o moderacion de Google.

### Zernio puede fallar temporalmente

Si Zernio devuelve errores internos al leer reseñas, el sistema no publica nuevas respuestas. Muestra el problema en terminal y espera a que Zernio vuelva a responder correctamente.

### Algunas URLs cortas de Google no sirven para responder

Algunos links publicos de Google Maps usan identificadores internos que no son el `reviewId` real que necesita Zernio. En esos casos el sistema busca la reseña en Zernio por autor, texto, estrellas y fecha. Si no encuentra una coincidencia suficiente, la deja pendiente.

### El match con clientes puede requerir validacion humana

Cuando hay varios clientes parecidos o falta informacion, el sistema no fuerza una asociacion. La persona debe elegir el cliente correcto.

## Resultado esperado

Con este proyecto, ORBIDI obtiene un proceso mas ordenado para:

- entender el estado real de las reseñas
- priorizar negativas
- identificar clientes afectados
- conectar reseñas con tickets y clientes
- responder reseñas GMB con control
- auditar decisiones y errores
- reducir tiempo operativo del equipo

En resumen, el proyecto convierte una gestion dispersa de reseñas en un flujo unico, visible y controlado.
