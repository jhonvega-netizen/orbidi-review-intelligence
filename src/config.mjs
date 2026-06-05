import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const index = trimmed.indexOf("=");
  if (index === -1) return null;
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

export function loadConfig(rootDir) {
  const envPath = path.join(rootDir, ".env");
  if (existsSync(envPath)) {
    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (!(key in process.env)) process.env[key] = value;
    }
  }

  return {
    port: Number(process.env.PORT || 4173),
    maxReviewsCap: Number(process.env.MAX_REVIEWS_CAP || 5000),
    geminiApiKey: process.env.GEMINI_API_KEY || "",
    geminiModel: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    geminiChunkSize: Number(process.env.GEMINI_CHUNK_SIZE || 50),
    geminiConcurrency: Number(process.env.GEMINI_CONCURRENCY || 4),
    openaiApiKey: process.env.OPENAI_API_KEY || "",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    serpapiApiKey: process.env.SERPAPI_API_KEY || "",
    zernioApiKey: process.env.ZERNIO_API_KEY || "",
    zernioBaseUrl: process.env.ZERNIO_BASE_URL || "https://zernio.com/api/v1",
    zernioAccountId: process.env.ZERNIO_ACCOUNT_ID || "",
    zernioLocationId: process.env.ZERNIO_LOCATION_ID || "",
    hubspotAccessToken: process.env.HUBSPOT_ACCESS_TOKEN || "",
    hubspotPortalId: process.env.HUBSPOT_PORTAL_ID || process.env.PORTAL_ID || "",
    hubspotReviewFormId: process.env.HUBSPOT_REVIEW_FORM_ID || "",
    hubspotContactingStageId: process.env.HUBSPOT_CONTACTING_STAGE_ID || "",
    hubspotContactingStageLabel: process.env.HUBSPOT_CONTACTING_STAGE_LABEL || "intentando contactar",
    hubspotPlatformValueGmb: process.env.HUBSPOT_PLATFORM_VALUE_GMB || "Google",
    hubspotPlatformValueTrustpilot: process.env.HUBSPOT_PLATFORM_VALUE_TRUSTPILOT || "Trustpilot",
    gbpAccessToken: process.env.GBP_ACCESS_TOKEN || "",
    gbpAccountId: process.env.GBP_ACCOUNT_ID || "",
    gbpLocationId: process.env.GBP_LOCATION_ID || "",
    allowLocalClassifier: process.env.ALLOW_LOCAL_CLASSIFIER !== "0"
  };
}
