import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { classifyHubspotClientMatches, classifyHubspotReviews } from "../src/geminiClassifier.mjs";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const DEFAULT_PORTAL_ID = "25808060";
let PORTAL_ID = DEFAULT_PORTAL_ID;
const BASE_URL = "https://api.hubapi.com";
let TARGET_VIEW_ID = "154934216";
let TARGET_VIEW_URL = `https://app-eu1.hubspot.com/contacts/${PORTAL_ID}/objects/0-5/views/${TARGET_VIEW_ID}/board`;
const LAST_ANALYSIS_PATH = path.join(DATA_DIR, "last-analysis.json");
let TARGET_PIPELINE_LABEL = "customer success";
let TARGET_STAGE_LABEL = "inbox";
let TARGET_STAGE_ID = "1932423374";
let TARGET_STAGE_IDS = ["1932423374", "2059638979", "5143618788"];
let TARGET_REVIEW_CATEGORY_PROPERTY = "categoria_del_ticket";
let TARGET_REVIEW_CATEGORY_VALUE = "Reseña";
let HUBSPOT_REVIEW_FORM_ID = "";
const HUBSPOT_CONTEXT_CACHE_PATH = path.join(DATA_DIR, "hubspot-context-cache.json");
const HUBSPOT_GEMINI_CACHE_PATH = path.join(DATA_DIR, "hubspot-gemini-cache.json");
const disabledActivityTypes = new Set();

function parseEnv(raw) {
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([^#=\s]+)=(.*)$/);
    if (!match) continue;
    env[match[1]] = match[2].trim();
  }
  return env;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9@._+\-\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set([
  "del",
  "de",
  "la",
  "las",
  "los",
  "el",
  "un",
  "una",
  "por",
  "para",
  "con",
  "sin",
  "ticket",
  "cliente",
  "clientes",
  "nuevo",
  "nueva",
  "servicio",
  "servicios",
  "orbidi",
  "plinng",
  "incidencia",
  "consulta",
  "solicitud",
  "reclamo",
  "reclamacion",
  "baja",
  "alta",
  "gestion",
  "empresa",
  "contacto",
  "principal"
]);

function tokens(value) {
  return normalize(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function emailsFrom(value) {
  return unique(String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []).map((email) =>
    email.toLowerCase()
  );
}

function phonesFrom(value) {
  return unique(
    String(value || "")
      .match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || []
  )
    .map((phone) => phone.replace(/\D/g, ""))
    .filter((phone) => phone.length >= 8);
}

function prop(record, name) {
  return record?.properties?.[name] || "";
}

function joinProps(record, names) {
  return names.map((name) => prop(record, name)).filter(Boolean).join(" | ");
}

function firstNonEmpty(values) {
  return values.find((value) => String(value || "").trim()) || "";
}

async function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function csvCell(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function hashPayload(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function hubspot(pathname, { token, method = "GET", body } = {}) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (response.status === 429 && attempt < 4) {
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!response.ok) {
      throw new Error(data.message || data.error || `HubSpot HTTP ${response.status}`);
    }
    return data;
  }
  throw new Error("HubSpot rate limit repetido.");
}

async function getPropertyNames(token, objectType) {
  const data = await hubspot(`/crm/v3/properties/${objectType}`, { token });
  return new Set((data.results || []).map((item) => item.name));
}

async function getTargetStages(token) {
  const data = await hubspot("/crm/v3/pipelines/tickets", { token });
  const stages = [];
  for (const pipeline of data.results || []) {
    if (normalize(pipeline.label) !== TARGET_PIPELINE_LABEL) continue;
    for (const stage of pipeline.stages || []) {
      if (TARGET_STAGE_IDS.includes(String(stage.id)) || normalize(stage.label) === TARGET_STAGE_LABEL || stage.id === TARGET_STAGE_ID) {
        stages.push({
          pipelineId: pipeline.id,
          pipelineLabel: pipeline.label,
          stageId: stage.id,
          stageLabel: stage.label
        });
      }
    }
  }
  return stages;
}

async function searchAll(token, objectType, body, label = objectType) {
  const results = [];
  let after = undefined;
  let page = 0;
  do {
    const data = await hubspot(`/crm/v3/objects/${objectType}/search`, {
      token,
      method: "POST",
      body: { ...body, limit: 100, after }
    });
    page += 1;
    results.push(...(data.results || []));
    after = data.paging?.next?.after;
    console.log(`HubSpot ${label}: pagina ${page}, recuperados=${results.length}, cursor=${after || "fin"}`);
  } while (after);
  return results;
}

async function getTicketsForStage(token, stage, properties) {
  const tickets = await searchAll(token, "tickets", {
    filterGroups: [
      {
        filters: [
          { propertyName: "hs_pipeline", operator: "EQ", value: stage.pipelineId },
          { propertyName: "hs_pipeline_stage", operator: "EQ", value: stage.stageId }
        ]
      }
    ],
    properties,
    sorts: [{ propertyName: "createdate", direction: "DESCENDING" }]
  }, `${stage.pipelineLabel}/${stage.stageLabel}`);
  return tickets.map((ticket) => ({ ...ticket, stage }));
}

async function searchCandidates(token, objectType, query, properties) {
  if (!query || normalize(query).length < 3) return [];
  try {
    const data = await hubspot(`/crm/v3/objects/${objectType}/search`, {
      token,
      method: "POST",
      body: {
        query,
        limit: 10,
        properties
      }
    });
    return data.results || [];
  } catch {
    return [];
  }
}

async function batchReadObjects(token, objectType, ids, properties) {
  const uniqueInputIds = unique(ids.map(String)).slice(0, 1000);
  const results = [];
  for (let index = 0; index < uniqueInputIds.length; index += 100) {
    const batchIds = uniqueInputIds.slice(index, index + 100);
    if (!batchIds.length) continue;
    try {
      const data = await hubspot(`/crm/v3/objects/${objectType}/batch/read`, {
        token,
        method: "POST",
        body: {
          properties,
          inputs: batchIds.map((id) => ({ id }))
        }
      });
      results.push(...(data.results || []));
      console.log(`HubSpot batch ${objectType}: ${Math.min(index + 100, uniqueInputIds.length)}/${uniqueInputIds.length}`);
    } catch (error) {
      console.log(`WARN: No se pudo leer batch ${objectType}: ${error.message}`);
      if (/scope|granted|required/i.test(error.message)) disabledActivityTypes.add(objectType);
    }
  }
  return results;
}

async function getAssociations(token, fromObjectType, fromObjectId, toObjectType) {
  const ids = [];
  let after = "";
  do {
    const suffix = after ? `?limit=500&after=${encodeURIComponent(after)}` : "?limit=500";
    try {
      const data = await hubspot(`/crm/v3/objects/${fromObjectType}/${fromObjectId}/associations/${toObjectType}${suffix}`, {
        token
      });
      ids.push(...(data.results || []).map((item) => item.id).filter(Boolean));
      after = data.paging?.next?.after || "";
    } catch (error) {
      console.log(`WARN: asociaciones ${fromObjectType}:${fromObjectId} -> ${toObjectType}: ${error.message}`);
      return [];
    }
  } while (after);
  return unique(ids);
}

async function findRecentActivity(token, objectType, objectId) {
  const activityTypes = ["notes", "calls", "emails", "meetings"];
  const snippets = [];
  for (const activityType of activityTypes) {
    if (disabledActivityTypes.has(activityType)) continue;
    try {
      const ids = await getAssociations(token, objectType, objectId, activityType);
      const recentIds = ids.slice(-3);
      if (!recentIds.length) continue;
      const records = await batchReadObjects(token, activityType, recentIds, [
        "hs_timestamp",
        "hs_note_body",
        "hs_call_body",
        "hs_email_subject",
        "hs_email_text",
        "hs_meeting_title",
        "hs_meeting_body"
      ]);
      for (const record of records.slice(0, 3)) {
        const text = joinProps(record, [
          "hs_timestamp",
          "hs_note_body",
          "hs_call_body",
          "hs_email_subject",
          "hs_email_text",
          "hs_meeting_title",
          "hs_meeting_body"
        ]);
        if (text) snippets.push(`${activityType}:${reviewText(text).slice(0, 220)}`);
      }
    } catch (error) {
      console.log(`WARN: actividad ${objectType}:${objectId}/${activityType}: ${error.message}`);
      if (/scope|granted|required/i.test(error.message)) disabledActivityTypes.add(activityType);
    }
  }
  return snippets.slice(0, 6);
}

async function inspectReviewForm(token) {
  const summary = {
    configuredFormId: HUBSPOT_REVIEW_FORM_ID || null,
    found: false,
    fields: [],
    relevantFields: [],
    message: ""
  };
  try {
    if (HUBSPOT_REVIEW_FORM_ID) {
      const form = await hubspot(`/marketing/v3/forms/${HUBSPOT_REVIEW_FORM_ID}`, { token });
      const fields = (form.formFieldGroups || []).flatMap((group) => group.fields || []);
      summary.found = true;
      summary.name = form.name || form.id || HUBSPOT_REVIEW_FORM_ID;
      summary.fields = fields.map((field) => ({ name: field.name, label: field.label, objectTypeId: field.objectTypeId }));
    } else {
      const data = await hubspot("/marketing/v3/forms?limit=100&formTypes=ALL", { token });
      const forms = data.results || [];
      const reviewForms = forms.filter((form) => /rese[nñ]a|review|trustpilot|google|gmb/i.test(`${form.name || ""} ${form.id || ""}`));
      summary.formsScanned = forms.length;
      summary.candidates = reviewForms.map((form) => ({ id: form.id, name: form.name })).slice(0, 10);
      if (reviewForms[0]) {
        const form = await hubspot(`/marketing/v3/forms/${reviewForms[0].id}`, { token });
        const fields = (form.formFieldGroups || []).flatMap((group) => group.fields || []);
        summary.found = true;
        summary.configuredFormId = reviewForms[0].id;
        summary.name = form.name || reviewForms[0].name;
        summary.fields = fields.map((field) => ({ name: field.name, label: field.label, objectTypeId: field.objectTypeId }));
      }
    }
    summary.relevantFields = summary.fields.filter((field) =>
      /rese[nñ]a|review|google|gmb|trustpilot|plataforma|servicio|cliente|empresa|contacto|url|enlace/i.test(
        `${field.name || ""} ${field.label || ""}`
      )
    );
    summary.message = summary.found
      ? `Form encontrado: ${summary.name}; campos relevantes=${summary.relevantFields.length}.`
      : "No se encontro un formulario de reseñas por nombre; configura HUBSPOT_REVIEW_FORM_ID si aplica.";
  } catch (error) {
    summary.message = `No se pudo consultar HubSpot Forms: ${error.message}`;
  }
  console.log(`HubSpot Forms: ${summary.message}`);
  if (summary.relevantFields?.length) {
    console.log(`Campos form relevantes: ${summary.relevantFields.map((field) => field.name || field.label).join(", ")}`);
  }
  return summary;
}

async function classifyWithCache(cacheKey, items, cacheNamespace, classifier, config, log) {
  const cache = await readJsonSafe(HUBSPOT_GEMINI_CACHE_PATH, { entries: {} });
  cache.entries ||= {};
  const pending = [];
  const results = [];

  for (const item of items) {
    const key = `${cacheNamespace}:${item[cacheKey] || item.id}:${hashPayload(item)}`;
    const cached = cache.entries[key];
    if (cached) {
      results.push(cached.result);
    } else {
      pending.push({ key, item });
    }
  }

  if (pending.length) {
    log("info", `Gemini cache ${cacheNamespace}: ${results.length} reutilizados, ${pending.length} nuevos.`);
    const fresh = await classifier(
      pending.map((entry) => entry.item),
      config,
      log
    );
    for (const result of fresh) {
      const source = pending.find((entry) => String(entry.item[cacheKey] || entry.item.id) === String(result[cacheKey] || result.id || result.ticketId));
      if (!source) continue;
      cache.entries[source.key] = {
        cachedAt: new Date().toISOString(),
        result
      };
      results.push(result);
    }
    await writeFile(HUBSPOT_GEMINI_CACHE_PATH, JSON.stringify(cache, null, 2), "utf8");
  } else {
    log("info", `Gemini cache ${cacheNamespace}: ${results.length} reutilizados, 0 nuevos.`);
  }

  return results;
}

async function enrichTopCandidateActivity(token, rows) {
  const activityCache = await readJsonSafe(path.join(DATA_DIR, "hubspot-activity-cache.json"), { records: {} });
  activityCache.records ||= {};
  const topCandidates = [];
  const seen = new Set();
  for (const row of rows) {
    for (const candidate of (row.candidateOptions || []).filter((item) => item.localScore >= 0.58).slice(0, 2)) {
      const key = `${candidate.type}:${candidate.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      topCandidates.push(candidate);
    }
  }

  await mapConcurrent(topCandidates, 4, async (candidate) => {
    const key = `${candidate.type}:${candidate.id}`;
    const cached = activityCache.records[key];
    if (cached && Date.now() - Date.parse(cached.cachedAt || 0) < 6 * 60 * 60 * 1000) {
      candidate.recentActivity = cached.recentActivity || [];
      return;
    }
    const fromType = candidate.type === "contact" ? "contacts" : "companies";
    const recentActivity = await findRecentActivity(token, fromType, candidate.id);
    candidate.recentActivity = recentActivity;
    activityCache.records[key] = { cachedAt: new Date().toISOString(), recentActivity };
  });

  const byKey = new Map(topCandidates.map((candidate) => [`${candidate.type}:${candidate.id}`, candidate.recentActivity || []]));
  for (const row of rows) {
    for (const candidate of row.candidateOptions || []) {
      const activity = byKey.get(`${candidate.type}:${candidate.id}`);
      if (!activity) continue;
      candidate.recentActivity = activity;
      candidate.text = [candidate.text, activity.join(" | ")].filter(Boolean).join(" | ").slice(0, 1200);
    }
  }

  await writeFile(path.join(DATA_DIR, "hubspot-activity-cache.json"), JSON.stringify(activityCache, null, 2), "utf8");
  console.log(`Actividad reciente HubSpot consultada para ${topCandidates.length} candidatos relevantes.`);
}

async function mapConcurrent(items, concurrency, worker) {
  let cursor = 0;
  let completed = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await worker(items[index], index);
      completed += 1;
      if (completed % 250 === 0) console.log(`Busquedas completadas: ${completed}/${items.length}`);
    }
  });
  await Promise.all(workers);
}

function candidateLabel(candidate) {
  if (candidate.type === "contact") {
    return [prop(candidate.record, "firstname"), prop(candidate.record, "lastname")].filter(Boolean).join(" ").trim();
  }
  return prop(candidate.record, "name");
}

const SERVICE_FIELDS = [
  "revenue__plan",
  "servicios_subvencionados",
  "servicio_producido",
  "tipo_de_proyecto",
  "tipo_de_proyecto_a_cancelar",
  "tipo_de_proyecto_por_fuera_de_la_sub",
  "productos_contratados"
];

function buildCandidate(type, record) {
  const propertyNames = type === "contact" ? CONTACT_PROPS : COMPANY_PROPS;
  const text = joinProps(record, propertyNames);
  const serviceText = joinProps(record, SERVICE_FIELDS);
  const label =
    type === "contact"
      ? [prop(record, "firstname"), prop(record, "lastname")].filter(Boolean).join(" ").trim()
      : prop(record, "name");
  return {
    id: record.id,
    type,
    record,
    label,
    text,
    serviceText,
    emails: emailsFrom(text),
    phones: phonesFrom(text),
    labelTokens: tokens(label),
    textTokens: tokens(text)
  };
}

function addToIndex(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function buildIndexes(candidates) {
  const emailIndex = new Map();
  const phoneIndex = new Map();
  const tokenIndex = new Map();
  candidates.forEach((candidate, index) => {
    candidate.emails.forEach((email) => addToIndex(emailIndex, email, index));
    candidate.phones.forEach((phone) => addToIndex(phoneIndex, phone, index));
    unique([...candidate.labelTokens, ...candidate.textTokens]).forEach((token) => {
      if (token.length >= 4) addToIndex(tokenIndex, token, index);
    });
  });
  return { emailIndex, phoneIndex, tokenIndex };
}

function summarizeRecord(type, record) {
  if (!record) return "";
  if (type === "contact") {
    return joinProps(record, CONTACT_PROPS).slice(0, 700);
  }
  if (type === "company") {
    return joinProps(record, COMPANY_PROPS).slice(0, 700);
  }
  if (type === "deal") {
    return joinProps(record, DEAL_PROPS).slice(0, 700);
  }
  return "";
}

async function enrichCandidatesWithRelatedContext(token, candidates) {
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [`${candidate.type}:${candidate.id}`, candidate])).values()];
  if (!uniqueCandidates.length) return;

  const contextCache = await readJsonSafe(HUBSPOT_CONTEXT_CACHE_PATH, { records: {} });
  contextCache.records ||= {};
  const companyIds = new Set();
  const dealIds = new Set();

  await mapConcurrent(uniqueCandidates, 5, async (candidate) => {
    const key = `${candidate.type}:${candidate.id}`;
    const cached = contextCache.records[key];
    if (cached && Date.now() - Date.parse(cached.cachedAt || 0) < 6 * 60 * 60 * 1000) {
      candidate.relatedCompanyIds = cached.companyIds || [];
      candidate.relatedDealIds = cached.dealIds || [];
      candidate.recentActivity = cached.recentActivity || [];
      return;
    }

    const fromType = candidate.type === "contact" ? "contacts" : "companies";
    const [relatedCompanies, relatedDeals] = await Promise.all([
      candidate.type === "contact" ? getAssociations(token, fromType, candidate.id, "companies") : Promise.resolve([]),
      getAssociations(token, fromType, candidate.id, "deals")
    ]);
    candidate.relatedCompanyIds = relatedCompanies;
    candidate.relatedDealIds = relatedDeals;
    candidate.recentActivity = [];
    contextCache.records[key] = {
      cachedAt: new Date().toISOString(),
      companyIds: relatedCompanies,
      dealIds: relatedDeals,
      recentActivity: []
    };
  });

  for (const candidate of uniqueCandidates) {
    (candidate.relatedCompanyIds || []).forEach((id) => companyIds.add(id));
    (candidate.relatedDealIds || []).forEach((id) => dealIds.add(id));
  }

  const [companies, deals] = await Promise.all([
    batchReadObjects(token, "companies", [...companyIds], COMPANY_PROPS),
    batchReadObjects(token, "deals", [...dealIds], DEAL_PROPS)
  ]);
  const companiesById = new Map(companies.map((record) => [String(record.id), record]));
  const dealsById = new Map(deals.map((record) => [String(record.id), record]));

  for (const candidate of uniqueCandidates) {
    const relatedCompanyText = (candidate.relatedCompanyIds || [])
      .map((id) => summarizeRecord("company", companiesById.get(String(id))))
      .filter(Boolean)
      .join(" | ");
    const relatedDealText = (candidate.relatedDealIds || [])
      .map((id) => summarizeRecord("deal", dealsById.get(String(id))))
      .filter(Boolean)
      .join(" | ");
    candidate.relatedContext = [summarizeRecord(candidate.type, candidate.record), relatedCompanyText, relatedDealText]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 1400);
    candidate.text = [candidate.text, candidate.relatedContext, (candidate.recentActivity || []).join(" | ")]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 2200);
    candidate.textTokens = tokens(candidate.text);

    const companyServiceText = (candidate.relatedCompanyIds || [])
      .map((id) => joinProps(companiesById.get(String(id)), SERVICE_FIELDS))
      .filter(Boolean)
      .join(" | ");
    const dealServiceText = (candidate.relatedDealIds || [])
      .map((id) => joinProps(dealsById.get(String(id)), SERVICE_FIELDS))
      .filter(Boolean)
      .join(" | ");
    candidate.serviceText = [candidate.serviceText || "", companyServiceText, dealServiceText]
      .filter(Boolean)
      .join(" | ")
      .slice(0, 600);
  }

  await writeFile(HUBSPOT_CONTEXT_CACHE_PATH, JSON.stringify(contextCache, null, 2), "utf8");
  if (uniqueCandidates.length) console.log(`Contexto extra HubSpot: ${uniqueCandidates.length} candidatos; actividad se consulta solo para top matches.`);
}

function overlapScore(leftTokens, rightTokens) {
  if (!leftTokens.length || !rightTokens.length) return 0;
  const rightSet = new Set(rightTokens);
  const overlap = leftTokens.filter((token) => rightSet.has(token)).length;
  const minLen = Math.min(leftTokens.length, rightTokens.length);
  if (minLen <= 1) {
    return overlap && leftTokens.some((token) => token.length >= 6 && rightSet.has(token)) ? 0.62 : 0;
  }
  return overlap / minLen;
}

function scoreCandidate(ticket, candidate) {
  const emailHit = ticket.emails.find((email) => candidate.emails.includes(email));
  if (emailHit) return { score: 1, reason: `email exacto: ${emailHit}` };

  const phoneHit = ticket.phones.find((phone) => candidate.phones.includes(phone));
  if (phoneHit) return { score: 0.96, reason: "telefono exacto" };

  const nameScores = ticket.nameHintsTokens.map((hintTokens) => overlapScore(hintTokens, candidate.labelTokens));
  const bestNameScore = Math.max(0, ...nameScores);
  if (bestNameScore >= 1) return { score: 0.9, reason: `nombre muy similar: ${candidate.label}` };
  if (bestNameScore >= 0.67) return { score: 0.78, reason: `nombre parcialmente similar: ${candidate.label}` };
  if (bestNameScore >= 0.62) return { score: 0.62, reason: `posible token distintivo: ${candidate.label}` };

  const serviceScore = overlapScore(ticket.searchTokens, candidate.textTokens);
  if (serviceScore >= 0.55) return { score: 0.72, reason: "coincidencia por texto/servicio" };
  if (serviceScore >= 0.35) return { score: 0.58, reason: "posible coincidencia debil por texto" };

  return { score: 0, reason: "" };
}

function matchStatus(score) {
  if (score >= 0.72) return "coincide";
  if (score >= 0.58) return "posible";
  return "no_coincide";
}

function reviewNameFromSubject(value) {
  return String(value || "").replace(/^\s*rese[nñ]a\s*-\s*/i, "").trim();
}

function reviewText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function scoreReviewMatch(ticketName, review) {
  if (normalize(ticketName) === normalize(review.author)) return 1;

  const subjectTokens = tokens(ticketName);
  const authorTokens = tokens(review.author);
  if (!subjectTokens.length || !authorTokens.length) return 0;

  const overlap = overlapScore(subjectTokens, authorTokens);
  if (overlap >= 1) return 0.92;
  if (overlap >= 0.67) return 0.76;
  if (authorTokens.length === 1 && subjectTokens.includes(authorTokens[0]) && authorTokens[0].length >= 5) return 0.62;
  return 0;
}

function findLocalReview(ticket, corpus) {
  const name = reviewNameFromSubject(prop(ticket, "subject"));
  const scored = corpus
    .map((review) => ({ review, score: scoreReviewMatch(name, review) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return Number(a.review.rating || 0) - Number(b.review.rating || 0);
    });
  return scored[0] || null;
}

function classifyHubspotReview(ticket, localReviewMatch) {
  const rating = Number(prop(ticket, "calificacion_resena") || localReviewMatch?.review?.rating || 0) || null;
  const reasonField = firstNonEmpty([prop(ticket, "motivo_de_la_resena_negativa"), prop(ticket, "submotivo_resena")]);
  const localText = reviewText(localReviewMatch?.review?.text);
  const localSentiment = localReviewMatch?.review?.sentiment;

  if (rating >= 4) {
    return {
      sentiment: "positive",
      rating,
      confidence: 0.94,
      reason: `Clasificada por ${rating} estrellas desde la reseña enlazada.`,
      text: localText,
      matchedAuthor: localReviewMatch?.review?.author || "",
      matchedReviewId: localReviewMatch?.review?.id || ""
    };
  }

  if (rating && rating <= 3) {
    return {
      sentiment: "negative",
      rating,
      confidence: 0.94,
      reason: `Clasificada por ${rating} estrellas desde la reseña enlazada.`,
      text: localText,
      matchedAuthor: localReviewMatch?.review?.author || "",
      matchedReviewId: localReviewMatch?.review?.id || ""
    };
  }

  if (localSentiment) {
    return {
      sentiment: localSentiment === "negative" ? "negative" : "positive",
      rating,
      confidence: 0.78,
      reason: "Clasificada por coincidencia con el histórico local de reseñas.",
      text: localText,
      matchedAuthor: localReviewMatch?.review?.author || "",
      matchedReviewId: localReviewMatch?.review?.id || ""
    };
  }

  if (reasonField) {
    return {
      sentiment: "negative",
      rating,
      confidence: 0.72,
      reason: `No se pudo leer estrellas del enlace; motivo negativo registrado: ${reasonField}.`,
      text: "",
      matchedAuthor: "",
      matchedReviewId: ""
    };
  }

  return {
    sentiment: "negative",
    rating,
    confidence: 0.5,
    reason: "Sin estrellas ni texto disponible para el enlace; revisar manualmente. Se marca negativa de baja confianza por estar en Vista Reseñas / INBOX.",
    text: "",
    matchedAuthor: "",
    matchedReviewId: ""
  };
}

function includesAny(text, terms) {
  const normalized = normalize(text);
  return terms.some((term) => normalized.includes(term));
}

function matchTerms(text, terms) {
  const normalized = ` ${normalize(text)} `;
  return terms.filter((term) => {
    const clean = normalize(term);
    if (!clean) return false;
    if (clean.length <= 3) {
      const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|\\s)${escaped}(\\s|$)`).test(normalized);
    }
    return normalized.includes(` ${clean} `) || normalized.includes(clean);
  });
}

function serviceEvidenceSources(ticket, info, reviewClassification, hubspotMatch) {
  return [
    { field: "ticket.subject", value: prop(ticket, "subject") },
    { field: "ticket.content", value: prop(ticket, "content") },
    { field: "ticket.description", value: prop(ticket, "description") },
    { field: "ticket.revenue__plan", value: prop(ticket, "revenue__plan") },
    { field: "ticket.servicios_subvencionados", value: prop(ticket, "servicios_subvencionados") },
    { field: "ticket.servicio_producido", value: prop(ticket, "servicio_producido") },
    { field: "ticket.tipo_de_proyecto_a_cancelar", value: prop(ticket, "tipo_de_proyecto_a_cancelar") },
    { field: "ticket.tipo_de_proyecto_por_fuera_de_la_sub", value: prop(ticket, "tipo_de_proyecto_por_fuera_de_la_sub") },
    { field: "review.text", value: reviewClassification.text },
    { field: "hubspot.service_fields", value: hubspotMatch?.serviceText || "" }
  ].filter((source) => String(source.value || "").trim());
}

function inferProjectType(ticket, info, reviewClassification) {
  const text = [
    prop(ticket, "subject"),
    prop(ticket, "content"),
    prop(ticket, "tipo_de_ticket"),
    prop(ticket, "revenue__plan"),
    prop(ticket, "servicios_subvencionados"),
    prop(ticket, "servicio_producido"),
    prop(ticket, "comentarios_adicionales_o_solicitudes_del_cliente"),
    prop(ticket, "productos___servicios_a_destacar"),
    prop(ticket, "categoria_ticket_helpdesk"),
    prop(ticket, "tipo_de_proyecto_a_cancelar"),
    prop(ticket, "tipo_de_proyecto_por_fuera_de_la_sub"),
    info.searchText,
    reviewClassification.text,
    reviewClassification.reason
  ].join(" | ");

  const pcTerms = matchTerms(text, [
    "kd pc",
    "pc",
    "ordenador",
    "portatil",
    "entrega",
    "stock",
    "antivirus profesional",
    "garantia pc",
    "puesto de trabajo",
    "dispositivo",
    "equipo",
    "laptop"
  ]);
  const marketingTerms = matchTerms(text, [
    "kd marketing",
    "marketing",
    "redes",
    "rrss",
    "social",
    "web",
    "seo",
    "ecommerce",
    "ecom",
    "ficha google",
    "google maps",
    "contenido",
    "dominio",
    "hosting",
    "pagina",
    "pagina web",
    "landing",
    "campana",
    "publicacion"
  ]);

  if (pcTerms.length > marketingTerms.length) {
    return {
      type: "KD PC",
      reason: `Se detectaron senales de PC: ${pcTerms.slice(0, 4).join(", ")}.`
    };
  }

  if (marketingTerms.length) {
    return {
      type: "KD MARKETING",
      reason: `Se detectaron senales de marketing: ${marketingTerms.slice(0, 4).join(", ")}.`
    };
  }

  return {
    type: "KD MARKETING",
    reason: "Sin senales de PC; asignado a KD MARKETING por defecto para no dejar reseñas sin clasificar."
  };
}

function inferProjectTypeConservative(ticket, info, reviewClassification) {
  const sources = serviceEvidenceSources(ticket, info, reviewClassification, info.hubspotMatch);
  const pcTerms = [
    "kd pc",
    "pc",
    "ordenador",
    "portatil",
    "portátil",
    "entrega",
    "stock",
    "antivirus profesional",
    "garantia pc",
    "garantía pc",
    "puesto de trabajo",
    "dispositivo",
    "equipo",
    "laptop",
    "informatica",
    "informática",
    "mantenimiento pc",
    "soporte tecnico",
    "soporte técnico",
    "hardware"
  ];
  const marketingTerms = [
    "kd marketing",
    "marketing",
    "campana",
    "campaña",
    "campanas",
    "campañas",
    "publicidad",
    "leads",
    "lead",
    "redes",
    "rrss",
    "social",
    "web",
    "seo",
    "sem",
    "ecommerce",
    "ecom",
    "ficha google",
    "google maps",
    "google ads",
    "meta ads",
    "contenido",
    "dominio",
    "hosting",
    "pagina",
    "página",
    "pagina web",
    "página web",
    "landing",
    "publicacion",
    "publicación",
    "captacion",
    "captación"
  ];

  const pcEvidence = [];
  const marketingEvidence = [];
  for (const source of sources) {
    const pcMatches = matchTerms(source.value, pcTerms);
    const marketingMatches = matchTerms(source.value, marketingTerms);
    if (pcMatches.length) pcEvidence.push(`${source.field}: ${pcMatches.slice(0, 4).join(", ")}`);
    if (marketingMatches.length) marketingEvidence.push(`${source.field}: ${marketingMatches.slice(0, 4).join(", ")}`);
  }

  if (pcEvidence.length >= 1 && marketingEvidence.length >= 1) {
    if (pcEvidence.length > marketingEvidence.length) {
      return {
        type: "KD PC",
        reason: `Evidencia dominante de KD PC: ${pcEvidence.slice(0, 3).join(" | ")}.`,
        evidence: pcEvidence
      };
    }
    if (marketingEvidence.length > pcEvidence.length) {
      return {
        type: "KD MARKETING",
        reason: `Evidencia dominante de KD MARKETING: ${marketingEvidence.slice(0, 3).join(" | ")}.`,
        evidence: marketingEvidence
      };
    }
    return {
      type: "KD PC + KD MARKETING",
      reason: `Evidencia de ambos servicios — PC: ${pcEvidence.slice(0, 2).join(" | ")} | MARKETING: ${marketingEvidence.slice(0, 2).join(" | ")}.`,
      evidence: [...pcEvidence, ...marketingEvidence]
    };
  }

  if (pcEvidence.length && pcEvidence.length > marketingEvidence.length) {
    return {
      type: "KD PC",
      reason: `Se detecto evidencia explicita de KD PC: ${pcEvidence.slice(0, 3).join(" | ")}.`,
      evidence: pcEvidence
    };
  }

  if (marketingEvidence.length && marketingEvidence.length >= pcEvidence.length) {
    return {
      type: "KD MARKETING",
      reason: `Se detecto evidencia explicita de KD MARKETING: ${marketingEvidence.slice(0, 3).join(" | ")}.`,
      evidence: marketingEvidence
    };
  }

  return {
    type: "UNKNOWN",
    reason: "No hay evidencia explicita en la reseña ni en propiedades relacionadas de HubSpot para KD PC o KD MARKETING.",
    evidence: []
  };
}

function detectReviewSource(ticket) {
  const text = [
    prop(ticket, "subject"),
    prop(ticket, "content"),
    prop(ticket, "description"),
    prop(ticket, "source"),
    prop(ticket, "tags"),
    prop(ticket, "hs_ticket_category"),
    prop(ticket, "categoria_del_ticket"),
    prop(ticket, "en_que_plataforma_aparece_la_resena_"),
    prop(ticket, "enlace_resena")
  ].join(" | ");
  const normalized = normalize(text);
  const reviewUrl = String(prop(ticket, "enlace_resena") || "").toLowerCase();

  if (
    reviewUrl.includes("trustpilot") ||
    normalized.includes("trustpilot") ||
    normalized.includes("trust pilot")
  ) {
    return {
      source: "Trustpilot",
      sourceExplanation: "Detectado por URL o propiedad que menciona Trustpilot."
    };
  }

  if (
    reviewUrl.includes("google") ||
    reviewUrl.includes("maps.app.goo.gl") ||
    normalized.includes("google") ||
    normalized.includes("gmb") ||
    normalized.includes("google business") ||
    normalized.includes("google maps")
  ) {
    return {
      source: "GMB",
      sourceExplanation: "Detectado por URL o propiedad que menciona Google/GMB/Google Maps."
    };
  }

  return {
    source: "UNKNOWN",
    sourceExplanation: "No hay senales suficientes para detectar si proviene de GMB o Trustpilot."
  };
}

function isReviewTicket(ticket) {
  const p = ticket.properties || {};
  const text = [
    p.subject,
    p.content,
    p.description,
    p[TARGET_REVIEW_CATEGORY_PROPERTY],
    p.categoria_del_ticket,
    p.en_que_plataforma_aparece_la_resena_,
    p.enlace_resena,
    p.calificacion_resena,
    p.motivo_de_la_resena_negativa,
    p.submotivo_resena
  ].join(" | ");
  const normalized = normalize(text);
  const category = normalize(p[TARGET_REVIEW_CATEGORY_PROPERTY] || p.categoria_del_ticket);
  const configuredCategory = normalize(TARGET_REVIEW_CATEGORY_VALUE);
  if (configuredCategory && !category) {
    return { keep: false, reason: "categoria vacia" };
  }
  const categoryMatches = configuredCategory && category
    ? category === configuredCategory || category.split(/[;,|]/).some((value) => value.trim() === configuredCategory)
    : false;
  if (configuredCategory && !categoryMatches) {
    return { keep: false, reason: "categoria distinta de resena" };
  }
  if (configuredCategory && categoryMatches) return { keep: true, reason: "categoria de reseña" };
  if (/^\s*rese[nñ]a\s*-/i.test(String(p.subject || ""))) return { keep: true, reason: "asunto reseña" };
  if (String(p.enlace_resena || "").trim()) return { keep: true, reason: "enlace reseña" };
  if (String(p.en_que_plataforma_aparece_la_resena_ || "").trim()) return { keep: true, reason: "campo plataforma de reseña" };
  if (normalized.includes("trustpilot") || normalized.includes("google") || normalized.includes("gmb")) {
    return { keep: true, reason: "origen reseña" };
  }
  if (p.calificacion_resena || p.motivo_de_la_resena_negativa || p.submotivo_resena) {
    return { keep: true, reason: "propiedades de reseña" };
  }
  return { keep: false, reason: "no parece reseña segun categoria/asunto/enlace/origen" };
}

function detectService(reviewText, ticket, hubspotMatch) {
  const info = {
    searchText: [
      prop(ticket, "subject"),
      prop(ticket, "content"),
      prop(ticket, "tipo_de_ticket"),
      prop(ticket, "revenue__plan"),
      prop(ticket, "servicios_subvencionados"),
      prop(ticket, "servicio_producido"),
      prop(ticket, "comentarios_adicionales_o_solicitudes_del_cliente"),
      prop(ticket, "productos___servicios_a_destacar"),
      hubspotMatch?.text || "",
      hubspotMatch?.relatedContext || "",
      hubspotMatch?.recentActivity || ""
    ].join(" | "),
    relatedContext: hubspotMatch?.relatedContext || "",
    recentActivity: hubspotMatch?.recentActivity || "",
    hubspotMatch
  };
  const classification = {
    text: reviewText,
    reason: hubspotMatch?.reason || ""
  };
  const project = inferProjectTypeConservative(ticket, info, classification);
  const validTypes = ["KD PC", "KD MARKETING", "KD PC + KD MARKETING"];
  return {
    service: validTypes.includes(project.type) ? project.type : "UNKNOWN",
    serviceExplanation: project.reason,
    serviceEvidence: project.evidence || []
  };
}

function ticketInfo(ticket) {
  const p = ticket.properties || {};
  const reviewSubjectName = reviewNameFromSubject(p.subject);
  const nameHints = unique([
    reviewSubjectName,
    p.a_quien_pertenece_la_resena_,
    p.nombre_del_contacto_principal,
    p.nombre_cliente,
    p.beneficiary_name,
    p.representante_name,
    p.ada_name,
    p.hs_all_associated_contact_firstnames && p.hs_all_associated_contact_lastnames
      ? `${p.hs_all_associated_contact_firstnames} ${p.hs_all_associated_contact_lastnames}`
      : "",
    p.nombre_comercial_de_la_empresa,
    p.subject
  ]);
  const primaryName = firstNonEmpty(nameHints);
  const searchText = joinProps(ticket, TICKET_PROPS);
  return {
    primaryName,
    nameHints,
    nameHintsTokens: nameHints.map(tokens).filter((item) => item.length),
    searchText,
    searchTokens: tokens(searchText),
    emails: emailsFrom(searchText),
    phones: phonesFrom(searchText)
  };
}

function queriesForTicket(info) {
  const emailQueries = info.emails.slice(0, 3);
  const nameQueries = info.nameHints
    .filter((hint) => {
      const hintTokens = tokens(hint);
      return hintTokens.length >= 2 || (hintTokens.length === 1 && hintTokens[0].length >= 6);
    })
    .slice(0, 4);
  return unique([...emailQueries, ...nameQueries]).slice(0, 6);
}

const TICKET_PROPS_CANDIDATES = [
  "hs_object_id",
  "subject",
  "content",
  "description",
  "createdate",
  "hs_lastmodifieddate",
  "hs_pipeline",
  "hs_pipeline_stage",
  "source",
  "tags",
  "categoria_del_ticket",
  "a_quien_pertenece_la_resena_",
  "calificacion_resena",
  "en_que_plataforma_aparece_la_resena_",
  "enlace_resena",
  "fecha_resena",
  "nombre_cliente",
  "nombre_comercial_de_la_empresa",
  "nombre_del_contacto_principal",
  "beneficiary_name",
  "representante_name",
  "ada_name",
  "email_contacto",
  "email_1",
  "email_2",
  "email_3",
  "hs_all_associated_contact_emails",
  "hs_all_associated_contact_firstnames",
  "hs_all_associated_contact_lastnames",
  "hs_all_associated_contact_phones",
  "hs_all_associated_contact_mobilephones",
  "tipo_cliente",
  "tipo_de_ticket",
  "asunto_del_ticket",
  "revenue__plan",
  "servicios_subvencionados",
  "servicio_producido",
  "link_drive_servicio",
  "comentarios_adicionales_o_solicitudes_del_cliente",
  "productos___servicios_a_destacar",
  "web_cliente",
  "cif_cliente"
];

const CONTACT_PROPS_CANDIDATES = [
  "hs_object_id",
  "firstname",
  "lastname",
  "email",
  "phone",
  "mobilephone",
  "company",
  "revenue__plan",
  "servicios_subvencionados",
  "servicio_producido",
  "tipo_de_proyecto",
  "productos_contratados",
  "createdate",
  "lifecyclestage"
];

const COMPANY_PROPS_CANDIDATES = [
  "hs_object_id",
  "name",
  "domain",
  "phone",
  "createdate",
  "lifecyclestage",
  "industry",
  "revenue__plan",
  "servicios_subvencionados",
  "servicio_producido",
  "tipo_de_proyecto",
  "productos_contratados",
  "description",
  "city"
];

const DEAL_PROPS_CANDIDATES = [
  "hs_object_id",
  "dealname",
  "dealstage",
  "pipeline",
  "amount",
  "closedate",
  "createdate",
  "servicios_subvencionados",
  "servicio_producido",
  "revenue__plan",
  "tipo_de_ticket",
  "tipo_de_proyecto",
  "productos_contratados",
  "description"
];

let TICKET_PROPS = [];
let CONTACT_PROPS = [];
let COMPANY_PROPS = [];
let DEAL_PROPS = [];

function buildHubspotCandidateUrl(candidate, portalId) {
  if (!portalId) return null;
  if (candidate.type === "contact") return `https://app-eu1.hubspot.com/contacts/${portalId}/contact/${candidate.id}`;
  if (candidate.type === "company") return `https://app-eu1.hubspot.com/contacts/${portalId}/company/${candidate.id}`;
  return null;
}

function deriveMatchReasonCategorical(scored) {
  if (!scored.length) return "insufficient_data";
  const topReason = scored[0]?.reason || "";
  if (topReason.includes("email exacto")) return "email_exact_match";
  if (topReason.includes("telefono exacto")) return "phone_exact_match";
  if (topReason.includes("nombre muy similar")) return "single_name_match";
  if (topReason.includes("texto") || topReason.includes("servicio")) return "activity_match";
  return "insufficient_data";
}

function buildEvidenceArray(info, scored, ticket) {
  const ev = [];
  if (info.emails.length) {
    ev.push({ type: "email", field: "ticket.emails", value: info.emails.join(", "), weight: "high" });
  }
  if (info.phones.length) {
    ev.push({ type: "phone", field: "ticket.phones", value: info.phones.join(", "), weight: "high" });
  }
  if (info.primaryName) {
    ev.push({ type: "name", field: "ticket.primaryName", value: info.primaryName, weight: "medium" });
  }
  const reviewLink = prop(ticket, "enlace_resena");
  if (reviewLink) {
    ev.push({ type: "ticket", field: "ticket.enlace_resena", value: String(reviewLink).slice(0, 100), weight: "medium" });
  }
  const top = scored[0]?.candidate;
  if (top?.recentActivity?.length) {
    ev.push({ type: "activity", field: `${top.type}:${top.id}/recentActivity`, value: top.recentActivity.slice(0, 2).join(" | ").slice(0, 200), weight: "medium" });
  }
  if (top?.serviceText) {
    ev.push({ type: "contracted_products", field: `${top.type}:${top.id}/serviceFields`, value: top.serviceText.slice(0, 200), weight: "medium" });
  }
  return ev;
}

function buildPossibleMatchesArray(scored, portalId) {
  return scored
    .filter((item) => item.score >= 0.45)
    .slice(0, 5)
    .map((item) => ({
      contactId: item.candidate.type === "contact" ? item.candidate.id : null,
      companyId: item.candidate.type === "company" ? item.candidate.id : (item.candidate.relatedCompanyIds?.[0] || null),
      clientName: candidateLabel(item.candidate),
      hubspotUrl: buildHubspotCandidateUrl(item.candidate, portalId),
      confidence: item.score >= 0.82 ? "high" : item.score >= 0.58 ? "medium" : "low",
      score: Number(item.score.toFixed(2)),
      explanation: item.reason || ""
    }));
}

function classifyInfoRequest(row, formSummary) {
  if (row.reviewSentiment !== "negative") return null;
  const ms = row.matchStatus;
  if (ms === "matched" && row.matchConfidence === "high") return null;
  const needsInfo = ms === "not_matched" || ms === "unidentifiable" ||
    ms === "multiple_possible_matches" ||
    (ms === "possible_match" && row.matchConfidence === "low");
  if (!needsInfo) return null;
  const reason = ms === "not_matched" || ms === "unidentifiable"
    ? "negative_review_unidentified"
    : ms === "multiple_possible_matches"
      ? "negative_review_ambiguous_match"
      : "insufficient_customer_data";
  return {
    requiresInfoRequest: true,
    infoRequestReason: reason,
    suggestedMessage: "Te enviamos este formulario. Por favor respóndelo para que podamos conocer más sobre ti y ayudarte mejor.",
    formConfigured: Boolean(formSummary?.found),
    formId: formSummary?.configuredFormId || null
  };
}

function getReviewInfoFormConfig(formSummary) {
  return {
    formId: formSummary?.configuredFormId || null,
    formUrl: null,
    fields: formSummary?.fields || [],
    relevantFields: formSummary?.relevantFields || [],
    isConfigured: Boolean(formSummary?.found),
    message: formSummary?.message || "Formulario de reseñas no configurado. Configura HUBSPOT_REVIEW_FORM_ID en .env."
  };
}

async function main() {
  const envFile = await readFile(path.join(ROOT, ".env"), "utf8").catch(() => "");
  const env = { ...process.env, ...parseEnv(envFile) };
  PORTAL_ID = env.HUBSPOT_PORTAL_ID || env.PORTAL_ID || DEFAULT_PORTAL_ID;
  TARGET_VIEW_ID = env.HUBSPOT_REVIEW_VIEW_ID || TARGET_VIEW_ID;
  TARGET_VIEW_URL = `https://app-eu1.hubspot.com/contacts/${PORTAL_ID}/objects/0-5/views/${TARGET_VIEW_ID}/board`;
  TARGET_PIPELINE_LABEL = normalize(env.HUBSPOT_REVIEW_PIPELINE_LABEL || TARGET_PIPELINE_LABEL);
  TARGET_STAGE_LABEL = normalize(env.HUBSPOT_REVIEW_STAGE_LABEL || TARGET_STAGE_LABEL);
  TARGET_STAGE_ID = env.HUBSPOT_REVIEW_STAGE_ID || TARGET_STAGE_ID;
  TARGET_STAGE_IDS = unique(
    String(env.HUBSPOT_REVIEW_STAGE_IDS || TARGET_STAGE_IDS.join(","))
      .split(/[,\s;]+/)
      .map((item) => item.trim())
      .filter(Boolean)
  );
  TARGET_REVIEW_CATEGORY_PROPERTY = env.HUBSPOT_REVIEW_CATEGORY_PROPERTY || TARGET_REVIEW_CATEGORY_PROPERTY;
  TARGET_REVIEW_CATEGORY_VALUE = env.HUBSPOT_REVIEW_CATEGORY_VALUE || TARGET_REVIEW_CATEGORY_VALUE;
  HUBSPOT_REVIEW_FORM_ID = env.HUBSPOT_REVIEW_FORM_ID || "";
  const token = env.HUBSPOT_ACCESS_TOKEN;
  if (!token) throw new Error("Falta HUBSPOT_ACCESS_TOKEN en .env");
  const aiConfig = {
    geminiApiKey: env.GEMINI_API_KEY || "",
    geminiModel: env.GEMINI_MODEL || "gemini-2.5-flash",
    allowLocalClassifier: env.ALLOW_LOCAL_CLASSIFIER !== "0"
  };

  await mkdir(DATA_DIR, { recursive: true });

  const [ticketPropertyNames, contactPropertyNames, companyPropertyNames, dealPropertyNames, stages] = await Promise.all([
    getPropertyNames(token, "tickets"),
    getPropertyNames(token, "contacts"),
    getPropertyNames(token, "companies"),
    getPropertyNames(token, "deals"),
    getTargetStages(token)
  ]);

  TICKET_PROPS = TICKET_PROPS_CANDIDATES.filter((name) => ticketPropertyNames.has(name));
  CONTACT_PROPS = CONTACT_PROPS_CANDIDATES.filter((name) => contactPropertyNames.has(name));
  COMPANY_PROPS = COMPANY_PROPS_CANDIDATES.filter((name) => companyPropertyNames.has(name));
  DEAL_PROPS = DEAL_PROPS_CANDIDATES.filter((name) => dealPropertyNames.has(name));
  const formSummary = await inspectReviewForm(token);

  console.log(`Etapas objetivo CUSTOMER SUCCESS / INBOX encontradas: ${stages.length}`);
  if (!stages.length) {
    throw new Error("No encontre la etapa INBOX dentro del pipeline CUSTOMER SUCCESS en HubSpot.");
  }

  const ticketGroups = [];
  for (const stage of stages) {
    const tickets = await getTicketsForStage(token, stage, TICKET_PROPS);
    console.log(`${stage.pipelineLabel} / ${stage.stageLabel}: ${tickets.length}`);
    ticketGroups.push(...tickets);
  }

  const seenTickets = new Map();
  for (const ticket of ticketGroups) seenTickets.set(ticket.id, ticket);
  const inboxTickets = [...seenTickets.values()];
  const ticketFilterStats = { processed: 0, discarded: 0, reasons: {} };
  const tickets = inboxTickets.filter((ticket) => {
    const decision = isReviewTicket(ticket);
    const key = decision.reason;
    ticketFilterStats.reasons[key] = (ticketFilterStats.reasons[key] || 0) + 1;
    if (decision.keep) {
      ticketFilterStats.processed += 1;
      return true;
    }
    ticketFilterStats.discarded += 1;
    return false;
  });
  const stageLabelSummary = stages.map((stage) => stage.stageLabel).join(", ");
  console.log(`Tickets recuperados desde HubSpot CUSTOMER SUCCESS / ${stageLabelSummary}: ${inboxTickets.length}`);
  console.log(`Tickets procesados como reseña: ${ticketFilterStats.processed}`);
  console.log(`Tickets descartados: ${ticketFilterStats.discarded}`);
  Object.entries(ticketFilterStats.reasons).forEach(([reason, count]) => console.log(`Filtro reseñas - ${reason}: ${count}`));

  const localReviewReport = await readJsonSafe(LAST_ANALYSIS_PATH, { items: [] });
  const localReviewCorpus = Array.isArray(localReviewReport?.items) ? localReviewReport.items : [];
  console.log(`Historico local de resenas disponible: ${localReviewCorpus.length}`);

  const ticketsById = new Map(tickets.map((ticket) => [String(ticket.id), ticket]));
  const ticketInfos = new Map(tickets.map((ticket) => [ticket.id, ticketInfo(ticket)]));
  const queryTasks = [];
  const seenTasks = new Set();
  for (const info of ticketInfos.values()) {
    for (const query of queriesForTicket(info)) {
      for (const objectType of ["contacts", "companies"]) {
        const key = `${objectType}:${normalize(query)}`;
        if (seenTasks.has(key)) continue;
        seenTasks.add(key);
        queryTasks.push({ key, objectType, query });
      }
    }
  }

  console.log(`Busquedas dirigidas a HubSpot: ${queryTasks.length}`);
  const candidateCache = new Map();
  await mapConcurrent(queryTasks, 4, async (task) => {
    const props = task.objectType === "contacts" ? CONTACT_PROPS : COMPANY_PROPS;
    const type = task.objectType === "contacts" ? "contact" : "company";
    const records = await searchCandidates(token, task.objectType, task.query, props);
    candidateCache.set(
      task.key,
      records.map((record) => buildCandidate(type, record)).filter((candidate) => candidate.label || candidate.emails.length || candidate.phones.length)
    );
    await sleep(80);
  });
  const allCandidates = [...candidateCache.values()].flat();
  console.log(`Candidatos HubSpot unicos antes de contexto extra: ${new Set(allCandidates.map((item) => `${item.type}:${item.id}`)).size}`);
  await enrichCandidatesWithRelatedContext(token, allCandidates);

  const rows = tickets.map((ticket) => {
    const info = ticketInfos.get(ticket.id);
    const poolById = new Map();
    for (const query of queriesForTicket(info)) {
      for (const objectType of ["contacts", "companies"]) {
        const key = `${objectType}:${normalize(query)}`;
        for (const candidate of candidateCache.get(key) || []) {
          poolById.set(`${candidate.type}:${candidate.id}`, candidate);
        }
      }
    }
    const pool = [...poolById.values()];
    const scoredAll = pool
      .map((candidate) => {
        const score = scoreCandidate(info, candidate);
        return { candidate, ...score };
      })
      .sort((a, b) => b.score - a.score);
    const scored = scoredAll.filter((item) => item.score > 0);

    const best = scored[0];
    const strongCandidates = scored.filter((item) => item.score >= 0.58);
    const isMultipleLocal = strongCandidates.length >= 2 &&
      (strongCandidates[0].score - (strongCandidates[1]?.score || 0)) < 0.2;
    const localStatus = isMultipleLocal
      ? "multiple"
      : best ? matchStatus(best.score) : "no_coincide";
    const localMatchStatusNorm = isMultipleLocal
      ? "multiple_possible_matches"
      : localStatus === "coincide" ? "matched"
        : localStatus === "posible" ? "possible_match"
          : "not_matched";
    const localReviewMatch = findLocalReview(ticket, localReviewCorpus);
    const reviewClassification = classifyHubspotReview(ticket, localReviewMatch);
    const reviewUrl = prop(ticket, "enlace_resena");
    const sourceDetection = detectReviewSource(ticket);
    const serviceDetection = detectService(reviewClassification.text, ticket, best?.candidate);
    const evidenceArray = buildEvidenceArray(ticketInfos.get(ticket.id), scored, ticket);
    const possibleMatchesArr = buildPossibleMatchesArray(scored, PORTAL_ID);
    if (info.emails.length) console.log(`[match] Ticket ${ticket.id}: email detectado ${info.emails[0]} — búsqueda por email prioritaria.`);
    if (isMultipleLocal) console.log(`[match] Ticket ${ticket.id}: múltiples candidatos fuertes (${strongCandidates.length}), sin forzar asociación.`);
    return {
      ticketId: ticket.id,
      ticketUrl: `https://app-eu1.hubspot.com/contacts/${PORTAL_ID}/ticket/${ticket.id}`,
      reviewUrl,
      reviewId: reviewUrl || reviewClassification.matchedReviewId || ticket.id,
      source: sourceDetection.source,
      sourceExplanation: sourceDetection.sourceExplanation,
      pipeline: ticket.stage.pipelineLabel,
      stage: ticket.stage.stageLabel,
      ticketCategory: prop(ticket, TARGET_REVIEW_CATEGORY_PROPERTY) || prop(ticket, "categoria_del_ticket"),
      createdate: prop(ticket, "createdate"),
      ticketName: prop(ticket, "subject"),
      referenceName: info.primaryName,
      reviewAuthor: reviewClassification.matchedAuthor || info.primaryName,
      reviewRating: reviewClassification.rating,
      reviewText: reviewClassification.text,
      reviewSentiment: reviewClassification.sentiment,
      reviewConfidence: Number(reviewClassification.confidence.toFixed(2)),
      reviewReason: reviewClassification.reason,
      matchedReviewId: reviewClassification.matchedReviewId,
      projectType: serviceDetection.service,
      projectReason: serviceDetection.serviceExplanation,
      service: serviceDetection.service,
      serviceExplanation: serviceDetection.serviceExplanation,
      serviceEvidence: serviceDetection.serviceEvidence,
      ticketEmails: info.emails.join("; "),
      status: localStatus,
      matchStatus: localMatchStatusNorm,
      matchConfidence: best ? (best.score >= 0.82 ? "high" : best.score >= 0.58 ? "medium" : "low") : "low",
      score: best ? Number(best.score.toFixed(2)) : 0,
      matchType: isMultipleLocal ? "" : (best?.candidate?.type || ""),
      matchId: isMultipleLocal ? "" : (best?.candidate?.id || ""),
      contactId: isMultipleLocal ? null : (best?.candidate?.type === "contact" ? best.candidate.id : null),
      companyId: isMultipleLocal ? null : (
        best?.candidate?.type === "company"
          ? best.candidate.id
          : best?.candidate?.relatedCompanyIds?.[0] || null),
      dealIds: isMultipleLocal ? [] : (best?.candidate?.relatedDealIds || []),
      dealId: isMultipleLocal ? null : (best?.candidate?.relatedDealIds?.[0] || null),
      clientName: isMultipleLocal ? null : (best ? candidateLabel(best.candidate) : null),
      matchName: isMultipleLocal ? "" : (best ? candidateLabel(best.candidate) : ""),
      matchEmailOrDomain: isMultipleLocal ? "" : (best
        ? best.candidate.type === "contact"
          ? prop(best.candidate.record, "email")
          : prop(best.candidate.record, "domain")
        : ""),
      matchReason: deriveMatchReasonCategorical(scored),
      matchExplanation: best?.reason || "",
      evidence: evidenceArray,
      requiresInfoRequest: null,
      associationStatus: "pending",
      candidateOptions: scoredAll
        .slice(0, 8)
        .map((item) => ({
          type: item.candidate.type,
          id: item.candidate.id,
          name: candidateLabel(item.candidate),
          emailOrDomain:
            item.candidate.type === "contact" ? prop(item.candidate.record, "email") : prop(item.candidate.record, "domain"),
          phone: item.candidate.phones[0] || "",
          localScore: Number(item.score.toFixed(2)),
          localReason: item.reason || "",
          relatedCompanyIds: item.candidate.relatedCompanyIds || [],
          relatedDealIds: item.candidate.relatedDealIds || [],
          recentActivity: item.candidate.recentActivity || [],
          relatedContext: item.candidate.relatedContext || "",
          serviceText: item.candidate.serviceText || "",
          text: item.candidate.text.slice(0, 900)
        }))
        .filter((candidate) => candidate.name || candidate.emailOrDomain || candidate.phone),
      possibleMatches: possibleMatchesArr,
      possibleMatchesSummary: scored
        .slice(0, 3)
        .map((item) => `${item.candidate.type}:${candidateLabel(item.candidate)} (${item.score.toFixed(2)})`)
        .join(" | ")
    };
  });
  await enrichTopCandidateActivity(token, rows);

  const reviewClassificationInput = rows.map((row) => ({
      id: row.ticketId,
      title: row.ticketName,
      author: row.reviewAuthor || row.referenceName,
      rating: row.reviewRating,
      text: row.reviewText,
      reason: row.reviewReason,
      sourceUrl: row.reviewUrl
    }));
  const geminiClassifications = await classifyWithCache(
    "id",
    reviewClassificationInput,
    "review",
    classifyHubspotReviews,
    aiConfig,
    (level, message) => console.log(`${level.toUpperCase()}: ${message}`)
  );
  const geminiById = new Map(geminiClassifications.map((item) => [String(item.id), item]));
  rows.forEach((row) => {
    const classification = geminiById.get(String(row.ticketId));
    if (!classification) return;
    row.reviewSentiment = classification.sentiment;
    row.reviewConfidence = Number(classification.confidence.toFixed(2));
    row.reviewReason = classification.reason || row.reviewReason;
    row.reviewRating = classification.rating || row.reviewRating;
    row.reviewText = classification.extractedText || row.reviewText;
    row.aiProvider = classification.provider || (aiConfig.geminiApiKey ? "gemini" : "local-fallback");
    row.aiModel = classification.model || (aiConfig.geminiApiKey ? aiConfig.geminiModel : "local-fallback");
    const candidateContext = row.candidateOptions?.[0] || {};
    const updatedService = detectService(row.reviewText, ticketsById.get(String(row.ticketId)) || { properties: { subject: row.ticketName } }, {
      serviceText: candidateContext.serviceText || "",
      reason: row.matchReason || ""
    });
    row.projectType = updatedService.service;
    row.projectReason = updatedService.serviceExplanation;
    row.service = updatedService.service;
    row.serviceExplanation = updatedService.serviceExplanation;
    row.serviceEvidence = updatedService.serviceEvidence;
  });

  const matchClassificationInput = rows.map((row) => ({
      ticketId: row.ticketId,
      ticketName: row.ticketName,
      reviewAuthor: row.reviewAuthor || row.referenceName,
      reviewRating: row.reviewRating,
      reviewText: row.reviewText,
      reviewReason: row.reviewReason,
      reviewUrl: row.reviewUrl,
      projectType: row.projectType,
      projectReason: row.projectReason,
      serviceEvidence: row.serviceEvidence,
      ticketEmails: row.ticketEmails,
      localMatchStatus: row.status,
      localMatchName: row.matchName,
      localMatchReason: row.matchReason,
      candidates: row.candidateOptions
    }));
  const geminiMatches = await classifyWithCache(
    "ticketId",
    matchClassificationInput,
    "match",
    classifyHubspotClientMatches,
    aiConfig,
    (level, message) => console.log(`${level.toUpperCase()}: ${message}`)
  );
  const geminiMatchById = new Map(geminiMatches.map((item) => [String(item.ticketId), item]));
  rows.forEach((row) => {
    const match = geminiMatchById.get(String(row.ticketId));
    if (!match) return;
    const selectedCandidate = row.candidateOptions.find(
      (candidate) => candidate.type === match.matchType && String(candidate.id) === String(match.matchId)
    );
    row.matchStatus = match.status;
    const statusToLocal = {
      matched: "coincide",
      possible_match: "posible",
      multiple_possible_matches: "multiple",
      unidentifiable: "no_coincide"
    };
    row.status = statusToLocal[match.status] || "no_coincide";
    row.score = Number(match.confidence.toFixed(2));
    row.matchConfidence = match.confidence >= 0.82 ? "high" : match.confidence >= 0.55 ? "medium" : "low";
    const isNoSingleMatch = match.status === "multiple_possible_matches" || match.status === "unidentifiable";
    row.matchType = isNoSingleMatch ? "" : (match.matchType || "");
    row.matchId = isNoSingleMatch ? "" : (match.matchId || "");
    row.contactId = !isNoSingleMatch && match.matchType === "contact" && match.matchId ? match.matchId : null;
    row.companyId = !isNoSingleMatch && match.matchType === "company" && match.matchId
      ? match.matchId
      : selectedCandidate?.relatedCompanyIds?.[0] || (isNoSingleMatch ? null : row.companyId) || null;
    row.dealIds = !isNoSingleMatch ? (selectedCandidate?.relatedDealIds || row.dealIds || []) : [];
    row.dealId = row.dealIds[0] || null;
    row.clientName = isNoSingleMatch ? null : (match.matchName || null);
    row.matchName = isNoSingleMatch ? "" : (match.matchName || "");
    row.matchEmailOrDomain = isNoSingleMatch ? "" : (match.matchEmailOrDomain || "");
    row.matchReason = match.matchReason || row.matchReason;
    row.matchExplanation = match.reason || row.matchExplanation;
    row.matchAiProvider = match.provider;
    row.matchAiModel = match.model;
    row.possibleMatchesSummary = row.candidateOptions
      .slice(0, 3)
      .map((item) => `${item.type}:${item.name || item.emailOrDomain} (${item.localScore.toFixed(2)})`)
      .join(" | ");
    if (isNoSingleMatch) {
      console.log(`[match] Ticket ${row.ticketId}: ${match.status} → no se fuerza asociación. Posibles: ${row.possibleMatchesSummary}`);
    }
  });

  // Calcular requiresInfoRequest tras conocer el sentiment y matchStatus definitivos
  rows.forEach((row) => {
    row.requiresInfoRequest = classifyInfoRequest(row, formSummary);
    if (row.requiresInfoRequest) {
      console.log(`[info] Ticket ${row.ticketId}: reseña negativa no identificada → requiresInfoRequest (${row.requiresInfoRequest.infoRequestReason})`);
    }
  });

  const matched = rows.filter((row) => row.status === "coincide");
  const possible = rows.filter((row) => row.status === "posible" || row.status === "multiple");
  const unmatched = rows.filter((row) => row.status === "no_coincide");
  const positiveReviews = rows.filter((row) => row.reviewSentiment === "positive");
  const negativeReviews = rows.filter((row) => row.reviewSentiment === "negative");
  const kdPcReviews = rows.filter((row) => row.projectType === "KD PC");
  const kdMarketingReviews = rows.filter((row) => row.projectType === "KD MARKETING");
  const unknownServiceReviews = rows.filter((row) => row.projectType === "UNKNOWN");
  const bySource = rows.reduce(
    (acc, row) => {
      const source = row.source === "GMB" || row.source === "Trustpilot" ? row.source : "UNKNOWN";
      acc[source] += 1;
      return acc;
    },
    { GMB: 0, Trustpilot: 0, UNKNOWN: 0 }
  );
  const byPipeline = Object.values(
    rows.reduce((acc, row) => {
      acc[row.pipeline] ||= { pipeline: row.pipeline, total: 0, coincidencias: 0, posibles: 0, sinCoincidencia: 0 };
      acc[row.pipeline].total += 1;
      if (row.status === "coincide") acc[row.pipeline].coincidencias += 1;
      else if (row.status === "posible") acc[row.pipeline].posibles += 1;
      else acc[row.pipeline].sinCoincidencia += 1;
      return acc;
    }, {})
  ).sort((a, b) => b.total - a.total);

  rows.forEach((row) => {
    console.log(
      `Ticket ${row.ticketId}: origen=${row.source}; servicio=${row.projectType}; sentimiento=${row.reviewSentiment}; match=${row.matchStatus}; cliente=${row.clientName || "sin sugerencia"}`
    );
  });

  const report = {
    generatedAt: new Date().toISOString(),
    portalId: PORTAL_ID,
    aiProvider: rows.some((row) => row.aiProvider === "gemini") ? "gemini" : "local-fallback",
    aiModel: rows.find((row) => row.aiProvider === "gemini")?.aiModel || "local-fallback",
    sourceView: {
      id: TARGET_VIEW_ID,
      url: TARGET_VIEW_URL,
      objectType: "0-5",
      boardColumn: stages.map((stage) => stage.stageLabel).join(", "),
      filters: [
        { propertyName: "hs_pipeline", operator: "EQ", value: "CUSTOMER SUCCESS" },
        { propertyName: "hs_pipeline_stage", operator: "IN", value: stages.map((stage) => stage.stageLabel).join(", ") },
        { propertyName: TARGET_REVIEW_CATEGORY_PROPERTY, operator: "EQ", value: TARGET_REVIEW_CATEGORY_VALUE }
      ]
    },
    hubspotForm: formSummary,
    reviewFormConfig: getReviewInfoFormConfig(formSummary),
    ticketRecovery: {
      recoveredFromHubSpot: inboxTickets.length,
      processed: ticketFilterStats.processed,
      discarded: ticketFilterStats.discarded,
      discardReasons: ticketFilterStats.reasons
    },
    scope: `Vista Reseñas ${TARGET_VIEW_ID} - CUSTOMER SUCCESS / ${stageLabelSummary}`,
    totals: {
      totalInboxReviews: rows.length,
      totalInbox: rows.length,
      totalTicketsNuevo: rows.length,
      reviewPositivas: positiveReviews.length,
      reviewNegativas: negativeReviews.length,
      kdPc: kdPcReviews.length,
      kdMarketing: kdMarketingReviews.length,
      proyectoSinIdentificar: unknownServiceReviews.length,
      sourceGmb: bySource.GMB,
      sourceTrustpilot: bySource.Trustpilot,
      sourceUnknown: bySource.UNKNOWN,
      asociacionesConfirmadas: 0,
      asociacionesPendientes: rows.length,
      coincidencias: matched.length,
      posibles: possible.length,
      noCoincidencias: unmatched.length,
      multiplesPosibles: rows.filter((r) => r.matchStatus === "multiple_possible_matches").length,
      noIdentificables: rows.filter((r) => r.matchStatus === "unidentifiable").length,
      requierenInfoAdicional: rows.filter((r) => r.requiresInfoRequest?.requiresInfoRequest).length
    },
    stages,
    byPipeline,
    bySource,
    items: rows,
    positiveReviews,
    negativeReviews,
    kdPcReviews,
    kdMarketingReviews,
    unknownServiceReviews,
    matches: matched,
    possibleMatches: possible,
    unmatched
  };

  const jsonPath = path.join(DATA_DIR, "hubspot-new-ticket-matches.json");
  const csvPath = path.join(DATA_DIR, "hubspot-new-ticket-matches.csv");
  const scopedJsonPath = path.join(DATA_DIR, "hubspot-customer-success-inbox-matches.json");
  const scopedCsvPath = path.join(DATA_DIR, "hubspot-customer-success-inbox-matches.csv");
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(scopedJsonPath, JSON.stringify(report, null, 2), "utf8");
  const headers = [
    "ticketId",
    "pipeline",
    "stage",
    "createdate",
    "ticketName",
    "reviewUrl",
    "source",
    "reviewSentiment",
    "reviewRating",
    "reviewAuthor",
    "reviewReason",
    "reviewText",
    "projectType",
    "projectReason",
    "serviceEvidence",
    "aiProvider",
    "aiModel",
    "referenceName",
    "ticketEmails",
    "matchStatus",
    "matchConfidence",
    "contactId",
    "companyId",
    "dealId",
    "dealIds",
    "clientName",
    "status",
    "score",
    "matchType",
    "matchId",
    "matchName",
    "matchEmailOrDomain",
    "matchReason",
    "ticketUrl",
    "possibleMatches"
  ];
  await writeFile(
    csvPath,
    [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n"),
    "utf8"
  );
  await writeFile(
    scopedCsvPath,
    [headers.join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n"),
    "utf8"
  );

  console.log(JSON.stringify(report.totals, null, 2));
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
  console.log(`JSON especifico: ${scopedJsonPath}`);
  console.log(`CSV especifico: ${scopedCsvPath}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
