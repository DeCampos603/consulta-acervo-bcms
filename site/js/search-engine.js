// Motor de indexação em memória, busca combinada e cálculo de KPIs em centavos inteiros.

import { normalizarTexto } from "./config.js";

export function buildSearchIndex(database) {
  const neMap = new Map();
  const ncByChave = new Map();
  const ncById = new Map();

  const empenhos = (database.empenhos || []).map((ne) => {
    const itensTxt = (ne.itens || [])
      .map((it) => `${it.subelemento || ""} ${it.subelemento_nome || ""} ${it.descricao || ""}`)
      .join(" ");

    const docParts = [
      ne.id,
      ne.chave,
      ne.numero,
      String(ne.numero || "").padStart(6, "0"),
      ne.ug,
      ne.ug_rotulo,
      ne.favorecido_nome,
      ne.favorecido_doc,
      ne.favorecido_doc_limpo,
      ne.nc_vinculada,
      ne.pi,
      ne.pi_desc,
      ne.nd,
      ne.nd_desc,
      ne.ptres,
      ne.fonte,
      ne.ugr,
      ne.acao,
      ne.processo_nup,
      ne.processo_licitatorio,
      ne.pregao,
      ne.modalidade,
      ne.tipo_empenho,
      ne.situacao_rotulo,
      ne.ordenador,
      ne.responsavel,
      ne.minuta,
      ne.local_entrega,
      ne.descricao,
      (ne.subelementos || []).join(" "),
      itensTxt,
    ];

    const item = {
      ...ne,
      _kind: "NE",
      _sortKey: ne.chave || "",
      _sortDate: ne.data_iso || "",
      _sortEntity: normalizarTexto(ne.favorecido_nome),
      _sortVal: ne.sigilo_lgpd || ne.valor_atual_c === null ? null : Number(ne.valor_atual_c || 0),
      _searchBlob: normalizarTexto(docParts.join(" ")),
      _subNorm: (ne.subelementos || []).map((s) => normalizarTexto(s)),
      _empresaKey: ne.sigilo_lgpd ? "" : (ne.favorecido_doc_limpo || normalizarTexto(ne.favorecido_nome)),
      _empresaSearch: normalizarTexto(
        `${ne.favorecido_nome} (${ne.favorecido_doc}) ${ne.favorecido_doc} ${ne.favorecido_doc_limpo}`
      ),
      _piSearch: normalizarTexto(`${ne.pi} ${ne.pi_desc}`),
      _ndSearch: normalizarTexto(`${ne.nd} ${ne.nd_desc}`),
    };
    neMap.set(item.id, item);
    return item;
  });

  const creditos = (database.creditos || []).map((nc) => {
    const itensTxt = (nc.itens || [])
      .map((it) => {
        const destTxt = (it.destino || [])
          .map((c) => `${c.ptres} ${c.fonte} ${c.nd} ${c.nd_desc} ${c.ugr} ${c.pi} ${c.pi_desc}`)
          .join(" ");
        return `${it.ug_favorecida} ${it.nome_favorecida} ${destTxt}`;
      })
      .join(" ");

    const piDescsTxt = Object.entries(nc.pi_descs || {})
      .map(([k, v]) => `${k} ${v}`)
      .join(" ");
    const ndDescsTxt = Object.entries(nc.nd_descs || {})
      .map(([k, v]) => `${k} ${v}`)
      .join(" ");

    const docParts = [
      nc.id,
      nc.chave,
      nc.numero,
      nc.ug_emitente,
      nc.nome_emitente,
      (nc.ugs_favorecidas || []).join(" "),
      (nc.pis || []).join(" "),
      piDescsTxt,
      (nc.nds || []).join(" "),
      ndDescsTxt,
      (nc.ptres || []).join(" "),
      (nc.fontes || []).join(" "),
      (nc.ugrs || []).join(" "),
      nc.acao,
      nc.tipo_nc,
      nc.status,
      nc.status_execucao,
      nc.descricao,
      (nc.nes_vinculadas || []).join(" "),
      itensTxt,
    ];

    const item = {
      ...nc,
      _kind: "NC",
      _sortKey: nc.chave || "",
      _sortDate: nc.data_iso || "",
      _sortEntity: normalizarTexto(nc.nome_emitente || nc.ug_emitente),
      _sortVal: nc.sigilo_lgpd || (nc.valor_bcms_c === null && nc.valor_total_c === null)
        ? null
        : Number(nc.valor_bcms_c || nc.valor_total_c || 0),
      _searchBlob: normalizarTexto(docParts.join(" ")),
    };
    ncById.set(item.id, item);
    if (!ncByChave.has(item.chave)) ncByChave.set(item.chave, []);
    ncByChave.get(item.chave).push(item);
    return item;
  });

  return { empenhos, creditos, neMap, ncByChave, ncById };
}

export function createDefaultFilters() {
  return {
    query: "",
    view: "todos", // todos | ne | nc
    ug: "",
    empresa: "",
    nc: "",
    pi: "",
    nd: "",
    situacao: "",
    ptres: "",
    fonte: "",
    ugr: "",
    acao: "",
    ugEmitente: "",
    modalidade: "",
    tipoEmpenho: "",
    pregao: "",
    subelemento: "",
    mes: "",
    dataDe: "",
    dataAte: "",
    valMinReais: "",
    valMaxReais: "",
    anexoFiltro: "", // com_pdf | com_processo | com_requisicao | com_saldo_nc | sem_pdf
    sort: "date_desc",
  };
}

function extractLeadingToken(val) {
  const s = String(val || "").trim();
  if (!s) return "";
  const idx = s.indexOf(" — ");
  return idx >= 0 ? s.slice(0, idx).trim() : s;
}

function parseReaisToCentavos(str) {
  const s = String(str || "").trim().replace(/\./g, "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function applyFilters(index, filters) {
  const tokens = normalizarTexto(filters.query)
    .split(" ")
    .filter(Boolean);

  const fUg = filters.ug.trim();
  const fEmpNorm = normalizarTexto(filters.empresa);
  const fEmpDig = filters.empresa.replace(/\D/g, "");
  const fNc = extractLeadingToken(filters.nc).toUpperCase();
  const fPi = extractLeadingToken(filters.pi).toUpperCase();
  const fNd = extractLeadingToken(filters.nd);
  const fSit = normalizarTexto(filters.situacao);
  const fPtres = filters.ptres.trim().toUpperCase();
  const fFonte = filters.fonte.trim().toUpperCase();
  const fUgr = filters.ugr.trim();
  const fAcao = filters.acao.trim().toUpperCase();
  const fEmit = extractLeadingToken(filters.ugEmitente);
  const fMod = normalizarTexto(filters.modalidade);
  const fTipoEmp = normalizarTexto(filters.tipoEmpenho);
  const fPregao = filters.pregao.trim();
  const fSub = normalizarTexto(filters.subelemento);
  const fMes = filters.mes.trim();
  const fDataDe = filters.dataDe.trim();
  const fDataAte = filters.dataAte.trim();
  const minC = parseReaisToCentavos(filters.valMinReais);
  const maxC = parseReaisToCentavos(filters.valMaxReais);
  const fAnexo = filters.anexoFiltro;

  const hasNeOnlyFilters = Boolean(
    fEmpNorm || fMod || fTipoEmp || fPregao || fSub || fAnexo === "com_processo" || fAnexo === "com_requisicao"
  );
  const hasNcOnlyFilters = Boolean(fEmit || fAnexo === "com_saldo_nc");

  const matchTokens = (blob) => {
    for (let i = 0; i < tokens.length; i++) {
      if (!blob.includes(tokens[i])) return false;
    }
    return true;
  };

  const matchedNes = [];
  if (filters.view !== "nc" && !hasNcOnlyFilters) {
    for (const ne of index.empenhos) {
      if (tokens.length && !matchTokens(ne._searchBlob)) continue;
      if (fUg && ne.ug !== fUg) continue;
      if (fEmpNorm) {
        const matchDig = fEmpDig.length >= 6 && ne.favorecido_doc_limpo.includes(fEmpDig);
        const matchTxt = ne._empresaSearch.includes(fEmpNorm);
        if (!matchDig && !matchTxt) continue;
      }
      if (fNc && !ne.nc_vinculada.toUpperCase().includes(fNc)) continue;
      if (fPi) {
        const fPiNorm = normalizarTexto(fPi);
        if (!ne.pi.toUpperCase().includes(fPi) && !ne._piSearch.includes(fPiNorm)) continue;
      }
      if (fNd) {
        const fNdNorm = normalizarTexto(fNd);
        if (!ne.nd.startsWith(fNd) && !ne._ndSearch.includes(fNdNorm)) continue;
      }
      if (fSit && normalizarTexto(ne.situacao_rotulo) !== fSit) continue;
      if (fPtres && ne.ptres.toUpperCase() !== fPtres) continue;
      if (fFonte && ne.fonte.toUpperCase() !== fFonte) continue;
      if (fUgr && ne.ugr !== fUgr) continue;
      if (fAcao && ne.acao.toUpperCase() !== fAcao) continue;
      if (fMod && normalizarTexto(ne.modalidade) !== fMod) continue;
      if (fTipoEmp && normalizarTexto(ne.tipo_empenho) !== fTipoEmp) continue;
      if (fPregao && ne.pregao !== fPregao) continue;
      if (fSub && !ne._subNorm.some((s) => s.includes(fSub))) continue;
      if (fMes && ne.mes !== fMes) continue;
      if (fDataDe && (!ne.data_iso || ne.data_iso < fDataDe)) continue;
      if (fDataAte && (!ne.data_iso || ne.data_iso > fDataAte)) continue;
      if (minC !== null && (ne.sigilo_lgpd || ne.valor_atual_c === null || ne.valor_atual_c < minC)) continue;
      if (maxC !== null && (ne.sigilo_lgpd || ne.valor_atual_c === null || ne.valor_atual_c > maxC)) continue;
      if (fAnexo === "sigilo_lgpd" && !ne.sigilo_lgpd) continue;
      if (fAnexo === "com_pdf" && !ne.tem_pdf) continue;
      if (fAnexo === "sem_pdf" && ne.tem_pdf) continue;
      if (fAnexo === "com_processo" && !ne.tem_processo) continue;
      if (fAnexo === "com_requisicao" && !ne.tem_requisicao) continue;
      matchedNes.push(ne);
    }
  }

  const matchedNcs = [];
  if (filters.view !== "ne" && !hasNeOnlyFilters) {
    for (const nc of index.creditos) {
      if (tokens.length && !matchTokens(nc._searchBlob)) continue;
      if (fUg && !(nc.ugs_favorecidas || []).includes(fUg)) continue;
      if (fNc && !nc.chave.toUpperCase().includes(fNc)) continue;
      if (fPi) {
        const fPiNorm = normalizarTexto(fPi);
        const piMatch = (nc.pis || []).some((p) => p.toUpperCase().includes(fPi)) ||
          Object.values(nc.pi_descs || {}).some((d) => normalizarTexto(d).includes(fPiNorm));
        if (!piMatch) continue;
      }
      if (fNd) {
        const fNdNorm = normalizarTexto(fNd);
        const ndMatch = (nc.nds || []).some((n) => n.startsWith(fNd)) ||
          Object.values(nc.nd_descs || {}).some((d) => normalizarTexto(d).includes(fNdNorm));
        if (!ndMatch) continue;
      }
      if (fSit && normalizarTexto(nc.status) !== fSit && normalizarTexto(nc.status_execucao) !== fSit) continue;
      if (fPtres && !(nc.ptres || []).some((p) => p.toUpperCase() === fPtres)) continue;
      if (fFonte && !(nc.fontes || []).some((f) => f.toUpperCase() === fFonte)) continue;
      if (fUgr && !(nc.ugrs || []).includes(fUgr)) continue;
      if (fAcao && nc.acao.toUpperCase() !== fAcao) continue;
      if (fEmit && nc.ug_emitente !== fEmit) continue;
      if (fMes && nc.mes !== fMes) continue;
      if (fDataDe && (!nc.data_iso || nc.data_iso < fDataDe)) continue;
      if (fDataAte && (!nc.data_iso || nc.data_iso > fDataAte)) continue;
      if (minC !== null && (nc.sigilo_lgpd || nc.valor_bcms_c === null || nc.valor_bcms_c < minC)) continue;
      if (maxC !== null && (nc.sigilo_lgpd || nc.valor_bcms_c === null || nc.valor_bcms_c > maxC)) continue;
      if (fAnexo === "sigilo_lgpd" && !nc.sigilo_lgpd) continue;
      if (fAnexo === "com_pdf" && !nc.tem_pdf) continue;
      if (fAnexo === "sem_pdf" && nc.tem_pdf) continue;
      if (fAnexo === "com_saldo_nc" && (nc.sigilo_lgpd || nc.valor_disponivel_c === null || nc.valor_disponivel_c <= 0)) continue;
      matchedNcs.push(nc);
    }
  }

  let items;
  if (filters.view === "ne") {
    items = matchedNes;
  } else if (filters.view === "nc") {
    items = matchedNcs;
  } else {
    items = [...matchedNes, ...matchedNcs];
  }

  sortItems(items, filters.sort);

  const qtdNesSigiloLgpd = matchedNes.filter((n) => n.sigilo_lgpd).length;
  const qtdNcsSigiloLgpd = matchedNcs.filter((c) => c.sigilo_lgpd).length;
  const kpis = {
    qtdTotal: items.length,
    qtdNes: matchedNes.length,
    qtdNcs: matchedNcs.length,
    qtdSigiloLgpd: qtdNesSigiloLgpd + qtdNcsSigiloLgpd,
    qtdNesSigiloLgpd,
    qtdNcsSigiloLgpd,
    qtdComPdf: items.filter((it) => !it.sigilo_lgpd && (it.tem_pdf || (it.documentos && it.documentos.length > 0))).length,
    totalEmpenhadoC: matchedNes.reduce(
      (acc, n) => acc + (n.sigilo_lgpd || n.valor_atual_c === null ? 0 : Number(n.valor_atual_c || 0)),
      0
    ),
    totalProvisionadoC: matchedNcs.reduce(
      (acc, c) => acc + (c.sigilo_lgpd || c.valor_provisionado_c === null ? 0 : Number(c.valor_provisionado_c || 0)),
      0
    ),
    totalDisponivelNcC: matchedNcs.reduce(
      (acc, c) => acc + (c.sigilo_lgpd || c.valor_disponivel_c === null ? 0 : Number(c.valor_disponivel_c || 0)),
      0
    ),
    empresasUnicas: new Set(matchedNes.map((n) => n._empresaKey).filter(Boolean)).size,
  };

  return { items, matchedNes, matchedNcs, kpis };
}

function sortItems(items, sortMode) {
  items.sort((a, b) => {
    switch (sortMode) {
      case "date_asc":
        return (a._sortDate || "").localeCompare(b._sortDate || "") || a._sortKey.localeCompare(b._sortKey);
      case "key_asc":
        return a._sortKey.localeCompare(b._sortKey);
      case "key_desc":
        return b._sortKey.localeCompare(a._sortKey);
      case "val_desc":
        if (a._sortVal === null && b._sortVal === null) {
          return (b._sortDate || "").localeCompare(a._sortDate || "") || b._sortKey.localeCompare(a._sortKey);
        }
        if (a._sortVal === null) return 1;
        if (b._sortVal === null) return -1;
        return b._sortVal - a._sortVal || (b._sortDate || "").localeCompare(a._sortDate || "");
      case "val_asc":
        if (a._sortVal === null && b._sortVal === null) {
          return (b._sortDate || "").localeCompare(a._sortDate || "") || b._sortKey.localeCompare(a._sortKey);
        }
        if (a._sortVal === null) return 1;
        if (b._sortVal === null) return -1;
        return a._sortVal - b._sortVal || (b._sortDate || "").localeCompare(a._sortDate || "");
      case "entity_asc":
        return (a._sortEntity || "").localeCompare(b._sortEntity || "") || a._sortKey.localeCompare(b._sortKey);
      case "date_desc":
      default:
        return (b._sortDate || "").localeCompare(a._sortDate || "") || b._sortKey.localeCompare(a._sortKey);
    }
  });
}
