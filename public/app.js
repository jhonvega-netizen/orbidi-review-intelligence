const state = {
  source: "zernio",
  filter: "all",
  hubspotFilter: "all",
  hubspotReport: null,
  hubspotReplyPreview: null,
  sheetAssociationPreview: null,
  gmbPositiveReplyPreview: null,
  result: null,
  lastNewResult: null,
  eventSource: null,
  selectedCandidates: new Map()
};

const els = {
  form: document.querySelector("#analysisForm"),
  runButton: document.querySelector("#runButton"),
  sampleButton: document.querySelector("#sampleButton"),
  newReviewsButton: document.querySelector("#newReviewsButton"),
  exportButton: document.querySelector("#exportButton"),
  clearLogsButton: document.querySelector("#clearLogsButton"),
  terminal: document.querySelector("#terminal"),
  summaryGrid: document.querySelector("#summaryGrid"),
  rateLabels: document.querySelector("#rateLabels"),
  reviewsTable: document.querySelector("#gmb-cards"),
  configStatus: document.querySelector("#configStatus"),
  reportContext: document.querySelector("#reportContext"),
  newReviewStatus: document.querySelector("#newReviewStatus"),
  newTotal: document.querySelector("#newTotal"),
  newPositive: document.querySelector("#newPositive"),
  newNegative: document.querySelector("#newNegative"),
  gmbPositiveReplyButton: document.querySelector("#gmbPositiveReplyButton"),
  gmbPositiveReplyAudit: document.querySelector("#gmbPositiveReplyAudit"),
  hubspotStatus: document.querySelector("#hubspotStatus"),
  hubspotMetrics: document.querySelector("#hubspotMetrics"),
  gmbReplyAudit: document.querySelector("#gmbReplyAudit"),
  hubspotTable: document.querySelector("#hubspotTable"),
  hubspotAnalyzeButton: document.querySelector("#hubspotAnalyzeButton"),
  hubspotRefreshButton: document.querySelector("#hubspotRefreshButton"),
  hubspotSheetAssociateButton: document.querySelector("#hubspotSheetAssociateButton"),
  hubspotReplyGmbButton: document.querySelector("#hubspotReplyGmbButton"),
  hubspotClearButton: null
};

function setupHubspotMinimalUi() {
  document.querySelector("#section-hubspot .section-toolbar")?.classList.add("hubspot-toolbar");
  const info = document.querySelector("#section-hubspot .section-eyebrow");
  if (info) info.textContent = "HubSpot Reseñas";
  if (els.hubspotReplyGmbButton) els.hubspotReplyGmbButton.textContent = "Responder reseñas";

  const toolbar = document.querySelector("#section-hubspot .toolbar-actions");
  if (toolbar && !document.querySelector("#hubspotClearButton")) {
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.className = "ghost-button";
    clearButton.id = "hubspotClearButton";
    clearButton.textContent = "Limpiar";
    toolbar.insertBefore(clearButton, els.hubspotAnalyzeButton || null);
  }
  els.hubspotClearButton = document.querySelector("#hubspotClearButton");

  document.querySelectorAll("#section-hubspot .hubspot-tab").forEach((button) => {
    if (["gmb_replied", "gmb_ack", "gmb_pending", "gmb_errors"].includes(button.dataset.hubspotFilter)) {
      button.remove();
    }
  });
  const tabs = document.querySelector("#section-hubspot .tabs");
  if (tabs && !tabs.querySelector('[data-hubspot-filter="trustpilot"]')) {
    const trustpilotButton = document.createElement("button");
    trustpilotButton.type = "button";
    trustpilotButton.className = "hubspot-tab";
    trustpilotButton.dataset.hubspotFilter = "trustpilot";
    trustpilotButton.textContent = "Trustpilot";
    const negativeButton = tabs.querySelector('[data-hubspot-filter="negative"]');
    tabs.insertBefore(trustpilotButton, negativeButton || null);
  }
}

function timePart(iso) {
  return new Date(iso).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setBusy(isBusy) {
  els.runButton.disabled = isBusy;
  els.newReviewsButton.disabled = isBusy;
  if (els.gmbPositiveReplyButton) els.gmbPositiveReplyButton.disabled = isBusy;
  els.runButton.textContent = isBusy ? "Analizando..." : "Analizar todo";
}

function openTerminal() {
  if (!els.terminal.classList.contains("terminal-open")) {
    els.terminal.classList.add("terminal-open");
    const btn = document.getElementById("terminalToggle");
    if (btn) btn.textContent = "▼ Terminal de análisis";
  }
}

function appendLog(entry) {
  openTerminal();
  const level = entry.level || "info";
  const prefix = `[${timePart(entry.time || new Date().toISOString())}] ${level.toUpperCase()}`;
  const line = `${prefix.padEnd(22, " ")} ${entry.message}\n`;
  const span = document.createElement("span");
  span.className = `log-${level}`;
  span.textContent = line;
  els.terminal.appendChild(span);
  els.terminal.scrollTop = els.terminal.scrollHeight;
}

function resetLogs() {
  els.terminal.textContent = "";
}

function updateSource(source) {
  state.source = source;
  document.querySelectorAll(".segment").forEach((button) => {
    button.classList.toggle("active", button.dataset.source === source);
  });
  document.querySelectorAll(".source-field").forEach((field) => {
    field.classList.toggle("hidden", field.dataset.for !== source);
  });
}

function updateFilter(filter) {
  state.filter = filter;
  document.querySelectorAll(".tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === filter);
  });
  renderTable();
}

function updateHubspotFilter(filter) {
  state.hubspotFilter = filter;
  document.querySelectorAll(".hubspot-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.hubspotFilter === filter);
  });
  renderHubspotTable();
}

function metric(label, value, className = "") {
  return `
    <article class="metric ${className}">
      <span>${label}</span>
      <strong>${value}</strong>
    </article>
  `;
}

function renderSummary(result) {
  const totals = result?.totals;
  if (!totals) return;

  els.summaryGrid.innerHTML = [
    metric("Total", totals.total),
    metric("Positivas", totals.positive, "positive"),
    metric("Negativas", totals.negative, "negative"),
    metric("Rating medio", totals.averageRating ?? "-")
  ].join("");

  const positiveWidth = totals.total ? totals.positiveRate : 0;
  document.querySelector(".bar-positive").style.width = `${positiveWidth}%`;
  document.querySelector(".bar-negative").style.width = `${100 - positiveWidth}%`;
  els.rateLabels.innerHTML = `
    <span>${totals.positiveRate}% positivas</span>
    <span>${totals.negativeRate}% negativas</span>
  `;
}

function renderReportContext(result) {
  if (!result?.meta) {
    els.reportContext.innerHTML = `<span class="section-eyebrow">GMB / Zernio · Análisis de reseñas</span><strong>Sin análisis cargado</strong>`;
    return;
  }
  const mode = result.meta.onlyNew ? "Nuevas reseñas" : "Histórico completo";
  const generated = result.meta.generatedAt
    ? new Date(result.meta.generatedAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })
    : "-";
  const extra = result.meta.onlyNew
    ? `${result.meta.newReviewCount ?? result.totals.total} nuevas de ${result.meta.allReviewCount ?? "-"} revisadas`
    : `${result.totals.total} reseñas analizadas`;
  els.reportContext.innerHTML = `
    <span class="section-eyebrow">GMB / Zernio · ${escapeHtml(mode)}</span>
    <strong>${escapeHtml(extra)} · ${escapeHtml(generated)}</strong>
  `;
}

function renderNewSummary(result) {
  state.lastNewResult = result || state.lastNewResult;
  const current = state.lastNewResult;
  if (!current?.totals) return;

  const generated = current.meta?.generatedAt
    ? new Date(current.meta.generatedAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })
    : "-";
  els.newReviewStatus.textContent = `${generated} · ${current.meta?.allReviewCount ?? "-"} revisadas`;
  els.newTotal.textContent = current.totals.total;
  els.newPositive.textContent = current.totals.positive;
  els.newNegative.textContent = current.totals.negative;
}

function hubspotMetric(label, value, className = "") {
  return `
    <article class="metric ${className}">
      <span>${label}</span>
      <strong>${value}</strong>
    </article>
  `;
}

function normalizeHubspotRows(report) {
  if (!report) return [];
  const rows = report.items || [...(report.matches || []), ...(report.possibleMatches || []), ...(report.unmatched || [])];
  if (state.hubspotFilter === "negative") return report.negativeReviews || rows.filter((row) => row.reviewSentiment !== "positive");
  if (state.hubspotFilter === "possible") return report.possibleMatches || rows.filter((row) => hubspotMatchStatus(row) === "possible_match");
  if (state.hubspotFilter === "unmatched") return report.unmatched || rows.filter((row) => ["not_matched", "unidentifiable"].includes(hubspotMatchStatus(row)));
  if (state.hubspotFilter === "matches") return report.matches || rows.filter((row) => hubspotMatchStatus(row) === "matched");
  if (state.hubspotFilter === "gmb") return rows.filter((row) => row.source === "GMB");
  if (state.hubspotFilter === "trustpilot") return rows.filter((row) => row.source === "Trustpilot");
  if (state.hubspotFilter === "gmb_replied") return rows.filter((row) => row.source === "GMB" && gmbReplyStatusForRow(row) === "replied");
  if (state.hubspotFilter === "gmb_ack") return rows.filter((row) => row.source === "GMB" && gmbReplyStatusForRow(row) === "zernio_acknowledged");
  if (state.hubspotFilter === "gmb_pending") return rows.filter((row) => row.source === "GMB" && !["replied", "already_replied", "error", "zernio_acknowledged"].includes(gmbReplyStatusForRow(row)));
  if (state.hubspotFilter === "gmb_errors") return rows.filter((row) => row.source === "GMB" && gmbReplyStatusForRow(row) === "error");
  return rows;
}

function renderHubspotMinimalMetrics(report) {
  if (!els.hubspotMetrics || !report?.totals) return;
  els.hubspotMetrics.innerHTML = [
    hubspotMetric("Total reseñas", report.totals.totalInboxReviews ?? report.totals.totalInbox ?? report.totals.totalTicketsNuevo ?? report.items?.length ?? 0),
    hubspotMetric("GMB", report.totals.sourceGmb ?? report.bySource?.GMB ?? 0),
    hubspotMetric("Trustpilot", report.totals.sourceTrustpilot ?? report.bySource?.Trustpilot ?? 0)
  ].join("");
}

function renderHubspotReport(report) {
  state.hubspotReport = report;
  if (!report?.totals) {
    els.hubspotStatus.textContent = "Sin reporte disponible";
    return;
  }

  const generated = report.generatedAt
    ? new Date(report.generatedAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })
    : "-";
  els.hubspotStatus.textContent = `${generated} · ${report.scope || "Vista Reseñas / Inbox"}`;
  const replySummary = state.hubspotReplyPreview?.summary || report.gmbReplySummary || {};
  els.hubspotMetrics.innerHTML = [
    hubspotMetric("Reseñas Inbox", report.totals.totalInboxReviews ?? report.totals.totalInbox ?? report.totals.totalTicketsNuevo),
    hubspotMetric("GMB", report.totals.sourceGmb ?? report.bySource?.GMB ?? 0),
    hubspotMetric("Trustpilot", report.totals.sourceTrustpilot ?? report.bySource?.Trustpilot ?? 0),
    hubspotMetric("UNKNOWN", report.totals.sourceUnknown ?? report.bySource?.UNKNOWN ?? 0),
    hubspotMetric("KD PC", report.totals.kdPc ?? "-"),
    hubspotMetric("KD Marketing", report.totals.kdMarketing ?? "-"),
    hubspotMetric("Servicio UNKNOWN", report.totals.proyectoSinIdentificar ?? 0),
    hubspotMetric("Coinciden", report.totals.coincidencias, "positive"),
    hubspotMetric("No coinciden", report.totals.noCoincidencias, "negative"),
    hubspotMetric("Múltiples posibles", report.totals.multiplesPosibles ?? 0),
    hubspotMetric("No identificables", report.totals.noIdentificables ?? 0),
    hubspotMetric("Confirmadas", report.totals.asociacionesConfirmadas ?? 0, "positive"),
    hubspotMetric("Pendientes", report.totals.asociacionesPendientes ?? 0),
    hubspotMetric("Posibles", report.totals.posiblesCoincidencias ?? report.totals.posibles ?? 0),
    hubspotMetric("GMB elegibles", replySummary.eligible ?? replySummary.gmbElegibles ?? report.totals.gmbElegibles ?? 0),
    hubspotMetric("Publicadas Google", replySummary.replied ?? replySummary.respondidas ?? report.totals.gmbRespondidas ?? 0, "positive"),
    hubspotMetric("Acuse Zernio", replySummary.acuseZernio ?? report.totals.gmbAcuseZernio ?? 0, "possible"),
    hubspotMetric("Ya respondidas", replySummary.alreadyReplied ?? replySummary.yaRespondidas ?? report.totals.gmbYaRespondidas ?? 0),
    hubspotMetric("Pendientes manual", replySummary.manualReview ?? replySummary.pendientesManual ?? report.totals.gmbPendientesManual ?? 0, "possible"),
    hubspotMetric("Omitidas GMB", replySummary.skipped ?? replySummary.omitidas ?? report.totals.gmbOmitidas ?? 0),
    hubspotMetric("Errores GMB", replySummary.errors ?? replySummary.errores ?? report.totals.gmbErrores ?? 0, "negative"),
    hubspotMetric("Requieren info", report.totals.requierenInfoAdicional ?? 0, "negative")
  ].join("");
  renderHubspotMinimalMetrics(report);
  if (els.hubspotReplyGmbButton) els.hubspotReplyGmbButton.disabled = !(report.items || []).some((row) => row.source === "GMB");
  renderGmbReplyAudit(report);
  renderHubspotTable();
}

function hubspotMatchLabel(row) {
  const status = hubspotMatchStatus(row);
  if (status === "matched") return "Coincide";
  if (status === "possible_match") return "Posible";
  if (status === "multiple_possible_matches") return "Múltiples posibles";
  if (status === "unidentifiable") return "No identificable";
  return "No coincide";
}

function hubspotMatchStatus(row) {
  if (row.matchStatus) return row.matchStatus;
  if (row.status === "coincide") return "matched";
  if (row.status === "posible") return "possible_match";
  if (row.status === "multiple") return "multiple_possible_matches";
  return "not_matched";
}

function hubspotMatchClass(row) {
  const status = hubspotMatchStatus(row);
  if (status === "matched") return "positive";
  if (status === "possible_match") return "possible";
  if (status === "multiple_possible_matches") return "possible";
  return "negative";
}

function canConfirmHubspotAssociation(row) {
  if (!row.ticketId) return false;
  const status = hubspotMatchStatus(row);
  if (status === "not_matched" || status === "unidentifiable") return false;
  if (status === "multiple_possible_matches") {
    return Boolean(state.selectedCandidates.has(String(row.ticketId)));
  }
  return Boolean(row.clientName || row.matchName || row.contactId || row.companyId || row.matchId);
}

function buildHubSpotRecordUrl({ contactId, companyId, portalId, matchType }) {
  const portal = String(portalId || state.hubspotReport?.portalId || "").trim();
  if (!portal) return "";
  if (contactId && matchType !== "company") return `https://app-eu1.hubspot.com/contacts/${encodeURIComponent(portal)}/contact/${encodeURIComponent(contactId)}`;
  if (companyId) return `https://app-eu1.hubspot.com/contacts/${encodeURIComponent(portal)}/company/${encodeURIComponent(companyId)}`;
  if (contactId) return `https://app-eu1.hubspot.com/contacts/${encodeURIComponent(portal)}/contact/${encodeURIComponent(contactId)}`;
  return "";
}

function hubspotClientCell(row) {
  const status = hubspotMatchStatus(row);
  const portalId = state.hubspotReport?.portalId;

  if (status === "multiple_possible_matches") {
    const opts = Array.isArray(row.possibleMatches) ? row.possibleMatches : [];
    if (!opts.length) return '<span class="activity-empty">Múltiples posibles — sin datos</span>';
    const selected = state.selectedCandidates.get(String(row.ticketId));
    const options = opts.map((opt) => {
      const val = JSON.stringify({ contactId: opt.contactId, companyId: opt.companyId, clientName: opt.clientName });
      const isSelected = selected?.clientName === opt.clientName;
      return `<option value="${escapeHtml(val)}" ${isSelected ? "selected" : ""}>${escapeHtml(opt.clientName || opt.contactId || "?")} (${opt.confidence})</option>`;
    }).join("");
    return `<select class="candidate-select" data-ticket-id="${escapeHtml(String(row.ticketId))}"><option value="">— seleccionar —</option>${options}</select>`;
  }

  if (status === "unidentifiable" || status === "not_matched") {
    return '<span class="activity-empty">No identificable</span>';
  }

  const name = row.clientName || row.matchName || row.matchEmailOrDomain || "-";
  if (!name || name === "-") return "-";
  const url = buildHubSpotRecordUrl({
    contactId: row.contactId,
    companyId: row.companyId,
    portalId,
    matchType: row.matchType
  });
  if (!url) return escapeHtml(name);
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(name)}</a>`;
}

function requiresInfoCell(row) {
  const info = row.requiresInfoRequest;
  if (!info?.requiresInfoRequest) return "-";
  const reasonLabels = {
    negative_review_unidentified: "No identificada",
    negative_review_ambiguous_match: "Match ambiguo",
    insufficient_customer_data: "Datos insuficientes"
  };
  const label = reasonLabels[info.infoRequestReason] || info.infoRequestReason;
  const formNote = info.formConfigured
    ? `Formulario ID: ${escapeHtml(info.formId || "configurado")}`
    : "Formulario no configurado";
  return `<details class="activity-details">
    <summary><span class="pill negative" style="font-size:10px">Requiere info</span> ${escapeHtml(label)}</summary>
    <div style="font-size:12px;margin-top:4px">
      <p style="margin:2px 0">${escapeHtml(info.suggestedMessage)}</p>
      <p style="margin:2px 0;color:var(--muted)">${escapeHtml(formNote)}</p>
    </div>
  </details>`;
}

function activityTypeLabel(type) {
  if (type === "notes") return "Nota";
  if (type === "calls") return "Llamada";
  if (type === "emails") return "Email";
  if (type === "meetings") return "Reunión";
  return type;
}

function activitySourceCell(row) {
  const top = row.candidateOptions?.[0];
  if (!top) return '<span class="activity-empty">Sin candidato sugerido</span>';

  const portalId = String(state.hubspotReport?.portalId || "");
  const recordUrl = buildHubSpotRecordUrl({
    contactId: top.type === "contact" ? top.id : null,
    companyId: top.type === "company" ? top.id : null,
    portalId,
    matchType: top.type
  });
  const typeLabel = top.type === "contact" ? "Contacto" : "Empresa";
  const nameHtml = recordUrl
    ? `<a href="${escapeHtml(recordUrl)}" target="_blank" rel="noreferrer">${escapeHtml(top.name || top.id)}</a>`
    : escapeHtml(top.name || top.id || "-");

  const activity = Array.isArray(top.recentActivity) ? top.recentActivity : [];

  if (!activity.length) {
    return `<small>${typeLabel}: ${nameHtml}<br><span class="activity-empty">Sin actividad reciente cacheada</span></small>`;
  }

  const items = activity.map((item) => {
    const sep = item.indexOf(":");
    const aType = sep > -1 ? item.slice(0, sep).trim() : "actividad";
    const text = sep > -1 ? item.slice(sep + 1).trim() : item;
    return `<li><span class="activity-tag">${escapeHtml(activityTypeLabel(aType))}</span>${escapeHtml(text.slice(0, 240))}</li>`;
  }).join("");

  const count = activity.length;
  return `<div class="activity-source-wrap">
    <div class="activity-source-header">${typeLabel}: ${nameHtml} &middot; <span style="color:var(--muted)">${count} ${count === 1 ? "actividad" : "actividades"}</span></div>
    <ul class="activity-list">${items}</ul>
  </div>`;
}

function associationButton(row) {
  const confirmed = row.associationStatus === "confirmed";
  if (confirmed) {
    return `<button type="button" class="ghost-button" disabled>Confirmada</button>`;
  }
  const status = hubspotMatchStatus(row);
  if (status === "not_matched" || status === "unidentifiable") {
    return '<span class="activity-empty">Sin cliente</span>';
  }
  if (status === "multiple_possible_matches") {
    const hasSelection = state.selectedCandidates.has(String(row.ticketId));
    return `<button type="button" class="ghost-button confirm-association-button" data-ticket-id="${escapeHtml(row.ticketId)}" ${hasSelection ? "" : "disabled"}>Confirmar selección</button>`;
  }
  if (!canConfirmHubspotAssociation(row)) return "-";
  return `<button type="button" class="ghost-button confirm-association-button" data-ticket-id="${escapeHtml(row.ticketId)}">Confirmar asociación</button>`;
}

function buildStars(rating) {
  if (!rating) return "";
  const r = Math.min(5, Math.max(0, Math.round(Number(rating))));
  return "★".repeat(r) + "☆".repeat(5 - r);
}

function buildInfoRequestBannerHtml(info) {
  if (!info?.requiresInfoRequest) return "";
  const labels = {
    negative_review_unidentified: "Reseña negativa no identificada",
    negative_review_ambiguous_match: "Match ambiguo — varios posibles clientes",
    insufficient_customer_data: "Datos insuficientes para identificar"
  };
  const label = labels[info.infoRequestReason] || info.infoRequestReason;
  const form = info.formConfigured
    ? `Formulario ID: ${escapeHtml(info.formId || "?")}`
    : "Formulario no configurado (agrega HUBSPOT_REVIEW_FORM_ID en .env)";
  return `<div class="info-request-banner">
    <div class="info-req-icon">⚠</div>
    <div>
      <strong>Requiere información adicional</strong>
      <span class="info-req-reason">${escapeHtml(label)}</span>
    </div>
    <div class="info-req-msg">
      <p>"${escapeHtml(info.suggestedMessage || "")}"</p>
      <small>${escapeHtml(form)}</small>
    </div>
  </div>`;
}

function buildCardMatchSection(row) {
  const status = hubspotMatchStatus(row);
  const matchClass = hubspotMatchClass(row);
  const matchLabel = hubspotMatchLabel(row);
  const confLabels = { high: "Alta confianza", medium: "Confianza media", low: "Baja confianza" };
  const confLabel = confLabels[row.matchConfidence] || "";
  return `<div class="card-match">
    <div class="match-badges">
      <span class="pill ${matchClass}">${matchLabel}</span>
      ${confLabel ? `<span class="conf-badge ${row.matchConfidence}">${escapeHtml(confLabel)}</span>` : ""}
    </div>
    <div class="match-client">${hubspotClientCell(row)}</div>
    <div class="match-action">${associationButton(row)}</div>
  </div>`;
}

function sheetMatchForTicket(ticketId) {
  const results = state.sheetAssociationPreview?.items || [];
  return results.find((item) => String(item.ticketId) === String(ticketId)) || null;
}

function buildSheetMatchSection(row) {
  const result = sheetMatchForTicket(row.ticketId);
  const status = hubspotMatchStatus(row);
  const shouldShow = result || status === "not_matched" || status === "unidentifiable";
  if (!shouldShow) return "";

  if (!result) {
    return `<div class="sheet-match-panel muted">
      <div class="sheet-match-head">
        <span class="detail-label">Google Sheets</span>
        <span class="pill neutral">Sin cruce ejecutado</span>
      </div>
      <p>Presiona <strong>Cruzar Sheet</strong> para buscar posibles coincidencias por alias y correo.</p>
    </div>`;
  }

  const sheet = result.sheet || {};
  const ready = result.status === "ready";
  const associated = result.status === "associated";
  const possibleReady = result.status === "possible_ready";
  const noMatch = result.status === "no_sheet_match";
  const noContact = result.status === "sheet_match_no_hubspot_contact" || result.status === "possible_sheet_match_no_hubspot_contact";
  const error = result.status === "error";
  const label = associated
    ? "Asociada"
    : ready
      ? "Coincidencia lista"
      : possibleReady
        ? "Posible coincidencia"
        : noContact
          ? "Sheet sin contacto HubSpot"
          : noMatch
            ? "Sin coincidencia en Sheet"
            : error
              ? "Error"
              : result.status;
  const pillClass = associated ? "positive" : ready || possibleReady ? "possible" : error ? "negative" : "neutral";
  const score = Number(result.sheetMatchScore || 0);
  const reasons = Array.isArray(result.sheetMatchReasons) ? result.sheetMatchReasons : [];
  const action = ready || possibleReady
    ? `<button type="button" class="ghost-button sheet-associate-button" data-ticket-id="${escapeHtml(row.ticketId)}">${possibleReady ? "Asociar posible" : "Asociar con Sheet"}</button>`
    : associated || row.associationStatus === "confirmed"
      ? `<button type="button" class="ghost-button" disabled>Asociada</button>`
      : "";

  return `<div class="sheet-match-panel ${ready || possibleReady ? "ready" : associated ? "associated" : ""}">
    <div class="sheet-match-head">
      <span class="detail-label">Coincidencia Google Sheets</span>
      <span class="pill ${pillClass}">${escapeHtml(label)}</span>
    </div>
    ${sheet.alias || sheet.primaryEmail || sheet.fullName ? `<div class="sheet-grid">
      <span><b>Fila</b>${escapeHtml(sheet.sheetRowNumber || "-")}</span>
      <span><b>Alias</b>${escapeHtml(sheet.alias || "-")}</span>
      <span><b>Email</b>${escapeHtml(sheet.primaryEmail || sheet.secondaryEmail || "-")}</span>
      <span><b>Nombre</b>${escapeHtml(sheet.fullName || "-")}</span>
      <span><b>Telefono</b>${escapeHtml(sheet.phone || "-")}</span>
      <span><b>Contacto HubSpot</b>${escapeHtml(result.hubspotContactId || "-")}</span>
    </div>` : ""}
    ${score ? `<p><strong>Confianza:</strong> ${(score * 100).toFixed(0)}%${reasons.length ? ` · ${escapeHtml(reasons.join("; "))}` : ""}</p>` : ""}
    ${result.hubspotReason ? `<p><strong>Búsqueda HubSpot:</strong> ${escapeHtml(result.hubspotReason)}</p>` : ""}
    ${result.error ? `<p class="reply-error"><strong>Error:</strong> ${escapeHtml(result.error)}</p>` : ""}
    ${action ? `<div class="sheet-action">${action}</div>` : ""}
  </div>`;
}

function gmbReplyPreviewForTicket(ticketId) {
  const results = state.hubspotReplyPreview?.results || [];
  return results.find((item) => String(item.ticketId) === String(ticketId)) || null;
}

function gmbReplyDataForRow(row) {
  const preview = gmbReplyPreviewForTicket(row.ticketId);
  return preview || {
    status: row.gmbReplyStatus,
    message: row.gmbReplyMessage,
    error: row.gmbReplyError,
    reason: row.gmbReply?.reason || row.gmbReply?.matchExplanation,
    reviewId: row.gmbReply?.reviewId || row.reviewId || row.matchedReviewId,
    accountId: row.gmbReply?.zernioAccountId || row.gmbReply?.accountId,
    reviewUrl: row.gmbReply?.googleReviewUrl || row.gmbReply?.reviewUrl || row.reviewUrl || "",
    repliedAt: row.gmbReply?.repliedAt,
    attemptedAt: row.gmbReply?.attemptedAt,
    repliedBy: row.gmbReply?.repliedBy
  };
}

function gmbReplyStatusForRow(row) {
  const reply = gmbReplyDataForRow(row);
  return reply.status || (row.source === "GMB" ? "pending" : "not_applicable");
}

function gmbReplyStatusMeta(status) {
  const map = {
    pending: ["Pendiente", "possible"],
    ready: ["Lista para responder", "positive"],
    replied: ["Publicada Google", "positive"],
    zernio_acknowledged: ["Acuse Zernio sin verificar", "possible"],
    already_replied: ["Ya respondida", "positive"],
    manual_review: ["Revision manual", "possible"],
    skipped: ["Omitida", "neutral"],
    error: ["Error", "negative"],
    not_applicable: ["No aplica", "neutral"]
  };
  return map[status] || [status || "Pendiente", "neutral"];
}

function renderGmbReplyAudit(report) {
  if (!els.gmbReplyAudit) return;
  const rows = Array.isArray(report?.items) ? report.items : [];
  const gmbRows = rows.filter((row) => row.source === "GMB");
  const repliedRows = gmbRows.filter((row) => gmbReplyStatusForRow(row) === "replied");
  const acknowledgedRows = gmbRows.filter((row) => gmbReplyStatusForRow(row) === "zernio_acknowledged");
  const errorRows = gmbRows.filter((row) => gmbReplyStatusForRow(row) === "error");
  const pendingRows = gmbRows.filter((row) => !["replied", "already_replied", "error", "zernio_acknowledged"].includes(gmbReplyStatusForRow(row)));

  if (!gmbRows.length) {
    els.gmbReplyAudit.innerHTML = "";
    return;
  }

  const cards = repliedRows.map((row) => {
    const reply = gmbReplyDataForRow(row);
    const date = reply.repliedAt
      ? new Date(reply.repliedAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })
      : "-";
    const ticketLabel = row.ticketName || row.ticketId || "-";
    const ticket = row.ticketUrl
      ? `<a href="${escapeHtml(row.ticketUrl)}" target="_blank" rel="noreferrer">${escapeHtml(ticketLabel)}</a>`
      : escapeHtml(ticketLabel);
    const reviewUrl = reply.reviewUrl || row.reviewUrl || "";
    const reviewLink = reviewUrl
      ? `<span class="reply-url">URL reseña: <a href="${escapeHtml(reviewUrl)}" target="_blank" rel="noreferrer">${escapeHtml(reviewUrl)}</a></span>`
      : '<span class="reply-url unavailable">URL reseña: no disponible en HubSpot/Zernio</span>';
    return `<article class="reply-audit-item">
      <div class="reply-audit-row">
        <span class="pill positive">Publicada Google</span>
        <strong>${ticket}</strong>
        <span>${escapeHtml(date)}</span>
      </div>
      <div class="reply-audit-meta">
        <span>Cliente/autor: <b>${escapeHtml(row.clientName || row.reviewAuthor || row.referenceName || "Sin identificar")}</b></span>
        <span>Review ID: <code>${escapeHtml(reply.reviewId || row.reviewId || "-")}</code></span>
        ${reply.accountId ? `<span>Cuenta Zernio: <code>${escapeHtml(reply.accountId)}</code></span>` : ""}
        ${reviewLink}
      </div>
      ${reply.message ? `<p>${escapeHtml(reply.message)}</p>` : ""}
    </article>`;
  }).join("");

  els.gmbReplyAudit.innerHTML = `<section class="reply-audit-panel">
    <div class="reply-audit-head">
      <div>
        <span class="section-eyebrow">Auditoría Zernio</span>
        <strong>Reseñas GMB publicadas en Google</strong>
      </div>
      <div class="reply-audit-counts">
        <span><b>${repliedRows.length}</b> publicadas</span>
        <span><b>${acknowledgedRows.length}</b> acuse Zernio</span>
        <span><b>${pendingRows.length}</b> pendientes</span>
        <span><b>${errorRows.length}</b> errores</span>
      </div>
    </div>
    ${repliedRows.length ? `<div class="reply-audit-list">${cards}</div>` : '<p class="reply-audit-empty">Todavía no hay respuestas GMB verificadas como publicadas en Google. Los acuses antiguos de Zernio quedaron separados para reintentar con el endpoint correcto.</p>'}
  </section>`;
}

function buildGmbReplySection(row) {
  const reply = gmbReplyDataForRow(row);
  const status = gmbReplyStatusForRow(row);
  const [label, className] = gmbReplyStatusMeta(status);
  const message = reply.message || row.gmbReplyMessage || "";
  const reason = reply.reason || row.gmbReply?.matchExplanation || "";
  const error = reply.error || row.gmbReplyError || "";
  const sentDate = reply.repliedAt
    ? new Date(reply.repliedAt).toLocaleString("es-CO", { dateStyle: "short", timeStyle: "short" })
    : "";

  if (status === "not_applicable" && row.source !== "GMB") return "";

  return `<div class="gmb-reply-panel">
    <div class="gmb-reply-head">
      <span class="detail-label">Estado respuesta GMB</span>
      <span class="pill ${className}">${escapeHtml(label)}</span>
    </div>
    ${status === "replied" ? `<p><strong>Validación:</strong> Publicada mediante endpoint Google Business de Zernio${sentDate ? ` el ${escapeHtml(sentDate)}` : ""}.</p>` : ""}
    ${status === "zernio_acknowledged" ? `<p><strong>Validación:</strong> Zernio devolvió success en el endpoint de Inbox, pero no hay confirmación de publicación en Google. Conviene reintentar con el endpoint Google Business.</p>` : ""}
    ${reply.reviewUrl ? `<p><strong>URL reseña:</strong> <a class="reply-url-link" href="${escapeHtml(reply.reviewUrl)}" target="_blank" rel="noreferrer">${escapeHtml(reply.reviewUrl)}</a></p>` : row.source === "GMB" ? `<p><strong>URL reseña:</strong> no disponible en HubSpot/Zernio.</p>` : ""}
    ${reply.reviewId ? `<p><strong>Review ID Zernio/Google:</strong> <code>${escapeHtml(reply.reviewId)}</code></p>` : ""}
    ${reply.accountId ? `<p><strong>Cuenta Zernio:</strong> <code>${escapeHtml(reply.accountId)}</code></p>` : ""}
    ${message ? `<p><strong>Mensaje respuesta:</strong> ${escapeHtml(message)}</p>` : ""}
    ${reason ? `<p><strong>Motivo:</strong> ${escapeHtml(reason)}</p>` : ""}
    ${error ? `<p class="reply-error"><strong>Error respuesta:</strong> ${escapeHtml(error)}</p>` : ""}
  </div>`;
}

function buildCardDetailSection(row) {
  const explanation = row.matchExplanation || row.matchReason;
  const hasActivity = row.candidateOptions?.[0]?.recentActivity?.length;
  const evidence = Array.isArray(row.evidence) && row.evidence.length ? row.evidence : null;
  if (!explanation && !hasActivity && !evidence) return "";

  const explanationHtml = explanation
    ? `<div class="detail-block"><span class="detail-label">Análisis match</span><p>${escapeHtml(explanation)}</p></div>`
    : "";

  const activityHtml = hasActivity
    ? `<div class="detail-block"><span class="detail-label">Actividad fuente</span>${activitySourceCell(row)}</div>`
    : "";

  const evidenceHtml = evidence
    ? `<div class="detail-block"><span class="detail-label">Evidencia usada</span>
       <ul class="evidence-list">${evidence.map((e) =>
         `<li><span class="activity-tag">${escapeHtml(e.type)}</span><strong>${escapeHtml(e.field)}</strong>: <em>${escapeHtml(String(e.value || "").slice(0, 100))}</em></li>`
       ).join("")}</ul></div>`
    : "";

  return `<details class="card-detail activity-details">
    <summary>Ver análisis y actividad</summary>
    <div class="card-detail-body">${explanationHtml}${activityHtml}${evidenceHtml}</div>
  </details>`;
}

function reviewCard(row) {
  const sourceClass = row.source === "GMB" ? "gmb" : row.source === "Trustpilot" ? "trustpilot" : "src-unknown";
  const svcRaw = row.service || row.projectType || "UNKNOWN";
  const serviceClass = svcRaw === "KD MARKETING" ? "marketing" : svcRaw === "KD PC" ? "pc" : svcRaw.includes("+") ? "dual" : "svc-unknown";
  const stars = buildStars(row.reviewRating);
  const date = row.createdate ? new Date(row.createdate).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" }) : "";
  const reviewText = row.reviewText || row.reviewReason || "";
  const ticketHtml = row.ticketUrl
    ? `<a href="${escapeHtml(row.ticketUrl)}" target="_blank" rel="noreferrer" class="card-link">${escapeHtml(row.ticketName || row.ticketId)} ↗</a>`
    : `<span class="card-link">${escapeHtml(row.ticketName || row.ticketId)}</span>`;
  const reviewLinkHtml = row.reviewUrl
    ? `<a href="${escapeHtml(row.reviewUrl)}" target="_blank" rel="noreferrer" class="source-link">Ver reseña ↗</a>`
    : "";
  const serviceTitle = [row.serviceExplanation, ...(row.serviceEvidence || [])].filter(Boolean).join(" | ");
  const confirmed = row.associationStatus === "confirmed";
  const category = row.ticketCategory || row.category || "";

  return `<article class="review-card negative" data-ticket-id="${escapeHtml(String(row.ticketId))}">
    <div class="card-head">
      ${category ? `<span class="category-badge">Categoría: ${escapeHtml(category)}</span>` : ""}
      <span class="src-badge ${sourceClass}">${escapeHtml(row.source || "?")}</span>
      ${stars ? `<span class="stars-display">${stars} <span class="rating-num">${row.reviewRating}</span></span>` : ""}
      <span class="svc-badge ${serviceClass}" title="${escapeHtml(serviceTitle)}">${escapeHtml(svcRaw)}</span>
      <span class="card-spacer"></span>
      ${date ? `<span class="card-date">${escapeHtml(date)}</span>` : ""}
      ${reviewLinkHtml}
    </div>
    <div class="card-body">
      <div class="card-meta">
        <span class="card-author">${escapeHtml(row.reviewAuthor || row.referenceName || "Autor desconocido")}</span>
        ${ticketHtml}
        ${confirmed ? `<span class="assoc-confirmed">✓ Confirmada</span>` : ""}
      </div>
      ${reviewText ? `<p class="card-review-text">${escapeHtml(reviewText.slice(0, 340))}${reviewText.length > 340 ? "…" : ""}</p>` : ""}
    </div>
    ${buildInfoRequestBannerHtml(row.requiresInfoRequest)}
    ${buildCardMatchSection(row)}
    ${buildSheetMatchSection(row)}
    ${buildGmbReplySection(row)}
    <div class="card-foot">
      <span></span>
      ${buildCardDetailSection(row)}
    </div>
  </article>`;
}

function reviewCardMinimal(row) {
  const sourceClass = row.source === "GMB" ? "gmb" : row.source === "Trustpilot" ? "trustpilot" : "src-unknown";
  const service = row.service || row.projectType || "UNKNOWN";
  const serviceClass = service === "KD MARKETING" ? "marketing" : service === "KD PC" ? "pc" : service.includes("+") ? "dual" : "svc-unknown";
  const stars = buildStars(row.reviewRating);
  const status = hubspotMatchStatus(row);
  const confirmed = row.associationStatus === "confirmed";
  const date = row.createdate ? new Date(row.createdate).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" }) : "";
  const title = row.reviewAuthor || row.referenceName || row.ticketName || "Reseña sin autor";
  const ticketLabel = row.ticketName || row.ticketId || "";
  const reviewText = String(row.reviewText || row.reviewReason || "").trim();
  const client = hubspotClientCell(row);
  const sheetResult = sheetMatchForTicket(row.ticketId);
  const detailBlocks = [
    row.matchExplanation || row.matchReason
      ? `<div class="detail-block"><span class="detail-label">Análisis match</span><p>${escapeHtml(row.matchExplanation || row.matchReason)}</p></div>`
      : "",
    sheetResult ? buildSheetMatchSection(row) : "",
    buildGmbReplySection(row)
  ].filter(Boolean).join("");

  return `<article class="review-card review-card-minimal negative" data-ticket-id="${escapeHtml(String(row.ticketId))}">
    <div class="minimal-card-main">
      <div class="minimal-card-title">
        <strong>${escapeHtml(title)}</strong>
        ${ticketLabel ? `<span>${escapeHtml(ticketLabel)}</span>` : ""}
      </div>
      <div class="minimal-card-badges">
        <span class="src-badge ${sourceClass}">${escapeHtml(row.source || "UNKNOWN")}</span>
        <span class="svc-badge ${serviceClass}">${escapeHtml(service)}</span>
        ${stars ? `<span class="stars-display">${stars} <span class="rating-num">${escapeHtml(row.reviewRating)}</span></span>` : ""}
        ${date ? `<span class="card-date">${escapeHtml(date)}</span>` : ""}
      </div>
      ${reviewText ? `<p class="card-review-text minimal-text">${escapeHtml(reviewText.slice(0, 220))}${reviewText.length > 220 ? "..." : ""}</p>` : ""}
    </div>
    <div class="minimal-card-side">
      <div class="minimal-match">
        <span class="pill ${hubspotMatchClass(row)}">${escapeHtml(hubspotMatchLabel(row))}</span>
        <span class="minimal-client">${client}</span>
        <span class="${confirmed ? "assoc-confirmed" : "assoc-pending"}">${confirmed ? "Asociación confirmada" : "Pendiente"}</span>
      </div>
      <div class="minimal-actions">
        ${row.ticketUrl ? `<a href="${escapeHtml(row.ticketUrl)}" target="_blank" rel="noreferrer" class="ghost-button sm">Ticket</a>` : ""}
        ${row.reviewUrl ? `<a href="${escapeHtml(row.reviewUrl)}" target="_blank" rel="noreferrer" class="ghost-button sm">Reseña</a>` : ""}
        ${associationButton(row)}
      </div>
    </div>
    ${detailBlocks ? `<details class="card-detail minimal-detail"><summary>Ver detalles</summary><div class="card-detail-body">${detailBlocks}</div></details>` : ""}
  </article>`;
}

function renderHubspotTable() {
  const report = state.hubspotReport;
  const rows = normalizeHubspotRows(report);
  if (!rows.length) {
    els.hubspotTable.innerHTML = '<div class="cards-empty"><p>Sin reseñas para este filtro.</p></div>';
    return;
  }
  els.hubspotTable.innerHTML = rows.slice(0, 300).map(reviewCardMinimal).join("");
}

function clearHubspotView() {
  state.hubspotFilter = "all";
  state.hubspotReport = null;
  state.hubspotReplyPreview = null;
  state.sheetAssociationPreview = null;
  state.selectedCandidates.clear();

  document.querySelectorAll(".hubspot-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.hubspotFilter === "all");
  });
  if (els.hubspotStatus) els.hubspotStatus.textContent = "Sin datos cargados";
  if (els.hubspotMetrics) {
    els.hubspotMetrics.innerHTML = [
      hubspotMetric("Total reseñas", "-"),
      hubspotMetric("GMB", "-"),
      hubspotMetric("Trustpilot", "-")
    ].join("");
  }
  if (els.gmbReplyAudit) els.gmbReplyAudit.innerHTML = "";
  if (els.hubspotTable) {
    els.hubspotTable.innerHTML = '<div class="cards-empty"><p>Vista limpia. Usa <strong>Analizar HubSpot</strong> para cargar reseñas.</p></div>';
  }
  if (els.hubspotReplyGmbButton) els.hubspotReplyGmbButton.disabled = true;
  resetLogs();
}

function canonicalReviewId(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/\/reviews\/([^/?#]+)/i);
  return match?.[1] || raw;
}

function gmbPositiveReplyForReview(review) {
  const results = state.gmbPositiveReplyPreview?.results || [];
  const id = canonicalReviewId(review.id);
  return results.find((item) => canonicalReviewId(item.reviewId) === id) || null;
}

function gmbPositiveReplyStatusHtml(item) {
  const reply = gmbPositiveReplyForReview(item);
  const rating = Number(item.rating || 0);
  if (reply) {
    const labelMap = {
      ready: "Lista",
      replied: "Publicada",
      zernio_acknowledged: "Acuse Zernio",
      already_replied: "Ya respondida",
      error: "Error"
    };
    const classMap = {
      ready: "possible",
      replied: "positive",
      zernio_acknowledged: "possible",
      already_replied: "neutral",
      error: "negative"
    };
    const status = reply.status || "ready";
    return `<div class="reply-status-cell">
      <span class="pill ${classMap[status] || "neutral"}">${escapeHtml(labelMap[status] || status)}</span>
      ${reply.message ? `<small>${escapeHtml(reply.message)}</small>` : ""}
      ${reply.error ? `<small class="reply-error">${escapeHtml(reply.error)}</small>` : ""}
    </div>`;
  }
  if (String(item.reply || "").trim()) {
    return `<span class="pill neutral">Ya respondida</span>`;
  }
  if (rating >= 4) {
    return `<span class="pill possible">Pendiente positiva</span>`;
  }
  return `<span class="pill neutral">No aplica</span>`;
}

function renderGmbPositiveReplyAudit(data = state.gmbPositiveReplyPreview) {
  if (!els.gmbPositiveReplyAudit) return;
  if (!data?.summary) {
    els.gmbPositiveReplyAudit.innerHTML = "";
    return;
  }

  const summary = data.summary || {};
  const visible = (data.results || [])
    .filter((item) => ["ready", "replied", "zernio_acknowledged", "error"].includes(item.status))
    .slice(0, 80);
  const cards = visible.map((item) => `
    <div class="reply-audit-item">
      <div class="reply-audit-row">
        <strong>${escapeHtml(item.author || "Autor desconocido")}</strong>
        <span class="pill ${item.status === "error" ? "negative" : item.status === "replied" ? "positive" : "possible"}">${escapeHtml(item.status)}</span>
        <span>${escapeHtml(item.rating || "-")} ★</span>
      </div>
      ${item.message ? `<p>${escapeHtml(item.message)}</p>` : ""}
      ${item.error ? `<p class="reply-error">${escapeHtml(item.error)}</p>` : ""}
      ${item.reviewId ? `<div class="reply-audit-meta"><span>Review ID: <code>${escapeHtml(item.reviewId)}</code></span></div>` : ""}
    </div>
  `).join("");

  els.gmbPositiveReplyAudit.innerHTML = `<section class="reply-audit-panel">
    <div class="reply-audit-head">
      <div>
        <span class="section-eyebrow">GMB / Zernio</span>
        <strong>Respuestas positivas sin contestar</strong>
      </div>
      <div class="reply-audit-counts">
        <span><b>${summary.positive || 0}</b> positivas 4+</span>
        <span><b>${summary.ready || 0}</b> listas</span>
        <span><b>${summary.replied || 0}</b> publicadas</span>
        <span><b>${summary.alreadyReplied || 0}</b> ya respondidas</span>
        <span><b>${summary.errors || 0}</b> errores</span>
      </div>
    </div>
    ${cards ? `<div class="reply-audit-list">${cards}</div>` : '<p class="reply-audit-empty">No hay reseñas positivas pendientes de respuesta.</p>'}
  </section>`;
}

function gmbReviewCard(item) {
  const sentimentClass = item.sentiment === "positive" ? "positive" : "negative";
  const sentimentLabel = item.sentiment === "positive" ? "Positiva" : "Negativa";
  const stars = buildStars(item.rating);
  const date = item.publishedAt
    ? (() => { try { return new Date(item.publishedAt).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" }); } catch { return String(item.publishedAt); } })()
    : "";
  const text = String(item.text || "").trim();
  const reviewLinkHtml = item.sourceUrl
    ? `<a href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer" class="source-link">Ver reseña ↗</a>`
    : "";
  const replyHtml = gmbPositiveReplyStatusHtml(item);
  const reasonHtml = item.reason
    ? `<div class="gmb-card-reason"><span class="detail-label">Análisis Gemini</span><p>${escapeHtml(item.reason)}</p></div>`
    : "";

  return `<article class="review-card ${sentimentClass}">
    <div class="card-head">
      <span class="pill ${sentimentClass}">${sentimentLabel}</span>
      ${stars ? `<span class="stars-display">${stars} <span class="rating-num">${escapeHtml(String(item.rating ?? ""))}</span></span>` : ""}
      <span class="card-spacer"></span>
      ${date ? `<span class="card-date">${escapeHtml(date)}</span>` : ""}
      ${reviewLinkHtml}
    </div>
    <div class="card-body">
      <div class="card-meta">
        <span class="card-author">${escapeHtml(item.author || "Autor desconocido")}</span>
      </div>
      ${text ? `<p class="card-review-text">${escapeHtml(text.slice(0, 420))}${text.length > 420 ? "…" : ""}</p>` : ""}
    </div>
    ${reasonHtml}
    ${replyHtml ? `<div class="card-foot"><span></span><div class="reply-status-cell">${replyHtml}</div></div>` : ""}
  </article>`;
}

function renderTable() {
  const items = state.result?.items || [];
  const visible = state.filter === "all" ? items : items.filter((item) => item.sentiment === state.filter);

  if (!visible.length) {
    els.reviewsTable.innerHTML = '<div class="cards-empty"><p>Sin reseñas para este filtro.</p></div>';
    return;
  }

  els.reviewsTable.innerHTML = visible.map(gmbReviewCard).join("");
}

function renderResult(result) {
  state.result = result;
  renderReportContext(result);
  if (result?.meta?.onlyNew) renderNewSummary(result);
  renderSummary(result);
  renderGmbPositiveReplyAudit();
  renderTable();
  els.exportButton.disabled = !result?.items?.length;
}

function csvEscape(value) {
  const raw = String(value ?? "");
  return `"${raw.replace(/"/g, '""')}"`;
}

function exportCsv() {
  if (!state.result?.items?.length) return;
  const header = ["sentiment", "rating", "author", "publishedAt", "confidence", "reason", "text"];
  const rows = state.result.items.map((item) =>
    header.map((key) => csvEscape(item[key])).join(",")
  );
  const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `orbidi-resenas-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function payloadFromForm() {
  const data = new FormData(els.form);
  return {
    source: state.source,
    companyName: String(data.get("companyName") || "").trim(),
    googleUrl: String(data.get("googleUrl") || "").trim(),
    zernioMode: "gmb-reviews",
    zernioAccountId: String(data.get("zernioAccountId") || "").trim(),
    zernioLocationId: String(data.get("zernioLocationId") || "").trim(),
    gbpAccountId: String(data.get("gbpAccountId") || "").trim(),
    gbpLocationId: String(data.get("gbpLocationId") || "").trim(),
    manualReviews: String(data.get("manualReviews") || "").trim(),
    maxReviews: Number(data.get("maxReviews") || 100)
  };
}

async function startAnalysis(payload) {
  setBusy(true);
  resetLogs();
  appendLog({ time: new Date().toISOString(), level: "info", message: "Solicitud enviada al backend." });

  if (state.eventSource) state.eventSource.close();

  const response = await fetch("/api/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo iniciar el analisis.");

  const events = new EventSource(`/api/jobs/${data.jobId}/events`);
  state.eventSource = events;

  events.addEventListener("log", (event) => appendLog(JSON.parse(event.data)));
  events.addEventListener("done", (event) => {
    renderResult(JSON.parse(event.data));
    appendLog({ time: new Date().toISOString(), level: "success", message: "Resultado recibido en el frontend." });
    setBusy(false);
    events.close();
  });
  events.addEventListener("failed", (event) => {
    const error = JSON.parse(event.data);
    appendLog({ time: new Date().toISOString(), level: "error", message: error.message || "El trabajo fallo." });
    setBusy(false);
    events.close();
  });
  events.onerror = () => {
    appendLog({ time: new Date().toISOString(), level: "warn", message: "Conexion de eventos cerrada o interrumpida." });
  };
}

async function loadLatestReports() {
  const response = await fetch("/api/reports/latest");
  if (!response.ok) return;
  const data = await response.json();
  if (data.lastNewAnalysis) {
    renderNewSummary(data.lastNewAnalysis);
    renderResult(data.lastNewAnalysis);
  } else if (data.lastAnalysis) {
    renderResult(data.lastAnalysis);
  }
}

async function loadHubspotReport() {
  try {
    const [response, sheetResponse] = await Promise.all([
      fetch("/api/hubspot/new-ticket-matches"),
      fetch("/api/hubspot/sheet-association-audit").catch(() => null)
    ]);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo cargar HubSpot.");
    if (sheetResponse?.ok) {
      const sheetAudit = await sheetResponse.json();
      if (Array.isArray(sheetAudit.items) && sheetAudit.items.length) state.sheetAssociationPreview = sheetAudit;
    }
    state.selectedCandidates.clear();
    state.hubspotReplyPreview = null;
    renderHubspotReport(data);
  } catch (error) {
    els.hubspotStatus.textContent = error.message;
    els.hubspotTable.innerHTML = `<div class="cards-empty"><p>${escapeHtml(error.message)}</p></div>`;
  }
}

async function confirmHubspotAssociation(ticketId) {
  const row = state.hubspotReport?.items?.find((item) => String(item.ticketId) === String(ticketId));
  if (!row) throw new Error("No se encontro la fila de HubSpot para confirmar.");

  const overrideSelection = state.selectedCandidates.get(String(ticketId));
  const resolvedContactId = overrideSelection?.contactId || row.contactId || (row.matchType === "contact" ? row.matchId : null);
  const resolvedCompanyId = overrideSelection?.companyId || row.companyId || (row.matchType === "company" ? row.matchId : null);
  const resolvedClientName = overrideSelection?.clientName || row.clientName || row.matchName || row.matchEmailOrDomain || null;

  const payload = {
    ticketId: String(row.ticketId),
    reviewId: row.reviewId || row.matchedReviewId || row.reviewUrl || null,
    source: row.source || "UNKNOWN",
    contactId: resolvedContactId,
    companyId: resolvedCompanyId,
    dealId: row.dealId || null,
    dealIds: row.dealIds || [],
    clientName: resolvedClientName,
    service: row.service || row.projectType || "UNKNOWN",
    sentiment: row.reviewSentiment === "positive" ? "positive" : "negative",
    matchStatus: overrideSelection ? "matched" : (row.matchStatus || "not_matched"),
    matchConfidence: overrideSelection ? "medium" : (row.matchConfidence || "low"),
    matchExplanation: overrideSelection
      ? `Selección manual: ${overrideSelection.clientName}`
      : (row.matchExplanation || row.matchReason || ""),
    evidence: Array.isArray(row.evidence) ? row.evidence : []
  };

  const response = await fetch("/api/hubspot/confirm-association", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo confirmar la asociacion.");

  const ticketMsg = data.ticketUpdateStatus === "success"
    ? `Propiedades actualizadas sin cambiar el estado: ${Object.values(data.ticketUpdateProperties || {}).join(", ")}.`
    : data.ticketUpdateStatus === "error"
      ? `Advertencia: no se pudo actualizar propiedades del ticket: ${data.ticketUpdateError}.`
      : "";
  appendLog({
    time: new Date().toISOString(),
    level: "success",
    message: `Asociacion confirmada para ticket ${row.ticketId} con cliente ${payload.clientName || "sin nombre"}. HubSpot: ${data.hubspotAssociationStatus || "sin estado"} (${data.hubspotAssociated?.contactIds?.length || 0} contactos, ${data.hubspotAssociated?.companyIds?.length || 0} empresas, ${data.hubspotAssociated?.dealIds?.length || 0} negocios). ${ticketMsg}`.trim()
  });
  await loadHubspotReport();
}

function hubspotReplyTicketPayload(row) {
  return {
    ticketId: row.ticketId,
    ticketName: row.ticketName,
    ticketUrl: row.ticketUrl,
    reviewId: row.reviewId || row.matchedReviewId || null,
    matchedReviewId: row.matchedReviewId || null,
    reviewUrl: row.reviewUrl || null,
    source: row.source || "UNKNOWN",
    reviewAuthor: row.reviewAuthor || row.referenceName || "",
    referenceName: row.referenceName || "",
    reviewText: row.reviewText || "",
    reviewReason: row.reviewReason || "",
    reviewRating: row.reviewRating || null,
    reviewSentiment: row.reviewSentiment || "negative",
    createdate: row.createdate || "",
    clientName: row.clientName || row.matchName || "",
    contactId: row.contactId || null,
    companyId: row.companyId || null,
    service: row.service || row.projectType || "UNKNOWN",
    projectType: row.projectType || row.service || "UNKNOWN",
    matchStatus: row.matchStatus || hubspotMatchStatus(row),
    matchConfidence: row.matchConfidence || "low",
    matchExplanation: row.matchExplanation || row.matchReason || "",
    associationStatus: row.associationStatus || "pending",
    confirmedAssociation: row.confirmedAssociation || null,
    evidence: Array.isArray(row.evidence) ? row.evidence : []
  };
}

function appendReplyEndpointLogs(data) {
  for (const entry of data.logs || []) {
    appendLog({ time: entry.time, level: entry.level, message: entry.message });
  }
  const summary = data.summary || {};
  appendLog({
    time: new Date().toISOString(),
    level: data.dryRun ? "info" : "success",
    message: `${data.dryRun ? "Dry-run" : "Respuesta real"} GMB: ${summary.eligible || 0} elegibles, ${summary.ready || 0} listas, ${summary.replied || 0} respondidas, ${summary.alreadyReplied || 0} ya respondidas, ${summary.manualReview || 0} manuales, ${summary.skipped || 0} omitidas, ${summary.errors || 0} errores.`
  });
}

async function postGmbReplyRequest(dryRun, tickets) {
  const formPayload = payloadFromForm();
  const response = await fetch("/api/hubspot/reply-gmb-reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dryRun,
      tickets,
      zernioAccountId: formPayload.zernioAccountId,
      zernioLocationId: formPayload.zernioLocationId,
      maxReviews: formPayload.maxReviews
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudieron procesar respuestas GMB.");
  return data;
}

function appendPositiveReplyEndpointLogs(data) {
  for (const entry of data.logs || []) {
    appendLog({ time: entry.time, level: entry.level, message: entry.message });
  }
  const summary = data.summary || {};
  appendLog({
    time: new Date().toISOString(),
    level: data.dryRun ? "info" : "success",
    message: `${data.dryRun ? "Dry-run" : "Envio real"} positivas GMB: ${summary.positive || 0} positivas 4+, ${summary.ready || 0} listas, ${summary.replied || 0} publicadas, ${summary.alreadyReplied || 0} ya respondidas, ${summary.skipped || 0} omitidas, ${summary.errors || 0} errores.`
  });
}

async function postGmbPositiveReplyRequest(dryRun) {
  const formPayload = payloadFromForm();
  const response = await fetch("/api/gmb/reply-positive-reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      dryRun,
      zernioAccountId: formPayload.zernioAccountId,
      zernioLocationId: formPayload.zernioLocationId,
      maxReviews: formPayload.maxReviews
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudieron responder reseñas positivas GMB.");
  return data;
}

function applyPositiveReplyResultToCurrentReport(data) {
  if (!state.result?.items?.length) return;
  const replied = (data.results || []).filter((item) => ["replied", "zernio_acknowledged"].includes(item.status));
  if (!replied.length) return;
  const byReview = new Map(replied.map((item) => [canonicalReviewId(item.reviewId), item]));
  state.result.items = state.result.items.map((item) => {
    const reply = byReview.get(canonicalReviewId(item.id));
    if (!reply) return item;
    return {
      ...item,
      reply: reply.message || item.reply
    };
  });
}

async function replyPositiveGmbReviews() {
  if (!els.gmbPositiveReplyButton) return;
  els.gmbPositiveReplyButton.disabled = true;
  els.gmbPositiveReplyButton.textContent = "Simulando positivas...";
  resetLogs();
  appendLog({ time: new Date().toISOString(), level: "info", message: "Inicio de dry-run para responder solo reseñas positivas GMB sin contestar." });

  try {
    const dryRunData = await postGmbPositiveReplyRequest(true);
    state.gmbPositiveReplyPreview = dryRunData;
    appendPositiveReplyEndpointLogs(dryRunData);
    renderGmbPositiveReplyAudit(dryRunData);
    renderTable();

    const ready = Number(dryRunData.summary?.ready || 0);
    if (!ready) {
      appendLog({ time: new Date().toISOString(), level: "warn", message: "No hay reseñas positivas GMB sin contestar listas para responder." });
      return;
    }

    const confirmed = window.confirm(
      `Zernio respondera ${ready} reseñas positivas de Google con 4 o 5 estrellas que no tienen respuesta.\n\nGemini ya genero variaciones de la plantilla para evitar textos repetitivos.\n\n¿Confirmas el envio real?`
    );
    if (!confirmed) {
      appendLog({ time: new Date().toISOString(), level: "warn", message: "Envio real de positivas cancelado por el usuario despues del dry-run." });
      return;
    }

    els.gmbPositiveReplyButton.textContent = "Respondiendo positivas...";
    appendLog({ time: new Date().toISOString(), level: "info", message: "Confirmacion recibida. Publicando respuestas positivas GMB por Zernio." });
    const realData = await postGmbPositiveReplyRequest(false);
    state.gmbPositiveReplyPreview = realData;
    appendPositiveReplyEndpointLogs(realData);
    applyPositiveReplyResultToCurrentReport(realData);
    renderGmbPositiveReplyAudit(realData);
    renderTable();
  } catch (error) {
    appendLog({ time: new Date().toISOString(), level: "error", message: `Error respuestas positivas GMB: ${error.message}` });
  } finally {
    els.gmbPositiveReplyButton.disabled = false;
    els.gmbPositiveReplyButton.textContent = "Responder positivas GMB";
  }
}

async function replyGmbReviews() {
  const rows = state.hubspotReport?.items || [];
  if (!rows.length) {
    appendLog({ time: new Date().toISOString(), level: "warn", message: "No hay reporte HubSpot cargado para responder reseñas GMB." });
    return;
  }
  const tickets = rows.map(hubspotReplyTicketPayload);
  els.hubspotReplyGmbButton.disabled = true;
  els.hubspotReplyGmbButton.textContent = "Simulando...";
  resetLogs();
  appendLog({ time: new Date().toISOString(), level: "info", message: "Inicio de dry-run para respuestas GMB." });

  try {
    const dryRunData = await postGmbReplyRequest(true, tickets);
    state.hubspotReplyPreview = dryRunData;
    appendReplyEndpointLogs(dryRunData);
    renderHubspotReport(state.hubspotReport);

    const summary = dryRunData.summary || {};
    const ready = Number(summary.ready || 0);
    if (!ready) {
      appendLog({ time: new Date().toISOString(), level: "warn", message: "No hay reseñas GMB listas para responder automaticamente." });
      return;
    }

    const confirmed = window.confirm(
      `Zernio respondera ${ready} reseñas GMB encontradas en Zernio.\n\nNo se responderan Trustpilot ni UNKNOWN. Revisa el dry-run y la confianza del match antes de confirmar.\n\n¿Confirmas el envio real?`
    );
    if (!confirmed) {
      appendLog({ time: new Date().toISOString(), level: "warn", message: "Envio real cancelado por el usuario despues del dry-run." });
      return;
    }

    els.hubspotReplyGmbButton.textContent = "Respondiendo...";
    appendLog({ time: new Date().toISOString(), level: "info", message: "Confirmacion recibida. Enviando respuestas reales por Zernio." });
    const realData = await postGmbReplyRequest(false, tickets);
    state.hubspotReplyPreview = realData;
    appendReplyEndpointLogs(realData);
    await loadHubspotReport();
  } catch (error) {
    appendLog({ time: new Date().toISOString(), level: "error", message: `Error respuestas GMB: ${error.message}` });
  } finally {
    els.hubspotReplyGmbButton.disabled = false;
    els.hubspotReplyGmbButton.textContent = "Responder reseÃ±as GMB";
  }
}

async function postSheetAssociationRequest(dryRun) {
  const response = await fetch("/api/hubspot/associate-unmatched-from-sheet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dryRun })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo cruzar Google Sheets con HubSpot.");
  return data;
}

async function postSingleSheetAssociation(ticketId) {
  const response = await fetch("/api/hubspot/associate-unmatched-from-sheet", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dryRun: false, ticketIds: [String(ticketId)] })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "No se pudo asociar el ticket desde Google Sheets.");
  return data;
}

function appendSheetAssociationLogs(data) {
  const summary = data.summary || {};
  appendLog({
    time: new Date().toISOString(),
    level: data.dryRun ? "info" : "success",
    message: `${data.dryRun ? "Dry-run" : "Asociacion real"} Sheet: ${summary.unmatchedTickets || 0} tickets no coinciden, ${summary.sheetMatches || 0} matches fuertes, ${summary.possibleSheetMatches || 0} posibles, ${summary.hubspotContactsFound || 0} contactos HubSpot encontrados, ${summary.associated || 0} asociados, ${summary.skipped || 0} omitidos, ${summary.errors || 0} errores.`
  });

  for (const item of (data.items || []).filter((row) => ["ready", "possible_ready", "associated", "error"].includes(row.status)).slice(0, 20)) {
    const sheet = item.sheet || {};
    const level = item.status === "error" ? "error" : item.status === "associated" ? "success" : "info";
    const message = item.status === "error"
      ? `Sheet ticket ${item.ticketId}: ${item.error}`
      : `Sheet ${item.status}: ticket ${item.ticketId} con alias "${sheet.alias || "-"}", email "${sheet.primaryEmail || sheet.secondaryEmail || "-"}", contacto HubSpot ${item.hubspotContactId || "-"}.`;
    appendLog({ time: new Date().toISOString(), level, message });
  }
}

async function associateUnmatchedFromSheet() {
  if (!els.hubspotSheetAssociateButton) return;
  els.hubspotSheetAssociateButton.disabled = true;
  els.hubspotSheetAssociateButton.textContent = "Cruzando...";
  resetLogs();
  appendLog({ time: new Date().toISOString(), level: "info", message: "Inicio de cruce visual de tickets no coincidentes contra Google Sheets." });

  try {
    const dryRunData = await postSheetAssociationRequest(true);
    state.sheetAssociationPreview = dryRunData;
    appendSheetAssociationLogs(dryRunData);
    renderHubspotReport(state.hubspotReport);
    const ready = (dryRunData.items || []).filter((item) => ["ready", "possible_ready"].includes(item.status)).length;
    if (!ready) {
      appendLog({ time: new Date().toISOString(), level: "warn", message: "No hay tickets no coincidentes listos para asociar desde Google Sheets." });
      return;
    }
    appendLog({ time: new Date().toISOString(), level: "success", message: `${ready} coincidencia(s) de Sheet listas. Revisa cada tarjeta y usa el boton "Asociar con Sheet".` });
  } catch (error) {
    appendLog({ time: new Date().toISOString(), level: "error", message: `Error cruce Sheet: ${error.message}` });
  } finally {
    els.hubspotSheetAssociateButton.disabled = false;
    els.hubspotSheetAssociateButton.textContent = "Cruzar Sheet";
  }
}

async function associateSingleSheetTicket(ticketId, button) {
  button.disabled = true;
  button.textContent = "Asociando...";
  try {
    const data = await postSingleSheetAssociation(ticketId);
    appendSheetAssociationLogs(data);
    const realItem = (data.items || []).find((item) => String(item.ticketId) === String(ticketId));
    if (realItem) {
      const items = state.sheetAssociationPreview?.items || [];
      const nextItems = [realItem, ...items.filter((item) => String(item.ticketId) !== String(ticketId))];
      state.sheetAssociationPreview = {
        ...(state.sheetAssociationPreview || {}),
        items: nextItems
      };
    }
    appendLog({ time: new Date().toISOString(), level: "success", message: `Ticket ${ticketId} asociado desde Google Sheets.` });
    await loadHubspotReport();
  } catch (error) {
    appendLog({ time: new Date().toISOString(), level: "error", message: `Error asociando ticket ${ticketId} desde Sheet: ${error.message}` });
    button.disabled = false;
    button.textContent = "Asociar con Sheet";
  }
}

async function analyzeHubspotOnly() {
  els.hubspotAnalyzeButton.disabled = true;
  if (els.hubspotReplyGmbButton) els.hubspotReplyGmbButton.disabled = true;
  if (els.hubspotSheetAssociateButton) els.hubspotSheetAssociateButton.disabled = true;
  els.hubspotAnalyzeButton.textContent = "Analizando...";
  els.hubspotStatus.textContent = "Analisis HubSpot en curso...";
  resetLogs();
  appendLog({ time: new Date().toISOString(), level: "info", message: "Analisis de HubSpot iniciado." });

  try {
    const response = await fetch("/api/hubspot/analyze", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "No se pudo iniciar HubSpot.");

    let seenLogsCount = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const statusResponse = await fetch("/api/hubspot/analyze/status");
      const status = await statusResponse.json();
      const allLogs = status.logs || [];
      const newLogs = allLogs.slice(seenLogsCount);
      for (const log of newLogs) {
        appendLog({ time: log.time, level: log.level, message: log.message });
      }
      seenLogsCount = allLogs.length;
      if (status.status === "done") {
        await loadHubspotReport();
        appendLog({ time: new Date().toISOString(), level: "success", message: "Reporte HubSpot actualizado en el front." });
        break;
      }
      if (status.status === "failed") throw new Error(status.error || "HubSpot fallo.");
    }
  } catch (error) {
    els.hubspotStatus.textContent = error.message;
    appendLog({ time: new Date().toISOString(), level: "error", message: error.message });
  } finally {
    els.hubspotAnalyzeButton.disabled = false;
    if (els.hubspotReplyGmbButton) els.hubspotReplyGmbButton.disabled = !(state.hubspotReport?.items || []).some((row) => row.source === "GMB");
    if (els.hubspotSheetAssociateButton) els.hubspotSheetAssociateButton.disabled = false;
    els.hubspotAnalyzeButton.textContent = "Analizar HubSpot";
  }
}

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  const badges = [
    ["Gemini", config.geminiConfigured],
    ["Zernio", config.zernioConfigured],
    ["SerpApi", config.serpapiConfigured],
    ["Business Profile", config.gbpConfigured]
  ];

  els.configStatus.innerHTML = badges
    .map(([label, ok]) => `<span class="badge ${ok ? "ok" : "warn"}">${label}: ${ok ? "OK" : "pendiente"}</span>`)
    .join("");
}

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => updateSource(button.dataset.source));
});

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => updateFilter(button.dataset.filter));
});

setupHubspotMinimalUi();

document.querySelectorAll(".hubspot-tab").forEach((button) => {
  button.addEventListener("click", () => updateHubspotFilter(button.dataset.hubspotFilter));
});

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await startAnalysis({ ...payloadFromForm(), onlyNew: false });
  } catch (error) {
    appendLog({ time: new Date().toISOString(), level: "error", message: error.message });
    setBusy(false);
  }
});

els.newReviewsButton.addEventListener("click", async () => {
  try {
    await startAnalysis({ ...payloadFromForm(), onlyNew: true });
  } catch (error) {
    appendLog({ time: new Date().toISOString(), level: "error", message: error.message });
    setBusy(false);
  }
});

els.hubspotAnalyzeButton.addEventListener("click", analyzeHubspotOnly);

els.hubspotTable.addEventListener("change", (event) => {
  const select = event.target.closest(".candidate-select");
  if (!select) return;
  const ticketId = String(select.dataset.ticketId);
  if (!select.value) {
    state.selectedCandidates.delete(ticketId);
  } else {
    try {
      state.selectedCandidates.set(ticketId, JSON.parse(select.value));
    } catch {
      state.selectedCandidates.delete(ticketId);
    }
  }
  renderHubspotTable();
});

els.hubspotTable.addEventListener("click", async (event) => {
  const sheetButton = event.target.closest(".sheet-associate-button");
  if (sheetButton) {
    await associateSingleSheetTicket(sheetButton.dataset.ticketId, sheetButton);
    return;
  }

  const button = event.target.closest(".confirm-association-button");
  if (!button) return;
  button.disabled = true;
  button.textContent = "Confirmando...";
  try {
    await confirmHubspotAssociation(button.dataset.ticketId);
  } catch (error) {
    appendLog({ time: new Date().toISOString(), level: "error", message: `Error de confirmacion: ${error.message}` });
    button.disabled = false;
    button.textContent = "Confirmar asociación";
  }
});

els.clearLogsButton.addEventListener("click", resetLogs);
els.exportButton.addEventListener("click", exportCsv);
els.hubspotRefreshButton.addEventListener("click", loadHubspotReport);
els.hubspotReplyGmbButton?.addEventListener("click", replyGmbReviews);
els.gmbPositiveReplyButton?.addEventListener("click", replyPositiveGmbReviews);
els.hubspotSheetAssociateButton?.addEventListener("click", associateUnmatchedFromSheet);
els.hubspotClearButton?.addEventListener("click", clearHubspotView);

// ── Tab navigation ──────────────────────────────────────────
document.querySelectorAll(".nav-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll(".main-section").forEach((s) => s.classList.toggle("hidden", s.id !== `section-${tab}`));
    document.querySelectorAll(".nav-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
    if (tab === "gmb") {
      document.getElementById("gmbConfigDrawer")?.removeAttribute("open");
    }
  });
});

// ── Terminal toggle ──────────────────────────────────────────
document.getElementById("terminalToggle")?.addEventListener("click", () => {
  const body = document.getElementById("terminal");
  const isOpen = body.classList.toggle("terminal-open");
  document.getElementById("terminalToggle").textContent = isOpen ? "▼ Terminal de análisis" : "▶ Terminal de análisis";
});

// ── Samplebutton switches to GMB tab ────────────────────────
els.sampleButton.addEventListener("click", async () => {
  document.querySelector('[data-tab="gmb"]')?.click();
  updateSource("sample");
  try {
    await startAnalysis({ source: "sample", companyName: "ORBIDI", maxReviews: 100 });
  } catch (error) {
    appendLog({ time: new Date().toISOString(), level: "error", message: error.message });
    setBusy(false);
  }
});

loadConfig().catch(() => {
  els.configStatus.innerHTML = '<span class="badge warn">Config: pendiente</span>';
});

loadLatestReports().catch(() => {});
loadHubspotReport();
