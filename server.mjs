import { createServer } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import { loadConfig } from "./src/config.mjs";
import {
  collectReviews,
  fetchZernioPositiveUnrepliedGmbReviews,
  replyToZernioGmbReview,
  resolveZernioGoogleBusinessAccountId
} from "./src/reviewProviders.mjs";
import { classifyReviews } from "./src/geminiClassifier.mjs";
import { buildReport } from "./src/report.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const config = loadConfig(__dirname);
const jobs = new Map();
const lastAnalysisPath = path.join(dataDir, "last-analysis.json");
const lastNewAnalysisPath = path.join(dataDir, "last-new-analysis.json");
const reviewSnapshotPath = path.join(dataDir, "review-snapshot.json");
const hubspotTicketMatchesPath = path.join(dataDir, "hubspot-new-ticket-matches.json");
const confirmedAssociationsPath = path.join(dataDir, "confirmed-review-associations.json");
const gmbReviewRepliesPath = path.join(dataDir, "gmb-review-replies.json");
const gmbPositiveReplyCachePath = path.join(dataDir, "gmb-positive-reply-cache.json");
const sheetAssociationAuditPath = path.join(dataDir, "sheet-hubspot-association-audit.json");
const REVIEW_SHEET_ID = process.env.REVIEW_SHEET_ID || "1zQEeXcSB4DU5fDcZskNUA5N3ndI9wQe70ZQmaQyo-Xw";
const REVIEW_SHEET_GID = process.env.REVIEW_SHEET_GID || "475670343";
let hubspotJob = null;

const HUBSPOT_ASSOCIATION_CONTEXT_PROPS = {
  contacts: [
    "firstname",
    "lastname",
    "email",
    "phone",
    "mobilephone",
    "company"
  ],
  companies: [
    "name",
    "domain",
    "description",
    "revenue__plan",
    "servicios_subvencionados",
    "servicio_producido",
    "tipo_de_proyecto",
    "productos_contratados",
    "industry"
  ],
  deals: [
    "dealname",
    "dealstage",
    "pipeline",
    "description",
    "revenue__plan",
    "servicios_subvencionados",
    "servicio_producido",
    "tipo_de_ticket",
    "tipo_de_proyecto",
    "productos_contratados"
  ]
};

const REVIEW_NEGATIVE_REASON_FIELD = "motivo_de_la_resena_negativa";
const REVIEW_MKT_PROJECT_TYPE_FIELD = "tipo_de_proyecto_a_cancelar";
const REVIEW_REASON_VALUES = {
  mkt: "Tiempo entrega proyecto",
  pc: "Solo ordenador"
};
const MKT_PROJECT_TYPE_VALUES = {
  WEB: "WEB",
  ECOM: "ECOM",
  RRSS: "RRSS",
  SEO: "SEO",
  FACT: "ANLT"
};

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function json(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function createJob(input) {
  const job = {
    id: crypto.randomUUID(),
    input,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: [],
    result: null,
    error: null,
    emitter: new EventEmitter()
  };
  jobs.set(job.id, job);
  return job;
}

function redact(value) {
  if (!value) return value;
  if (typeof value !== "string") return value;
  return String(value)
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "sk-***")
    .replace(/sk_[A-Za-z0-9_-]{12,}/g, "sk_***")
    .replace(/pat-[A-Za-z0-9_-]{12,}/g, "pat-***")
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "AIza***")
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "ya29.***")
    .replace(/api_key=[^&\s]+/gi, "api_key=***");
}

function addLog(job, level, message, meta) {
  const entry = {
    id: `${Date.now()}-${job.logs.length}`,
    time: new Date().toISOString(),
    level,
    message: redact(message),
    meta: meta ? JSON.parse(JSON.stringify(meta, (_, value) => redact(value))) : undefined
  };
  job.logs.push(entry);
  job.updatedAt = entry.time;
  job.emitter.emit("log", entry);
}

function sendSse(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function publicConfig() {
  return {
    geminiConfigured: Boolean(config.geminiApiKey),
    geminiModel: config.geminiModel,
    openaiConfigured: Boolean(config.openaiApiKey),
    openaiModel: config.openaiModel,
    serpapiConfigured: Boolean(config.serpapiApiKey),
    zernioConfigured: Boolean(config.zernioApiKey),
    hubspotConfigured: Boolean(config.hubspotAccessToken),
    hubspotPortalId: config.hubspotPortalId,
    gbpConfigured: Boolean(config.gbpAccessToken && config.gbpAccountId && config.gbpLocationId),
    localClassifierAllowed: config.allowLocalClassifier,
    maxReviewsCap: config.maxReviewsCap
  };
}

async function readJsonSafe(filePath, fallback = null) {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function reviewKey(review) {
  return String(review?.id || "").trim();
}

async function loadKnownReviewIds() {
  const snapshot = await readJsonSafe(reviewSnapshotPath, null);
  if (Array.isArray(snapshot?.ids)) return new Set(snapshot.ids.map(String));

  const lastAnalysis = await readJsonSafe(lastAnalysisPath, null);
  if (Array.isArray(lastAnalysis?.items)) {
    return new Set(lastAnalysis.items.map((item) => String(item.id)).filter(Boolean));
  }

  return new Set();
}

async function saveReviewSnapshot(reviews, meta = {}) {
  await mkdir(dataDir, { recursive: true });
  const ids = [...new Set(reviews.map(reviewKey).filter(Boolean))];
  await writeFile(
    reviewSnapshotPath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        count: ids.length,
        ids,
        meta
      },
      null,
      2
    ),
    "utf8"
  );
}

async function latestReports() {
  return {
    lastAnalysis: await readJsonSafe(lastAnalysisPath, null),
    lastNewAnalysis: await readJsonSafe(lastNewAnalysisPath, null),
    snapshot: await readJsonSafe(reviewSnapshotPath, null)
  };
}

async function loadConfirmedAssociations() {
  const data = await readJsonSafe(confirmedAssociationsPath, { items: [] });
  return Array.isArray(data?.items) ? data.items : [];
}

async function saveConfirmedAssociations(items) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    confirmedAssociationsPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2),
    "utf8"
  );
}

async function loadGmbReviewReplies() {
  const data = await readJsonSafe(gmbReviewRepliesPath, { items: [] });
  const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
  return items.map((item) => {
    if (
      item?.status === "replied" &&
      !item.googlePublished &&
      item.zernioResponse?.reply &&
      item.zernioResponse?.status === "success"
    ) {
      return {
        ...item,
        status: "zernio_acknowledged",
        previousStatus: "replied",
        verificationStatus: "unverified",
        verificationNote: "Zernio devolvio success usando el endpoint de Inbox, pero no se verifico publicacion en Google."
      };
    }
    return item;
  });
}

async function saveGmbReviewReplies(items) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    gmbReviewRepliesPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), items }, null, 2),
    "utf8"
  );
}

async function loadPositiveReplyCache() {
  const data = await readJsonSafe(gmbPositiveReplyCachePath, { entries: {} });
  return data?.entries && typeof data.entries === "object" ? data.entries : {};
}

async function savePositiveReplyCache(entries) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(
    gmbPositiveReplyCachePath,
    JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2),
    "utf8"
  );
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrlForMatch(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    const queryKeys = [...url.searchParams.keys()].filter((key) => /^(utm_|fbclid|gclid)/i.test(key));
    queryKeys.forEach((key) => url.searchParams.delete(key));
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

function normalizedTokenSet(value) {
  return new Set(normalizeText(value).split(" ").filter((token) => token.length > 2));
}

function textSimilarity(left, right) {
  const a = normalizedTokenSet(left);
  const b = normalizedTokenSet(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

function daysBetween(left, right) {
  const a = new Date(left).getTime();
  const b = new Date(right).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.abs(a - b) / 86400000;
}

function uniqueIds(values) {
  return [
    ...new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : String(value || "").split(/[,\s;]+/)))
        .map((value) => String(value || "").trim())
        .filter(Boolean)
    )
  ];
}

async function hubspotRequest(pathname, { method = "GET", body } = {}) {
  if (!config.hubspotAccessToken) {
    throw new Error("Falta HUBSPOT_ACCESS_TOKEN en .env para asociar registros en HubSpot.");
  }

  const response = await fetch(`https://api.hubapi.com${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${config.hubspotAccessToken}`,
      "content-type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = data.message || data.error || `HubSpot HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
}

async function getHubspotAssociatedIds(fromObjectType, fromObjectId, toObjectType) {
  const ids = [];
  let after = "";
  do {
    const query = after ? `?limit=500&after=${encodeURIComponent(after)}` : "?limit=500";
    const data = await hubspotRequest(
      `/crm/v3/objects/${fromObjectType}/${encodeURIComponent(fromObjectId)}/associations/${toObjectType}${query}`
    );
    ids.push(...(data.results || []).map((item) => item.id).filter(Boolean));
    after = data.paging?.next?.after || "";
  } while (after);
  return uniqueIds(ids);
}

async function batchReadHubspotObjects(objectType, ids, properties) {
  const cleanIds = uniqueIds(ids);
  if (!cleanIds.length) return [];
  const data = await hubspotRequest(`/crm/v3/objects/${objectType}/batch/read`, {
    method: "POST",
    body: {
      properties,
      inputs: cleanIds.map((id) => ({ id }))
    }
  });
  return data.results || [];
}

function candidateIds(row, type, clientName, onlyStrong = false) {
  const expectedName = normalizeText(clientName);
  return uniqueIds(
    (row?.candidateOptions || [])
      .filter((candidate) => {
        if (candidate.type !== type) return false;
        if (!onlyStrong) return true;
        const score = Number(candidate.localScore || 0);
        return score >= 0.72 || (expectedName && normalizeText(candidate.name) === expectedName);
      })
      .map((candidate) => candidate.id)
  );
}

function findSelectedCandidate(row, association) {
  const candidates = Array.isArray(row?.candidateOptions) ? row.candidateOptions : [];
  const contactId = String(association.contactId || "");
  const companyId = String(association.companyId || "");
  const clientName = normalizeText(association.clientName);
  return candidates.find((candidate) => {
    if (contactId && candidate.type === "contact" && String(candidate.id) === contactId) return true;
    if (companyId && candidate.type === "company" && String(candidate.id) === companyId) return true;
    if (companyId && (candidate.relatedCompanyIds || []).map(String).includes(companyId)) return true;
    if (clientName && normalizeText(candidate.name) === clientName) return true;
    return false;
  }) || candidates[0] || null;
}

function objectText(record) {
  return Object.values(record?.properties || {})
    .filter((value) => value !== null && value !== undefined)
    .join(" | ");
}

function serviceFlagsFromText(value) {
  const text = normalizeText(value);
  const pcTerms = ["ordenador", "portatil", "laptop", "dispositivo", "hardware", "lenovo", "macbook", "computador", "computer"];
  const mktTerms = ["marketing", "mkt", "web", "pagina", "landing", "wordpress", "ecom", "ecommerce", "tienda", "rrss", "redes", "social", "seo", "posicionamiento", "fact", "factura", "facturacion", "analitica", "google business", "google maps"];
  return {
    pc: pcTerms.some((term) => text.includes(term)) || /\bpc\b/.test(text) || /(entrega|envio) (del )?(pc|ordenador|portatil)/.test(text),
    mkt: mktTerms.some((term) => text.includes(term))
  };
}

function rowServiceFlags(row) {
  const service = normalizeText(row?.service || row?.projectType || "");
  const evidenceText = [
    row?.reviewText,
    row?.reviewReason,
    row?.serviceExplanation,
    ...(Array.isArray(row?.serviceEvidence) ? row.serviceEvidence : []),
    row?.matchExplanation
  ].join(" | ");
  const textFlags = serviceFlagsFromText(evidenceText);
  return {
    pc: service.includes("kd pc") || service.includes("ordenador") || textFlags.pc,
    mkt: service.includes("marketing") || service.includes("mkt") || textFlags.mkt
  };
}

function scoreRelatedRecord(record, row, seedIds) {
  const id = String(record.id || "");
  const seed = seedIds.has(id);
  const rowFlags = rowServiceFlags(row);
  const recordFlags = serviceFlagsFromText(objectText(record));
  let score = seed ? 50 : 0;
  const reasons = [];
  if (seed) reasons.push("viene del candidato/match seleccionado");
  if (rowFlags.pc && recordFlags.pc) {
    score += 30;
    reasons.push("señales de ordenador/KD PC");
  }
  if (rowFlags.mkt && recordFlags.mkt) {
    score += 30;
    reasons.push("señales de proyecto MKT");
  }
  if (!rowFlags.pc && !rowFlags.mkt && seed) reasons.push("servicio no concluyente; se conserva solo el relacionado al candidato");
  return {
    id,
    score,
    include: seed || score >= 30,
    reasons,
    flags: recordFlags
  };
}

async function resolveSingleContactFromCompanies(companyIds, row, association) {
  const contactIds = uniqueIds(
    (
      await Promise.all(companyIds.map((id) => getHubspotAssociatedIds("companies", id, "contacts").catch(() => [])))
    ).flat()
  );
  if (!contactIds.length) return "";
  if (contactIds.length === 1) return contactIds[0];

  const expected = normalizeText(association.clientName || row?.clientName || row?.matchName || row?.referenceName || row?.reviewAuthor);
  if (!expected) return "";
  const contacts = await batchReadHubspotObjects("contacts", contactIds, HUBSPOT_ASSOCIATION_CONTEXT_PROPS.contacts).catch(() => []);
  const matches = contacts.filter((contact) => {
    const p = contact.properties || {};
    const name = normalizeText(`${p.firstname || ""} ${p.lastname || ""}`);
    return name && (name === expected || expected.includes(name) || name.includes(expected));
  });
  return matches.length === 1 ? String(matches[0].id) : "";
}

async function resolveHubspotAssociationTargets(association, row) {
  // Solo asociar al cliente explícitamente confirmado — sin expandir a entidades relacionadas
  const contactId = String(association.contactId || "").trim() || null;
  const companyId = String(association.companyId || "").trim() || null;
  const rawDealIds = uniqueIds([association.dealId, association.dealIds]).slice(0, 3);

  // Si tenemos contacto pero no empresa, intentar obtener su empresa principal (solo 1)
  let resolvedCompanyId = companyId;
  if (contactId && !resolvedCompanyId) {
    const companies = await getHubspotAssociatedIds("contacts", contactId, "companies").catch(() => []);
    if (companies[0]) resolvedCompanyId = String(companies[0]);
  }

  return {
    contactIds: contactId ? [contactId] : [],
    companyIds: resolvedCompanyId ? [resolvedCompanyId] : [],
    dealIds: rawDealIds
  };
}

async function createHubspotTicketAssociation(ticketId, toObjectType, toObjectId) {
  return hubspotRequest(
    `/crm/v4/objects/tickets/${encodeURIComponent(ticketId)}/associations/default/${toObjectType}/${encodeURIComponent(toObjectId)}`,
    { method: "PUT" }
  );
}

async function resolveHubspotAssociationTargetsV2(association, row) {
  const selectedCandidate = findSelectedCandidate(row, association);
  let contactId =
    String(association.contactId || "").trim() ||
    (row?.matchType === "contact" ? String(row.matchId || "").trim() : "") ||
    (selectedCandidate?.type === "contact" ? String(selectedCandidate.id || "").trim() : "");
  const companySeedIds = uniqueIds([
    association.companyId,
    row?.companyId,
    selectedCandidate?.type === "company" ? selectedCandidate.id : "",
    selectedCandidate?.relatedCompanyIds
  ]);
  const dealSeedIds = uniqueIds([association.dealId, association.dealIds, row?.dealId, row?.dealIds, selectedCandidate?.relatedDealIds]);

  if (!contactId && companySeedIds.length) {
    contactId = await resolveSingleContactFromCompanies(companySeedIds, row, association);
  }

  const relatedCompanyIds = contactId
    ? await getHubspotAssociatedIds("contacts", contactId, "companies").catch(() => [])
    : [];
  const relatedDealIdsFromContact = contactId
    ? await getHubspotAssociatedIds("contacts", contactId, "deals").catch(() => [])
    : [];
  const companyIdsForDeals = uniqueIds([...companySeedIds, ...relatedCompanyIds]);
  const relatedDealIdsFromCompanies = (
    await Promise.all(companyIdsForDeals.map((id) => getHubspotAssociatedIds("companies", id, "deals").catch(() => [])))
  ).flat();

  const companyCandidates = uniqueIds([...companySeedIds, ...relatedCompanyIds]);
  const dealCandidates = uniqueIds([...dealSeedIds, ...relatedDealIdsFromContact, ...relatedDealIdsFromCompanies]);
  const companies = await batchReadHubspotObjects("companies", companyCandidates, HUBSPOT_ASSOCIATION_CONTEXT_PROPS.companies).catch(() => []);
  const deals = await batchReadHubspotObjects("deals", dealCandidates, HUBSPOT_ASSOCIATION_CONTEXT_PROPS.deals).catch(() => []);

  const companySeedSet = new Set(companySeedIds.map(String));
  const dealSeedSet = new Set(dealSeedIds.map(String));
  const companyScores = companies.map((record) => scoreRelatedRecord(record, row, companySeedSet));
  const dealScores = deals.map((record) => scoreRelatedRecord(record, row, dealSeedSet));

  return {
    contactIds: contactId ? [contactId] : [],
    companyIds: companyScores.filter((item) => item.include).sort((a, b) => b.score - a.score).map((item) => item.id).slice(0, 3),
    dealIds: dealScores.filter((item) => item.include).sort((a, b) => b.score - a.score).map((item) => item.id).slice(0, 5),
    selectedCandidate: selectedCandidate
      ? {
          type: selectedCandidate.type,
          id: selectedCandidate.id,
          name: selectedCandidate.name,
          relatedCompanyIds: selectedCandidate.relatedCompanyIds || [],
          relatedDealIds: selectedCandidate.relatedDealIds || []
        }
      : null,
    relationScores: {
      companies: companyScores,
      deals: dealScores
    }
  };
}

async function connectHubspotAssociationTargets(association, rowHint) {
  const row = rowHint || (() => {
    return null;
  })();
  const targets = await resolveHubspotAssociationTargetsV2(association, row);
  const operations = [
    ...targets.contactIds.map((id) => ({ type: "contacts", id })),
    ...targets.companyIds.map((id) => ({ type: "companies", id })),
    ...targets.dealIds.map((id) => ({ type: "deals", id }))
  ];

  if (!operations.length) {
    return {
      status: "skipped",
      targets,
      results: [],
      errors: ["No hay contactId, companyId ni dealId para asociar en HubSpot."]
    };
  }

  const results = [];
  const errors = [];
  for (const operation of operations) {
    try {
      await createHubspotTicketAssociation(association.ticketId, operation.type, operation.id);
      results.push({ ...operation, status: "associated" });
    } catch (error) {
      errors.push({ ...operation, message: error.message });
    }
  }

  return {
    status: errors.length ? (results.length ? "partial" : "error") : "success",
    targets,
    results,
    errors
  };
}

function normalizeAssociationPayload(input) {
  const source = ["GMB", "Trustpilot", "UNKNOWN"].includes(input.source) ? input.source : "UNKNOWN";
  const service = ["KD MARKETING", "KD PC", "KD PC + KD MARKETING", "UNKNOWN"].includes(input.service) ? input.service : "UNKNOWN";
  const sentiment = input.sentiment === "positive" ? "positive" : "negative";
  const matchStatus = ["matched", "possible_match", "not_matched"].includes(input.matchStatus)
    ? input.matchStatus
    : "not_matched";
  const matchConfidence = ["high", "medium", "low"].includes(input.matchConfidence)
    ? input.matchConfidence
    : "low";

  if (!String(input.ticketId || "").trim()) throw new Error("ticketId es obligatorio.");

  return {
    ticketId: String(input.ticketId).trim(),
    reviewId: input.reviewId ? String(input.reviewId) : null,
    source,
    contactId: input.contactId ? String(input.contactId) : null,
    companyId: input.companyId ? String(input.companyId) : null,
    dealId: input.dealId ? String(input.dealId) : null,
    dealIds: uniqueIds([input.dealIds, input.dealId]),
    clientName: input.clientName ? String(input.clientName) : null,
    service,
    sentiment,
    matchStatus,
    matchConfidence,
    matchExplanation: String(input.matchExplanation || "").slice(0, 1000),
    evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 20) : [],
    confirmedAt: new Date().toISOString(),
    confirmedBy: "local_user"
  };
}

let _cachedContactingStageId = null;
let _allPipelineStages = null;

async function fetchAllPipelineStages() {
  if (_allPipelineStages) return _allPipelineStages;
  const data = await hubspotRequest("/crm/v3/pipelines/tickets");
  const result = [];
  for (const pipeline of data.results || []) {
    for (const stage of pipeline.stages || []) {
      result.push({ pipelineId: pipeline.id, pipelineLabel: pipeline.label, stageId: stage.id, stageLabel: stage.label });
    }
  }
  _allPipelineStages = result;
  return result;
}

async function getContactingStageId() {
  if (config.hubspotContactingStageId) return config.hubspotContactingStageId;
  if (_cachedContactingStageId) return _cachedContactingStageId;
  try {
    const stages = await fetchAllPipelineStages();
    const pipelineLabel = normalizeText(process.env.HUBSPOT_REVIEW_PIPELINE_LABEL || "customer success");
    const targetLabel = normalizeText(config.hubspotContactingStageLabel || "intentando contactar");
    const inPipeline = stages.filter((s) => normalizeText(s.pipelineLabel).includes(pipelineLabel));

    // Intento 1: coincidencia exacta del label configurado
    let match = inPipeline.find((s) => normalizeText(s.stageLabel).includes(targetLabel));

    // Intento 2: buscar "contactar" o "contacting" si el nombre exacto no existe
    if (!match) {
      match = inPipeline.find((s) => {
        const n = normalizeText(s.stageLabel);
        return n.includes("contactar") || n.includes("contacting") || n.includes("contactando");
      });
    }

    if (match) {
      console.log(`[confirm] Stage destino: "${match.stageLabel}" (${match.stageId})`);
      _cachedContactingStageId = match.stageId;
      return match.stageId;
    }

    const available = inPipeline.map((s) => `"${s.stageLabel}" → ID: ${s.stageId}`).join(" | ");
    console.warn(`[confirm] ATENCIÓN: Stage "${config.hubspotContactingStageLabel}" no encontrado.`);
    console.warn(`[confirm] Stages en pipeline "${pipelineLabel}": ${available || "ninguno"}`);
    console.warn(`[confirm] Solución: añade HUBSPOT_CONTACTING_STAGE_ID=<id> en .env con el ID correcto.`);
    console.warn(`[confirm] Diagnóstico completo: GET /api/hubspot/debug/stages`);
  } catch (error) {
    console.warn(`[confirm] Error consultando pipeline stages: ${error.message}`);
  }
  return null;
}

async function getTicketNotes(ticketId) {
  try {
    const noteIds = await getHubspotAssociatedIds("tickets", ticketId, "notes");
    if (!noteIds.length) return null;

    const recentIds = noteIds.slice(-5);
    const batchData = await hubspotRequest("/crm/v3/objects/notes/batch/read", {
      method: "POST",
      body: {
        properties: ["hs_note_body", "hs_timestamp"],
        inputs: recentIds.map((id) => ({ id }))
      }
    });

    const notes = (batchData.results || [])
      .filter((n) => n.properties?.hs_note_body)
      .sort((a, b) => new Date(b.properties?.hs_timestamp || 0) - new Date(a.properties?.hs_timestamp || 0));

    if (!notes.length) return null;

    return notes
      .slice(0, 3)
      .map((n) => {
        const rawText = String(n.properties.hs_note_body || "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const date = n.properties?.hs_timestamp
          ? new Date(n.properties.hs_timestamp).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" })
          : "";
        return date ? `[${date}] ${rawText}` : rawText;
      })
      .join("\n---\n")
      .slice(0, 1000);
  } catch (error) {
    console.log(`[confirm] No se pudieron obtener notas del ticket ${ticketId}: ${error.message}`);
    return null;
  }
}

function buildGestionCommentFallback(row) {
  if (!row?.candidateOptions?.length) return null;
  const top = row.candidateOptions[0];
  const activities = Array.isArray(top?.recentActivity) ? top.recentActivity : [];
  if (!activities.length) return null;

  const notes = activities
    .filter((a) => typeof a === "string" && a.startsWith("notes:"))
    .map((a) => a.slice("notes:".length).replace(/^\s*\d{4}-\d{2}-\d{2}[T\s]\S+\s*\|?\s*/, "").trim());

  const source = notes.length ? notes : activities.map((a) => {
    const sep = a.indexOf(":");
    return sep > -1 ? `[${a.slice(0, sep)}] ${a.slice(sep + 1).trim()}` : a;
  });

  return source.slice(0, 3).join("\n---\n").slice(0, 1000) || null;
}

function detectMktProjectTypesFromText(value) {
  const text = normalizeText(value);
  const result = [];
  const add = (key) => {
    const item = MKT_PROJECT_TYPE_VALUES[key];
    if (item && !result.includes(item)) result.push(item);
  };
  if (/(web|pagina|landing|wordpress|dominio|hosting|site)/.test(text)) add("WEB");
  if (/(ecom|e commerce|ecommerce|tienda online|woocommerce|shopify|prestashop|carrito)/.test(text)) add("ECOM");
  if (/(rrss|redes|social|instagram|facebook|linkedin|tiktok|metricool|publicacion|contenido)/.test(text)) add("RRSS");
  if (/(seo|posicionamiento|google business|google maps|gmb|ficha google|keywords)/.test(text)) add("SEO");
  if (/(fact|factura|facturacion|facturacion electronica|analitica)/.test(text)) add("FACT");
  return result;
}

async function associationContextText(targets) {
  const [companies, deals] = await Promise.all([
    batchReadHubspotObjects("companies", targets?.companyIds || [], HUBSPOT_ASSOCIATION_CONTEXT_PROPS.companies).catch(() => []),
    batchReadHubspotObjects("deals", targets?.dealIds || [], HUBSPOT_ASSOCIATION_CONTEXT_PROPS.deals).catch(() => [])
  ]);
  return [...companies, ...deals].map(objectText).join(" | ");
}

async function buildReviewNegativeProperties(row, targets) {
  if (row?.reviewSentiment !== "negative") return {};
  const reviewContext = [
    row?.reviewText,
    row?.reviewReason,
    row?.service,
    row?.projectType
  ].join(" | ");
  const associationContext = await associationContextText(targets);
  const mktContext = [
    reviewContext,
    row?.serviceExplanation,
    ...(Array.isArray(row?.serviceEvidence) ? row.serviceEvidence : []),
    row?.matchExplanation,
    associationContext
  ].join(" | ");
  const service = normalizeText(row?.service || row?.projectType || "");
  const textFlags = serviceFlagsFromText(reviewContext);
  const flags = {
    pc: service.includes("kd pc") || textFlags.pc,
    mkt: service.includes("marketing") || service.includes("mkt") || textFlags.mkt
  };
  const properties = {};
  const reasonValues = [];
  if (flags.mkt) reasonValues.push(REVIEW_REASON_VALUES.mkt);
  if (flags.pc) reasonValues.push(REVIEW_REASON_VALUES.pc);
  if (reasonValues.length) properties[REVIEW_NEGATIVE_REASON_FIELD] = [...new Set(reasonValues)].join(";");
  if (flags.mkt) {
    const mktTypes = detectMktProjectTypesFromText(mktContext);
    if (mktTypes.length) properties[REVIEW_MKT_PROJECT_TYPE_FIELD] = mktTypes.join(";");
  }
  return properties;
}

async function updateTicketPropertiesOnConfirm(ticketId, source, row, targets) {
  const properties = {};

  // Platform field
  if (source === "GMB") properties.en_que_plataforma_aparece_la_resena_ = config.hubspotPlatformValueGmb;
  else if (source === "Trustpilot") properties.en_que_plataforma_aparece_la_resena_ = config.hubspotPlatformValueTrustpilot;

  // Comentario gestion: primero notas del propio ticket, luego actividad del candidato como fallback
  const gestionField = process.env.HUBSPOT_GESTION_COMMENT_FIELD || "comentario_gestion";
  const gestionComment = (await getTicketNotes(ticketId)) || buildGestionCommentFallback(row);
  if (gestionComment) {
    properties[gestionField] = gestionComment;
    console.log(`[confirm] Comentario gestión preparado (${gestionComment.length} chars)`);
  } else {
    console.log(`[confirm] Sin notas disponibles para comentario gestión en ticket ${ticketId}`);
  }

  Object.assign(properties, await buildReviewNegativeProperties(row, targets));

  if (!Object.keys(properties).length) return { status: "skipped", properties: {} };

  try {
    await hubspotRequest(`/crm/v3/objects/tickets/${encodeURIComponent(ticketId)}`, {
      method: "PATCH",
      body: { properties }
    });
    return { status: "success", properties };
  } catch (error) {
    return { status: "error", message: error.message, properties };
  }
}

async function previewAssociationConfirmation(input) {
  const normalized = normalizeAssociationPayload(input);
  const report = await readJsonSafe(hubspotTicketMatchesPath, null);
  const row = (report?.items || []).find((item) => String(item.ticketId) === String(normalized.ticketId)) || null;
  const targets = await resolveHubspotAssociationTargetsV2(normalized, row);
  const properties = {};
  if (normalized.source === "GMB") properties.en_que_plataforma_aparece_la_resena_ = config.hubspotPlatformValueGmb;
  else if (normalized.source === "Trustpilot") properties.en_que_plataforma_aparece_la_resena_ = config.hubspotPlatformValueTrustpilot;
  const gestionField = process.env.HUBSPOT_GESTION_COMMENT_FIELD || "comentario_gestion";
  const gestionComment = (await getTicketNotes(normalized.ticketId)) || buildGestionCommentFallback(row);
  if (gestionComment) properties[gestionField] = gestionComment;
  Object.assign(properties, await buildReviewNegativeProperties(row, targets));
  return { normalized, row, targets, properties };
}

function parseCsvRows(raw) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const text = String(raw || "").replace(/^\uFEFF/, "");

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((header) => String(header || "").trim());
  return rows
    .filter((current) => current.some((value) => String(value || "").trim()))
    .map((current) => Object.fromEntries(headers.map((header, index) => [header, current[index] || ""])));
}

async function fetchReviewSheetRows() {
  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(REVIEW_SHEET_ID)}/gviz/tq?tqx=out:csv&gid=${encodeURIComponent(REVIEW_SHEET_GID)}`;
  const response = await fetch(url, { headers: { accept: "text/csv" } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Google Sheets respondio con HTTP ${response.status}.`);
  return parseCsvRows(text);
}

function sheetRowInfo(row, index) {
  const primaryEmail = String(row["Dirección de correo electrónico"] || "").trim();
  const secondaryEmail = String(row["Correo electrónico "] || row["Correo electrónico"] || "").trim();
  const alias = String(row["Alias (con el que has dejado tu reseña)"] || "").trim();
  const fullName = String(row["Nombre completo"] || "").trim();
  const phone = String(row["Teléfono de contacto "] || row["Teléfono de contacto"] || "").trim();
  return {
    sheetRowNumber: index + 2,
    timestamp: String(row["Marca temporal"] || "").trim(),
    primaryEmail,
    secondaryEmail,
    emails: uniqueIds([primaryEmail, secondaryEmail]).filter((value) => /@/.test(value)),
    alias,
    fullName,
    phone,
    authorizedContact: String(row["¿Nos autorizas a contactarte para dar seguimiento a tu caso?"] || "").trim(),
    associatedInHubspot: String(row["Asociado en Hubspot"] || "").trim()
  };
}

function reviewTicketIdentityText(row) {
  return [
    row?.reviewAuthor,
    row?.referenceName,
    row?.ticketName,
    row?.reviewText,
    row?.reviewReason,
    row?.description,
    row?.content
  ].filter(Boolean).join(" | ");
}

function compactIdentity(value) {
  return normalizeText(value).replace(/\s+/g, "");
}

function tokenList(value) {
  return normalizeText(value).split(" ").filter((token) => token.length >= 3);
}

function scoreSheetTicketMatch(ticket, sheet) {
  const ticketText = reviewTicketIdentityText(ticket);
  const ticketNorm = normalizeText(ticketText);
  const authorNorm = normalizeText(ticket.reviewAuthor || ticket.referenceName || ticket.ticketName || "");
  const aliasNorm = normalizeText(sheet.alias);
  const nameNorm = normalizeText(sheet.fullName);
  const emailNorms = sheet.emails.map((email) => normalizeText(email));
  const sheetSearchNorm = normalizeText([sheet.alias, sheet.fullName, sheet.primaryEmail, sheet.secondaryEmail, sheet.phone].join(" "));
  const reasons = [];
  let score = 0;

  for (const email of emailNorms) {
    if (email && ticketNorm.includes(email)) {
      score = Math.max(score, 1);
      reasons.push("email del sheet aparece en el ticket");
    }
  }

  if (aliasNorm && authorNorm) {
    const aliasCompact = compactIdentity(sheet.alias);
    const authorCompact = compactIdentity(ticket.reviewAuthor || ticket.referenceName || "");
    if (aliasNorm === authorNorm || (aliasCompact && aliasCompact === authorCompact)) {
      score = Math.max(score, 0.96);
      reasons.push("alias exacto con autor de reseña");
    } else if (aliasCompact.length >= 3 && authorCompact.length >= 3 && (authorNorm.includes(aliasNorm) || aliasNorm.includes(authorNorm))) {
      score = Math.max(score, 0.88);
      reasons.push("alias contenido en autor/titulo");
    } else {
      const aliasSimilarity = aliasCompact.length >= 3 && authorCompact.length >= 3 ? textSimilarity(aliasNorm, authorNorm) : 0;
      if (aliasSimilarity >= 0.7) {
        score = Math.max(score, aliasSimilarity);
        reasons.push(`alias similar (${aliasSimilarity.toFixed(2)})`);
      }
    }
  }

  if (nameNorm && ticketNorm) {
    const nameSimilarity = Math.max(textSimilarity(nameNorm, ticketNorm), textSimilarity(nameNorm, authorNorm));
    if (nameSimilarity >= 0.55) {
      score = Math.max(score, Math.min(0.82, nameSimilarity));
      reasons.push(`nombre similar (${nameSimilarity.toFixed(2)})`);
    }
  }

  const sharedTokens = tokenList(ticket.reviewAuthor || ticket.referenceName || "")
    .filter((token) => token.length >= 4 && tokenList(sheetSearchNorm).includes(token));
  if (sharedTokens.length) {
    score = Math.max(score, sharedTokens.length >= 2 ? 0.58 : 0.42);
    reasons.push(`token compartido: ${sharedTokens.slice(0, 3).join(", ")}`);
  }

  const prefixTokens = tokenList(ticket.reviewAuthor || ticket.referenceName || "")
    .filter((token) => token.length >= 3 && tokenList(sheetSearchNorm).some((sheetToken) => sheetToken.startsWith(token) || token.startsWith(sheetToken)));
  if (prefixTokens.length && score < 0.42) {
    score = Math.max(score, 0.34);
    reasons.push(`token parcial: ${prefixTokens.slice(0, 3).join(", ")}`);
  }

  return {
    matched: score >= 0.82,
    possible: score >= 0.3,
    score,
    reasons
  };
}

function unmatchedReviewRows(report) {
  const rows = Array.isArray(report?.items) ? report.items : [];
  return rows.filter((row) => {
    if (row.associationStatus === "confirmed") return false;
    const status = row.matchStatus || row.status || "";
    return status === "not_matched" || status === "unidentifiable" || status === "no_coincide";
  });
}

async function searchHubspotObjects(objectType, body) {
  const data = await hubspotRequest(`/crm/v3/objects/${objectType}/search`, {
    method: "POST",
    body
  });
  return data.results || [];
}

async function searchHubspotContactFromSheet(sheet) {
  for (const email of sheet.emails) {
    const exact = await searchHubspotObjects("contacts", {
      limit: 5,
      properties: HUBSPOT_ASSOCIATION_CONTEXT_PROPS.contacts,
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }]
    }).catch(() => []);
    if (exact.length) {
      return {
        contact: exact[0],
        confidence: "high",
        reason: `contacto encontrado por email exacto del sheet (${email})`
      };
    }
  }

  const queryCandidates = uniqueIds([sheet.phone, sheet.fullName, sheet.alias]).filter((value) => String(value).length >= 3);
  for (const query of queryCandidates) {
    const results = await searchHubspotObjects("contacts", {
      limit: 5,
      query,
      properties: HUBSPOT_ASSOCIATION_CONTEXT_PROPS.contacts
    }).catch(() => []);
    if (!results.length) continue;
    const scored = results.map((contact) => {
      const p = contact.properties || {};
      const name = `${p.firstname || ""} ${p.lastname || ""}`.trim();
      const text = [name, p.email, p.phone, p.mobilephone, p.company].join(" | ");
      const score = Math.max(textSimilarity(sheet.fullName, text), textSimilarity(sheet.alias, text));
      const phoneHit = sheet.phone && normalizeText(text).includes(normalizeText(sheet.phone));
      return { contact, score: phoneHit ? Math.max(score, 0.9) : score, phoneHit };
    }).sort((a, b) => b.score - a.score);
    if (scored[0]?.score >= 0.55) {
      return {
        contact: scored[0].contact,
        confidence: scored[0].score >= 0.85 ? "high" : "medium",
        reason: scored[0].phoneHit ? "contacto encontrado por telefono del sheet" : `contacto encontrado por busqueda de nombre/alias (${query})`
      };
    }
  }

  return { contact: null, confidence: "low", reason: "no se encontro contacto en HubSpot con email, telefono, nombre o alias del sheet" };
}

function contactDisplayName(contact) {
  const p = contact?.properties || {};
  const name = `${p.firstname || ""} ${p.lastname || ""}`.trim();
  return name || p.email || contact?.id || "";
}

async function associateUnmatchedFromSheet(input = {}) {
  const dryRun = input.dryRun !== false;
  const report = await readJsonSafe(hubspotTicketMatchesPath, null);
  if (!report?.items?.length) throw new Error("No hay reporte HubSpot cargado para cruzar con Google Sheets.");

  const confirmed = await loadConfirmedAssociations();
  const confirmedTicketIds = new Set(confirmed.map((item) => String(item.ticketId)));
  const requestedTicketIds = new Set(uniqueIds([input.ticketIds, input.ticketId]).map(String));
  const sheetRows = (await fetchReviewSheetRows()).map(sheetRowInfo);
  const unmatchedRows = unmatchedReviewRows(report)
    .filter((row) => !confirmedTicketIds.has(String(row.ticketId)))
    .filter((row) => !requestedTicketIds.size || requestedTicketIds.has(String(row.ticketId)));
  const items = [];
  const summary = {
    dryRun,
    sheetRows: sheetRows.length,
    unmatchedTickets: unmatchedRows.length,
    confirmedSkipped: confirmedTicketIds.size,
    sheetMatches: 0,
    possibleSheetMatches: 0,
    hubspotContactsFound: 0,
    ready: 0,
    associated: 0,
    skipped: 0,
    errors: 0
  };

  for (const ticket of unmatchedRows) {
    try {
      const scoredSheetRows = sheetRows
        .map((sheet) => ({ sheet, match: scoreSheetTicketMatch(ticket, sheet) }))
        .sort((a, b) => b.match.score - a.match.score);
      const best = scoredSheetRows.find((item) => item.match.matched);
      const possible = best || scoredSheetRows.find((item) => item.match.possible);
      const topCandidates = scoredSheetRows
        .filter((item) => item.match.score >= 0.2)
        .slice(0, 3)
        .map((item) => ({
          sheet: item.sheet,
          sheetMatchScore: item.match.score,
          sheetMatchReasons: item.match.reasons
        }));

      if (!possible) {
        summary.skipped += 1;
        items.push({ ticketId: ticket.ticketId, ticketName: ticket.ticketName, status: "no_sheet_match", topCandidates });
        continue;
      }
      if (possible.match.matched) summary.sheetMatches += 1;
      else summary.possibleSheetMatches += 1;

      const hubspot = await searchHubspotContactFromSheet(possible.sheet);
      if (!hubspot.contact) {
        summary.skipped += 1;
        items.push({
          ticketId: ticket.ticketId,
          ticketName: ticket.ticketName,
          status: possible.match.matched ? "sheet_match_no_hubspot_contact" : "possible_sheet_match_no_hubspot_contact",
          sheet: possible.sheet,
          sheetMatchScore: possible.match.score,
          sheetMatchReasons: possible.match.reasons,
          topCandidates,
          hubspotReason: hubspot.reason
        });
        continue;
      }
      summary.hubspotContactsFound += 1;

      const payload = {
        ticketId: String(ticket.ticketId),
        reviewId: ticket.reviewId || ticket.matchedReviewId || ticket.reviewUrl || null,
        source: ticket.source || "UNKNOWN",
        contactId: String(hubspot.contact.id),
        companyId: null,
        dealIds: [],
        clientName: contactDisplayName(hubspot.contact),
        service: ticket.service || ticket.projectType || "UNKNOWN",
        sentiment: ticket.reviewSentiment === "positive" ? "positive" : "negative",
        matchStatus: possible.match.matched ? "matched" : "possible_match",
        matchConfidence: possible.match.matched ? hubspot.confidence : "medium",
        matchExplanation: `${possible.match.matched ? "Asociacion" : "Posible asociacion"} desde Google Sheets fila ${possible.sheet.sheetRowNumber}: ${possible.match.reasons.join("; ")}. ${hubspot.reason}.`,
        evidence: [
          ...(Array.isArray(ticket.evidence) ? ticket.evidence : []),
          { type: "google_sheet_alias", value: possible.sheet.alias },
          { type: "google_sheet_email", value: possible.sheet.primaryEmail || possible.sheet.secondaryEmail },
          { type: "google_sheet_name", value: possible.sheet.fullName },
          { type: "google_sheet_phone", value: possible.sheet.phone },
          { type: "google_sheet_row", value: String(possible.sheet.sheetRowNumber) }
        ]
      };

      if (dryRun) {
        summary.ready += 1;
        items.push({
          ticketId: ticket.ticketId,
          ticketName: ticket.ticketName,
          status: possible.match.matched ? "ready" : "possible_ready",
          payload,
          sheet: possible.sheet,
          sheetMatchScore: possible.match.score,
          sheetMatchReasons: possible.match.reasons,
          topCandidates,
          hubspotContactId: hubspot.contact.id,
          hubspotReason: hubspot.reason
        });
        continue;
      }

      const association = await confirmAssociation(payload);
      summary.associated += 1;
      items.push({
        ticketId: ticket.ticketId,
        ticketName: ticket.ticketName,
        status: "associated",
        associationId: association.associationId,
        sheet: possible.sheet,
        sheetMatchScore: possible.match.score,
        sheetMatchReasons: possible.match.reasons,
        topCandidates,
        hubspotContactId: hubspot.contact.id,
        hubspotAssociated: association.hubspotAssociated,
        hubspotReason: hubspot.reason
      });
    } catch (error) {
      summary.errors += 1;
      items.push({ ticketId: ticket.ticketId, ticketName: ticket.ticketName, status: "error", error: error.message });
    }
  }

  if (!dryRun) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(
      sheetAssociationAuditPath,
      JSON.stringify({ updatedAt: new Date().toISOString(), summary, items }, null, 2),
      "utf8"
    );
  }

  return {
    success: true,
    dryRun,
    summary,
    items,
    sheet: {
      id: REVIEW_SHEET_ID,
      gid: REVIEW_SHEET_GID
    },
    persistedPath: dryRun ? null : path.relative(__dirname, sheetAssociationAuditPath)
  };
}

async function confirmAssociation(input) {
  const normalized = normalizeAssociationPayload(input);
  // Leer fila una sola vez y compartirla con todas las funciones
  const report = await readJsonSafe(hubspotTicketMatchesPath, null);
  const row = (report?.items || []).find((item) => String(item.ticketId) === String(normalized.ticketId)) || null;
  const hubspotAssociations = await connectHubspotAssociationTargets(normalized, row);
  if (hubspotAssociations.status === "error") {
    throw new Error(`No se pudo asociar en HubSpot: ${hubspotAssociations.errors.map((item) => item.message).join("; ")}`);
  }
  const ticketUpdate = await updateTicketPropertiesOnConfirm(normalized.ticketId, normalized.source, row, hubspotAssociations.targets);
  const existing = await loadConfirmedAssociations();
  const previous = existing.find((item) => item.ticketId === normalized.ticketId);
  const association = {
    associationId: previous?.associationId || crypto.randomUUID(),
    ...normalized,
    hubspotAssociationStatus: hubspotAssociations.status,
    hubspotAssociated: hubspotAssociations.targets,
    hubspotAssociationResults: hubspotAssociations.results,
    hubspotAssociationErrors: hubspotAssociations.errors,
    ticketUpdateStatus: ticketUpdate.status,
    ticketUpdateProperties: ticketUpdate.properties,
    ticketUpdateError: ticketUpdate.message || null
  };
  const items = [association, ...existing.filter((item) => item.ticketId !== normalized.ticketId)];
  await saveConfirmedAssociations(items);
  return association;
}

function associationPayloadFromReportRow(row) {
  return normalizeAssociationPayload({
    ticketId: String(row.ticketId),
    reviewId: row.reviewId || row.matchedReviewId || row.reviewUrl || null,
    source: row.source || "UNKNOWN",
    contactId: row.contactId || (row.matchType === "contact" ? row.matchId : null),
    companyId: row.companyId || (row.matchType === "company" ? row.matchId : null),
    dealId: row.dealId || null,
    dealIds: row.dealIds || [],
    clientName: row.clientName || row.matchName || row.matchEmailOrDomain || null,
    service: row.service || row.projectType || "UNKNOWN",
    sentiment: row.reviewSentiment === "positive" ? "positive" : "negative",
    matchStatus: row.matchStatus || "not_matched",
    matchConfidence: row.matchConfidence || "low",
    matchExplanation: row.matchExplanation || row.matchReason || "",
    evidence: Array.isArray(row.evidence) ? row.evidence : []
  });
}

async function autofillAnalyzedHubspotTicketFields(report, pushLog = () => {}) {
  const rows = Array.isArray(report?.items) ? report.items : [];
  const summary = {
    attempted: rows.length,
    updated: 0,
    skipped: 0,
    errors: 0,
    items: []
  };

  for (const row of rows) {
    try {
      const normalized = associationPayloadFromReportRow(row);
      const targets = await resolveHubspotAssociationTargetsV2(normalized, row);
      const ticketUpdate = await updateTicketPropertiesOnConfirm(normalized.ticketId, normalized.source, row, targets);
      const item = {
        ticketId: normalized.ticketId,
        status: ticketUpdate.status,
        properties: ticketUpdate.properties || {},
        error: ticketUpdate.message || null,
        targetContext: {
          contactIds: targets.contactIds,
          companyIds: targets.companyIds,
          dealIds: targets.dealIds
        }
      };
      summary.items.push(item);
      if (ticketUpdate.status === "success" || ticketUpdate.status === "partial") {
        summary.updated += 1;
        pushLog("success", `Campos de reseña actualizados para ticket ${normalized.ticketId}.`);
      } else {
        summary.skipped += 1;
        pushLog("info", `Sin campos para actualizar en ticket ${normalized.ticketId}.`);
      }
    } catch (error) {
      summary.errors += 1;
      summary.items.push({ ticketId: row.ticketId, status: "error", error: error.message });
      pushLog("error", `Error actualizando campos del ticket ${row.ticketId}: ${error.message}`);
    }
  }

  return summary;
}

function compactReviewText(row) {
  return [
    row?.reviewText,
    row?.reviewReason,
    row?.description,
    row?.content,
    row?.ticketName,
    row?.subject,
    row?.matchExplanation
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 4000);
}

function ticketReviewIdentifiers(row) {
  const evidenceValues = Array.isArray(row?.evidence)
    ? row.evidence.map((item) => item.value).filter(Boolean)
    : [];
  return uniqueIds([
    row?.reviewId,
    row?.matchedReviewId,
    row?.reviewUrl,
    row?.sourceUrl,
    row?.externalReviewId,
    evidenceValues
  ]);
}

function matchHubSpotTicketToZernioReview(ticketAnalysis, zernioReviews) {
  const ticketIds = ticketReviewIdentifiers(ticketAnalysis);
  const ticketUrls = ticketIds.map(normalizeUrlForMatch).filter(Boolean);
  const author = normalizeText(ticketAnalysis.reviewAuthor || ticketAnalysis.referenceName || ticketAnalysis.clientName);
  const ticketText = compactReviewText(ticketAnalysis);
  const rating = Number(ticketAnalysis.reviewRating || ticketAnalysis.rating || 0);
  const createdAt = ticketAnalysis.reviewDate || ticketAnalysis.createdate || ticketAnalysis.createdAt;

  const scored = zernioReviews.map((review) => {
    let score = 0;
    const reasons = [];
    const reviewId = String(review.id || "");
    const reviewUrl = normalizeUrlForMatch(review.sourceUrl);

    if (ticketIds.some((id) => id && (String(id) === reviewId || String(id).includes(reviewId) || reviewId.includes(String(id))))) {
      score += 85;
      reasons.push("ID de reseña coincide");
    }
    if (reviewUrl && ticketUrls.some((url) => url === reviewUrl || url.includes(reviewUrl) || reviewUrl.includes(url))) {
      score += 85;
      reasons.push("URL de reseña coincide");
    }

    const reviewAuthor = normalizeText(review.author);
    if (author && reviewAuthor) {
      if (author === reviewAuthor) {
        score += 22;
        reasons.push("autor exacto");
      } else if (author.includes(reviewAuthor) || reviewAuthor.includes(author)) {
        score += 16;
        reasons.push("autor similar");
      }
    }

    if (rating && review.rating && Math.round(Number(review.rating)) === Math.round(rating)) {
      score += 10;
      reasons.push("rating coincide");
    }

    const dayDiff = daysBetween(createdAt, review.publishedAt || review.updatedAt);
    if (dayDiff !== null && dayDiff <= 3) {
      score += 8;
      reasons.push("fecha cercana");
    }

    const similarity = textSimilarity(ticketText, review.text);
    if (similarity >= 0.75) {
      score += 28;
      reasons.push(`texto muy similar (${Math.round(similarity * 100)}%)`);
    } else if (similarity >= 0.45) {
      score += 14;
      reasons.push(`texto similar (${Math.round(similarity * 100)}%)`);
    }

    return {
      review,
      reviewId,
      score,
      reasons,
      similarity
    };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 30) {
    return {
      matched: false,
      reviewId: null,
      matchConfidence: "low",
      matchExplanation: "No se encontro una reseña GMB en Zernio con señales suficientes.",
      matchedReview: null
    };
  }

  const second = scored[1];
  let matchConfidence = best.score >= 80 ? "high" : best.score >= 45 ? "medium" : "low";
  if (matchConfidence === "high" && second?.score >= 45 && best.score - second.score < 10) {
    matchConfidence = "medium";
  }

  return {
    matched: true,
    reviewId: best.reviewId,
    matchConfidence,
    matchExplanation: `${best.reasons.join(", ") || "señales parciales"}; score ${best.score}.`,
    matchedReview: best.review
  };
}

function extractGoogleMapsReviewId(value) {
  const raw = String(value || "");
  if (!raw) return "";
  const decoded = decodeURIComponent(raw);
  const markers = [
    /[@:]((?:CAIQ|ChZDSUhN|Ci9DQUl)[^|!?&\s]+)/,
    /[?&]reviewId=([^&]+)/i,
    /[?&]review_id=([^&]+)/i
  ];
  for (const pattern of markers) {
    const match = decoded.match(pattern);
    if (match?.[1]) return match[1].replace(/\|+$/, "");
  }
  return "";
}

function isReplyableGoogleBusinessReviewId(value) {
  const raw = String(value || "");
  const reviewId = raw.match(/\/reviews\/([^/?#]+)/i)?.[1] || raw;
  return /^AbFvOq[A-Za-z0-9_-]+$/.test(reviewId);
}

async function matchFromGoogleMapsUrlFallback(ticketAnalysis) {
  const reviewUrl = String(ticketAnalysis.reviewUrl || ticketAnalysis.sourceUrl || "").trim();
  if (!reviewUrl) return null;

  let finalUrl = reviewUrl;
  if (/maps\.app\.goo\.gl/i.test(reviewUrl)) {
    try {
      const response = await fetch(reviewUrl, { method: "GET", redirect: "follow" });
      finalUrl = response.url || reviewUrl;
    } catch {
      finalUrl = reviewUrl;
    }
  }

  const reviewId = extractGoogleMapsReviewId(finalUrl);
  if (!reviewId) return null;
  if (!isReplyableGoogleBusinessReviewId(reviewId)) return null;

  return {
    matched: true,
    reviewId,
    matchConfidence: "high",
    matchExplanation: "reviewId extraido desde URL directa/corta de Google Maps del ticket.",
    matchedReview: {
      id: reviewId,
      sourceUrl: finalUrl,
      rating: ticketAnalysis.reviewRating,
      text: ticketAnalysis.reviewText,
      author: ticketAnalysis.reviewAuthor
    }
  };
}

const POSITIVE_GMB_REPLY_TEMPLATES = [
  "¡Muchas gracias por tu comentario! Nos alegra saber que tu experiencia con Orbidi fue positiva. Nuestro equipo trabaja para ofrecer el mejor servicio.",
  "¡Gracias por compartir tu experiencia! Nos encanta saber que hemos cumplido con tus expectativas. En ORBIDI seguimos esforzándonos para ofrecer un servicio de calidad. ¡Te esperamos para futuras oportunidades!"
];

function selectPositiveReplyVariant(seed) {
  const options = POSITIVE_GMB_REPLY_TEMPLATES;
  const digest = crypto.createHash("sha1").update(String(seed || "")).digest("hex");
  return options[Number.parseInt(digest.slice(0, 2), 16) % options.length];
}

function stripGeminiFence(value) {
  return String(value || "")
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
}

function geminiResponseText(data) {
  return (data.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();
}

function chunkArray(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function sanitizePositiveReplyMessage(message, review) {
  let clean = String(message || "")
    .replace(/\s+/g, " ")
    .replace(/https?:\/\/\S+/gi, "")
    .trim();

  if (!clean) clean = selectPositiveReplyVariant(review?.id || review?.author);
  if (!/orbidi/i.test(clean)) clean = `${clean} Gracias por confiar en ORBIDI.`;
  if (clean.length > 420) clean = clean.slice(0, 420).replace(/\s+\S*$/, "").trim();
  if (clean && !/[.!?¡!]$/.test(clean)) clean += ".";
  return clean;
}

function positiveReplyCacheKey(review) {
  return canonicalGmbReviewId(review?.id) || String(review?.id || "");
}

function positiveReplyFingerprint(review) {
  return crypto
    .createHash("sha1")
    .update(
      JSON.stringify({
        id: positiveReplyCacheKey(review),
        author: review?.author || "",
        rating: review?.rating || "",
        text: String(review?.text || "").slice(0, 1000)
      })
    )
    .digest("hex");
}

async function generatePositiveGmbReplyMessages(reviews, addReplyLog = () => {}) {
  if (!reviews.length) return new Map();
  if (!config.geminiApiKey) {
    throw new Error("Falta GEMINI_API_KEY en .env para generar respuestas positivas con Gemini.");
  }

  const model = String(config.geminiModel || "gemini-2.5-flash").replace(/^models\//, "");
  const chunkSize = Math.max(1, Math.min(Number(config.geminiChunkSize || 30), 50));
  const cache = await loadPositiveReplyCache();
  const messages = new Map();
  const uncached = [];
  let cacheDirty = false;

  for (const review of reviews) {
    const key = positiveReplyCacheKey(review);
    const fingerprint = positiveReplyFingerprint(review);
    const cached = key ? cache[key] : null;
    if (cached?.fingerprint === fingerprint && cached.message) {
      messages.set(String(review.id), {
        message: sanitizePositiveReplyMessage(cached.message, review),
        reason: cached.reason || "Respuesta reutilizada desde cache local.",
        model: cached.model || model,
        cached: true
      });
      continue;
    }
    uncached.push({ review, key, fingerprint });
  }

  if (!uncached.length) {
    addReplyLog("success", `Gemini no fue necesario: ${reviews.length} respuestas positivas reutilizadas desde cache local.`);
    return messages;
  }

  addReplyLog(
    "info",
    `Cache Gemini positiva: ${reviews.length - uncached.length} reutilizadas, ${uncached.length} nuevas para generar.`
  );

  const chunks = chunkArray(uncached, chunkSize);

  for (let index = 0; index < chunks.length; index += 1) {
    const current = chunks[index];
    addReplyLog("info", `Gemini generando respuestas positivas lote ${index + 1}/${chunks.length} (${current.length} reseñas).`);

    const payload = {
      system_instruction: {
        parts: [
          {
            text:
              "Eres gestor de reputacion online de ORBIDI. Genera respuestas breves en espanol para reseñas positivas de Google. Deben sonar humanas, agradecidas y profesionales, con variaciones naturales para que no parezcan repetidas. Usa como base estas plantillas, sin copiarlas siempre literalmente: " +
              JSON.stringify(POSITIVE_GMB_REPLY_TEMPLATES) +
              ". No prometas acciones concretas, no incluyas enlaces, correos, formularios ni datos inventados. Maximo 2 frases. Responde solo JSON valido con {\"items\":[{\"id\":\"...\",\"message\":\"...\",\"reason\":\"...\"}]}."
          }
        ]
      },
      contents: [
        {
          role: "user",
          parts: [
            {
              text: JSON.stringify({
                reviews: current.map(({ review }) => ({
                  id: review.id,
                  author: review.author,
                  rating: review.rating,
                  text: String(review.text || "").slice(0, 320),
                  publishedAt: review.publishedAt
                }))
              })
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.75,
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
    if (!response.ok) {
      throw new Error(data.error?.message || `Gemini respondio con HTTP ${response.status}.`);
    }

    const parsed = JSON.parse(stripGeminiFence(geminiResponseText(data)));
    if (!Array.isArray(parsed.items)) throw new Error("Gemini no devolvio una lista items valida para respuestas positivas.");
    for (const item of parsed.items) {
      const entry = current.find((candidate) => String(candidate.review.id) === String(item.id));
      if (!entry) continue;
      const review = entry.review;
      const result = {
        message: sanitizePositiveReplyMessage(item.message, review),
        reason: String(item.reason || "Respuesta positiva generada por Gemini.").slice(0, 240),
        model
      };
      messages.set(String(review.id), result);
      if (entry.key) {
        cache[entry.key] = {
          fingerprint: entry.fingerprint,
          message: result.message,
          reason: result.reason,
          model,
          generatedAt: new Date().toISOString()
        };
        cacheDirty = true;
      }
    }
  }

  for (const review of reviews) {
    if (!messages.has(String(review.id))) {
      const fallback = {
        message: sanitizePositiveReplyMessage(selectPositiveReplyVariant(review.id), review),
        reason: "Gemini no devolvio item para esta reseña; se uso una variante segura de plantilla.",
        model: "template-fallback"
      };
      messages.set(String(review.id), fallback);
      const key = positiveReplyCacheKey(review);
      if (key) {
        cache[key] = {
          fingerprint: positiveReplyFingerprint(review),
          message: fallback.message,
          reason: fallback.reason,
          model: fallback.model,
          generatedAt: new Date().toISOString()
        };
        cacheDirty = true;
      }
    }
  }

  if (cacheDirty) await savePositiveReplyCache(cache);

  return messages;
}

function selectGmbReviewReply(ticketAnalysis) {
  if (ticketAnalysis.source !== "GMB") {
    return { shouldReply: false, replyType: "not_gmb", message: "", reason: "La reseña no es GMB." };
  }

  const sentiment = ticketAnalysis.reviewSentiment === "positive" || ticketAnalysis.sentiment === "positive"
    ? "positive"
    : "negative";

  if (sentiment === "positive") {
    return {
      shouldReply: true,
      replyType: "positive",
      message: selectPositiveReplyVariant(ticketAnalysis.reviewId || ticketAnalysis.ticketId),
      reason: "Reseña positiva GMB."
    };
  }

  const status = ticketAnalysis.matchStatus || "not_matched";
  const identified = Boolean(
    ticketAnalysis.associationStatus === "confirmed" ||
    ticketAnalysis.confirmedAssociation ||
    ticketAnalysis.contactId ||
    ticketAnalysis.companyId ||
    status === "matched" ||
    (ticketAnalysis.matchConfidence === "high" && ticketAnalysis.clientName)
  );

  if (identified) {
    return {
      shouldReply: true,
      replyType: "negative_identified",
      message: "Hola, lamentamos que tu experiencia no haya sido la esperada. Hemos trasladado tu caso al equipo de Calidad para revisar lo ocurrido y poder ayudarte lo antes posible. Gracias por compartir tu experiencia.\n\nEquipo ORBIDI",
      reason: "Reseña negativa con cliente identificable."
    };
  }

  return {
    shouldReply: true,
    replyType: "negative_unidentified",
    message: "Hola; Desde el equipo de ORBIDI queremos revisar tu caso y ponernos en contacto contigo en la mayor brevedad posible. Para ello, necesitaremos que completes el siguiente formulario: https://docs.google.com/forms/d/e/1FAIpQLScMjSwTvc5k5VYpftBKQDVxM1kvKlwrYhQuZRbDmknZf0-i9w/viewform",
    reason: "Reseña negativa sin cliente identificable."
  };
}

function canonicalGmbReviewId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const decoded = decodeURIComponent(raw);
  const resourceMatch = decoded.match(/\/reviews\/([^/?#]+)/i);
  if (resourceMatch?.[1]) return resourceMatch[1];
  return decoded;
}

function gmbReplyMaps(items) {
  const byTicket = new Map();
  const byReview = new Map();
  for (const item of items) {
    if (item.ticketId) byTicket.set(String(item.ticketId), item);
    if (item.reviewId) {
      byReview.set(String(item.reviewId), item);
      const canonical = canonicalGmbReviewId(item.reviewId);
      if (canonical) byReview.set(canonical, item);
    }
  }
  return { byTicket, byReview };
}

function hasRemoteReply(review) {
  return Boolean(String(review?.reply || "").trim());
}

async function replyGmbReviewsFromHubSpot(input) {
  const dryRun = input.dryRun !== false;
  const report = await readJsonSafe(hubspotTicketMatchesPath, null);
  const tickets = Array.isArray(input.tickets) && input.tickets.length ? input.tickets : (report?.items || []);
  const log = [];
  const addReplyLog = (level, message) => log.push({ time: new Date().toISOString(), level, message: redact(message) });

  if (!tickets.length) throw new Error("No hay tickets analizados para revisar respuestas GMB.");
  addReplyLog("info", `${dryRun ? "Dry-run" : "Ejecucion real"} de respuestas GMB iniciado para ${tickets.length} tickets.`);

  const maxReviews = Math.max(1, Math.min(Number(input.maxReviews || config.maxReviewsCap || 5000), config.maxReviewsCap));
  const existing = await loadGmbReviewReplies();
  const existingMaps = gmbReplyMaps(existing.filter((item) => item.status === "replied"));
  let zernioReviews = [];
  let zernioFetchError = null;
  try {
    zernioReviews = await collectReviews(
      {
        source: "zernio",
        zernioMode: "inbox",
        zernioAccountId: input.zernioAccountId || config.zernioAccountId,
        zernioLocationId: input.zernioLocationId || config.zernioLocationId,
        maxReviews
      },
      config,
      addReplyLog,
      __dirname
    );
    addReplyLog("success", `${zernioReviews.length} reseñas GMB del inbox de Zernio cargadas para matching y respuesta.`);
  } catch (error) {
    zernioFetchError = error;
    addReplyLog("error", `Zernio no pudo cargar reseñas GMB: ${error.message}`);
    addReplyLog("warn", "Se omite el envio automatico hasta que Zernio vuelva a responder. No se publicara ninguna respuesta sin lectura fresca de Zernio.");
    if (!dryRun) throw error;
  }
  let defaultZernioAccountId =
    input.zernioAccountId ||
    config.zernioAccountId ||
    zernioReviews.find((review) => review.accountId)?.accountId ||
    "";
  if (!defaultZernioAccountId) {
    try {
      defaultZernioAccountId = await resolveZernioGoogleBusinessAccountId(
        { zernioAccountId: input.zernioAccountId || config.zernioAccountId },
        config,
        addReplyLog
      );
    } catch (error) {
      addReplyLog("warn", `No se pudo resolver accountId por defecto de Zernio: ${error.message}`);
    }
  }

  const newRecords = [];
  const results = [];
  const summary = {
    received: tickets.length,
    gmbTickets: 0,
    eligible: 0,
    ready: 0,
    replied: 0,
    skipped: 0,
    errors: 0,
    alreadyReplied: 0,
    manualReview: 0
  };

  for (const ticket of tickets) {
    const ticketId = String(ticket.ticketId || "");
    const source = ticket.source === "GMB" ? "GMB" : ticket.source === "Trustpilot" ? "Trustpilot" : "UNKNOWN";
    const base = {
      ticketId,
      source,
      reviewId: ticket.reviewId || ticket.matchedReviewId || null,
      clientName: ticket.clientName || ticket.matchName || null,
      sentiment: ticket.reviewSentiment === "positive" ? "positive" : "negative",
      status: "skipped",
      message: "",
      error: null
    };

    if (source !== "GMB") {
      summary.skipped += 1;
      results.push({ ...base, reason: "Solo se responden reseñas GMB; Trustpilot/UNKNOWN quedan omitidas." });
      continue;
    }
    summary.gmbTickets += 1;

    if (zernioFetchError) {
      const reviewIds = ticketReviewIdentifiers(ticket);
      const existingReply =
        existingMaps.byTicket.get(ticketId) ||
        reviewIds.map((id) => existingMaps.byReview.get(String(id))).find(Boolean) ||
        null;
      if (existingReply) {
        summary.alreadyReplied += 1;
        results.push({
          ...base,
          reviewId: existingReply.reviewId || base.reviewId,
          status: "already_replied",
          message: existingReply.message || "",
          reason: "Zernio no pudo cargar reseñas ahora; se conserva respuesta ya registrada en historial local."
        });
      } else {
        summary.manualReview += 1;
        results.push({
          ...base,
          status: "manual_review",
          reason: `Zernio no esta disponible para leer reseñas (${zernioFetchError.message}). No se publica sin lectura fresca de Zernio.`
        });
      }
      continue;
    }

    let match = matchHubSpotTicketToZernioReview(ticket, zernioReviews);
    if (!match.matched || !match.reviewId) {
      const urlMatch = await matchFromGoogleMapsUrlFallback(ticket);
      if (urlMatch) match = urlMatch;
    }
    addReplyLog("info", `Ticket ${ticketId}: match Zernio ${match.matchConfidence} - ${match.matchExplanation}`);
    if (!match.matched || !match.reviewId) {
      summary.skipped += 1;
      results.push({ ...base, status: "skipped", reason: match.matchExplanation });
      continue;
    }
    if (!match.matchedReview && !isReplyableGoogleBusinessReviewId(match.reviewId)) {
      summary.manualReview += 1;
      results.push({
        ...base,
        reviewId: match.reviewId,
        status: "manual_review",
        matchConfidence: "low",
        matchExplanation: match.matchExplanation,
        reason: "El enlace de Google no devolvio un reviewId respondible por Zernio; requiere revisar la URL o emparejar la reseña desde Zernio."
      });
      continue;
    }

    const accountId = match.matchedReview?.accountId || defaultZernioAccountId;
    if (hasRemoteReply(match.matchedReview)) {
      summary.alreadyReplied += 1;
      results.push({
        ...base,
        reviewId: match.reviewId,
        status: "already_replied",
        matchConfidence: match.matchConfidence,
        matchExplanation: match.matchExplanation,
        message: match.matchedReview.reply,
        reason: "Zernio ya devuelve una respuesta publicada para esta reseña."
      });
      continue;
    }

    const alreadyReplied = existingMaps.byTicket.has(ticketId) || existingMaps.byReview.has(String(match.reviewId));
    if (alreadyReplied) {
      summary.alreadyReplied += 1;
      results.push({
        ...base,
        reviewId: match.reviewId,
        status: "already_replied",
        matchConfidence: match.matchConfidence,
        matchExplanation: match.matchExplanation,
        reason: "La reseña ya tiene respuesta registrada en el historial local."
      });
      continue;
    }

    const decision = selectGmbReviewReply({
      ...ticket,
      reviewId: match.reviewId,
      matchConfidence: match.matchConfidence,
      matchedReview: match.matchedReview
    });
    if (!decision.shouldReply) {
      summary.skipped += 1;
      results.push({ ...base, reviewId: match.reviewId, status: "skipped", reason: decision.reason });
      continue;
    }

    if (!accountId) {
      summary.errors += 1;
      results.push({
        ...base,
        reviewId: match.reviewId,
        status: "error",
        replyType: decision.replyType,
        message: decision.message,
        error: "No se encontro accountId de Zernio para responder."
      });
      continue;
    }

    summary.eligible += 1;
    const result = {
      ...base,
      reviewId: match.reviewId,
      accountId,
      status: dryRun ? "ready" : "replied",
      replyType: decision.replyType,
      message: decision.message,
      matchConfidence: match.matchConfidence,
      matchExplanation: match.matchExplanation,
      reason: decision.reason
    };

    if (dryRun) {
      summary.ready += 1;
      results.push(result);
      continue;
    }

    try {
      const zernioResponse = await replyToZernioGmbReview(
        { reviewId: match.reviewId, accountId, message: decision.message },
        config
      );
      const record = {
        id: crypto.randomUUID(),
        ticketId,
        reviewId: match.reviewId,
        source: "GMB",
        zernioAccountId: accountId,
        zernioPublishEndpoint: "google-business-review",
        googlePublished: Boolean(zernioResponse?.success),
        clientName: result.clientName,
        sentiment: result.sentiment,
        service: ticket.service || ticket.projectType || "UNKNOWN",
        replyType: decision.replyType,
        message: decision.message,
        status: zernioResponse?.success ? "replied" : "zernio_acknowledged",
        verificationStatus: zernioResponse?.success ? "published_by_google_business_endpoint" : "unverified",
        matchConfidence: match.matchConfidence,
        matchExplanation: match.matchExplanation,
        repliedAt: new Date().toISOString(),
        repliedBy: "local_user",
        zernioResponse
      };
      newRecords.push(record);
      if (record.status === "replied") summary.replied += 1;
      else summary.manualReview += 1;
      results.push({
        ...result,
        status: record.status,
        googlePublished: record.googlePublished,
        verificationStatus: record.verificationStatus,
        repliedAt: record.repliedAt
      });
      addReplyLog(
        record.googlePublished ? "success" : "warn",
        `${record.googlePublished ? "Respuesta GMB publicada" : "Respuesta GMB enviada pero no verificada"} para ticket ${ticketId} / reseña ${match.reviewId}.`
      );
    } catch (error) {
      summary.errors += 1;
      const record = {
        id: crypto.randomUUID(),
        ticketId,
        reviewId: match.reviewId,
        source: "GMB",
        zernioAccountId: accountId,
        message: decision.message,
        status: "error",
        error: error.message,
        matchConfidence: match.matchConfidence,
        matchExplanation: match.matchExplanation,
        attemptedAt: new Date().toISOString(),
        attemptedBy: "local_user"
      };
      newRecords.push(record);
      results.push({ ...result, status: "error", error: error.message });
      addReplyLog("error", `Error respondiendo ticket ${ticketId}: ${error.message}`);
    }
  }

  if (!dryRun && newRecords.length) {
    const merged = [
      ...newRecords,
      ...existing.filter((item) => !newRecords.some((record) => record.ticketId === item.ticketId || record.reviewId === item.reviewId))
    ];
    await saveGmbReviewReplies(merged);
  }

  return {
    success: true,
    dryRun,
    summary,
    results,
    logs: log,
    persistedPath: path.relative(__dirname, gmbReviewRepliesPath)
  };
}

async function replyPositiveGmbReviewsFromZernio(input) {
  const dryRun = input.dryRun !== false;
  const log = [];
  const addReplyLog = (level, message) => log.push({ time: new Date().toISOString(), level, message: redact(message) });
  const maxReviews = Math.max(1, Math.min(Number(input.maxReviews || config.maxReviewsCap || 5000), config.maxReviewsCap));

  addReplyLog("info", `${dryRun ? "Dry-run" : "Ejecucion real"} de respuestas positivas GMB/Zernio iniciado. Limite: ${maxReviews}.`);

  const optimizedSearch = await fetchZernioPositiveUnrepliedGmbReviews(
    {
      zernioAccountId: input.zernioAccountId || config.zernioAccountId,
      zernioLocationId: input.zernioLocationId || config.zernioLocationId,
      maxReviews
    },
    config,
    addReplyLog,
    __dirname
  );
  const zernioReviews = optimizedSearch.reviews || [];

  let defaultZernioAccountId =
    input.zernioAccountId ||
    config.zernioAccountId ||
    optimizedSearch.accountId ||
    zernioReviews.find((review) => review.accountId)?.accountId ||
    "";
  if (!defaultZernioAccountId) {
    defaultZernioAccountId = await resolveZernioGoogleBusinessAccountId(
      { zernioAccountId: input.zernioAccountId || config.zernioAccountId },
      config,
      addReplyLog
    );
  }

  const existing = await loadGmbReviewReplies();
  const existingMaps = gmbReplyMaps(
    existing.filter((item) => ["replied", "zernio_acknowledged", "already_replied"].includes(item.status))
  );
  const summary = {
    received: zernioReviews.length,
    optimizedSearch: true,
    zernioPages: optimizedSearch.pages || 0,
    providerTotal: optimizedSearch.providerTotal || null,
    positive: 0,
    eligible: 0,
    ready: 0,
    replied: 0,
    alreadyReplied: 0,
    skipped: 0,
    errors: 0,
    manualReview: 0
  };
  const results = [];
  const candidates = [];

  for (const review of zernioReviews) {
    const rating = Number(review.rating || 0);
    const reviewId = String(review.id || "");
    const accountId = review.accountId || defaultZernioAccountId;
    const base = {
      ticketId: null,
      source: "GMB",
      reviewId,
      accountId,
      author: review.author || "",
      rating: review.rating || null,
      reviewUrl: review.sourceUrl || "",
      sentiment: "positive",
      status: "skipped",
      message: "",
      error: null
    };

    if (!rating || rating < 4) {
      summary.skipped += 1;
      continue;
    }
    summary.positive += 1;

    if (hasRemoteReply(review)) {
      summary.alreadyReplied += 1;
      summary.skipped += 1;
      results.push({
        ...base,
        status: "already_replied",
        message: review.reply || "",
        reason: "Zernio ya devuelve una respuesta publicada para esta reseña positiva."
      });
      continue;
    }

    const existingReply = existingMaps.byReview.get(reviewId) || existingMaps.byReview.get(canonicalGmbReviewId(reviewId));
    if (existingReply) {
      summary.alreadyReplied += 1;
      summary.skipped += 1;
      results.push({
        ...base,
        status: "already_replied",
        message: existingReply.message || "",
        reason: "La reseña positiva ya tiene respuesta registrada en el historial local."
      });
      continue;
    }

    if (!accountId) {
      summary.errors += 1;
      results.push({
        ...base,
        status: "error",
        error: "No se encontro accountId de Zernio para responder esta reseña positiva."
      });
      continue;
    }

    candidates.push({ review, accountId, base });
  }

  addReplyLog(
    "info",
    `${summary.positive} reseñas positivas encontradas; ${candidates.length} sin respuesta remota/local listas para generar mensaje.`
  );

  const generatedMessages = await generatePositiveGmbReplyMessages(
    candidates.map((item) => item.review),
    addReplyLog
  );

  const newRecords = [];
  for (const item of candidates) {
    const generated = generatedMessages.get(String(item.review.id)) || {};
    const message = generated.message || sanitizePositiveReplyMessage(selectPositiveReplyVariant(item.review.id), item.review);
    const result = {
      ...item.base,
      reviewId: item.review.id,
      accountId: item.accountId,
      status: dryRun ? "ready" : "replied",
      replyType: "positive_gmb_gemini",
      message,
      matchConfidence: "high",
      matchExplanation: "Reseña positiva obtenida directamente desde Zernio GBP; 4+ estrellas y sin respuesta.",
      reason: generated.reason || "Respuesta positiva generada a partir de plantilla ORBIDI con variacion Gemini.",
      aiProvider: "gemini",
      aiModel: generated.model || config.geminiModel
    };

    summary.eligible += 1;

    if (dryRun) {
      summary.ready += 1;
      results.push(result);
      continue;
    }

    try {
      const zernioResponse = await replyToZernioGmbReview(
        { reviewId: item.review.id, accountId: item.accountId, message },
        config
      );
      const record = {
        id: crypto.randomUUID(),
        ticketId: null,
        reviewId: item.review.id,
        source: "GMB",
        sourcePanel: "gmb_zernio",
        zernioAccountId: item.accountId,
        zernioPublishEndpoint: "google-business-review",
        googlePublished: Boolean(zernioResponse?.success),
        clientName: item.review.author || null,
        reviewAuthor: item.review.author || null,
        rating: item.review.rating || null,
        sentiment: "positive",
        service: "UNKNOWN",
        replyType: "positive_gmb_gemini",
        message,
        status: zernioResponse?.success ? "replied" : "zernio_acknowledged",
        verificationStatus: zernioResponse?.success ? "published_by_google_business_endpoint" : "unverified",
        matchConfidence: "high",
        matchExplanation: result.matchExplanation,
        repliedAt: new Date().toISOString(),
        repliedBy: "local_user",
        zernioResponse
      };
      newRecords.push(record);
      if (record.status === "replied") summary.replied += 1;
      else summary.manualReview += 1;
      results.push({
        ...result,
        status: record.status,
        googlePublished: record.googlePublished,
        verificationStatus: record.verificationStatus,
        repliedAt: record.repliedAt
      });
      addReplyLog(
        record.googlePublished ? "success" : "warn",
        `${record.googlePublished ? "Respuesta positiva publicada" : "Respuesta positiva enviada sin verificacion"} para reseña ${item.review.id}.`
      );
    } catch (error) {
      summary.errors += 1;
      const record = {
        id: crypto.randomUUID(),
        ticketId: null,
        reviewId: item.review.id,
        source: "GMB",
        sourcePanel: "gmb_zernio",
        zernioAccountId: item.accountId,
        reviewAuthor: item.review.author || null,
        rating: item.review.rating || null,
        sentiment: "positive",
        replyType: "positive_gmb_gemini",
        message,
        status: "error",
        error: error.message,
        matchConfidence: "high",
        matchExplanation: result.matchExplanation,
        attemptedAt: new Date().toISOString(),
        attemptedBy: "local_user"
      };
      newRecords.push(record);
      results.push({ ...result, status: "error", error: error.message });
      addReplyLog("error", `Error respondiendo reseña positiva ${item.review.id}: ${error.message}`);
    }
  }

  if (!dryRun && newRecords.length) {
    const newReviewKeys = new Set(newRecords.map((record) => canonicalGmbReviewId(record.reviewId)).filter(Boolean));
    const merged = [
      ...newRecords,
      ...existing.filter((item) => !newReviewKeys.has(canonicalGmbReviewId(item.reviewId)))
    ];
    await saveGmbReviewReplies(merged);
  }

  return {
    success: true,
    dryRun,
    summary,
    results,
    logs: log,
    persistedPath: path.relative(__dirname, gmbReviewRepliesPath)
  };
}

function associationByTicketId(items) {
  return new Map(items.map((item) => [String(item.ticketId), item]));
}

function enrichHubspotReport(report, associations, gmbReplies = []) {
  if (!report?.items) return report;
  const byTicket = associationByTicketId(associations);
  const replyMaps = gmbReplyMaps(gmbReplies);
  const enrichRow = (row) => {
    const association = byTicket.get(String(row.ticketId));
    const reviewIds = ticketReviewIdentifiers(row);
    const reply =
      replyMaps.byTicket.get(String(row.ticketId)) ||
      reviewIds.map((id) => replyMaps.byReview.get(String(id))).find(Boolean) ||
      null;
    return {
      ...row,
      associationStatus: association ? "confirmed" : "pending",
      confirmedAssociation: association || null,
      gmbReply: reply,
      gmbReplyStatus: reply?.status || (row.source === "GMB" ? "pending" : "not_applicable"),
      gmbReplyMessage: reply?.message || "",
      gmbReplyError: reply?.error || ""
    };
  };
  const items = report.items.map(enrichRow);
  const rebuild = (rows) => rows.map((row) => items.find((item) => item.ticketId === row.ticketId) || enrichRow(row));
  const confirmedCount = items.filter((item) => item.associationStatus === "confirmed").length;
  const bySource = items.reduce(
    (acc, item) => {
      const source = item.source === "GMB" || item.source === "Trustpilot" ? item.source : "UNKNOWN";
      acc[source] += 1;
      return acc;
    },
    { GMB: 0, Trustpilot: 0, UNKNOWN: 0 }
  );
  const gmbReplySummary = items.reduce(
    (acc, item) => {
      if (item.source !== "GMB") return acc;
      acc.gmbElegibles += 1;
      if (item.gmbReplyStatus === "replied") acc.respondidas += 1;
      else if (item.gmbReplyStatus === "error") acc.errores += 1;
      else if (item.gmbReplyStatus === "zernio_acknowledged") acc.acuseZernio += 1;
      else if (item.gmbReplyStatus === "already_replied") acc.yaRespondidas += 1;
      else acc.pendientes += 1;
      return acc;
    },
    { gmbElegibles: 0, respondidas: 0, omitidas: 0, errores: 0, acuseZernio: 0, yaRespondidas: 0, pendientesManual: 0, pendientes: 0 }
  );

  return {
    ...report,
    items,
    matches: rebuild(report.matches || []),
    possibleMatches: rebuild(report.possibleMatches || []),
    unmatched: rebuild(report.unmatched || []),
    positiveReviews: rebuild(report.positiveReviews || []),
    negativeReviews: rebuild(report.negativeReviews || []),
    kdPcReviews: rebuild(report.kdPcReviews || []),
    kdMarketingReviews: rebuild(report.kdMarketingReviews || []),
    bySource,
    gmbReplySummary,
    confirmedAssociations: associations,
    totals: {
      ...report.totals,
      sourceGmb: bySource.GMB,
      sourceTrustpilot: bySource.Trustpilot,
      sourceUnknown: bySource.UNKNOWN,
      totalHubSpotInbox: items.length,
      asociacionesConfirmadas: confirmedCount,
      asociacionesPendientes: items.length - confirmedCount,
      posiblesCoincidencias: (report.possibleMatches || []).length,
      gmbElegibles: gmbReplySummary.gmbElegibles,
      gmbRespondidas: gmbReplySummary.respondidas,
      gmbOmitidas: gmbReplySummary.omitidas,
      gmbErrores: gmbReplySummary.errores,
      gmbAcuseZernio: gmbReplySummary.acuseZernio,
      gmbYaRespondidas: gmbReplySummary.yaRespondidas,
      gmbPendientesManual: gmbReplySummary.pendientesManual
    }
  };
}

function runHubspotAnalysis() {
  if (hubspotJob?.status === "running") return hubspotJob;

  const job = {
    id: crypto.randomUUID(),
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    logs: [],
    error: null
  };
  hubspotJob = job;

  const nodePath = process.execPath;
  const child = spawn(nodePath, [path.join(__dirname, "scripts", "hubspot-new-ticket-matches.mjs")], {
    cwd: __dirname,
    env: process.env,
    windowsHide: true
  });

  const pushLog = (level, message) => {
    job.logs.push({ time: new Date().toISOString(), level, message: redact(String(message || "").trim()) });
    job.updatedAt = new Date().toISOString();
  };

  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) pushLog("info", line);
  });
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) pushLog("error", line);
  });
  child.on("error", (error) => {
    job.status = "failed";
    job.error = error.message;
    pushLog("error", error.message);
  });
  child.on("close", (code) => {
    if (job.status !== "failed") {
      if (code !== 0) {
        job.status = "failed";
        job.error = `HubSpot finalizo con codigo ${code}.`;
        pushLog("error", job.error);
      } else {
        pushLog("success", "Analisis HubSpot finalizado. Iniciando relleno automatico de campos de tickets.");
        (async () => {
          try {
            const report = await readJsonSafe(hubspotTicketMatchesPath, null);
            const autofill = await autofillAnalyzedHubspotTicketFields(report, pushLog);
            const updatedReport = {
              ...report,
              autoFieldUpdate: {
                ...autofill,
                updatedAt: new Date().toISOString()
              }
            };
            await writeFile(hubspotTicketMatchesPath, JSON.stringify(updatedReport, null, 2), "utf8");
            await writeFile(path.join(dataDir, "hubspot-customer-success-inbox-matches.json"), JSON.stringify(updatedReport, null, 2), "utf8");
            job.status = "done";
            pushLog("success", `Relleno automatico finalizado: ${autofill.updated} actualizados, ${autofill.skipped} omitidos, ${autofill.errors} errores.`);
          } catch (error) {
            job.status = "failed";
            job.error = `Error en relleno automatico de campos: ${error.message}`;
            pushLog("error", job.error);
          } finally {
            job.updatedAt = new Date().toISOString();
          }
        })();
      }
    }
    job.updatedAt = new Date().toISOString();
  });

  return job;
}

async function runJob(job) {
  const log = (level, message, meta) => addLog(job, level, message, meta);
  job.status = "running";
  log("info", "Trabajo iniciado.");

  try {
    const maxReviews = Math.max(1, Math.min(Number(job.input.maxReviews || 100), config.maxReviewsCap));
    log("info", `Fuente seleccionada: ${job.input.source || "serpapi"}. Limite: ${maxReviews} resenas.`);

    const allReviews = await collectReviews({ ...job.input, maxReviews }, config, log, __dirname);
    if (!allReviews.length) {
      throw new Error("No se encontraron resenas para analizar.");
    }

    let reviews = allReviews;
    let knownCount = null;
    const onlyNew = Boolean(job.input.onlyNew);
    if (onlyNew) {
      const knownIds = await loadKnownReviewIds();
      knownCount = knownIds.size;
      reviews = allReviews.filter((review) => {
        const key = reviewKey(review);
        return key && !knownIds.has(key);
      });
      log("info", `${knownCount} resenas ya estaban registradas en el snapshot.`);
      log("info", `${reviews.length} resenas nuevas detectadas.`);
    }

    log("info", `${reviews.length} resenas listas para clasificar.`);
    const classifications = reviews.length ? await classifyReviews(reviews, config, log) : [];
    const report = buildReport(reviews, classifications, {
      source: job.input.source,
      companyName: job.input.companyName,
      googleUrl: job.input.googleUrl,
      generatedAt: new Date().toISOString(),
      aiProvider: config.geminiApiKey ? "gemini" : "local-fallback",
      aiModel: config.geminiApiKey ? config.geminiModel : "local-fallback",
      onlyNew,
      allReviewCount: allReviews.length,
      knownReviewCount: knownCount,
      newReviewCount: reviews.length
    });

    job.result = report;
    job.status = "done";
    job.updatedAt = new Date().toISOString();

    await mkdir(dataDir, { recursive: true });
    await writeFile(onlyNew ? lastNewAnalysisPath : lastAnalysisPath, JSON.stringify(report, null, 2), "utf8");
    await saveReviewSnapshot(allReviews, {
      source: job.input.source,
      companyName: job.input.companyName,
      allReviewCount: allReviews.length,
      lastJobId: job.id
    });

    if (onlyNew) {
      log(
        "success",
        `Revision de nuevas finalizada: ${report.totals.total} nuevas, ${report.totals.positive} positivas, ${report.totals.negative} negativas.`
      );
    } else {
      log("success", `Analisis finalizado: ${report.totals.positive} positivas, ${report.totals.negative} negativas.`);
    }
    job.emitter.emit("done", report);
  } catch (error) {
    job.status = "error";
    job.error = redact(error?.message || String(error));
    job.updatedAt = new Date().toISOString();
    log("error", job.error);
    job.emitter.emit("failed", { message: job.error });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const target = path.normalize(path.join(publicDir, requested));

  if (!target.startsWith(publicDir)) {
    json(res, 403, { error: "Forbidden" });
    return;
  }

  try {
    const fileStat = await stat(target);
    if (!fileStat.isFile()) {
      json(res, 404, { error: "Not found" });
      return;
    }

    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "content-type": mimeTypes[ext] || "application/octet-stream" });
    createReadStream(target).pipe(res);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, time: new Date().toISOString() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      json(res, 200, publicConfig());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/reports/latest") {
      json(res, 200, await latestReports());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/hubspot/new-ticket-matches") {
      const report = await readJsonSafe(hubspotTicketMatchesPath, null);
      if (!report) {
        json(res, 404, { error: "No hay reporte de HubSpot generado todavia." });
        return;
      }
      const associations = await loadConfirmedAssociations();
      const gmbReplies = await loadGmbReviewReplies();
      json(res, 200, enrichHubspotReport(report, associations, gmbReplies));
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/hubspot/confirmed-associations") {
      json(res, 200, { items: await loadConfirmedAssociations() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/hubspot/gmb-review-replies") {
      json(res, 200, { items: await loadGmbReviewReplies() });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/hubspot/sheet-association-audit") {
      const audit = await readJsonSafe(sheetAssociationAuditPath, { updatedAt: null, summary: null, items: [] });
      json(res, 200, audit);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hubspot/confirm-association") {
      const input = await readJsonBody(req);
      const association = await confirmAssociation(input);
      json(res, 200, {
        success: true,
        associationId: association.associationId,
        confirmedAt: association.confirmedAt,
        hubspotAssociationStatus: association.hubspotAssociationStatus,
        hubspotAssociated: association.hubspotAssociated,
        hubspotAssociationResults: association.hubspotAssociationResults,
        hubspotAssociationErrors: association.hubspotAssociationErrors,
        ticketUpdateStatus: association.ticketUpdateStatus,
        ticketUpdateProperties: association.ticketUpdateProperties,
        ticketUpdateError: association.ticketUpdateError
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hubspot/confirm-association/preview") {
      const input = await readJsonBody(req);
      const preview = await previewAssociationConfirmation(input);
      json(res, 200, {
        success: true,
        ticketId: preview.normalized.ticketId,
        targets: preview.targets,
        properties: preview.properties
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hubspot/associate-unmatched-from-sheet") {
      const input = await readJsonBody(req);
      const result = await associateUnmatchedFromSheet(input);
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hubspot/reply-gmb-reviews") {
      const input = await readJsonBody(req);
      const result = await replyGmbReviewsFromHubSpot(input);
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/gmb/reply-positive-reviews") {
      const input = await readJsonBody(req);
      const result = await replyPositiveGmbReviewsFromZernio(input);
      json(res, 200, result);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/hubspot/review-form-config") {
      const report = await readJsonSafe(hubspotTicketMatchesPath, null);
      if (!report?.reviewFormConfig) {
        json(res, 200, { formId: null, formUrl: null, fields: [], relevantFields: [], isConfigured: false, message: "Ejecuta Analizar HubSpot para obtener la configuracion del formulario." });
        return;
      }
      json(res, 200, report.reviewFormConfig);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/hubspot/debug/stages") {
      try {
        _allPipelineStages = null;
        const stages = await fetchAllPipelineStages();
        const contactingId = await getContactingStageId();
        json(res, 200, { stages, detectedContactingStageId: contactingId });
      } catch (error) {
        json(res, 500, { error: error.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/hubspot/analyze") {
      const job = runHubspotAnalysis();
      json(res, 202, { jobId: job.id, status: job.status });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/hubspot/analyze/status") {
      json(res, 200, hubspotJob || { status: "idle", logs: [] });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/analyze") {
      const input = await readJsonBody(req);
      const job = createJob(input);
      setTimeout(() => runJob(job), 0);
      json(res, 202, { jobId: job.id });
      return;
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/events)?$/);
    if (jobMatch && req.method === "GET") {
      const job = jobs.get(jobMatch[1]);
      if (!job) {
        json(res, 404, { error: "Job not found" });
        return;
      }

      if (url.pathname.endsWith("/events")) {
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });

        for (const entry of job.logs) sendSse(res, "log", entry);
        if (job.status === "done") sendSse(res, "done", job.result);
        if (job.status === "error") sendSse(res, "failed", { message: job.error });

        const onLog = (entry) => sendSse(res, "log", entry);
        const onDone = (result) => sendSse(res, "done", result);
        const onFailed = (error) => sendSse(res, "failed", error);
        const heartbeat = setInterval(() => res.write(": keep-alive\n\n"), 15000);

        job.emitter.on("log", onLog);
        job.emitter.once("done", onDone);
        job.emitter.once("failed", onFailed);

        req.on("close", () => {
          clearInterval(heartbeat);
          job.emitter.off("log", onLog);
          job.emitter.off("done", onDone);
          job.emitter.off("failed", onFailed);
        });
        return;
      }

      json(res, 200, {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        logs: job.logs,
        result: job.result,
        error: job.error
      });
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    json(res, 405, { error: "Method not allowed" });
  } catch (error) {
    json(res, 500, { error: redact(error?.message || String(error)) });
  }
});

const serverHost = process.env.PORT ? "0.0.0.0" : "127.0.0.1";
server.listen(config.port, serverHost, () => {
  console.log(`GMB review automation running at http://${serverHost}:${config.port}`);
});
