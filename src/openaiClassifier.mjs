function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function stripCodeFence(value) {
  return String(value || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function localClassify(review) {
  const text = `${review.text || ""}`.toLowerCase();
  const negativeTerms = [
    "estafa",
    "fraude",
    "timo",
    "horrible",
    "pesimo",
    "malo",
    "no recomiendo",
    "decepcion",
    "problema",
    "reclamar",
    "incumpl",
    "lento",
    "caro",
    "perdida",
    "nunca",
    "enga"
  ];
  const positiveTerms = [
    "excelente",
    "recomiendo",
    "genial",
    "bueno",
    "profesional",
    "rapido",
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
    id: review.id,
    sentiment: score >= 0 ? "positive" : "negative",
    confidence: Math.min(0.95, Math.max(0.55, Math.abs(score) / 4 + 0.55)),
    reason: review.rating
      ? `Clasificacion local basada en ${review.rating} estrellas y palabras clave.`
      : "Clasificacion local basada en palabras clave."
  };
}

async function classifyChunkWithOpenAI(reviews, config) {
  const payload = {
    model: config.openaiModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "Eres un analista de reputacion online. Clasifica resenas de Google en positive o negative. Usa tanto estrellas como texto. 4-5 estrellas suelen ser positive; 1-2 negative; con 3 estrellas decide por el contenido dominante. No inventes datos. Responde solo JSON valido con {\"items\":[{\"id\":\"...\",\"sentiment\":\"positive|negative\",\"confidence\":0.0,\"reason\":\"...\"}]}."
      },
      {
        role: "user",
        content: JSON.stringify({
          reviews: reviews.map((review) => ({
            id: review.id,
            author: review.author,
            rating: review.rating,
            text: review.text,
            publishedAt: review.publishedAt
          }))
        })
      }
    ]
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.openaiApiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || `OpenAI respondio con HTTP ${response.status}.`);
  }

  const content = data.choices?.[0]?.message?.content;
  const parsed = JSON.parse(stripCodeFence(content));
  if (!Array.isArray(parsed.items)) throw new Error("OpenAI no devolvio una lista items valida.");
  return parsed.items.map((item) => ({
    id: String(item.id),
    sentiment: item.sentiment === "negative" ? "negative" : "positive",
    confidence: Number(item.confidence || 0),
    reason: String(item.reason || "").slice(0, 240)
  }));
}

export async function classifyReviews(reviews, config, log) {
  if (!config.openaiApiKey) {
    if (!config.allowLocalClassifier) {
      throw new Error("Falta OPENAI_API_KEY. Configurala en .env para clasificar con ChatGPT.");
    }
    log("warn", "OPENAI_API_KEY no esta configurada; se usa clasificador local solo para pruebas.");
    return reviews.map(localClassify);
  }

  const results = [];
  const chunks = chunk(reviews, 20);
  log("info", `Clasificando con OpenAI (${config.openaiModel}) en ${chunks.length} lote(s).`);

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      const current = chunks[index];
      log("info", `Enviando lote ${index + 1}/${chunks.length} a ChatGPT (${current.length} resenas).`);
      const classified = await classifyChunkWithOpenAI(current, config);
      results.push(...classified);
    }
  } catch (error) {
    if (!config.allowLocalClassifier) throw error;
    log("warn", `OpenAI no pudo clasificar (${error.message}); se usa clasificador local de respaldo.`);
    return reviews.map(localClassify);
  }

  return results;
}
