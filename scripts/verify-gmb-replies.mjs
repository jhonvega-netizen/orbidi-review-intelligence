import { readFile, writeFile } from "node:fs/promises";
import { loadConfig } from "../src/config.mjs";

const config = loadConfig(process.cwd());
const repliesPath = new URL("../data/gmb-review-replies.json", import.meta.url);

function reviewParts(resourceName) {
  const raw = String(resourceName || "");
  return {
    locationId: raw.match(/\/locations\/([^/]+)/)?.[1] || "",
    reviewId: raw.match(/\/reviews\/([^/?#]+)/)?.[1] || raw
  };
}

function reviewUrlFromZernioReview(review) {
  return String(
    review?.reviewUrl ||
    review?.sourceUrl ||
    review?.link ||
    review?.url ||
    review?.metadata?.reviewUrl ||
    review?.metadata?.mapsUri ||
    ""
  ).trim();
}

async function zernioFetch(pathname, params = {}) {
  const base = config.zernioBaseUrl.replace(/\/+$/, "");
  const url = new URL(`${base}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${config.zernioApiKey}`,
      accept: "application/json"
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error?.message || data.message || data.error || data.status || "";
    throw new Error(detail ? `Zernio HTTP ${response.status}: ${detail}` : `Zernio HTTP ${response.status}`);
  }
  return data;
}

async function findReview({ accountId, locationId, reviewId }) {
  let pageToken = "";
  for (let page = 0; page < 80; page += 1) {
    const data = await zernioFetch(`/accounts/${encodeURIComponent(accountId)}/gmb-reviews`, {
      locationId,
      pageSize: 50,
      pageToken
    });
    const reviews = Array.isArray(data.reviews) ? data.reviews : [];
    const found = reviews.find((review) => {
      const candidate = String(review.reviewId || review.id || review.name || "");
      return candidate === reviewId || candidate.includes(reviewId);
    });
    if (found) return found;
    pageToken = data.nextPageToken || "";
    if (!pageToken) break;
  }
  return null;
}

const raw = await readFile(repliesPath, "utf8");
const data = JSON.parse(raw);
const items = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
const updated = [];
let verified = 0;
let notFound = 0;
let withoutReply = 0;
let errors = 0;

for (const item of items) {
  if (item.source !== "GMB" || !item.reviewId || !item.zernioAccountId || item.status === "error") {
    updated.push(item);
    continue;
  }
  const { locationId, reviewId } = reviewParts(item.reviewId);
  try {
    const review = await findReview({ accountId: item.zernioAccountId, locationId, reviewId });
    if (!review) {
      notFound += 1;
      updated.push({
        ...item,
        status: item.status === "replied" ? "zernio_acknowledged" : item.status,
        googlePublished: false,
        verificationStatus: "review_not_found_in_gmb_location",
        verifiedAt: new Date().toISOString()
      });
      continue;
    }

    const reply = review.reviewReply || review.reply || null;
    if (!reply) {
      withoutReply += 1;
      updated.push({
        ...item,
        status: "zernio_acknowledged",
        googlePublished: false,
        verificationStatus: "gmb_review_found_without_reply",
        verifiedAt: new Date().toISOString()
      });
      continue;
    }

    verified += 1;
    updated.push({
      ...item,
      status: "replied",
      googlePublished: true,
      verificationStatus: "verified_from_google_business_reviews",
      verifiedAt: new Date().toISOString(),
      googleReviewUrl: reviewUrlFromZernioReview(review) || item.googleReviewUrl || item.reviewUrl || null,
      googleReply: reply
    });
  } catch (error) {
    errors += 1;
    updated.push({
      ...item,
      status: item.status === "replied" ? "zernio_acknowledged" : item.status,
      googlePublished: false,
      verificationStatus: "verification_error",
      verificationError: error.message,
      verifiedAt: new Date().toISOString()
    });
  }
}

await writeFile(
  repliesPath,
  JSON.stringify({ updatedAt: new Date().toISOString(), verificationSummary: { verified, notFound, withoutReply, errors }, items: updated }, null, 2),
  "utf8"
);

console.log(JSON.stringify({ verified, notFound, withoutReply, errors, total: items.length }));
