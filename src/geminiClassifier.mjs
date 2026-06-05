function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function mapLimit(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results.flat();
}

function stripCodeFence(value) {
  return String(value || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function localClassify(review) {
  const text = `${review.text || ""} ${review.reason || ""}`.toLowerCase();
  const negativeTerms = [
    "estafa",
    "fraude",
    "timo",
    "horrible",
    "pesimo",
    "pésimo",
    "malo",
    "mala",
    "no recomiendo",
    "decepcion",
    "decepción",
    "problema",
    "reclamar",
    "incumpl",
    "lento",
    "caro",
    "perdida",
    "pérdida",
    "nunca",
    "enga",
    "falta de comunicacion",
    "falta de comunicación"
  ];
  const positiveTerms = [
    "excelente",
    "recomiendo",
    "genial",
    "bueno",
    "buena",
    "profesional",
    "rapido",
    "rápido",
    "satisfecho",
    "contento",
    "gracias",
    "atento",
    "calidad"
  ];

  let score = 0;
  if (review.rating >= 4) score += 2;
  if (review.rating <= 2) score -= 2;
  if (review.rating === 3) score -= 0.25;
  for (const term of negativeTerms) if (text.includes(term)) score -= 1;
  for (const term of positiveTerms) if (text.includes(term)) score += 1;

  return {
    id: String(review.id),
    sentiment: score >= 0 ? "positive" : "negative",
    confidence: Math.min(0.95, Math.max(0.55, Math.abs(score) / 4 + 0.55)),
    provider: "local-fallback",
    model: "local-fallback",
    reason: review.rating
      ? `Clasificacion local basada en ${review.rating} estrellas y palabras clave.`
      : "Clasificacion local basada en palabras clave."
  };
}

function geminiText(data) {
  return (data.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();
}

function normalizeClassification(item) {
  return {
    id: String(item.id),
    sentiment: item.sentiment === "negative" ? "negative" : "positive",
    confidence: Math.min(1, Math.max(0, Number(item.confidence || 0))),
    provider: "gemini",
    model: "gemini",
    reason: String(item.reason || "").slice(0, 280),
    rating: item.rating === null || item.rating === undefined ? null : Number(item.rating) || null,
    extractedText: String(item.extractedText || item.text || "").slice(0, 900)
  };
}

function normalizeClientMatch(item) {
  const statusMap = {
    matched: "matched",
    coincide: "matched",
    possible_match: "possible_match",
    posible: "possible_match",
    multiple_possible_matches: "multiple_possible_matches",
    unidentifiable: "unidentifiable",
    not_matched: "not_matched"
  };
  const status = statusMap[item.status] || "not_matched";
  const validMatchReasons = new Set([
    "email_exact_match", "phone_exact_match", "single_name_match",
    "activity_match", "company_product_match", "ambiguous_multiple_matches", "insufficient_data"
  ]);
  const rawMatchReason = String(item.matchReason || "");
  return {
    ticketId: String(item.ticketId || item.id),
    status,
    confidence: Math.min(1, Math.max(0, Number(item.confidence || 0))),
    reason: String(item.reason || "").slice(0, 320),
    matchReason: validMatchReasons.has(rawMatchReason) ? rawMatchReason : "",
    matchType: String(item.matchType || ""),
    matchId: String(item.matchId || ""),
    matchName: String(item.matchName || ""),
    matchEmailOrDomain: String(item.matchEmailOrDomain || ""),
    provider: "gemini",
    model: "gemini"
  };
}

async function classifyChunkWithGemini(reviews, config, { useUrlContext = false } = {}) {
  const model = String(config.geminiModel || "gemini-2.5-flash").replace(/^models\//, "");
  const payload = {
    system_instruction: {
      parts: [
        {
          text:
            "Eres un analista de reputacion online. Clasifica cada reseña como positive o negative. Usa estrellas, texto, motivo interno y URL si esta disponible. 4-5 estrellas suelen ser positive; 1-2 negative; con 3 estrellas decide por el contenido dominante. No inventes datos: si una URL no se puede leer, usa los campos disponibles y dilo en reason. Responde solo JSON valido con {\"items\":[{\"id\":\"...\",\"sentiment\":\"positive|negative\",\"confidence\":0.0,\"reason\":\"...\",\"rating\":1,\"extractedText\":\"...\"}]}."
        }
      ]
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: JSON.stringify({
              reviews: reviews.map((review) => ({
                id: review.id,
                author: review.author,
                rating: review.rating,
                text: review.text,
                publishedAt: review.publishedAt,
                title: review.title,
                reason: review.reason,
                sourceUrl: review.sourceUrl || review.url
              }))
            })
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0
    }
  };

  if (useUrlContext && reviews.some((review) => review.sourceUrl || review.url)) {
    payload.tools = [{ url_context: {} }];
  } else {
    payload.generationConfig.response_mime_type = "application/json";
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.geminiApiKey
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `Gemini respondio con HTTP ${response.status}.`);
  }

  const parsed = JSON.parse(stripCodeFence(geminiText(data)));
  if (!Array.isArray(parsed.items)) throw new Error("Gemini no devolvio una lista items valida.");
  return parsed.items.map((item) => ({
    ...normalizeClassification(item),
    model
  }));
}

export async function classifyReviews(reviews, config, log) {
  if (!config.geminiApiKey) {
    if (!config.allowLocalClassifier) {
      throw new Error("Falta GEMINI_API_KEY en .env para clasificar con Gemini.");
    }
    log("warn", "GEMINI_API_KEY no esta configurada; se usa clasificador local de respaldo.");
    return reviews.map(localClassify);
  }

  const chunkSize = Math.max(1, Number(config.geminiChunkSize || 20));
  const concurrency = Math.max(1, Number(config.geminiConcurrency || 3));
  const chunks = chunk(reviews, chunkSize);
  log("info", `Clasificando con Gemini (${config.geminiModel}) en ${chunks.length} lote(s), concurrencia ${concurrency}.`);

  try {
    return await mapLimit(chunks, concurrency, async (current, index) => {
      log("info", `Enviando lote ${index + 1}/${chunks.length} a Gemini (${current.length} resenas).`);
      return classifyChunkWithGemini(current, config);
    });
  } catch (error) {
    if (!config.allowLocalClassifier) throw error;
    log("warn", `Gemini no pudo clasificar (${error.message}); se usa clasificador local de respaldo.`);
    return reviews.map(localClassify);
  }
}

export async function classifyHubspotReviews(reviews, config, log = () => {}) {
  if (!reviews.length) return [];
  if (!config.geminiApiKey) {
    if (!config.allowLocalClassifier) throw new Error("Falta GEMINI_API_KEY en .env para clasificar HubSpot.");
    log("warn", "GEMINI_API_KEY no esta configurada; HubSpot usa clasificador local.");
    return reviews.map(localClassify);
  }

  const results = [];
  const chunks = chunk(reviews, 12);
  log("info", `Clasificando resenas HubSpot con Gemini (${config.geminiModel}) en ${chunks.length} lote(s).`);

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const current = chunks[index];
      log("info", `HubSpot lote ${index + 1}/${chunks.length}: ${current.length} resenas.`);
      results.push(...(await classifyChunkWithGemini(current, config, { useUrlContext: true })));
    }
  } catch (error) {
    if (!config.allowLocalClassifier) throw error;
    log("warn", `Gemini no pudo clasificar HubSpot (${error.message}); se usa clasificador local.`);
    return reviews.map(localClassify);
  }

  return results;
}

async function classifyClientMatchChunkWithGemini(items, config) {
  const model = String(config.geminiModel || "gemini-2.5-flash").replace(/^models\//, "");
  const payload = {
    system_instruction: {
      parts: [
        {
          text:
            "Eres un analista de datos CRM. Determina si una reseña/ticket de HubSpot corresponde a un cliente existente.\n\nPRIORIDADES:\n1. Email exacto → matched, matchReason:email_exact_match, confidence≥0.95\n2. Teléfono exacto → matched o possible_match, matchReason:phone_exact_match\n3. Nombre+apellido con empresa/deal/actividad clara → matched, matchReason:single_name_match\n4. Varios candidatos viables sin poder distinguir → multiple_possible_matches, matchReason:ambiguous_multiple_matches\n5. Sin datos identificativos → unidentifiable, matchReason:insufficient_data\n6. Sin candidatos relevantes → not_matched\n\nREGLAS:\n- NO uses matched solo por nombre común sin apellido, email, empresa o evidencia adicional.\n- Si hay 2+ candidatos viables sin distinción clara, usa multiple_possible_matches.\n- Usa revenue__plan/servicios_subvencionados/servicio_producido como evidencia de productos contratados.\n- En reason indica: email, nombre, empresa, dominio, teléfono, deal, actividad, productos_contratados.\n- matchReason: email_exact_match|phone_exact_match|single_name_match|activity_match|company_product_match|ambiguous_multiple_matches|insufficient_data\n\nResponde solo JSON válido: {\"items\":[{\"ticketId\":\"...\",\"status\":\"matched|possible_match|multiple_possible_matches|not_matched|unidentifiable\",\"confidence\":0.0,\"reason\":\"...\",\"matchReason\":\"email_exact_match|...\",\"matchType\":\"contact|company|\",\"matchId\":\"...\",\"matchName\":\"...\",\"matchEmailOrDomain\":\"...\"}]}"
        }
      ]
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: JSON.stringify({ items })
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0,
      response_mime_type: "application/json"
    }
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": config.geminiApiKey
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Gemini respondio con HTTP ${response.status}.`);

  const parsed = JSON.parse(stripCodeFence(geminiText(data)));
  if (!Array.isArray(parsed.items)) throw new Error("Gemini no devolvio una lista items valida para coincidencias.");
  return parsed.items.map((item) => ({
    ...normalizeClientMatch(item),
    model
  }));
}

export async function classifyHubspotClientMatches(items, config, log = () => {}) {
  if (!items.length) return [];
  if (!config.geminiApiKey) {
    if (!config.allowLocalClassifier) throw new Error("Falta GEMINI_API_KEY en .env para analizar coincidencias HubSpot.");
    log("warn", "GEMINI_API_KEY no esta configurada; se mantiene coincidencia local de HubSpot.");
    return [];
  }

  const chunks = chunk(items, 8);
  const results = [];
  log("info", `Analizando coincidencias HubSpot con Gemini (${config.geminiModel}) en ${chunks.length} lote(s).`);

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const current = chunks[index];
      log("info", `Coincidencias HubSpot lote ${index + 1}/${chunks.length}: ${current.length} tickets.`);
      results.push(...(await classifyClientMatchChunkWithGemini(current, config)));
    }
  } catch (error) {
    if (!config.allowLocalClassifier) throw error;
    log("warn", `Gemini no pudo analizar coincidencias HubSpot (${error.message}); se mantiene coincidencia local.`);
    return [];
  }

  return results;
}
