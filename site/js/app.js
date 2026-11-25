import {
  APP_PUBLIC_CONFIG,
  decodeAccessPayload,
  encodeAccessPayload,
  escapeHtml,
  formatBRL,
  formatBytes,
  formatDocumento,
  formatNumberBR,
  sanitizeCsvCell,
  triggerBlobDownload,
} from "./config.js";
import {
  AppsScriptProvider,
  GoogleOAuthDriveProvider,
  LocalApiProvider,
  LocalFolderProvider,
} from "./drive-providers.js";
import { applyFilters, buildSearchIndex, createDefaultFilters } from "./search-engine.js";
import { buildZipBlob } from "./zip-writer.js";

const STORAGE_KEYS = {
  theme: "bcms_consulta_theme",
  appsUrl: "bcms_apps_url",
  appsUrlSession: "bcms_apps_url_session",
  appsTokenSession: "bcms_apps_token_session",
  oauthClient: "bcms_oauth_client",
  oauthFolder: "bcms_oauth_folder",
};

const state = {
  provider: null,
  database: null,
  index: null,
  filters: createDefaultFilters(),
  filtered: { items: [], matchedNes: [], matchedNcs: [], kpis: {} },
  page: 1,
  pageSize: 50,
  selectedIds: new Set(),
  maskCpf: true,
  currentItem: null,
  currentDocs: [],
  currentDocIdx: 0,
  currentPdfResult: null,
  currentObjectUrl: "",
  toastTimer: null,
  lastTriggerEl: null,
};

const $ = (id) => document.getElementById(id);

function showToast(msg, durationMs = 3800) {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => el.classList.add("hidden"), durationMs);
}

function setTheme(theme) {
  const alvo = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", alvo);
  $("btn-theme").textContent = alvo === "light" ? "Tema Escuro" : "Tema Claro";
  try {
    localStorage.setItem(STORAGE_KEYS.theme, alvo);
  } catch {}
}

function initTheme() {
  let saved = "dark";
  try {
    saved = localStorage.getItem(STORAGE_KEYS.theme) || "dark";
  } catch {}
  setTheme(saved);
}

function setConnectError(msg = "") {
  const box = $("connect-error");
  if (!msg) {
    box.classList.add("hidden");
    box.textContent = "";
  } else {
    box.textContent = msg;
    box.classList.remove("hidden");
  }
}

function switchConnectMode(mode) {
  const tabs = [
    ["apps", "tab-mode-apps", "panel-mode-apps"],
    ["oauth", "tab-mode-oauth", "panel-mode-oauth"],
    ["folder", "tab-mode-folder", "panel-mode-folder"],
  ];
  for (const [key, tabId, panelId] of tabs) {
    const active = key === mode;
    $(tabId).setAttribute("aria-selected", active ? "true" : "false");
    $(panelId).classList.toggle("hidden", !active);
  }
  setConnectError("");
}

function setConnectedUI(connected, statusLabel = "") {
  $("connect-section").classList.toggle("hidden", connected);
  $("workspace-section").classList.toggle("hidden", !connected);
  $("btn-share-link").classList.toggle(
    "hidden",
    !(connected && state.provider?.id === "apps_script")
  );
  $("btn-refresh").classList.toggle("hidden", !connected);
  $("btn-disconnect").classList.toggle("hidden", !connected);
  const pill = $("conn-status-pill");
  pill.classList.toggle("is-online", connected);
  $("conn-status-text").textContent = connected
    ? statusLabel || "Conectado ao Acervo"
    : "Desconectado do Drive";
}

async function connectWithProvider(provider, buttonEl = null) {
  setConnectError("");
  const origText = buttonEl ? buttonEl.textContent : "";
  if (buttonEl) {
    buttonEl.disabled = true;
    buttonEl.classList.add("is-loading");
    buttonEl.textContent = "Conectando...";
  }
  try {
    const res = await provider.loadDatabase((stepMsg) => {
      if (buttonEl) buttonEl.textContent = stepMsg;
    });
    if (!res || !res.database || !Array.isArray(res.database.empenhos)) {
      throw new Error("Formato inválido de banco_consulta_bcms.json.");
    }
    state.provider = provider;
    applyLoadedDatabase(res.database, res.label || provider.label);
  } catch (err) {
    setConnectError(err?.message || String(err));
  } finally {
    if (buttonEl) {
      buttonEl.disabled = false;
      buttonEl.classList.remove("is-loading");
      buttonEl.textContent = origText;
    }
  }
}

function applyLoadedDatabase(database, statusLabel) {
  state.database = database;
  state.index = buildSearchIndex(database);
  state.selectedIds.clear();
  state.filters = createDefaultFilters();
  state.page = 1;

  populateFacetControls(database.filtros || {});
  syncControlsFromFilters();
  setConnectedUI(true, statusLabel);
  recomputeAndRender();
  showToast(
    `Base carregada: ${database.empenhos.length} NEs e ${database.creditos.length} NCs prontas para consulta.`
  );
}

function populateFacetControls(f) {
  const fillSelect = (id, list, defaultLabel) => {
    const sel = $(id);
    sel.innerHTML = `<option value="">${escapeHtml(defaultLabel)}</option>`;
    for (const item of list || []) {
      const opt = document.createElement("option");
      opt.value = item.valor;
      opt.textContent = `${item.rotulo} (${item.qtd})`;
      sel.appendChild(opt);
    }
  };

  const fillDatalist = (id, list, useLabelAsValue = false) => {
    const dl = $(id);
    dl.innerHTML = "";
    for (const item of list || []) {
      const opt = document.createElement("option");
      opt.value = useLabelAsValue ? item.rotulo : item.valor;
      if (!useLabelAsValue && item.rotulo && item.rotulo !== item.valor) {
        opt.label = `${item.rotulo} (${item.qtd})`;
      } else {
        opt.label = `${item.qtd} registro(s)`;
      }
      dl.appendChild(opt);
    }
  };

  fillSelect("flt-ug", f.ugs, "Todas (160329 e 167329)");
  fillSelect("flt-modalidade", f.modalidades, "Todas as modalidades");
  fillSelect("flt-tipo-emp", f.tipos_empenho, "Todos os tipos");
  fillSelect("flt-mes", f.meses, "Todos os meses");

  // Situação combina situações de NE + status de NC
  const sitList = [
    ...(f.situacoes_ne || []),
    ...(f.status_nc || []),
  ];
  fillSelect("flt-situacao", sitList, "Todas as situações");

  fillDatalist("dl-empresa", f.empresas, true);
  fillDatalist("dl-nc", f.ncs, false);
  fillDatalist("dl-pi", f.pis, true);
  fillDatalist("dl-nd", f.nds, true);
  fillDatalist("dl-ptres", f.ptres, false);
  fillDatalist("dl-fonte", f.fontes, false);
  fillDatalist("dl-ugr", f.ugrs, false);
  fillDatalist("dl-acao", f.acoes, false);
  fillDatalist("dl-emitente", f.ug_emitentes, true);
  fillDatalist("dl-pregao", f.pregoes, false);
  fillDatalist("dl-subelemento", f.subelementos, false);
}

function syncControlsFromFilters() {
  const f = state.filters;
  $("input-omnibox").value = f.query;
  $("btn-clear-search").classList.toggle("hidden", !f.query);
  $("flt-ug").value = f.ug;
  $("flt-empresa").value = f.empresa;
  $("flt-nc").value = f.nc;
  $("flt-pi").value = f.pi;
  $("flt-nd").value = f.nd;
  $("flt-situacao").value = f.situacao;
  $("flt-ptres").value = f.ptres;
  $("flt-fonte").value = f.fonte;
  $("flt-ugr").value = f.ugr;
  $("flt-acao").value = f.acao;
  $("flt-emitente").value = f.ugEmitente;
  $("flt-modalidade").value = f.modalidade;
  $("flt-tipo-emp").value = f.tipoEmpenho;
  $("flt-pregao").value = f.pregao;
  $("flt-subelemento").value = f.subelemento;
  $("flt-mes").value = f.mes;
  $("flt-data-de").value = f.dataDe;
  $("flt-data-ate").value = f.dataAte;
  $("flt-val-min").value = f.valMinReais;
  $("flt-val-max").value = f.valMaxReais;
  $("flt-anexo").value = f.anexoFiltro;
  $("sort-select").value = f.sort;

  document.querySelectorAll(".view-btn").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.view === f.view);
  });
}

function readFiltersFromControls() {
  const f = state.filters;
  f.query = $("input-omnibox").value;
  $("btn-clear-search").classList.toggle("hidden", !f.query);
  f.ug = $("flt-ug").value;
  f.empresa = $("flt-empresa").value;
  f.nc = $("flt-nc").value;
  f.pi = $("flt-pi").value;
  f.nd = $("flt-nd").value;
  f.situacao = $("flt-situacao").value;
  f.ptres = $("flt-ptres").value;
  f.fonte = $("flt-fonte").value;
  f.ugr = $("flt-ugr").value;
  f.acao = $("flt-acao").value;
  f.ugEmitente = $("flt-emitente").value;
  f.modalidade = $("flt-modalidade").value;
  f.tipoEmpenho = $("flt-tipo-emp").value;
  f.pregao = $("flt-pregao").value;
  f.subelemento = $("flt-subelemento").value;
  f.mes = $("flt-mes").value;
  f.dataDe = $("flt-data-de").value;
  f.dataAte = $("flt-data-ate").value;
  f.valMinReais = $("flt-val-min").value;
  f.valMaxReais = $("flt-val-max").value;
  f.anexoFiltro = $("flt-anexo").value;
  f.sort = $("sort-select").value;
}

function recomputeAndRender() {
  if (!state.index) return;
  state.filtered = applyFilters(state.index, state.filters);
  const totalPages = Math.max(1, Math.ceil(state.filtered.items.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  renderKPIs();
  renderActiveChips();
  renderResults();
}

function formatValorLgpd(centavos, sigiloLgpd) {
  if (sigiloLgpd || centavos === null || centavos === undefined) {
    return "Oculto (LGPD)";
  }
  return formatBRL(centavos);
}

function renderKPIs() {
  const { kpis } = state.filtered;
  const meta = state.database?.meta || {};
  $("badge-count-all").textContent = String(kpis.qtdNes + kpis.qtdNcs);
  $("badge-count-ne").textContent = String(kpis.qtdNes);
  $("badge-count-nc").textContent = String(kpis.qtdNcs);

  $("kpi-qtd-total").textContent = String(kpis.qtdTotal);
  $("kpi-qtd-sub").textContent = `${kpis.qtdNes} NE(s) · ${kpis.qtdNcs} NC(s)` +
    (kpis.qtdSigiloLgpd > 0 ? ` · ${kpis.qtdSigiloLgpd} em sigilo LGPD` : "");
  $("kpi-val-empenhado").textContent = formatBRL(kpis.totalEmpenhadoC);
  $("kpi-empresas-sub").textContent =
    `${kpis.empresasUnicas} empresa(s) pública(s)` +
    (kpis.qtdNesSigiloLgpd > 0 ? ` · ${kpis.qtdNesSigiloLgpd} NE(s) CPF ocultas` : "");
  $("kpi-val-credito").textContent = formatBRL(kpis.totalProvisionadoC);
  $("kpi-disp-sub").textContent =
    `Saldo disponível: ${formatBRL(kpis.totalDisponivelNcC)}` +
    (kpis.qtdNcsSigiloLgpd > 0 ? ` · ${kpis.qtdNcsSigiloLgpd} NC(s) CPF ocultas` : "");
  $("kpi-pdfs").textContent = `${kpis.qtdComPdf} / ${kpis.qtdTotal}`;
  $("kpi-base-meta").textContent = `Gerado em ${meta.gerado_em_br || "—"}`;
}

function renderActiveChips() {
  const labels = [
    ["query", "Busca"],
    ["ug", "UG"],
    ["empresa", "Empresa"],
    ["nc", "NC"],
    ["pi", "PI"],
    ["nd", "ND"],
    ["situacao", "Situação"],
    ["ptres", "PTRES"],
    ["fonte", "Fonte"],
    ["ugr", "UGR"],
    ["acao", "Ação"],
    ["ugEmitente", "Emitente"],
    ["modalidade", "Modalidade"],
    ["tipoEmpenho", "Tipo NE"],
    ["pregao", "Pregão"],
    ["subelemento", "Subelemento"],
    ["mes", "Mês"],
    ["dataDe", "De"],
    ["dataAte", "Até"],
    ["valMinReais", "Valor Mín"],
    ["valMaxReais", "Valor Máx"],
    ["anexoFiltro", "Documento"],
  ];

  const container = $("active-chips");
  container.innerHTML = "";
  let count = 0;

  for (const [key, title] of labels) {
    const val = state.filters[key];
    if (!val) continue;
    count++;
    const chip = document.createElement("span");
    chip.className = "filter-chip";
    chip.innerHTML = `<span>${escapeHtml(title)}: <strong>${escapeHtml(val)}</strong></span>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", `Remover filtro ${title}`);
    btn.textContent = "×";
    btn.addEventListener("click", () => {
      state.filters[key] = "";
      state.page = 1;
      syncControlsFromFilters();
      recomputeAndRender();
    });
    chip.appendChild(btn);
    container.appendChild(chip);
  }

  $("btn-reset-filters").classList.toggle("hidden", count === 0);
}

function statusBadgeClass(item) {
  if (item._kind === "NC") {
    if (item.valor_disponivel_c > 0) return "badge-ok";
    if (String(item.status_execucao).toLowerCase().includes("anulad")) return "badge-danger";
    return "badge-neutral";
  }
  switch (item.situacao) {
    case "TOTALMENTE_ANULADO":
      return "badge-danger";
    case "PARCIALMENTE_ANULADO":
    case "MISTO":
      return "badge-warn";
    case "REFORCADO":
      return "badge-ok";
    default:
      return "badge-neutral";
  }
}

function getVisiblePageItems() {
  const total = state.filtered.items.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  const start = (state.page - 1) * state.pageSize;
  const end = Math.min(total, start + state.pageSize);
  return {
    slice: state.filtered.items.slice(start, end),
    start,
    end,
    total,
    totalPages,
  };
}

function updateSelectedUI() {
  const n = state.selectedIds.size;
  $("selected-count-badge").textContent = `(${n})`;
  $("btn-download-zip").disabled = n === 0;
}

function renderResults() {
  const { slice, start, end, total, totalPages } = getVisiblePageItems();
  $("results-count-label").textContent = total
    ? `Exibindo ${start + 1}–${end} de ${total} documento(s)`
    : "0 documento encontrado";
  $("page-indicator").textContent = `Página ${state.page} de ${totalPages}`;
  $("btn-prev-page").disabled = state.page <= 1;
  $("btn-next-page").disabled = state.page >= totalPages;

  const tbody = $("results-tbody");
  const mobileWrap = $("mobile-cards");
  tbody.innerHTML = "";
  mobileWrap.innerHTML = "";
  $("empty-state").classList.toggle("hidden", total > 0);

  const visibleWithDocs = slice.filter((it) => it.documentos && it.documentos.length > 0);
  const allVisibleSelected =
    visibleWithDocs.length > 0 && visibleWithDocs.every((it) => state.selectedIds.has(it.id));
  $("chk-select-all").checked = allVisibleSelected;

  for (const item of slice) {
    const isNE = item._kind === "NE";
    const isLgpd = Boolean(item.sigilo_lgpd);
    const mainDoc = !isLgpd ? (item.documentos || [])[0] || null : null;
    const hasDocs = Boolean(mainDoc);
    const badgeCls = statusBadgeClass(item);

    // Tabela Desktop
    const tr = document.createElement("tr");
    const entityName = isNE
      ? item.favorecido_nome || "—"
      : `${item.ug_emitente} · ${item.nome_emitente || "UG Emitente"}`;
    const entitySub = isNE
      ? isLgpd
        ? "CPF Oculto (LGPD)"
        : formatDocumento(item.favorecido_doc, item.favorecido_tipo, state.maskCpf)
      : `Favorece: ${(item.ugs_favorecidas || []).join(", ") || "BCMS"}`;

    const classMain = isNE
      ? `${item.pi || "—"} · ND ${item.nd || "—"}`
      : `${(item.pis || []).slice(0, 2).join(", ") || "—"} · ND ${(item.nds || []).slice(0, 2).join(", ") || "—"}`;
    const classSub = isNE
      ? `PTRES ${item.ptres || "—"} · ${item.pregao ? "PE " + item.pregao : item.tipo_empenho || ""}`
      : `PTRES ${(item.ptres || []).slice(0, 2).join(", ") || "—"} · Ação ${item.acao || "—"}`;

    const linkText = isNE
      ? item.nc_vinculada
        ? `NC: ${item.nc_vinculada}`
        : "Sem NC citada"
      : `${(item.nes_vinculadas || []).length} NE(s) vinculada(s)`;
    const statusText = isNE
      ? item.situacao_rotulo
      : item.status_execucao || item.status || "Contabilizada";
    const valorFmt = isNE
      ? formatValorLgpd(item.valor_atual_c, isLgpd)
      : formatValorLgpd(item.valor_bcms_c, isLgpd);
    const valorSub = isLgpd
      ? "PDF restrito (LGPD)"
      : isNE
      ? item.tem_processo
        ? "c/ Processo Escaneado"
        : item.tem_requisicao
        ? "c/ Requisição"
        : ""
      : `Disp.: ${formatBRL(item.valor_disponivel_c)}`;
    const lgpdBadgeHtml = isLgpd ? ` <span class="badge badge-warn">Sigilo LGPD</span>` : "";

    tr.innerHTML = `
      <td>
        <input class="row-check" type="checkbox" data-check-id="${escapeHtml(item.id)}" ${
          state.selectedIds.has(item.id) ? "checked" : ""
        } ${hasDocs ? "" : "disabled"} aria-label="Selecionar ${escapeHtml(item.chave)} para download em lote">
      </td>
      <td>
        <span class="badge ${isNE ? "badge-ne" : "badge-nc"}">${isNE ? "NE" : "NC"}</span>
        <button type="button" class="doc-key-btn" data-open-id="${escapeHtml(item.id)}">${escapeHtml(item.chave)}</button>
        <span class="cell-sub mono">v${escapeHtml(item.versao || "000")} · ${isLgpd ? "oculto (LGPD)" : `${escapeHtml(item.documentos?.length || 0)} arq.`}</span>
      </td>
      <td>
        <span>${escapeHtml(item.data_emissao || "—")}</span>
        <span class="cell-sub mono">UG ${escapeHtml(isNE ? item.ug : item.ug_principal || "160329")}</span>
      </td>
      <td>
        <div class="cell-clamp" title="${escapeHtml(entityName)}"><strong>${escapeHtml(entityName)}</strong></div>
        <span class="cell-sub mono">${escapeHtml(entitySub)}</span>
      </td>
      <td>
        <div class="cell-clamp" title="${escapeHtml(classMain)}">${escapeHtml(classMain)}</div>
        <span class="cell-sub">${escapeHtml(classSub)}</span>
      </td>
      <td>
        <span class="badge ${badgeCls}">${escapeHtml(statusText)}</span>${lgpdBadgeHtml}
        <span class="cell-sub mono">${escapeHtml(linkText)}</span>
      </td>
      <td style="text-align:right;white-space:nowrap;">
        <strong class="mono">${escapeHtml(valorFmt)}</strong>
        ${valorSub ? `<span class="cell-sub mono">${escapeHtml(valorSub)}</span>` : ""}
      </td>
      <td>
        <div class="row-actions">
          <button type="button" class="icon-btn" data-open-id="${escapeHtml(item.id)}" title="Abrir ficha detalhada e visualizar PDF">
            Abrir
          </button>
          <button type="button" class="icon-btn" data-dl-id="${escapeHtml(item.id)}" ${
            hasDocs ? "" : "disabled"
          } title="${isLgpd ? "PDF ocultado pela LGPD (pagamento direto a militar)" : hasDocs ? "Baixar PDF oficial" : "PDF não disponível no acervo"}">
            PDF
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);

    // Card Mobile
    const card = document.createElement("article");
    card.className = "m-card";
    card.innerHTML = `
      <div class="m-card-head">
        <div>
          <span class="badge ${isNE ? "badge-ne" : "badge-nc"}">${isNE ? "NE" : "NC"}</span>
          <button type="button" class="doc-key-btn" data-open-id="${escapeHtml(item.id)}">${escapeHtml(item.chave)}</button>
          <span class="cell-sub mono">${escapeHtml(item.data_emissao || "—")} · UG ${escapeHtml(isNE ? item.ug : item.ug_principal || "160329")}</span>
        </div>
        <strong class="mono">${escapeHtml(valorFmt)}</strong>
      </div>
      <div><strong>${escapeHtml(entityName)}</strong></div>
      <div class="m-card-meta">
        <span>${escapeHtml(classMain)}</span>
        <span class="badge ${badgeCls}">${escapeHtml(statusText)}</span>${lgpdBadgeHtml}
      </div>
      <div class="m-card-actions">
        <button type="button" class="btn btn-sm btn-primary" data-open-id="${escapeHtml(item.id)}">Detalhes &amp; PDF</button>
        <button type="button" class="btn btn-sm btn-emerald" data-dl-id="${escapeHtml(item.id)}" ${hasDocs ? "" : "disabled"}>Baixar PDF</button>
      </div>
    `;
    mobileWrap.appendChild(card);
  }

  updateSelectedUI();
}

function findItemById(id) {
  if (!state.index) return null;
  return state.index.neMap.get(id) || state.index.ncById.get(id) || null;
}

async function downloadPrimaryPdfForItem(item, triggerBtn = null) {
  const doc = (item.documentos || [])[0];
  if (!doc) {
    showToast("Este registro ainda não possui arquivo PDF vinculado no acervo.");
    return;
  }
  const orig = triggerBtn ? triggerBtn.textContent : "";
  if (triggerBtn) {
    triggerBtn.disabled = true;
    triggerBtn.textContent = "...";
  }
  try {
    const res = await state.provider.fetchPdf(doc);
    if (res.mode === "drive_link") {
      window.open(res.downloadUrl || res.previewUrl, "_blank", "noopener,noreferrer");
      showToast("Arquivo grande (>15 MB): download iniciado direto pelo Google Drive.");
    } else {
      triggerBlobDownload(res.blob, res.name || doc.nome_arquivo);
      showToast(`Download iniciado: ${doc.nome_arquivo}`);
    }
  } catch (err) {
    showToast(`Erro ao baixar PDF: ${err?.message || err}`, 5000);
  } finally {
    if (triggerBtn) {
      triggerBtn.disabled = false;
      triggerBtn.textContent = orig;
    }
  }
}

async function downloadSelectedAsZip() {
  const ids = Array.from(state.selectedIds);
  if (!ids.length || !state.provider) return;

  const progressBox = $("batch-progress");
  const progressText = $("batch-progress-text");
  const btnZip = $("btn-download-zip");
  btnZip.disabled = true;
  progressBox.classList.remove("hidden");

  const entries = [];
  const skipped = [];
  const usedNames = new Set();

  try {
    for (let i = 0; i < ids.length; i++) {
      const item = findItemById(ids[i]);
      if (!item || !item.documentos || !item.documentos.length) continue;
      const doc = item.documentos[0];
      progressText.textContent = `Baixando documento ${i + 1} de ${ids.length}: ${doc.nome_arquivo}...`;

      try {
        const res = await state.provider.fetchPdf(doc);
        if (res.mode === "drive_link") {
          skipped.push(`${doc.nome_arquivo} (>15 MB)`);
          continue;
        }
        const buf = new Uint8Array(await res.blob.arrayBuffer());
        let entryName = doc.nome_arquivo;
        if (usedNames.has(entryName)) {
          entryName = `${i + 1}_${entryName}`;
        }
        usedNames.add(entryName);
        entries.push({ name: entryName, data: buf });
      } catch (err) {
        skipped.push(`${doc.nome_arquivo} (${err?.message || "erro"})`);
      }
    }

    if (!entries.length) {
      showToast("Nenhum PDF pôde ser empacotado no ZIP.", 4500);
      return;
    }

    progressText.textContent = `Empacotando ${entries.length} PDF(s) em arquivo .ZIP...`;
    const zipBlob = buildZipBlob(entries);
    const stamp = new Date().toISOString().slice(0, 10);
    triggerBlobDownload(zipBlob, `Acervo_BCMS_${stamp}_${entries.length}docs.zip`);

    if (skipped.length) {
      showToast(
        `ZIP gerado com ${entries.length} arquivo(s). Ignorados: ${skipped.slice(0, 3).join(", ")}`,
        6000
      );
    } else {
      showToast(`ZIP gerado com ${entries.length} documento(s)!`);
    }
  } finally {
    progressBox.classList.add("hidden");
    updateSelectedUI();
  }
}

function exportFilteredCsv() {
  const items = state.filtered.items;
  if (!items.length) {
    showToast("Não há registros na consulta atual para exportar.");
    return;
  }

  const headers = [
    "Tipo",
    "UG",
    "Documento",
    "Versao",
    "Emissao",
    "Favorecido_ou_Emitente",
    "CNPJ_CPF_UG",
    "PI",
    "ND",
    "PTRES",
    "Fonte",
    "UGR",
    "Acao",
    "NC_ou_NEs_Vinculadas",
    "Modalidade",
    "Pregao",
    "Situacao",
    "Valor_BRL",
    "Qtd_Arquivos_PDF",
    "Descricao",
  ];

  const rows = [headers.map(sanitizeCsvCell).join(";")];
  for (const it of items) {
    const isNE = it._kind === "NE";
    const row = [
      it._kind,
      isNE ? it.ug : it.ug_principal,
      it.chave,
      it.versao,
      it.data_emissao,
      isNE ? it.favorecido_nome : it.nome_emitente,
      isNE
        ? it.sigilo_lgpd
          ? "OCULTO (LGPD)"
          : formatDocumento(it.favorecido_doc, it.favorecido_tipo, state.maskCpf)
        : it.ug_emitente,
      isNE ? it.pi : (it.pis || []).join(" | "),
      isNE ? it.nd : (it.nds || []).join(" | "),
      isNE ? it.ptres : (it.ptres || []).join(" | "),
      isNE ? it.fonte : (it.fontes || []).join(" | "),
      isNE ? it.ugr : (it.ugrs || []).join(" | "),
      it.acao,
      isNE ? it.nc_vinculada : (it.nes_vinculadas || []).join(" | "),
      isNE ? it.modalidade : it.tipo_nc,
      isNE ? it.pregao : "",
      isNE ? it.situacao_rotulo : it.status_execucao || it.status,
      formatValorLgpd(isNE ? it.valor_atual_c : it.valor_bcms_c, it.sigilo_lgpd),
      it.sigilo_lgpd ? "Oculto (LGPD)" : String((it.documentos || []).length),
      it.descricao,
    ];
    rows.push(row.map(sanitizeCsvCell).join(";"));
  }

  const csvContent = "\uFEFF" + rows.join("\r\n");
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8" });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerBlobDownload(blob, `Consulta_BCMS_SIAFI_${stamp}.csv`);
  showToast(`Planilha CSV exportada (${items.length} linhas).`);
}

function revokePdfUrl() {
  if (state.currentObjectUrl) {
    URL.revokeObjectURL(state.currentObjectUrl);
    state.currentObjectUrl = "";
  }
}

async function openDocumentModal(item, triggerEl = null) {
  if (!item) return;
  if (triggerEl) state.lastTriggerEl = triggerEl;
  state.currentItem = item;
  state.currentDocs = item.sigilo_lgpd ? [] : item.documentos || [];
  state.currentDocIdx = 0;

  const isNE = item._kind === "NE";
  const badgeKind = $("modal-badge-kind");
  badgeKind.textContent = isNE ? `NE · UG ${item.ug}` : `NC · Emitente ${item.ug_emitente}`;
  badgeKind.className = `badge ${isNE ? "badge-ne" : "badge-nc"}`;

  $("modal-title").textContent = item.chave;
  const badgeStatus = $("modal-badge-status");
  badgeStatus.textContent = item.sigilo_lgpd
    ? "Sigilo LGPD"
    : isNE
    ? item.situacao_rotulo
    : item.status_execucao || item.status || "Contabilizada";
  badgeStatus.className = `badge ${item.sigilo_lgpd ? "badge-warn" : statusBadgeClass(item)}`;

  renderModalDetails(item);
  renderPdfDocTabs();

  $("doc-modal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
  $("btn-modal-close").focus();

  if (state.currentDocs.length > 0) {
    await loadModalPdfAt(0);
  } else {
    revokePdfUrl();
    state.currentPdfResult = null;
    $("btn-pdf-download").disabled = true;
    $("btn-pdf-open-tab").disabled = true;
    $("pdf-viewer-stage").innerHTML = item.sigilo_lgpd
      ? `
      <div class="pdf-placeholder">
        <strong>🔒 Documento Protegido (LGPD)</strong>
        <span>Empenhos e créditos nominativos de pagamento direto a militares têm CPF, dados pessoais, valores e PDF ocultados.</span>
      </div>`
      : `
      <div class="pdf-placeholder">
        <strong>PDF Oficial ainda não disponível no acervo</strong>
        <span>Este registro existe na conciliação SIAFI/Tesouro Gerencial, mas o PDF correspondente ainda não foi extraído para a pasta de documentos.</span>
      </div>`;
  }
}

function closeDocumentModal() {
  $("doc-modal").classList.add("hidden");
  document.body.style.overflow = "";
  revokePdfUrl();
  $("pdf-viewer-stage").innerHTML = "";
  if (state.lastTriggerEl && typeof state.lastTriggerEl.focus === "function") {
    state.lastTriggerEl.focus();
  }
  state.lastTriggerEl = null;
}

function renderModalDetails(item) {
  const pane = $("modal-details-pane");
  if (item._kind === "NE") {
    const isLgpd = Boolean(item.sigilo_lgpd);
    const ncMatches = item.nc_vinculada
      ? state.index.ncByChave.get(item.nc_vinculada) || []
      : [];
    const docFav = isLgpd
      ? "OCULTO (LGPD)"
      : formatDocumento(item.favorecido_doc, item.favorecido_tipo, state.maskCpf);

    const itensHtml = (item.itens || []).length
      ? `
      <div class="detail-section">
        <h3>Itens Empenhados e Operações (${item.itens.length})</h3>
        <div style="overflow-x:auto;">
          <table class="mini-table">
            <thead>
              <tr>
                <th>Seq</th>
                <th>Descrição / Subelemento</th>
                <th>Operações</th>
                <th style="text-align:right;">Líquido</th>
              </tr>
            </thead>
            <tbody>
              ${item.itens
                .map(
                  (it) => `
                <tr>
                  <td class="mono">${escapeHtml(String(it.seq ?? "").padStart(3, "0"))}</td>
                  <td>
                    <strong>${escapeHtml(it.descricao || "—")}</strong>
                    <div style="color:var(--text-muted);margin-top:2px;">Sub ${escapeHtml(it.subelemento || "—")} · ${escapeHtml(it.subelemento_nome || "")}</div>
                  </td>
                  <td class="mono">
                    ${(it.operacoes || [])
                      .map(
                        (op) =>
                          `<div>${escapeHtml(op.data)} · ${escapeHtml(op.operacao)}: ${escapeHtml(formatNumberBR(op.quantidade))} × ${escapeHtml(formatNumberBR(op.valor_unitario))} = <strong>${escapeHtml(formatBRL(op.valor_total_c))}</strong></div>`
                      )
                      .join("")}
                  </td>
                  <td class="mono" style="text-align:right;white-space:nowrap;"><strong>${escapeHtml(formatBRL(it.valor_liquido_c))}</strong></td>
                </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>`
      : "";

    pane.innerHTML = `
      <div class="detail-section">
        <h3>Identificação e Favorecido</h3>
        <div class="kv-grid">
          <div class="kv-item"><span>Unidade Emitente</span><strong class="mono">${escapeHtml(item.ug_rotulo)}</strong></div>
          <div class="kv-item"><span>Emissão / Versão</span><strong class="mono">${escapeHtml(item.data_emissao || "—")} · v${escapeHtml(item.versao)}</strong></div>
          <div class="kv-item"><span>Tipo de Empenho</span><strong>${escapeHtml(item.tipo_empenho || "—")}</strong></div>
          <div class="kv-item"><span>Favorecido</span><strong>${escapeHtml(item.favorecido_nome || "—")}</strong></div>
          <div class="kv-item"><span>${escapeHtml(item.favorecido_tipo || "Documento")}</span><strong class="mono">${escapeHtml(docFav)}</strong></div>
          <div class="kv-item"><span>Modalidade / Pregão</span><strong>${escapeHtml(item.modalidade || "—")} ${item.pregao ? `· ${escapeHtml(item.pregao)}` : ""}</strong></div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Valores da Nota de Empenho</h3>
        <div class="kv-grid">
          <div class="kv-item"><span>Valor Líquido Atual</span><strong class="mono" style="color:var(--accent-blue-text);font-size:var(--fs-md);">${escapeHtml(formatValorLgpd(item.valor_atual_c, isLgpd))}</strong></div>
          <div class="kv-item"><span>Incluído</span><strong class="mono">${escapeHtml(formatValorLgpd(item.valor_incluido_c, isLgpd))}</strong></div>
          <div class="kv-item"><span>Reforçado</span><strong class="mono">${escapeHtml(formatValorLgpd(item.valor_reforcado_c, isLgpd))}</strong></div>
          <div class="kv-item"><span>Anulado</span><strong class="mono">${escapeHtml(formatValorLgpd(item.valor_anulado_c, isLgpd))}</strong></div>
        </div>
        ${
          !isLgpd && item.cel_empenhado_c > 0
            ? `<div style="font-size:var(--fs-xs);color:var(--text-muted);border-top:1px solid var(--border-subtle);padding-top:8px;">
                Execução consolidada da célula (${escapeHtml(item.pi)} · ${escapeHtml(item.nd)}):
                Empenhado ${escapeHtml(formatBRL(item.cel_empenhado_c))} ·
                Liquidado ${escapeHtml(formatBRL(item.cel_liquidado_c))} (${escapeHtml(String(item.cel_pct_liquidado ?? 0))}%) ·
                Pago ${escapeHtml(formatBRL(item.cel_pago_c))}
              </div>`
            : ""
        }
      </div>

      <div class="detail-section">
        <h3>Classificação Orçamentária e Rastreabilidade</h3>
        <div class="kv-grid">
          <div class="kv-item"><span>Esfera / PTRES</span><strong class="mono">${escapeHtml(item.esfera || "—")} · ${escapeHtml(item.ptres || "—")}</strong></div>
          <div class="kv-item"><span>Fonte / UGR</span><strong class="mono">${escapeHtml(item.fonte || "—")} · ${escapeHtml(item.ugr || "—")}</strong></div>
          <div class="kv-item"><span>Plano Interno (PI)</span><strong class="mono">${escapeHtml(item.pi || "—")}</strong><span style="font-size:11px;color:var(--text-muted);">${escapeHtml(item.pi_desc || "")}</span></div>
          <div class="kv-item"><span>Natureza (ND)</span><strong class="mono">${escapeHtml(item.nd || "—")}</strong><span style="font-size:11px;color:var(--text-muted);">${escapeHtml(item.nd_desc || "")}</span></div>
          <div class="kv-item"><span>Ação / Processo (NUP)</span><strong class="mono">${escapeHtml(item.acao || "—")} · ${escapeHtml(isLgpd ? "Oculto (LGPD)" : item.processo_nup || "—")}</strong></div>
          <div class="kv-item"><span>Nota de Crédito (NC)</span>
            ${
              ncMatches.length
                ? `<div class="link-pills">${ncMatches
                    .map(
                      (nc) =>
                        `<button type="button" class="link-pill-btn" data-jump-id="${escapeHtml(nc.id)}">${escapeHtml(nc.chave)} (UG ${escapeHtml(nc.ug_emitente)})</button>`
                    )
                    .join("")}</div>`
                : `<strong class="mono">${escapeHtml(item.nc_vinculada || "Não citada")}</strong>`
            }
          </div>
        </div>
        ${item.prova_rastreabilidade ? `<div style="font-size:var(--fs-xs);color:var(--text-secondary);">Auditoria: <strong>${escapeHtml(item.prova_rastreabilidade)}</strong></div>` : ""}
      </div>

      <div class="detail-section">
        <h3>Descrição, Entrega e Responsáveis</h3>
        <p style="margin:0;font-size:var(--fs-sm);line-height:1.55;">${escapeHtml(item.descricao || "—")}</p>
        <div class="kv-grid">
          <div class="kv-item"><span>Local de Entrega</span><strong>${escapeHtml(isLgpd ? "Oculto (LGPD)" : item.local_entrega || "—")}</strong></div>
          <div class="kv-item"><span>Minuta / Amparo</span><strong>${escapeHtml(isLgpd ? "Oculto (LGPD)" : item.minuta || "—")} · ${escapeHtml(item.amparo || "")}</strong></div>
          <div class="kv-item"><span>Ordenador de Despesa</span><strong>${escapeHtml(isLgpd ? "Oculto (LGPD)" : item.ordenador || "—")}</strong></div>
          <div class="kv-item"><span>Responsável pela NE</span><strong>${escapeHtml(isLgpd ? "Oculto (LGPD)" : item.responsavel || "—")}</strong></div>
        </div>
      </div>

      ${itensHtml}
    `;
  } else {
    // NC Details
    const isLgpdNc = Boolean(item.sigilo_lgpd);
    const linkedNes = (item.nes_vinculadas || [])
      .map((neId) => state.index.neMap.get(neId))
      .filter(Boolean);

    const itensHtml = (item.itens || []).length
      ? `
      <div class="detail-section">
        <h3>Células de Destino para o BCMS (${item.itens.length})</h3>
        <div style="overflow-x:auto;">
          <table class="mini-table">
            <thead>
              <tr>
                <th>Seq / UG Fav.</th>
                <th>PTRES · Fonte · PI · ND · UGR</th>
                <th style="text-align:right;">Valor</th>
              </tr>
            </thead>
            <tbody>
              ${item.itens
                .map((it) =>
                  (it.destino || []).length
                    ? it.destino
                        .map(
                          (c) => `
                      <tr>
                        <td class="mono">${escapeHtml(String(it.seq))} · ${escapeHtml(it.ug_favorecida)}</td>
                        <td>
                          <span class="mono">PTRES ${escapeHtml(c.ptres)} · Fonte ${escapeHtml(c.fonte)} · UGR ${escapeHtml(c.ugr)}</span>
                          <div><strong>PI ${escapeHtml(c.pi || "—")}</strong> ${escapeHtml(c.pi_desc || "")} · <strong>ND ${escapeHtml(c.nd)}</strong> ${escapeHtml(c.nd_desc || "")}</div>
                        </td>
                        <td class="mono" style="text-align:right;white-space:nowrap;"><strong>${escapeHtml(formatValorLgpd(c.valor_c, isLgpdNc))}</strong></td>
                      </tr>`
                        )
                        .join("")
                    : `<tr>
                        <td class="mono">${escapeHtml(String(it.seq))} · ${escapeHtml(it.ug_favorecida)}</td>
                        <td>${escapeHtml(it.nome_favorecida)} (${escapeHtml(it.situacao)})</td>
                        <td class="mono" style="text-align:right;"><strong>${escapeHtml(formatValorLgpd(it.valor_c, isLgpdNc))}</strong></td>
                      </tr>`
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </div>`
      : "";

    pane.innerHTML = `
      <div class="detail-section">
        <h3>Identificação da Nota de Crédito</h3>
        <div class="kv-grid">
          <div class="kv-item"><span>UG Emitente</span><strong class="mono">${escapeHtml(item.ug_emitente)} · ${escapeHtml(item.nome_emitente || "—")}</strong></div>
          <div class="kv-item"><span>UG(s) Favorecida(s) BCMS</span><strong class="mono">${escapeHtml((item.ugs_favorecidas || []).join(", ") || "—")}</strong></div>
          <div class="kv-item"><span>Data de Emissão</span><strong class="mono">${escapeHtml(item.data_emissao || "—")}</strong></div>
          <div class="kv-item"><span>Tipo / Operação</span><strong>${escapeHtml(item.tipo_nc || "—")}</strong></div>
          <div class="kv-item"><span>Status SIAFI</span><strong>${escapeHtml(item.status || "—")}</strong></div>
          <div class="kv-item"><span>Ação Orçamentária</span><strong class="mono">${escapeHtml(item.acao || "—")}</strong></div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Execução Financeira do Crédito (BCMS)</h3>
        <div class="kv-grid">
          <div class="kv-item"><span>Valor no Documento</span><strong class="mono">${escapeHtml(formatValorLgpd(item.valor_bcms_c, isLgpdNc))}</strong></div>
          <div class="kv-item"><span>Provisionado Líquido</span><strong class="mono" style="color:var(--accent-blue-text);">${escapeHtml(formatValorLgpd(item.valor_provisionado_c, isLgpdNc))}</strong></div>
          <div class="kv-item"><span>Empenhado</span><strong class="mono">${escapeHtml(formatValorLgpd(item.valor_empenhado_c, isLgpdNc))}</strong></div>
          <div class="kv-item"><span>Saldo Disponível</span><strong class="mono" style="color:var(--accent-emerald-text);">${escapeHtml(formatValorLgpd(item.valor_disponivel_c, isLgpdNc))}</strong></div>
        </div>
      </div>

      <div class="detail-section">
        <h3>Classificação e Notas de Empenho Vinculadas (${linkedNes.length})</h3>
        <div class="kv-grid">
          <div class="kv-item"><span>PI(s)</span><strong class="mono">${escapeHtml((item.pis || []).join(", ") || "—")}</strong></div>
          <div class="kv-item"><span>ND(s)</span><strong class="mono">${escapeHtml((item.nds || []).join(", ") || "—")}</strong></div>
          <div class="kv-item"><span>PTRES</span><strong class="mono">${escapeHtml((item.ptres || []).join(", ") || "—")}</strong></div>
          <div class="kv-item"><span>Fontes</span><strong class="mono">${escapeHtml((item.fontes || []).join(", ") || "—")}</strong></div>
        </div>
        ${
          linkedNes.length
            ? `<div class="link-pills">${linkedNes
                .map(
                  (ne) =>
                    `<button type="button" class="link-pill-btn" data-jump-id="${escapeHtml(ne.id)}">${escapeHtml(ne.chave)} · ${escapeHtml(formatValorLgpd(ne.valor_atual_c, ne.sigilo_lgpd))}</button>`
                )
                .join("")}</div>`
            : `<span style="font-size:var(--fs-xs);color:var(--text-muted);">Nenhuma NE do BCMS referencia diretamente esta NC no momento.</span>`
        }
      </div>

      <div class="detail-section">
        <h3>Observação / Finalidade da NC</h3>
        <p style="margin:0;font-size:var(--fs-sm);line-height:1.55;">${escapeHtml(item.descricao || "—")}</p>
      </div>

      ${itensHtml}
    `;
  }
}

function renderPdfDocTabs() {
  const tabs = $("pdf-doc-tabs");
  tabs.innerHTML = "";
  if (!state.currentDocs.length) {
    tabs.innerHTML = `<span style="font-size:var(--fs-xs);color:var(--text-muted);">Sem arquivos anexos</span>`;
    return;
  }
  state.currentDocs.forEach((doc, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `pdf-tab-btn ${idx === state.currentDocIdx ? "is-active" : ""}`;
    btn.textContent = `${doc.rotulo} (${formatBytes(doc.tamanho_bytes)})`;
    btn.addEventListener("click", () => loadModalPdfAt(idx));
    tabs.appendChild(btn);
  });
}

async function loadModalPdfAt(idx) {
  state.currentDocIdx = idx;
  renderPdfDocTabs();
  const doc = state.currentDocs[idx];
  const stage = $("pdf-viewer-stage");
  $("btn-pdf-download").disabled = true;
  $("btn-pdf-open-tab").disabled = true;
  revokePdfUrl();
  state.currentPdfResult = null;

  stage.innerHTML = `<div class="pdf-placeholder">Carregando <strong>${escapeHtml(doc.nome_arquivo)}</strong>...</div>`;

  try {
    const res = await state.provider.fetchPdf(doc);
    if (!state.currentItem || state.currentDocIdx !== idx) return;
    state.currentPdfResult = res;

    if (res.mode === "drive_link") {
      $("btn-pdf-download").disabled = false;
      $("btn-pdf-open-tab").disabled = false;
      stage.innerHTML = `
        <div class="pdf-placeholder">
          <strong>Documento extenso (${escapeHtml(formatBytes(res.size))})</strong>
          <span>Por exceder 15 MB na ponte Apps Script, abra ou baixe diretamente via Google Drive autenticado:</span>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
            <a class="btn btn-primary" href="${escapeHtml(res.previewUrl)}" target="_blank" rel="noopener noreferrer">Visualizar no Drive</a>
            <a class="btn btn-emerald" href="${escapeHtml(res.downloadUrl)}" target="_blank" rel="noopener noreferrer">Baixar PDF</a>
          </div>
        </div>`;
      return;
    }

    const objUrl = URL.createObjectURL(res.blob);
    state.currentObjectUrl = objUrl;
    $("btn-pdf-download").disabled = false;
    $("btn-pdf-open-tab").disabled = false;

    const iframe = document.createElement("iframe");
    iframe.className = "pdf-iframe";
    iframe.title = doc.nome_arquivo;
    iframe.src = objUrl;
    stage.innerHTML = "";
    stage.appendChild(iframe);
  } catch (err) {
    stage.innerHTML = `
      <div class="pdf-placeholder">
        <strong>Falha ao carregar o PDF</strong>
        <span>${escapeHtml(err?.message || String(err))}</span>
      </div>`;
  }
}

function wireEvents() {
  $("btn-theme").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    setTheme(cur === "light" ? "dark" : "light");
  });

  $("tab-mode-apps").addEventListener("click", () => switchConnectMode("apps"));
  $("tab-mode-oauth").addEventListener("click", () => switchConnectMode("oauth"));
  $("tab-mode-folder").addEventListener("click", () => switchConnectMode("folder"));

  $("panel-mode-apps").addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = $("input-apps-url").value.trim();
    const token = $("input-apps-token").value.trim();
    if (!url || !token) return;
    if ($("chk-remember-apps").checked) {
      try {
        localStorage.setItem(STORAGE_KEYS.appsUrl, url);
        sessionStorage.setItem(STORAGE_KEYS.appsUrlSession, url);
        sessionStorage.setItem(STORAGE_KEYS.appsTokenSession, token);
      } catch {}
    } else {
      try {
        localStorage.removeItem(STORAGE_KEYS.appsUrl);
        sessionStorage.removeItem(STORAGE_KEYS.appsUrlSession);
        sessionStorage.removeItem(STORAGE_KEYS.appsTokenSession);
      } catch {}
    }
    await connectWithProvider(new AppsScriptProvider(url, token), $("btn-connect-apps"));
  });

  $("panel-mode-oauth").addEventListener("submit", async (e) => {
    e.preventDefault();
    const clientId = $("input-oauth-client").value.trim();
    const folderId = $("input-oauth-folder").value.trim();
    if (!clientId || !folderId) return;
    if ($("chk-remember-oauth").checked) {
      try {
        localStorage.setItem(STORAGE_KEYS.oauthClient, clientId);
        localStorage.setItem(STORAGE_KEYS.oauthFolder, folderId);
      } catch {}
    }
    await connectWithProvider(new GoogleOAuthDriveProvider(clientId, folderId), $("btn-connect-oauth"));
  });

  $("btn-connect-folder").addEventListener("click", async () => {
    await connectWithProvider(new LocalFolderProvider(), $("btn-connect-folder"));
  });

  $("btn-connect-local-api").addEventListener("click", async () => {
    await connectWithProvider(new LocalApiProvider(), $("btn-connect-local-api"));
  });

  $("btn-refresh").addEventListener("click", async () => {
    if (!state.provider) return;
    const btn = $("btn-refresh");
    btn.disabled = true;
    btn.textContent = "Atualizando...";
    try {
      const res = await state.provider.refresh();
      applyLoadedDatabase(res.database, res.label || state.provider.label);
    } catch (err) {
      showToast(`Falha ao atualizar: ${err?.message || err}`, 5000);
    } finally {
      btn.disabled = false;
      btn.textContent = "Atualizar Base";
    }
  });

  $("btn-share-link").addEventListener("click", async () => {
    if (!state.provider || state.provider.id !== "apps_script") return;
    const encoded = encodeAccessPayload(state.provider.url, state.provider.token);
    const shareUrl = `${window.location.origin}${window.location.pathname}#acesso=${encoded}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      showToast(
        "Link direto de 1 clique copiado! Cole no grupo do batalhão. Quem não tiver este link não consegue acessar.",
        5500
      );
    } catch {
      window.prompt("Copie o link direto para o grupo do batalhão:", shareUrl);
    }
  });

  $("btn-disconnect").addEventListener("click", () => {
    state.provider = null;
    state.database = null;
    state.index = null;
    try {
      sessionStorage.removeItem(STORAGE_KEYS.appsUrlSession);
      sessionStorage.removeItem(STORAGE_KEYS.appsTokenSession);
    } catch {}
    setConnectedUI(false);
    closeDocumentModal();
  });

  // Busca e filtros
  let searchTimer = null;
  const triggerFilterUpdate = (debounce = false) => {
    clearTimeout(searchTimer);
    const run = () => {
      readFiltersFromControls();
      state.page = 1;
      recomputeAndRender();
    };
    if (debounce) {
      searchTimer = setTimeout(run, 140);
    } else {
      run();
    }
  };

  $("input-omnibox").addEventListener("input", () => triggerFilterUpdate(true));
  $("btn-clear-search").addEventListener("click", () => {
    $("input-omnibox").value = "";
    triggerFilterUpdate(false);
    $("input-omnibox").focus();
  });

  [
    "flt-ug",
    "flt-situacao",
    "flt-modalidade",
    "flt-tipo-emp",
    "flt-mes",
    "flt-data-de",
    "flt-data-ate",
    "flt-anexo",
    "sort-select",
  ].forEach((id) => $(id).addEventListener("change", () => triggerFilterUpdate(false)));

  [
    "flt-empresa",
    "flt-nc",
    "flt-pi",
    "flt-nd",
    "flt-ptres",
    "flt-fonte",
    "flt-ugr",
    "flt-acao",
    "flt-emitente",
    "flt-pregao",
    "flt-subelemento",
    "flt-val-min",
    "flt-val-max",
  ].forEach((id) => $(id).addEventListener("input", () => triggerFilterUpdate(true)));

  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filters.view = btn.dataset.view;
      state.page = 1;
      syncControlsFromFilters();
      recomputeAndRender();
    });
  });

  document.querySelectorAll(".preset-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.filters = createDefaultFilters();
      const p = btn.dataset.preset;
      if (p === "ug160") state.filters.ug = "160329";
      if (p === "ug167") state.filters.ug = "167329";
      if (p === "com_processo") {
        state.filters.view = "ne";
        state.filters.anexoFiltro = "com_processo";
      }
      if (p === "com_requisicao") {
        state.filters.view = "ne";
        state.filters.anexoFiltro = "com_requisicao";
      }
      if (p === "com_saldo_nc") {
        state.filters.view = "nc";
        state.filters.anexoFiltro = "com_saldo_nc";
      }
      if (p === "anuladas") {
        state.filters.view = "ne";
        state.filters.situacao = "Totalmente Anulada";
      }
      state.page = 1;
      syncControlsFromFilters();
      recomputeAndRender();
    });
  });

  const resetAll = () => {
    state.filters = createDefaultFilters();
    state.page = 1;
    syncControlsFromFilters();
    recomputeAndRender();
  };
  $("btn-reset-filters").addEventListener("click", resetAll);
  $("btn-empty-reset").addEventListener("click", resetAll);

  // Paginação
  $("page-size-select").addEventListener("change", () => {
    state.pageSize = Number($("page-size-select").value) || 50;
    state.page = 1;
    renderResults();
  });
  $("btn-prev-page").addEventListener("click", () => {
    if (state.page > 1) {
      state.page--;
      renderResults();
    }
  });
  $("btn-next-page").addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(state.filtered.items.length / state.pageSize));
    if (state.page < totalPages) {
      state.page++;
      renderResults();
    }
  });

  // Seleção em lote e ações na tabela/cards
  $("chk-select-all").addEventListener("change", (e) => {
    const checked = e.target.checked;
    const { slice } = getVisiblePageItems();
    for (const it of slice) {
      if (!it.documentos || !it.documentos.length) continue;
      if (checked) state.selectedIds.add(it.id);
      else state.selectedIds.delete(it.id);
    }
    renderResults();
  });

  const handleRowInteraction = (e) => {
    const chk = e.target.closest("[data-check-id]");
    if (chk) {
      const id = chk.dataset.checkId;
      if (chk.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      updateSelectedUI();
      return;
    }
    const openBtn = e.target.closest("[data-open-id]");
    if (openBtn) {
      const it = findItemById(openBtn.dataset.openId);
      if (it) openDocumentModal(it, openBtn);
      return;
    }
    const dlBtn = e.target.closest("[data-dl-id]");
    if (dlBtn) {
      const it = findItemById(dlBtn.dataset.dlId);
      if (it) downloadPrimaryPdfForItem(it, dlBtn);
    }
  };
  $("results-tbody").addEventListener("click", handleRowInteraction);
  $("mobile-cards").addEventListener("click", handleRowInteraction);

  $("btn-download-zip").addEventListener("click", downloadSelectedAsZip);
  $("btn-export-csv").addEventListener("click", exportFilteredCsv);

  // Modal eventos
  $("btn-modal-close").addEventListener("click", closeDocumentModal);
  $("doc-modal").addEventListener("click", (e) => {
    if (e.target === $("doc-modal")) closeDocumentModal();
  });
  $("modal-details-pane").addEventListener("click", (e) => {
    const jump = e.target.closest("[data-jump-id]");
    if (jump) {
      const target = findItemById(jump.dataset.jumpId);
      if (target) openDocumentModal(target);
      else showToast("Documento referenciado não está indexado na base atual.");
    }
  });

  $("btn-pdf-download").addEventListener("click", () => {
    const res = state.currentPdfResult;
    const doc = state.currentDocs[state.currentDocIdx];
    if (!res || !doc) return;
    if (res.mode === "drive_link") {
      window.open(res.downloadUrl || res.previewUrl, "_blank", "noopener,noreferrer");
    } else {
      triggerBlobDownload(res.blob, res.name || doc.nome_arquivo);
    }
  });

  $("btn-pdf-open-tab").addEventListener("click", () => {
    const res = state.currentPdfResult;
    if (!res) return;
    if (res.mode === "drive_link") {
      window.open(res.previewUrl, "_blank", "noopener,noreferrer");
    } else if (state.currentObjectUrl) {
      window.open(state.currentObjectUrl, "_blank", "noopener,noreferrer");
    }
  });

  $("btn-modal-copy").addEventListener("click", async () => {
    const it = state.currentItem;
    if (!it) return;
    const isNE = it._kind === "NE";
    const summary = isNE
      ? `${it.chave} | UG ${it.ug} | ${it.favorecido_nome} (${it.sigilo_lgpd ? "OCULTO (LGPD)" : formatDocumento(it.favorecido_doc, it.favorecido_tipo, state.maskCpf)}) | PI ${it.pi} | ND ${it.nd} | NC ${it.nc_vinculada || "-"} | ${formatValorLgpd(it.valor_atual_c, it.sigilo_lgpd)}`
      : `${it.chave} | Emitente ${it.ug_emitente} (${it.nome_emitente}) | PI ${(it.pis || []).join(",")} | ND ${(it.nds || []).join(",")} | Valor ${formatValorLgpd(it.valor_bcms_c, it.sigilo_lgpd)} | Disponível ${formatValorLgpd(it.valor_disponivel_c, it.sigilo_lgpd)}`;
    try {
      await navigator.clipboard.writeText(summary);
      showToast("Resumo copiado para a área de transferência.");
    } catch {
      showToast("Não foi possível copiar automaticamente.");
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("doc-modal").classList.contains("hidden")) {
      closeDocumentModal();
      return;
    }
    if (
      (e.key === "/" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) &&
      !$("workspace-section").classList.contains("hidden") &&
      $("doc-modal").classList.contains("hidden")
    ) {
      const tag = document.activeElement?.tagName;
      if (e.key === "/" && (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT")) return;
      e.preventDefault();
      $("input-omnibox").focus();
    }
  });
}

async function bootstrap() {
  initTheme();
  wireEvents();
  $("origin-hint").textContent = window.location.origin;

  // 1. Verificar link direto de acesso (#acesso=...) antes de qualquer coisa
  const magicPayload = decodeAccessPayload(window.location.hash);
  if (magicPayload) {
    try {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search
      );
      sessionStorage.setItem(STORAGE_KEYS.appsUrlSession, magicPayload.u);
      sessionStorage.setItem(STORAGE_KEYS.appsTokenSession, magicPayload.t);
    } catch {}
    await connectWithProvider(
      new AppsScriptProvider(magicPayload.u, magicPayload.t),
      $("btn-connect-apps")
    );
    return;
  }

  // Preencher preferências públicas opcionais / sessão ativa
  let sessionUrl = "";
  let sessionToken = "";
  try {
    sessionUrl = sessionStorage.getItem(STORAGE_KEYS.appsUrlSession) || "";
    sessionToken = sessionStorage.getItem(STORAGE_KEYS.appsTokenSession) || "";
    const savedAppsUrl =
      sessionUrl ||
      localStorage.getItem(STORAGE_KEYS.appsUrl) ||
      APP_PUBLIC_CONFIG.defaultAppsScriptUrl;
    const savedClient =
      localStorage.getItem(STORAGE_KEYS.oauthClient) ||
      APP_PUBLIC_CONFIG.defaultOAuthClientId;
    const savedFolder =
      localStorage.getItem(STORAGE_KEYS.oauthFolder) ||
      APP_PUBLIC_CONFIG.defaultDriveFolderId;
    if (savedAppsUrl) $("input-apps-url").value = savedAppsUrl;
    if (sessionToken) $("input-apps-token").value = sessionToken;
    if (savedClient) $("input-oauth-client").value = savedClient;
    if (savedFolder) $("input-oauth-folder").value = savedFolder;
  } catch {}

  if (sessionUrl && sessionToken) {
    await connectWithProvider(
      new AppsScriptProvider(sessionUrl, sessionToken),
      $("btn-connect-apps")
    );
    return;
  }

  // Detectar servidor local automaticamente na porta padrão (8765) ou ?local=1
  const host = window.location.hostname;
  const port = window.location.port;
  const isLocalHost = host === "127.0.0.1" || host === "localhost";
  if (isLocalHost && (port === "8765" || window.location.search.includes("local=1"))) {
    const localApi = new LocalApiProvider();
    const status = await localApi.detect();
    if (status && status.tem_banco) {
      $("local-server-banner").classList.remove("hidden");
      $("local-server-meta").textContent = `${status.pasta} · banco com ${formatBytes(status.banco_bytes)} pronto para consulta imediata.`;
      await connectWithProvider(localApi, $("btn-connect-local-api"));
    }
  }
}

bootstrap();
