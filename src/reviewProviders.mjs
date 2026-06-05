import { readFile } from "node:fs/promises";
import path from "node:path";

const ratingMap = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
  "1": 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5
};

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function ratingToNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(1, Math.min(5, value));
  const raw = String(value || "").trim();
  if (ratingMap[raw]) return ratingMap[raw];
  const match = raw.match(/([1-5](?:\.\d+)?)/);
  return match ? Math.max(1, Math.min(5, Number(match[1]))) : null;
}

function replyText(value) {
  if (!value) return "";
  if (typeof value === "string") return cleanText(value);
  if (typeof value !== "object") return "";
  return cleanText(
    value.comment ||
    value.text ||
    value.message ||
    value.body ||
    value.content ||
    value.reply ||
    ""
  );
}

function normalizeReview(review, fallbackIndex, source) {
  const rating = ratingToNumber(
    review.rating ?? review.stars ?? review.starRating ?? review.score ?? review.reviewRating
  );
  const text = cleanText(
    review.text ?? review.comment ?? review.snippet ?? review.description ?? review.review_text ?? review.body
  );
  const rawAuthor =
    review.author ||
    review.user?.name ||
    review.reviewer?.displayName ||
    review.reviewer?.name ||
    review.reviewer_name ||
    (String(review.name || "").startsWith("accounts/") ? "" : review.name) ||
    "Usuario";

  return {
    id: String(review.id || review.reviewId || review.review_id || review.name || `${source}-${fallbackIndex}`),
    author: cleanText(rawAuthor),
    rating,
    text,
    publishedAt: review.publishedAt || review.date || review.iso_date || review.createTime || review.created || review.relative_time_description || "",
    updatedAt: review.updatedAt || review.updateTime || review.updated || "",
    sourceUrl: review.link || review.sourceUrl || review.review_url || review.reviewUrl || "",
    source,
    reply: replyText(review.reviewReply) || replyText(review.reply) || replyText(review.owner_answer),
    platform: review.platform || "",
    accountId: review.accountId || review.account_id || review.account?._id || review.account?.id || "",
    locationId: review.locationId || review.location_id || review.location?.id || review.location?.name || ""
  };
}

function dedupeReviews(reviews) {
  const seen = new Set();
  const result = [];
  for (const review of reviews) {
    const key = `${review.id}|${review.author}|${review.rating}|${review.text.slice(0, 80)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(review);
  }
  return result;
}

function parseManualReviews(input) {
  if (Array.isArray(input)) return input;
  const raw = String(input || "").trim();
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.reviews)) return parsed.reviews;
  } catch {
    // Try a lightweight CSV/TSV import next.
  }

  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const separator = raw.includes("\t") ? "\t" : raw.includes(";") ? ";" : ",";
  const headers = lines[0].split(separator).map((item) => item.trim().toLowerCase());
  const hasHeaders = headers.some((header) => ["rating", "stars", "text", "comment", "author"].includes(header));
  const dataLines = hasHeaders ? lines.slice(1) : lines;

  return dataLines.map((line, index) => {
    const values = line.split(separator).map((item) => item.trim());
    if (!hasHeaders) {
      return { id: `manual-${index + 1}`, rating: values[0], text: values.slice(1).join(" ") };
    }
    const row = {};
    headers.forEach((header, columnIndex) => {
      row[header] = values[columnIndex] || "";
    });
    return {
      id: row.id || `manual-${index + 1}`,
      author: row.author || row.name,
      rating: row.rating || row.stars,
      text: row.text || row.comment || row.review,
      publishedAt: row.date || row.publishedat
    };
  });
}

function queryFromInput(input) {
  if (input.companyName) return input.companyName;
  if (input.googleUrl) {
    try {
      const parsed = new URL(input.googleUrl);
      return parsed.searchParams.get("q") || "ORBIDI Opiniones";
    } catch {
      return input.googleUrl;
    }
  }
  return "ORBIDI Opiniones";
}

async function serpApiFetch(params, apiKey) {
  const url = new URL("https://serpapi.com/search.json");
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  url.searchParams.set("api_key", apiKey);

  const response = await fetch(url, { headers: { accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    throw new Error(data.error || `SerpApi respondio con HTTP ${response.status}.`);
  }
  return data;
}

async function fetchSerpApiReviews(input, config, log) {
  if (!config.serpapiApiKey) {
    throw new Error("Falta SERPAPI_API_KEY. Configurala en .env para leer resenas desde el perfil publico de Google.");
  }

  const query = queryFromInput(input);
  log("info", `Buscando ficha de Google Maps para "${query}".`);

  const searchData = await serpApiFetch(
    {
      engine: "google_maps",
      q: query,
      hl: "es",
      gl: "es",
      type: "search"
    },
    config.serpapiApiKey
  );

  const candidates = [
    searchData.place_results,
    ...(Array.isArray(searchData.local_results) ? searchData.local_results : [])
  ].filter(Boolean);

  const preferred = candidates.find((item) => /orbidi/i.test(item.title || item.name || "")) || candidates[0];
  if (!preferred) {
    throw new Error("SerpApi no devolvio una ficha de Google Maps para esa busqueda.");
  }

  const dataId = preferred.data_id || preferred.data_cid || searchData.place_results?.data_id;
  const placeId = preferred.place_id || searchData.place_results?.place_id;
  if (!dataId && !placeId) {
    throw new Error("No se encontro data_id/place_id para consultar resenas.");
  }

  log("success", `Ficha encontrada: ${preferred.title || preferred.name || "Google Maps"}.`);

  const reviews = [];
  let nextPageToken = "";
  let page = 1;

  while (reviews.length < input.maxReviews) {
    const data = await serpApiFetch(
      {
        engine: "google_maps_reviews",
        data_id: dataId,
        place_id: dataId ? undefined : placeId,
        hl: "es",
        sort_by: "newestFirst",
        next_page_token: nextPageToken
      },
      config.serpapiApiKey
    );

    const pageReviews = data.reviews || data.review_results || data.user_reviews || [];
    log("info", `Pagina ${page}: ${pageReviews.length} resenas recibidas.`);

    reviews.push(
      ...pageReviews.map((review, index) => normalizeReview(review, reviews.length + index + 1, "serpapi"))
    );

    nextPageToken = data.serpapi_pagination?.next_page_token || data.next_page_token || "";
    if (!nextPageToken || !pageReviews.length) break;
    page += 1;
  }

  return dedupeReviews(reviews)
    .filter((review) => review.rating || review.text)
    .slice(0, input.maxReviews);
}

function resourceId(value, prefix) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith(`${prefix}/`) ? raw.slice(prefix.length + 1) : raw;
}

async function fetchBusinessProfileReviews(input, config, log) {
  const accessToken = input.gbpAccessToken || config.gbpAccessToken;
  const accountId = resourceId(input.gbpAccountId || config.gbpAccountId, "accounts");
  const locationId = resourceId(input.gbpLocationId || config.gbpLocationId, "locations");

  if (!accessToken || !accountId || !locationId) {
    throw new Error("Faltan GBP_ACCESS_TOKEN, GBP_ACCOUNT_ID y GBP_LOCATION_ID para usar Google Business Profile.");
  }

  const reviews = [];
  let pageToken = "";
  let page = 1;

  while (reviews.length < input.maxReviews) {
    const url = new URL(`https://mybusiness.googleapis.com/v4/accounts/${accountId}/locations/${locationId}/reviews`);
    url.searchParams.set("pageSize", "50");
    url.searchParams.set("orderBy", "updateTime desc");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json"
      }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error?.message || `Google Business Profile respondio con HTTP ${response.status}.`);
    }

    const pageReviews = data.reviews || [];
    log("info", `Pagina ${page}: ${pageReviews.length} resenas recibidas de Business Profile.`);
    reviews.push(
      ...pageReviews.map((review, index) => normalizeReview(review, reviews.length + index + 1, "business-profile"))
    );

    pageToken = data.nextPageToken || "";
    if (!pageToken || !pageReviews.length) break;
    page += 1;
  }

  return dedupeReviews(reviews)
    .filter((review) => review.rating || review.text)
    .slice(0, input.maxReviews);
}

async function zernioFetch(pathname, params, config, options = {}) {
  const base = config.zernioBaseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${pathname}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${config.zernioApiKey}`,
      accept: "application/json",
      ...(options.body ? { "content-type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error?.message || data.message || data.error || data.status || "";
    throw new Error(
      detail
        ? `Zernio respondio con HTTP ${response.status}: ${String(detail).slice(0, 500)}`
        : `Zernio respondio con HTTP ${response.status}.`
    );
  }
  return data;
}

export async function resolveZernioGoogleBusinessAccountId(input, config, log) {
  if (input.zernioAccountId || config.zernioAccountId) return input.zernioAccountId || config.zernioAccountId;

  log("info", "Buscando cuenta Google Business conectada en Zernio.");
  let account = null;

  try {
    const data = await zernioFetch("/accounts", {}, config);
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    account = accounts.find((item) => item.platform === "googlebusiness") || accounts[0];
  } catch (error) {
    log("warn", `/accounts fallo en Zernio (${error.message}); usando una resena del inbox para detectar accountId.`);
    const inbox = await zernioFetch(
      "/inbox/reviews",
      {
        platform: input.zernioPlatform || "googlebusiness",
        limit: 1,
        sortBy: "date",
        sortOrder: "desc"
      },
      config
    );
    const sample = Array.isArray(inbox.data) ? inbox.data.find((item) => item.accountId) : null;
    if (sample?.accountId) {
      account = {
        _id: sample.accountId,
        displayName: sample.accountUsername,
        username: sample.accountUsername,
        platform: sample.platform
      };
    }
  }

  if (!account?._id) {
    throw new Error("No se encontro una cuenta Google Business conectada en Zernio.");
  }

  log("success", `Cuenta Zernio encontrada: ${account.displayName || account.username || account._id}.`);
  return account._id;
}

async function fetchZernioGmbReviews(input, config, log) {
  const accountId = await resolveZernioGoogleBusinessAccountId(input, config, log);
  const reviews = [];
  const pageSize = 50;
  let pageToken = "";
  let page = 1;
  let providerTotal = null;

  while (reviews.length < input.maxReviews) {
    const data = await zernioFetch(
      `/accounts/${accountId}/gmb-reviews`,
      {
        locationId: input.zernioLocationId,
        pageSize,
        pageToken
      },
      config
    );

    const pageReviews = Array.isArray(data.reviews) ? data.reviews : [];
    providerTotal = Number(data.totalReviewCount || providerTotal || pageReviews.length);
    log("info", `Zernio GBP pagina ${page}: ${pageReviews.length} resenas recibidas.`);

    reviews.push(
      ...pageReviews.map((review, index) => normalizeReview(review, reviews.length + index + 1, "zernio"))
    );

    pageToken = data.nextPageToken || "";
    if (!pageToken || !pageReviews.length) break;
    page += 1;
  }

  const normalized = dedupeReviews(reviews)
    .filter((review) => review.rating || review.text)
    .slice(0, input.maxReviews);

  if (providerTotal && providerTotal > normalized.length) {
    log(
      "warn",
      `Zernio GBP reporta ${providerTotal} resenas totales; se analizaron ${normalized.length}. Sube el limite si necesitas cubrirlas todas.`
    );
  } else {
    log("success", `Zernio GBP reporta ${normalized.length} resenas cubiertas por el analisis.`);
  }

  return normalized;
}

async function fetchZernioReviews(input, config, log) {
  if (!config.zernioApiKey) {
    throw new Error("Falta ZERNIO_API_KEY. Configurala en .env para leer resenas desde Zernio.");
  }

  if (input.zernioMode !== "inbox") {
    return fetchZernioGmbReviews(input, config, log);
  }

  const reviews = [];
  const limit = 50;
  let cursor = "";
  let page = 1;
  let providerTotal = null;
  let uniqueAnalyzableCount = 0;

  log("info", "Consultando resenas de Google Business desde Zernio.");

  while (uniqueAnalyzableCount < input.maxReviews) {
    const data = await zernioFetch(
      "/inbox/reviews",
      {
        platform: input.zernioPlatform || "googlebusiness",
        accountId: input.zernioAccountId,
        limit,
        cursor,
        sortBy: "date",
        sortOrder: "desc"
      },
      config
    );

    const pageReviews = Array.isArray(data.data) ? data.data : [];
    providerTotal = Number(data.summary?.totalReviews || providerTotal || pageReviews.length);
    log("info", `Zernio pagina ${page}: ${pageReviews.length} resenas recibidas.`);

    reviews.push(
      ...pageReviews.map((review, index) => normalizeReview(review, reviews.length + index + 1, "zernio"))
    );
    uniqueAnalyzableCount = dedupeReviews(reviews).filter((review) => review.rating || review.text).length;

    cursor = data.pagination?.nextCursor || "";
    if (!data.pagination?.hasMore || !cursor || !pageReviews.length) break;
    page += 1;
  }

  const normalized = dedupeReviews(reviews)
    .filter((review) => review.rating || review.text)
    .slice(0, input.maxReviews);

  if (providerTotal && providerTotal > normalized.length) {
    log(
      "warn",
      `Zernio reporta ${providerTotal} resenas totales; se analizaron ${normalized.length}. Sube el limite si necesitas cubrirlas todas.`
    );
  } else {
    log("success", `Zernio reporta ${normalized.length} resenas cubiertas por el analisis.`);
  }

  return normalized;
}

export async function fetchZernioPositiveUnrepliedGmbReviews(input, config, log) {
  if (!config.zernioApiKey) {
    throw new Error("Falta ZERNIO_API_KEY. Configurala en .env para leer resenas desde Zernio.");
  }

  const accountId = await resolveZernioGoogleBusinessAccountId(input, config, log);
  const reviews = [];
  const limit = 50;
  let cursor = "";
  let page = 1;
  let providerTotal = null;

  log("info", "Consultando solo reseñas Google positivas sin respuesta en Zernio (minRating=4, hasReply=false).");

  while (reviews.length < input.maxReviews) {
    const data = await zernioFetch(
      "/inbox/reviews",
      {
        platform: "googlebusiness",
        accountId,
        minRating: 4,
        maxRating: 5,
        hasReply: false,
        limit,
        cursor,
        sortBy: "date",
        sortOrder: "desc"
      },
      config
    );

    const pageReviews = Array.isArray(data.data) ? data.data : [];
    providerTotal = Number(data.summary?.totalReviews || providerTotal || pageReviews.length);
    log("info", `Zernio positivas sin respuesta pagina ${page}: ${pageReviews.length} reseñas recibidas.`);

    reviews.push(
      ...pageReviews.map((review, index) => ({
        ...normalizeReview(review, reviews.length + index + 1, "zernio"),
        accountId: review.accountId || accountId,
        optimizedInboxSource: true
      }))
    );

    cursor = data.pagination?.nextCursor || "";
    if (!data.pagination?.hasMore || !cursor || !pageReviews.length) break;
    page += 1;
  }

  const normalized = dedupeReviews(reviews)
    .filter((review) => Number(review.rating || 0) >= 4 && !replyText(review.reply))
    .slice(0, input.maxReviews);

  log(
    "success",
    `Busqueda optimizada Zernio: ${normalized.length} reseñas positivas sin respuesta listas; ${page} pagina(s) consultada(s).`
  );

  return {
    accountId,
    reviews: normalized,
    pages: page,
    providerTotal
  };
}

async function fetchManualReviews(input, log) {
  const parsed = parseManualReviews(input.manualReviews);
  log("info", `${parsed.length} resenas importadas manualmente.`);
  return dedupeReviews(parsed.map((review, index) => normalizeReview(review, index + 1, "manual"))).filter(
    (review) => review.rating || review.text
  );
}

async function fetchSampleReviews(rootDir, log) {
  const samplePath = path.join(rootDir, "data", "reviews.sample.json");
  const parsed = JSON.parse(await readFile(samplePath, "utf8"));
  log("info", `${parsed.reviews.length} resenas de prueba cargadas.`);
  return parsed.reviews.map((review, index) => normalizeReview(review, index + 1, "sample"));
}

export async function collectReviews(input, config, log, rootDir) {
  const source = input.source || "serpapi";
  if (source === "zernio") return fetchZernioReviews(input, config, log);
  if (source === "business-profile") return fetchBusinessProfileReviews(input, config, log);
  if (source === "manual") return fetchManualReviews(input, log);
  if (source === "sample") return fetchSampleReviews(rootDir, log);
  return fetchSerpApiReviews(input, config, log);
}

function googleBusinessReviewId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const decoded = decodeURIComponent(raw);
  const resourceMatch = decoded.match(/\/reviews\/([^/?#]+)/i);
  if (resourceMatch?.[1]) return resourceMatch[1];
  return decoded;
}

function googleBusinessLocationId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const decoded = decodeURIComponent(raw);
  const locationMatch = decoded.match(/\/locations\/([^/?#]+)/i);
  if (!locationMatch?.[1]) return "";
  return `locations/${locationMatch[1]}`;
}

async function selectZernioGmbLocation({ accountId, locationId }, config) {
  if (!accountId || !locationId) return null;
  try {
    return await zernioFetch(
      `/accounts/${encodeURIComponent(accountId)}/gmb-locations`,
      {},
      config,
      {
        method: "PUT",
        body: { selectedLocationId: locationId }
      }
    );
  } catch (error) {
    const rawLocationId = locationId.replace(/^locations\//, "");
    if (rawLocationId === locationId) throw error;
    return zernioFetch(
      `/accounts/${encodeURIComponent(accountId)}/gmb-locations`,
      {},
      config,
      {
        method: "PUT",
        body: { selectedLocationId: rawLocationId }
      }
    );
  }
}

export async function replyToZernioGmbReview({ reviewId, accountId, message }, config) {
  if (!config.zernioApiKey) {
    throw new Error("Falta ZERNIO_API_KEY para responder resenas GMB desde Zernio.");
  }
  if (!reviewId) throw new Error("reviewId es obligatorio para responder en Zernio.");
  if (!accountId) throw new Error("accountId es obligatorio para responder en Zernio.");
  if (!message) throw new Error("message es obligatorio para responder en Zernio.");

  const gmbReviewId = googleBusinessReviewId(reviewId);
  const gmbLocationId = googleBusinessLocationId(reviewId);
  const locationSelection = await selectZernioGmbLocation({ accountId, locationId: gmbLocationId }, config);
  return zernioFetch(
    `/accounts/${encodeURIComponent(accountId)}/gmb-reviews/${encodeURIComponent(gmbReviewId)}/reply`,
    {},
    config,
    {
      method: "POST",
      body: {
        comment: message
      }
    }
  ).then((response) => ({ ...response, selectedLocationId: gmbLocationId || null, locationSelection }));
}
