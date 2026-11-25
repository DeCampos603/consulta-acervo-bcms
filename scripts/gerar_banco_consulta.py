# -*- coding: utf-8 -*-
"""Gerador do Banco de Dados Unificado de Consulta (NE + NC) — BCMS 2026.

Consolida em `Acervo-Empenhos-BCMS-2026/banco_consulta_bcms.json` (direto no Google Drive,
fora de qualquer pasta versionada no Git/GitHub):
  1. Notas de Empenho (NEs) — PDFs oficiais do SIAFI (`nes.json` + releitura de PDFs novos),
     enriquecidas com liquidação/pagamento da célula, ação, descrições de PI/ND e prova
     de rastreabilidade (`Dashboard-Credito-BCMS/data/data.json`), além de vínculos físicos
     para PDFs de Requisições (Inicial/Reforço/Anulação), Processos Escaneados e Empenhos GVA.
  2. Notas de Crédito (NCs) — PDFs oficiais do SIAFI (`ncs.json` + releitura de PDFs novos),
     enriquecidas com saldos de execução (`credito.json` / `Dashboard-Credito-BCMS`), nomes
     oficiais de UASGs (`uasgs.json`), descrições de PI/ND e vínculo reverso para todas as NEs
     emitidas à conta de cada NC.

Uso:
  py -3 -X utf8 scripts/gerar_banco_consulta.py
  py -3 -X utf8 scripts/gerar_banco_consulta.py --reler-pdfs
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

PROJETO_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = PROJETO_ROOT.parent
DEFAULT_ENV_PATH = PROJETO_ROOT / ".env"
DEFAULT_ACERVO = REPO_ROOT / "Acervo-Empenhos-BCMS-2026"
DEFAULT_REQ_PROJETO = REPO_ROOT / "Requisicoes-Empenho-BCMS"
DEFAULT_REQ_DADOS = DEFAULT_REQ_PROJETO / "dados"
DEFAULT_DASH_JSON = REPO_ROOT / "Dashboard-Credito-BCMS" / "data" / "data.json"
DEFAULT_SAIDA = DEFAULT_ACERVO / "banco_consulta_bcms.json"

UGS_BCMS = ("160329", "167329")
UG_LABELS = {
    "160329": "160329 · BCMS (OGU / Ordinário)",
    "167329": "167329 · BCMS (Fundo do Exército)",
}
TIPO_EMPENHO_MAP = {
    "1": "Ordinário",
    "1.0": "Ordinário",
    "3": "Estimativo",
    "3.0": "Estimativo",
    "5": "Global",
    "5.0": "Global",
}
MESES_PT = {
    "01": "01 · Janeiro",
    "02": "02 · Fevereiro",
    "03": "03 · Março",
    "04": "04 · Abril",
    "05": "05 · Maio",
    "06": "06 · Junho",
    "07": "07 · Julho",
    "08": "08 · Agosto",
    "09": "09 · Setembro",
    "10": "10 · Outubro",
    "11": "11 · Novembro",
    "12": "12 · Dezembro",
}

RE_NE_PDF = re.compile(
    r"^NE_(\d{6})_(\d{4}NE\d{6})_v(\d+)_([^_]+)_(\d{14})(?:_\d+)?\.pdf$", re.I
)
RE_NC_PDF = re.compile(
    r"^NC_(\d{6})_(\d{4}NC\d{6})_v(\d+)_(\d{14})(?:_\d+)?\.pdf$", re.I
)
RE_REQ_PDF = re.compile(r"(160329|167329)_(\d{4}NE\d{6})", re.I)
RE_PROC_NE = re.compile(r"NE_(\d+)", re.I)


def to_centavos(valor: object) -> int:
    """Converte valor monetário (str pt-BR/EN, int, float, Decimal, None) para centavos inteiros."""
    if valor is None or isinstance(valor, bool):
        return 0
    if isinstance(valor, int):
        return valor * 100
    if isinstance(valor, Decimal):
        return int((valor * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    s = str(valor).strip()
    if not s or s.lower() in ("none", "null", "nan", "-"):
        return 0
    s = s.replace("R$", "").replace("\xa0", "").replace(" ", "")
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".")
    try:
        dec = Decimal(s)
    except InvalidOperation:
        return 0
    if not dec.is_finite():
        return 0
    return int((dec * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def normalizar_tipo_empenho(valor: object) -> str:
    s = str(valor or "").strip()
    if not s:
        return ""
    return TIPO_EMPENHO_MAP.get(s, s)


def cpf_valido(digitos: str) -> bool:
    """Valida os 2 dígitos verificadores de um CPF (11 dígitos), rejeitando sequências repetidas."""
    dig = re.sub(r"\D", "", str(digitos or ""))
    if len(dig) != 11 or len(set(dig)) == 1:
        return False
    soma1 = sum(int(dig[i]) * (10 - i) for i in range(9))
    dv1 = ((soma1 * 10) % 11) % 10
    if dv1 != int(dig[9]):
        return False
    soma2 = sum(int(dig[i]) * (11 - i) for i in range(10))
    dv2 = ((soma2 * 10) % 11) % 10
    return dv2 == int(dig[10])


_RE_CPF_CANDIDATO = re.compile(r"(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)")


def texto_contem_cpf_valido(texto: str | None) -> bool:
    """Retorna True se o texto contém pelo menos um número de CPF matematicamente válido."""
    if not texto:
        return False
    for m in _RE_CPF_CANDIDATO.finditer(str(texto)):
        if cpf_valido(m.group(0)):
            return True
    return False


def classificar_favorecido_doc(raw: object) -> tuple[str, str, str]:
    """Retorna (tipo, somente_digitos, formatado)."""
    s = str(raw or "").strip()
    dig = re.sub(r"\D", "", s)
    if len(dig) == 14:
        fmt = f"{dig[:2]}.{dig[2:5]}.{dig[5:8]}/{dig[8:12]}-{dig[12:]}"
        return "CNPJ", dig, fmt
    if len(dig) == 11:
        fmt = f"{dig[:3]}.{dig[3:6]}.{dig[6:9]}-{dig[9:]}"
        return "CPF", dig, fmt
    if len(dig) == 6:
        return "UG", dig, dig
    return ("OUTRO", dig, s) if s else ("OUTRO", "", "")


def parse_data_iso(data_br: str | None) -> str:
    if not data_br:
        return ""
    m = re.search(r"(\d{2})/(\d{2})/(\d{4})", str(data_br))
    if not m:
        return ""
    return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"


def _carregar_json(caminho: Path, padrao: dict) -> dict:
    if not caminho.is_file():
        return padrao
    return json.loads(caminho.read_text(encoding="utf-8"))


def sincronizar_ncs_faltantes(acervo_dir: Path, req_dados_dir: Path) -> int:
    """Copia PDFs de NC que existam em Requisicoes-Empenho-BCMS/dados/nc/ mas faltem no acervo."""
    copiados = 0
    for ug in UGS_BCMS:
        origem_dir = req_dados_dir / "nc" / ug
        destino_dir = acervo_dir / "Notas de Crédito" / ug
        if not origem_dir.is_dir():
            continue
        destino_dir.mkdir(parents=True, exist_ok=True)
        for pdf in origem_dir.glob("*.pdf"):
            alvo = destino_dir / pdf.name
            if not alvo.is_file():
                shutil.copy2(pdf, alvo)
                copiados += 1
    return copiados


def _escanear_pdfs_ne_recentes(acervo_dir: Path) -> dict[str, dict]:
    """Retorna mapa {'160329:2026NE000001': info} com a versão+timestamp mais recente de Empenhos/."""
    melhores: dict[str, tuple[tuple[int, int], dict]] = {}
    for ug in UGS_BCMS:
        pasta = acervo_dir / "Empenhos" / ug
        if not pasta.is_dir():
            continue
        for pdf in pasta.glob("*.pdf"):
            m = RE_NE_PDF.match(pdf.name)
            if not m:
                continue
            ug_arq, chave, ver_s, _fav, ts_s = m.groups()
            rank = (int(ver_s), int(ts_s))
            k = f"{ug}:{chave.upper()}"
            atual = melhores.get(k)
            if atual is None or rank > atual[0]:
                melhores[k] = (
                    rank,
                    {
                        "path": pdf,
                        "rel": pdf.relative_to(acervo_dir).as_posix(),
                        "nome": pdf.name,
                        "tamanho": pdf.stat().st_size,
                        "versao": ver_s.zfill(3),
                        "ts": int(ts_s),
                        "ug_arq": ug_arq,
                    },
                )
    return {k: v[1] for k, v in melhores.items()}


def _escanear_pdfs_nc_recentes(acervo_dir: Path) -> dict[str, dict]:
    """Retorna mapa {'160329|160035:2026NC400182': info} (chave por ug_pasta + ug_emit + nc)."""
    melhores: dict[str, tuple[tuple[int, int], dict]] = {}
    for ug_pasta in UGS_BCMS:
        pasta = acervo_dir / "Notas de Crédito" / ug_pasta
        if not pasta.is_dir():
            continue
        for pdf in pasta.glob("*.pdf"):
            m = RE_NC_PDF.match(pdf.name)
            if not m:
                continue
            ug_emit, chave, ver_s, ts_s = m.groups()
            rank = (int(ver_s), int(ts_s))
            k = f"{ug_pasta}|{ug_emit}:{chave.upper()}"
            atual = melhores.get(k)
            if atual is None or rank > atual[0]:
                melhores[k] = (
                    rank,
                    {
                        "path": pdf,
                        "rel": pdf.relative_to(acervo_dir).as_posix(),
                        "nome": pdf.name,
                        "tamanho": pdf.stat().st_size,
                        "versao": ver_s.zfill(3),
                        "ts": int(ts_s),
                        "ug_pasta": ug_pasta,
                        "ug_emitente": ug_emit,
                        "chave": chave.upper(),
                    },
                )
    return {k: v[1] for k, v in melhores.items()}


def _indexar_documentos_secundarios(acervo_dir: Path) -> dict[str, dict[str, list[dict]]]:
    """Indexa Requisições, Processos Escaneados e Empenhos GVA por chave '{ug}:{chave}'."""
    reqs_by_ne: dict[str, list[dict]] = defaultdict(list)
    req_dir = acervo_dir / "REQUISICOES_REFORCO_ANULACAO_2026"
    if req_dir.is_dir():
        for pdf in sorted(req_dir.rglob("*.pdf")):
            m = RE_REQ_PDF.search(pdf.name)
            if not m:
                continue
            ug, ne = m.group(1), m.group(2).upper()
            rel = pdf.relative_to(acervo_dir).as_posix()
            sub = pdf.parent.name.upper()
            nome_up = pdf.name.upper()
            if "ANULACAO_TOTAL" in nome_up:
                rotulo = "Requisição · Anulação Total"
            elif "ANULACAO_PARCIAL" in nome_up or "ANULAC" in sub:
                rotulo = "Requisição · Anulação Parcial"
            elif "REFORCO" in nome_up or "REFORCO" in sub:
                rotulo = "Requisição · Reforço"
            else:
                rotulo = "Requisição · Empenho Inicial"
            reqs_by_ne[f"{ug}:{ne}"].append(
                {
                    "tipo": "requisicao",
                    "rotulo": rotulo,
                    "caminho_relativo": rel,
                    "nome_arquivo": pdf.name,
                    "tamanho_bytes": pdf.stat().st_size,
                }
            )

    procs_by_ne: dict[str, list[dict]] = defaultdict(list)
    proc_dir = acervo_dir / "PROCESSOS ESCANEADOS 2026"
    if proc_dir.is_dir():
        for pdf in sorted(proc_dir.rglob("*.pdf")):
            rel = pdf.relative_to(acervo_dir).as_posix()
            pasta_pai = pdf.parent.name
            if pasta_pai.startswith("160"):
                ug = "160329"
            elif pasta_pai.startswith("167"):
                ug = "167329"
            else:
                continue
            m = RE_PROC_NE.search(pdf.name)
            if not m:
                continue
            num_int = int(m.group(1))
            ne = f"2026NE{num_int:06d}"
            anulado = "ANULAD" in pasta_pai.upper()
            procs_by_ne[f"{ug}:{ne}"].append(
                {
                    "tipo": "processo_escaneado",
                    "rotulo": (
                        "Processo Escaneado (Anulado)"
                        if anulado
                        else "Processo Escaneado (Completo)"
                    ),
                    "caminho_relativo": rel,
                    "nome_arquivo": pdf.name,
                    "tamanho_bytes": pdf.stat().st_size,
                }
            )

    gva_by_ne: dict[str, list[dict]] = defaultdict(list)
    gva_dir = acervo_dir / "Empenhos GVA"
    if gva_dir.is_dir():
        for pdf in sorted(gva_dir.glob("*.pdf")):
            m = RE_NE_PDF.match(pdf.name)
            if not m:
                continue
            ug_arq, chave, ver_s, _fav, _ts = m.groups()
            rel = pdf.relative_to(acervo_dir).as_posix()
            gva_by_ne[f"{ug_arq}:{chave.upper()}"].append(
                {
                    "tipo": "empenho_gva",
                    "rotulo": f"NE GVA (v{ver_s.zfill(3)})",
                    "caminho_relativo": rel,
                    "nome_arquivo": pdf.name,
                    "tamanho_bytes": pdf.stat().st_size,
                }
            )

    return {"req": reqs_by_ne, "proc": procs_by_ne, "gva": gva_by_ne}


def _garantir_leitores(req_projeto: Path):
    if str(req_projeto) not in sys.path:
        sys.path.insert(0, str(req_projeto))
    from app.leitor_nc import ler_nc  # type: ignore
    from app.leitor_ne import completar_registro, ler_ne  # type: ignore

    return ler_ne, completar_registro, ler_nc


def _build_catalogo_descricoes(dash_data: dict, uasgs_json: dict) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    pi_desc: dict[str, str] = {}
    nd_desc: dict[str, str] = {}
    uasg_nomes: dict[str, str] = {}

    for u_cod, u_info in (uasgs_json.get("uasgs") or {}).items():
        if isinstance(u_info, dict) and u_info.get("nome"):
            uasg_nomes[str(u_cod)] = str(u_info["nome"]).strip()

    for n in (dash_data.get("empenhodata") or {}).get("nes") or []:
        if n.get("pi") and n.get("pi_desc"):
            pi_desc.setdefault(str(n["pi"]).strip(), str(n["pi_desc"]).strip())
        if n.get("nd") and n.get("nd_desc"):
            nd_desc.setdefault(str(n["nd"]).strip(), str(n["nd_desc"]).strip())

    for c in (dash_data.get("celulas") or {}).values():
        if c.get("pi") and c.get("pinome"):
            pi_desc.setdefault(str(c["pi"]).strip(), str(c["pinome"]).strip())
        if c.get("nd") and (c.get("ndnome") or c.get("nome")):
            nd_desc.setdefault(str(c["nd"]).strip(), str(c.get("ndnome") or c["nome"]).strip())

    for nc in (dash_data.get("ncdata") or {}).values():
        if nc.get("nd") and nc.get("ndn"):
            nd_desc.setdefault(str(nc["nd"]).strip(), str(nc["ndn"]).strip())

    return pi_desc, nd_desc, uasg_nomes


def _compactar_itens_ne(itens: list[dict]) -> list[dict]:
    saida = []
    for it in itens or []:
        ops = []
        for op in it.get("operacoes") or []:
            ops.append(
                {
                    "data": op.get("data") or "",
                    "operacao": op.get("operacao") or "",
                    "quantidade": str(op.get("quantidade") or ""),
                    "valor_unitario": str(op.get("valor_unitario") or ""),
                    "valor_total_c": to_centavos(op.get("valor_total")),
                }
            )
        saida.append(
            {
                "seq": it.get("seq"),
                "subelemento": it.get("subelemento") or "",
                "subelemento_nome": it.get("subelemento_nome") or "",
                "item_compra": it.get("item_compra"),
                "descricao": it.get("descricao") or "",
                "valor_item_c": to_centavos(it.get("valor_item")),
                "valor_liquido_c": to_centavos(it.get("valor_liquido")),
                "operacoes": ops,
            }
        )
    return saida


def gerar_banco(
    acervo_dir: Path = DEFAULT_ACERVO,
    req_dados_dir: Path = DEFAULT_REQ_DADOS,
    req_projeto_dir: Path = DEFAULT_REQ_PROJETO,
    dash_json_path: Path = DEFAULT_DASH_JSON,
    saida_path: Path = DEFAULT_SAIDA,
    reler_pdfs: bool = False,
    copiar_ncs: bool = True,
) -> dict:
    """Constrói o banco consolidado de consulta e grava atomicamente em `saida_path`."""
    acervo_dir = Path(acervo_dir).resolve()
    req_dados_dir = Path(req_dados_dir).resolve()
    dash_json_path = Path(dash_json_path).resolve()
    saida_path = Path(saida_path).resolve()

    if copiar_ncs:
        copiados = sincronizar_ncs_faltantes(acervo_dir, req_dados_dir)
        if copiados:
            print(f"[Sync] {copiados} PDF(s) de NC copiados para Acervo/Notas de Crédito/.")

    nes_raw_obj = _carregar_json(req_dados_dir / "nes.json", {"nes": {}})
    ncs_raw_obj = _carregar_json(req_dados_dir / "ncs.json", {"ncs": {}})
    cred_raw_obj = _carregar_json(req_dados_dir / "credito.json", {"ncs": {}})
    uasgs_obj = _carregar_json(req_dados_dir / "uasgs.json", {"uasgs": {}})
    dash_data = _carregar_json(dash_json_path, {})

    nes_raw: dict[str, dict] = dict(nes_raw_obj.get("nes") or {})
    ncs_raw: dict[str, dict] = dict(ncs_raw_obj.get("ncs") or {})
    cred_ncs: dict[str, dict] = dict(cred_raw_obj.get("ncs") or {})

    pi_desc_map, nd_desc_map, uasg_nomes = _build_catalogo_descricoes(dash_data, uasgs_obj)

    # Mapa rápido de Dashboard-Credito-BCMS (NEs do BCMS + ncdata para ações)
    dash_ne_map: dict[str, dict] = {}
    for n in (dash_data.get("empenhodata") or {}).get("nes") or []:
        ug = str(n.get("ug") or "").strip()
        ne_cod = str(n.get("ne") or "").strip().upper()
        if ug in UGS_BCMS and ne_cod:
            dash_ne_map[f"{ug}:{ne_cod}"] = n

    nc_acao_map: dict[str, str] = {}
    for k_nc, nc_d in (dash_data.get("ncdata") or {}).items():
        if not k_nc.startswith("BCMS_"):
            continue
        nc_full = str(nc_d.get("nc") or "")
        # ex: 160035000012026NC400182 -> emit=160035, chave=2026NC400182
        m_full = re.match(r"^(\d{6})\d{5}(\d{4}NC\d{6})$", nc_full, re.I)
        if m_full and nc_d.get("acao"):
            nc_acao_map[f"{m_full.group(1)}:{m_full.group(2).upper()}"] = str(nc_d["acao"]).strip()

    # Escanear PDFs mais recentes do disco
    pdfs_ne_disco = _escanear_pdfs_ne_recentes(acervo_dir)
    pdfs_nc_disco = _escanear_pdfs_nc_recentes(acervo_dir)
    docs_sec = _indexar_documentos_secundarios(acervo_dir)

    # Releitura seletiva caso haja PDFs mais novos/ausentes ou --reler-pdfs
    ler_ne_fn = completar_ne_fn = ler_nc_fn = None

    def _get_leitores():
        nonlocal ler_ne_fn, completar_ne_fn, ler_nc_fn
        if ler_ne_fn is None:
            ler_ne_fn, completar_ne_fn, ler_nc_fn = _garantir_leitores(req_projeto_dir)
        return ler_ne_fn, completar_ne_fn, ler_nc_fn

    nes_relidas = 0
    for key_ne, pdf_info in pdfs_ne_disco.items():
        existente = nes_raw.get(key_ne)
        versao_ex = int(existente.get("versao") or 0) if existente else -1
        arq_ex = (existente.get("arquivo") or "") if existente else ""
        if reler_pdfs or not existente or int(pdf_info["versao"]) > versao_ex or arq_ex != pdf_info["nome"]:
            ler_ne, completar, _ = _get_leitores()
            try:
                lida = completar(ler_ne(pdf_info["path"]))
                lida["ug_pasta"] = key_ne.split(":")[0]
                lida["caminho"] = str(pdf_info["path"])
                nes_raw[key_ne] = lida
                nes_relidas += 1
            except Exception as exc:
                print(f"[Aviso] Falha ao reler NE {pdf_info['nome']}: {exc}")

    ncs_relidas = 0
    for key_nc_pasta, pdf_info in pdfs_nc_disco.items():
        ug_pasta, rest = key_nc_pasta.split("|", 1)
        existente = ncs_raw.get(rest)
        versao_ex = int(existente.get("versao") or 0) if existente else -1
        arq_ex = (existente.get("arquivo") or "") if existente else ""
        if reler_pdfs or not existente or int(pdf_info["versao"]) > versao_ex or arq_ex != pdf_info["nome"]:
            _, _, ler_nc = _get_leitores()
            try:
                lida = ler_nc(pdf_info["path"])
                lida["ug_pasta"] = ug_pasta
                lida["caminho"] = str(pdf_info["path"])
                ncs_raw[rest] = lida
                ncs_relidas += 1
            except Exception as exc:
                print(f"[Aviso] Falha ao reler NC {pdf_info['nome']}: {exc}")

    if nes_relidas or ncs_relidas:
        print(f"[ETL] PDFs relidos do disco: {nes_relidas} NE(s), {ncs_relidas} NC(s).")

    # Montar registros consolidados de NEs
    nes_out: list[dict] = []
    nc_to_nes_keys: dict[str, list[str]] = defaultdict(list)
    chaves_restritas_lgpd: set[str] = set()

    for key_ne in sorted(nes_raw.keys()):
        raw = nes_raw[key_ne]
        ug = str(raw.get("ug_pasta") or raw.get("ug_emitente") or key_ne.split(":")[0]).strip()
        chave = str(raw.get("chave") or key_ne.split(":")[1]).strip().upper()
        uid = f"{ug}:{chave}"
        dash = dash_ne_map.get(uid, {})
        deriv = raw.get("derivados") or {}

        fav_doc_tipo, fav_doc_limpo, fav_doc_fmt = classificar_favorecido_doc(
            raw.get("favorecido_codigo") or dash.get("doc")
        )
        fav_nome = str(raw.get("favorecido_nome") or dash.get("fav") or "").strip()

        pi = str(raw.get("pi") or dash.get("pi") or "").strip()
        nd = str(raw.get("nd") or dash.get("nd") or "").strip()
        acao = str(dash.get("acao") or "").strip()
        pi_desc = str(dash.get("pi_desc") or pi_desc_map.get(pi, "")).strip()
        nd_desc = str(dash.get("nd_desc") or nd_desc_map.get(nd, "")).strip()

        nc_vinc = str(
            deriv.get("nc") or dash.get("nc") or dash.get("nc_citada") or ""
        ).strip().upper()
        if nc_vinc:
            nc_to_nes_keys[nc_vinc].append(uid)

        pregao = str(deriv.get("pregao") or "").strip()
        proc_lic = str(dash.get("proc") or "").strip()
        if not proc_lic and pregao:
            proc_lic = f"PREGAO {pregao}"

        # Documentos físicos vinculados (caminhos sempre relativos à pasta Acervo-Empenhos-BCMS-2026/)
        documentos: list[dict] = []
        seen_rels: set[str] = set()

        pdf_of = pdfs_ne_disco.get(uid)
        if pdf_of:
            documentos.append(
                {
                    "tipo": "ne_oficial",
                    "rotulo": f"NE Oficial SIAFI (v{pdf_of['versao']})",
                    "caminho_relativo": pdf_of["rel"],
                    "nome_arquivo": pdf_of["nome"],
                    "tamanho_bytes": pdf_of["tamanho"],
                }
            )
            seen_rels.add(pdf_of["rel"])

        for extra_cat in ("req", "proc", "gva"):
            for doc in docs_sec[extra_cat].get(uid, []):
                if doc["caminho_relativo"] not in seen_rels:
                    documentos.append(doc)
                    seen_rels.add(doc["caminho_relativo"])

        itens_comp = _compactar_itens_ne(raw.get("itens") or [])
        subelementos = sorted(
            {
                f"{it['subelemento']} - {it['subelemento_nome']}".strip(" -")
                for it in itens_comp
                if it.get("subelemento")
            }
        )

        valor_atual_c = to_centavos(raw.get("valor_atual"))
        if valor_atual_c == 0 and raw.get("saldo_planilha") is not None:
            valor_atual_c = to_centavos(raw.get("saldo_planilha"))

        data_br = str(raw.get("data_emissao") or dash.get("dia") or "").strip()
        data_iso = parse_data_iso(data_br)
        mes_ref = data_iso[5:7] if len(data_iso) >= 7 else ""

        sigilo_lgpd = fav_doc_tipo == "CPF"
        if sigilo_lgpd:
            chaves_restritas_lgpd.add(uid)
            nes_out.append(
                {
                    "id": uid,
                    "tipo_doc": "NE",
                    "sigilo_lgpd": True,
                    "pdf_restrito_lgpd": True,
                    "ug": ug,
                    "ug_rotulo": UG_LABELS.get(ug, ug),
                    "chave": chave,
                    "numero": raw.get("numero"),
                    "ano": raw.get("ano") or 2026,
                    "versao": str(raw.get("versao") or "001").zfill(3),
                    "versao_data_hora": raw.get("versao_data_hora") or "",
                    "operacao_versao": raw.get("operacao_versao") or "",
                    "data_emissao": data_br,
                    "data_iso": data_iso,
                    "mes": mes_ref,
                    "tipo_empenho": normalizar_tipo_empenho(raw.get("tipo_empenho")),
                    "situacao": raw.get("situacao") or "NORMAL",
                    "situacao_rotulo": raw.get("situacao_rotulo") or "Empenho Inicial",
                    "esfera": str(raw.get("esfera") or "").strip(),
                    "ptres": str(raw.get("ptres") or "").strip(),
                    "fonte": str(raw.get("fonte") or "").strip(),
                    "nd": nd,
                    "nd_desc": nd_desc,
                    "ugr": str(raw.get("ugr") or "").strip(),
                    "pi": pi,
                    "pi_desc": pi_desc,
                    "acao": acao,
                    "processo_nup": "",
                    "processo_licitatorio": proc_lic,
                    "pregao": pregao,
                    "uasg_pregao": str(deriv.get("uasg_pregao") or "").strip(),
                    "papel_ug": str(deriv.get("papel") or "").strip(),
                    "modalidade": str(raw.get("modalidade_licitacao") or "").strip(),
                    "amparo": str(raw.get("amparo") or "").strip(),
                    "minuta": "",
                    "local_entrega": "",
                    "ordenador": "",
                    "responsavel": "",
                    "favorecido_tipo": "CPF",
                    "favorecido_doc": "OCULTO (LGPD)",
                    "favorecido_doc_limpo": "",
                    "favorecido_nome": "Pagamento Direto a Militar (Dados Ocultados · LGPD)",
                    "nc_vinculada": nc_vinc,
                    "prova_rastreabilidade": str(dash.get("prova") or "").strip(),
                    "prova_slug": str(dash.get("prova_slug") or "").strip(),
                    "valor_atual_c": None,
                    "valor_incluido_c": None,
                    "valor_reforcado_c": None,
                    "valor_anulado_c": None,
                    "cel_empenhado_c": None,
                    "cel_liquidado_c": None,
                    "cel_pago_c": None,
                    "cel_pct_liquidado": None,
                    "descricao": "Dados pessoais, favorecido, CPF e valores ocultados (LGPD — pagamento direto a militar).",
                    "subelementos": [],
                    "itens": [],
                    "qtd_itens": 0,
                    "documentos": [],
                    "tem_pdf": False,
                    "tem_processo": False,
                    "tem_requisicao": False,
                }
            )
            continue

        nes_out.append(
            {
                "id": uid,
                "tipo_doc": "NE",
                "sigilo_lgpd": False,
                "pdf_restrito_lgpd": False,
                "ug": ug,
                "ug_rotulo": UG_LABELS.get(ug, ug),
                "chave": chave,
                "numero": raw.get("numero"),
                "ano": raw.get("ano") or 2026,
                "versao": str(raw.get("versao") or "001").zfill(3),
                "versao_data_hora": raw.get("versao_data_hora") or "",
                "operacao_versao": raw.get("operacao_versao") or "",
                "data_emissao": data_br,
                "data_iso": data_iso,
                "mes": mes_ref,
                "tipo_empenho": normalizar_tipo_empenho(raw.get("tipo_empenho")),
                "situacao": raw.get("situacao") or "NORMAL",
                "situacao_rotulo": raw.get("situacao_rotulo") or "Empenho Inicial",
                "esfera": str(raw.get("esfera") or "").strip(),
                "ptres": str(raw.get("ptres") or "").strip(),
                "fonte": str(raw.get("fonte") or "").strip(),
                "nd": nd,
                "nd_desc": nd_desc,
                "ugr": str(raw.get("ugr") or "").strip(),
                "pi": pi,
                "pi_desc": pi_desc,
                "acao": acao,
                "processo_nup": str(raw.get("processo") or "").strip(),
                "processo_licitatorio": proc_lic,
                "pregao": pregao,
                "uasg_pregao": str(deriv.get("uasg_pregao") or "").strip(),
                "papel_ug": str(deriv.get("papel") or "").strip(),
                "modalidade": str(raw.get("modalidade_licitacao") or "").strip(),
                "amparo": str(raw.get("amparo") or "").strip(),
                "minuta": str(raw.get("minuta") or "").strip(),
                "local_entrega": str(raw.get("local_entrega") or "").strip(),
                "ordenador": str(raw.get("ordenador") or "").strip(),
                "responsavel": str(raw.get("responsavel") or "").strip(),
                "favorecido_tipo": fav_doc_tipo,
                "favorecido_doc": fav_doc_fmt,
                "favorecido_doc_limpo": fav_doc_limpo,
                "favorecido_nome": fav_nome,
                "nc_vinculada": nc_vinc,
                "prova_rastreabilidade": str(dash.get("prova") or "").strip(),
                "prova_slug": str(dash.get("prova_slug") or "").strip(),
                "valor_atual_c": valor_atual_c,
                "valor_incluido_c": to_centavos(raw.get("valor_incluido")),
                "valor_reforcado_c": to_centavos(raw.get("valor_reforcado")),
                "valor_anulado_c": to_centavos(raw.get("valor_anulado")),
                "cel_empenhado_c": to_centavos(dash.get("cel_emp")),
                "cel_liquidado_c": to_centavos(dash.get("cel_liq")),
                "cel_pago_c": to_centavos(dash.get("cel_pag")),
                "cel_pct_liquidado": dash.get("pct_liq"),
                "descricao": str(raw.get("descricao") or dash.get("desc") or "").strip(),
                "subelementos": subelementos,
                "itens": itens_comp,
                "qtd_itens": len(itens_comp),
                "documentos": documentos,
                "tem_pdf": any(d["tipo"] == "ne_oficial" for d in documentos),
                "tem_processo": any(d["tipo"] == "processo_escaneado" for d in documentos),
                "tem_requisicao": any(d["tipo"] == "requisicao" for d in documentos),
            }
        )

    # Indexar PDFs de NC por ug_emit:chave
    nc_pdf_lookup: dict[str, dict] = {}
    for key_nc_pasta, pdf_info in pdfs_nc_disco.items():
        _, rest = key_nc_pasta.split("|", 1)
        nc_pdf_lookup[rest] = pdf_info

    # Montar registros consolidados de NCs
    ncs_out: list[dict] = []
    for key_nc in sorted(ncs_raw.keys()):
        raw = ncs_raw[key_nc]
        ug_emit = str(raw.get("ug_emitente") or key_nc.split(":")[0]).strip()
        chave = str(raw.get("chave") or key_nc.split(":")[1]).strip().upper()
        uid = f"{ug_emit}:{chave}"
        nome_emit = str(
            raw.get("nome_emitente") or uasg_nomes.get(ug_emit) or ""
        ).strip()
        cred_info = cred_ncs.get(uid) or {}
        fav_cred = cred_info.get("favorecidas") or {}

        # Itens voltados ao BCMS (160329 / 167329) e totais
        itens_bcms = []
        ugs_fav_bcms: set[str] = set()
        esferas: set[str] = set()
        ptres_set: set[str] = set()
        fontes_set: set[str] = set()
        nds_set: set[str] = set()
        ugrs_set: set[str] = set()
        pis_set: set[str] = set()
        valor_bcms_c = 0

        for it in raw.get("itens") or []:
            ug_f = str(it.get("ug_favorecida") or "").strip()
            if ug_f not in UGS_BCMS:
                continue
            ugs_fav_bcms.add(ug_f)
            v_it_c = to_centavos(it.get("valor"))
            valor_bcms_c += v_it_c

            destinos_fmt = []
            for cel in it.get("destino") or []:
                esf = str(cel.get("esfera") or "").strip()
                pt = str(cel.get("ptres") or "").strip()
                ft = str(cel.get("fonte") or "").strip()
                nd_c = str(cel.get("nd") or "").strip()
                ugr_c = str(cel.get("ugr") or "").strip()
                pi_c = str(cel.get("pi") or "").strip()
                if esf:
                    esferas.add(esf)
                if pt:
                    ptres_set.add(pt)
                if ft:
                    fontes_set.add(ft)
                if nd_c:
                    nds_set.add(nd_c)
                if ugr_c:
                    ugrs_set.add(ugr_c)
                if pi_c:
                    pis_set.add(pi_c)
                destinos_fmt.append(
                    {
                        "esfera": esf,
                        "ptres": pt,
                        "fonte": ft,
                        "nd": nd_c,
                        "nd_desc": nd_desc_map.get(nd_c, ""),
                        "ugr": ugr_c,
                        "pi": pi_c,
                        "pi_desc": pi_desc_map.get(pi_c, ""),
                        "valor_c": to_centavos(cel.get("valor")),
                    }
                )

            origens_fmt = [
                {
                    "esfera": str(c.get("esfera") or "").strip(),
                    "ptres": str(c.get("ptres") or "").strip(),
                    "fonte": str(c.get("fonte") or "").strip(),
                    "nd": str(c.get("nd") or "").strip(),
                    "ugr": str(c.get("ugr") or "").strip(),
                    "pi": str(c.get("pi") or "").strip(),
                    "valor_c": to_centavos(c.get("valor")),
                }
                for c in (it.get("origem") or [])
            ]

            itens_bcms.append(
                {
                    "seq": it.get("seq"),
                    "situacao": it.get("situacao") or "",
                    "ug_favorecida": ug_f,
                    "nome_favorecida": it.get("nome_favorecida") or "",
                    "com_detalhamento": bool(it.get("com_detalhamento")),
                    "valor_c": v_it_c,
                    "origem": origens_fmt,
                    "destino": destinos_fmt,
                }
            )

        # Fallback de células pelo credito.json caso algum item não tenha destino detalhado
        valor_prov_c = 0
        valor_emp_c = 0
        valor_disp_c = 0
        status_exec_list: list[str] = []
        for ug_f, fc_data in fav_cred.items():
            if ug_f not in UGS_BCMS:
                continue
            ugs_fav_bcms.add(ug_f)
            valor_prov_c += to_centavos(fc_data.get("prov"))
            valor_emp_c += to_centavos(fc_data.get("emp"))
            valor_disp_c += to_centavos(fc_data.get("cred"))
            if fc_data.get("status"):
                status_exec_list.append(str(fc_data["status"]))
            for cel in fc_data.get("celulas") or []:
                if cel.get("ptres"):
                    ptres_set.add(str(cel["ptres"]).strip())
                if cel.get("pi"):
                    pis_set.add(str(cel["pi"]).strip())
                if cel.get("nd"):
                    nds_set.add(str(cel["nd"]).strip())

        if not ugs_fav_bcms and raw.get("ug_pasta") in UGS_BCMS:
            ugs_fav_bcms.add(str(raw["ug_pasta"]))

        pdf_info = nc_pdf_lookup.get(uid)
        if not pdf_info and raw.get("caminho"):
            p_raw = Path(raw["caminho"])
            if p_raw.is_file() and acervo_dir in p_raw.parents:
                pdf_info = {
                    "rel": p_raw.relative_to(acervo_dir).as_posix(),
                    "nome": p_raw.name,
                    "tamanho": p_raw.stat().st_size,
                    "versao": str(raw.get("versao") or "000").zfill(3),
                }

        documentos = (
            [
                {
                    "tipo": "nc_oficial",
                    "rotulo": f"Nota de Crédito SIAFI (v{pdf_info['versao']})",
                    "caminho_relativo": pdf_info["rel"],
                    "nome_arquivo": pdf_info["nome"],
                    "tamanho_bytes": pdf_info["tamanho"],
                }
            ]
            if pdf_info
            else []
        )

        data_br = str(raw.get("data_emissao") or cred_info.get("dia") or "").strip()
        data_iso = parse_data_iso(data_br)
        mes_ref = data_iso[5:7] if len(data_iso) >= 7 else ""
        nes_vinc = sorted(set(nc_to_nes_keys.get(chave, [])))
        valor_total_c = to_centavos(raw.get("total"))
        if valor_bcms_c == 0:
            valor_bcms_c = abs(valor_prov_c) if valor_prov_c else valor_total_c

        pis_list = sorted(pis_set)
        nds_list = sorted(nds_set)

        descricao_raw = str(raw.get("descricao") or cred_info.get("obj") or "").strip()
        sigilo_lgpd_nc = texto_contem_cpf_valido(descricao_raw)
        if sigilo_lgpd_nc:
            chaves_restritas_lgpd.add(uid)
            for it in itens_bcms:
                it["valor_c"] = None
                for c in it.get("origem") or []:
                    c["valor_c"] = None
                for c in it.get("destino") or []:
                    c["valor_c"] = None
            documentos_nc: list[dict] = []
            descricao_nc = "Dados pessoais, favorecido, CPF e valores ocultados (LGPD — crédito nominativo para pagamento direto a militar)."
            val_total_out = None
            val_bcms_out = None
            val_prov_out = None
            val_emp_out = None
            val_disp_out = None
        else:
            documentos_nc = documentos
            descricao_nc = descricao_raw
            val_total_out = valor_total_c
            val_bcms_out = valor_bcms_c
            val_prov_out = valor_prov_c
            val_emp_out = valor_emp_c
            val_disp_out = valor_disp_c

        ncs_out.append(
            {
                "id": uid,
                "tipo_doc": "NC",
                "sigilo_lgpd": sigilo_lgpd_nc,
                "pdf_restrito_lgpd": sigilo_lgpd_nc,
                "chave": chave,
                "numero": raw.get("numero"),
                "ano": raw.get("ano") or 2026,
                "ug_emitente": ug_emit,
                "nome_emitente": nome_emit,
                "ugs_favorecidas": sorted(ugs_fav_bcms),
                "ug_principal": sorted(ugs_fav_bcms)[0] if ugs_fav_bcms else str(raw.get("ug_pasta") or ""),
                "data_emissao": data_br,
                "data_iso": data_iso,
                "mes": mes_ref,
                "versao": str(raw.get("versao") or "000").zfill(3),
                "versao_data_hora": raw.get("versao_data_hora") or "",
                "operacao_versao": raw.get("operacao_versao") or "",
                "tipo_nc": str(raw.get("tipo_nc") or cred_info.get("op") or "").strip(),
                "status": str(raw.get("status") or "").strip(),
                "status_execucao": " / ".join(sorted(set(status_exec_list))),
                "acao": nc_acao_map.get(uid, ""),
                "esferas": sorted(esferas),
                "ptres": sorted(ptres_set),
                "fontes": sorted(fontes_set),
                "nds": nds_list,
                "nd_descs": {nd_c: nd_desc_map.get(nd_c, "") for nd_c in nds_list if nd_desc_map.get(nd_c)},
                "ugrs": sorted(ugrs_set),
                "pis": pis_list,
                "pi_descs": {pi_c: pi_desc_map.get(pi_c, "") for pi_c in pis_list if pi_desc_map.get(pi_c)},
                "valor_total_c": val_total_out,
                "valor_bcms_c": val_bcms_out,
                "valor_provisionado_c": val_prov_out,
                "valor_empenhado_c": val_emp_out,
                "valor_disponivel_c": val_disp_out,
                "descricao": descricao_nc,
                "itens": itens_bcms,
                "qtd_itens_total": len(raw.get("itens") or []),
                "qtd_itens_bcms": len(itens_bcms),
                "nes_vinculadas": nes_vinc,
                "documentos": documentos_nc,
                "tem_pdf": bool(documentos_nc),
            }
        )

    # Construir facetas ordenadas para seletores da interface
    filtros = _construir_facetas(nes_out, ncs_out, pi_desc_map, nd_desc_map)

    agora = datetime.now()
    totais = {
        "qtd_nes": len(nes_out),
        "qtd_nes_sigilo_lgpd": sum(1 for n in nes_out if n.get("sigilo_lgpd")),
        "qtd_nes_com_pdf": sum(1 for n in nes_out if n["tem_pdf"]),
        "qtd_nes_com_processo": sum(1 for n in nes_out if n["tem_processo"]),
        "qtd_nes_com_requisicao": sum(1 for n in nes_out if n["tem_requisicao"]),
        "qtd_ncs": len(ncs_out),
        "qtd_ncs_sigilo_lgpd": sum(1 for c in ncs_out if c.get("sigilo_lgpd")),
        "qtd_ncs_com_pdf": sum(1 for c in ncs_out if c["tem_pdf"]),
        "qtd_empresas_unicas": len(filtros["empresas"]),
        "total_empenhado_liquido_c": sum(
            n["valor_atual_c"] for n in nes_out if not n.get("sigilo_lgpd") and n["valor_atual_c"] is not None
        ),
        "total_creditos_provisionados_c": sum(
            c["valor_provisionado_c"]
            for c in ncs_out
            if not c.get("sigilo_lgpd") and c["valor_provisionado_c"] is not None
        ),
        "total_creditos_disponiveis_c": sum(
            c["valor_disponivel_c"]
            for c in ncs_out
            if not c.get("sigilo_lgpd") and c["valor_disponivel_c"] is not None
        ),
    }

    banco = {
        "meta": {
            "versao_schema": "1.1.0",
            "unidade": "Batalhão Central de Manutenção e Suprimento (BCMS)",
            "ugs": list(UGS_BCMS),
            "exercicio": 2026,
            "gerado_em_iso": agora.isoformat(timespec="seconds"),
            "gerado_em_br": agora.strftime("%d/%m/%Y %H:%M"),
            "posicao_credito": cred_raw_obj.get("posicao") or "",
            "chaves_restritas_lgpd": sorted(chaves_restritas_lgpd),
            "totais": totais,
        },
        "filtros": filtros,
        "empenhos": nes_out,
        "creditos": ncs_out,
    }

    saida_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = saida_path.with_suffix(f".{os.getpid()}.tmp")
    tmp_path.write_text(
        json.dumps(banco, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    tmp_path.replace(saida_path)
    return banco


def _construir_facetas(
    nes: list[dict],
    ncs: list[dict],
    pi_desc_map: dict[str, str],
    nd_desc_map: dict[str, str],
) -> dict[str, list[dict]]:
    def _from_counter(cnt: Counter, labels: dict[str, str] | None = None, sort_by_key: bool = True):
        items = list(cnt.items())
        if sort_by_key:
            items.sort(key=lambda x: x[0])
        else:
            items.sort(key=lambda x: (-x[1], x[0]))
        out = []
        for k, qtd in items:
            if not k:
                continue
            rot = labels.get(k, k) if labels else k
            if labels and k in labels and labels[k] and labels[k] != k:
                rot = f"{k} — {labels[k]}" if not labels[k].startswith(k) else labels[k]
            out.append({"valor": k, "rotulo": rot, "qtd": qtd})
        return out

    c_ug = Counter()
    c_emp = Counter()
    emp_names: dict[str, str] = {}
    c_nc = Counter()
    c_pi = Counter()
    c_nd = Counter()
    c_ptres = Counter()
    c_fonte = Counter()
    c_ugr = Counter()
    c_acao = Counter()
    c_sit_ne = Counter()
    c_mod = Counter()
    c_tipo_emp = Counter()
    c_pregao = Counter()
    c_sub = Counter()
    c_mes = Counter()
    c_emit = Counter()
    emit_names: dict[str, str] = {}
    c_status_nc = Counter()

    for n in nes:
        c_ug[n["ug"]] += 1
        if n["favorecido_nome"] and not n.get("sigilo_lgpd"):
            chave_emp = n["favorecido_doc_limpo"] or n["favorecido_nome"]
            c_emp[chave_emp] += 1
            if n["favorecido_doc"]:
                emp_names[chave_emp] = f"{n['favorecido_nome']} ({n['favorecido_doc']})"
            else:
                emp_names[chave_emp] = n["favorecido_nome"]
        if n["nc_vinculada"]:
            c_nc[n["nc_vinculada"]] += 1
        if n["pi"]:
            c_pi[n["pi"]] += 1
        if n["nd"]:
            c_nd[n["nd"]] += 1
        if n["ptres"]:
            c_ptres[n["ptres"]] += 1
        if n["fonte"]:
            c_fonte[n["fonte"]] += 1
        if n["ugr"]:
            c_ugr[n["ugr"]] += 1
        if n["acao"]:
            c_acao[n["acao"]] += 1
        if n["situacao_rotulo"]:
            c_sit_ne[n["situacao_rotulo"]] += 1
        if n["modalidade"]:
            c_mod[n["modalidade"]] += 1
        if n["tipo_empenho"]:
            c_tipo_emp[n["tipo_empenho"]] += 1
        if n["pregao"]:
            c_pregao[n["pregao"]] += 1
        for s in n["subelementos"]:
            c_sub[s] += 1
        if n["mes"]:
            c_mes[n["mes"]] += 1

    for c in ncs:
        for ug_f in c["ugs_favorecidas"]:
            c_ug[ug_f] += 1
        c_nc[c["chave"]] += 1
        c_emit[c["ug_emitente"]] += 1
        if c["nome_emitente"]:
            emit_names[c["ug_emitente"]] = f"{c['ug_emitente']} — {c['nome_emitente']}"
        for p in c["pis"]:
            c_pi[p] += 1
        for nd_c in c["nds"]:
            c_nd[nd_c] += 1
        for pt in c["ptres"]:
            c_ptres[pt] += 1
        for ft in c["fontes"]:
            c_fonte[ft] += 1
        for ugr_c in c["ugrs"]:
            c_ugr[ugr_c] += 1
        if c["acao"]:
            c_acao[c["acao"]] += 1
        if c["status"]:
            c_status_nc[c["status"]] += 1
        if c["mes"]:
            c_mes[c["mes"]] += 1

    empresas_out = [
        {"valor": k, "rotulo": emp_names.get(k, k), "qtd": qtd}
        for k, qtd in sorted(c_emp.items(), key=lambda x: emp_names.get(x[0], x[0]))
    ]

    return {
        "ugs": _from_counter(c_ug, UG_LABELS),
        "empresas": empresas_out,
        "ncs": _from_counter(c_nc),
        "pis": _from_counter(c_pi, pi_desc_map),
        "nds": _from_counter(c_nd, nd_desc_map),
        "ptres": _from_counter(c_ptres),
        "fontes": _from_counter(c_fonte),
        "ugrs": _from_counter(c_ugr),
        "acoes": _from_counter(c_acao),
        "ug_emitentes": _from_counter(c_emit, emit_names),
        "situacoes_ne": _from_counter(c_sit_ne, sort_by_key=False),
        "status_nc": _from_counter(c_status_nc, sort_by_key=False),
        "modalidades": _from_counter(c_mod, sort_by_key=False),
        "tipos_empenho": _from_counter(c_tipo_emp, sort_by_key=False),
        "pregoes": _from_counter(c_pregao),
        "subelementos": _from_counter(c_sub),
        "meses": _from_counter(c_mes, MESES_PT),
    }


def carregar_env_local(env_path: Path | None = None) -> dict[str, str]:
    """Lê pares CHAVE=VALOR do arquivo .env local, mantendo prioridade para os.environ."""
    caminho = Path(env_path) if env_path is not None else DEFAULT_ENV_PATH
    valores: dict[str, str] = {}
    if caminho.is_file():
        for linha_bruta in caminho.read_text(encoding="utf-8").splitlines():
            linha = linha_bruta.strip()
            if not linha or linha.startswith("#") or "=" not in linha:
                continue
            chave, _, valor = linha.partition("=")
            chave = chave.strip()
            valor = valor.strip().strip('"').strip("'")
            if chave:
                valores[chave] = valor
    for k in ("APPS_SCRIPT_URL", "APPS_SCRIPT_TOKEN"):
        if os.environ.get(k):
            valores[k] = os.environ[k].strip()
    return valores


def notificar_ponte_apps_script(env_path: Path | None = None, timeout: int = 90) -> dict:
    """Solicita rebuild_map na ponte Google Apps Script (fail-safe: nunca derruba o build)."""
    env = carregar_env_local(env_path)
    url = env.get("APPS_SCRIPT_URL", "").strip()
    token = env.get("APPS_SCRIPT_TOKEN", "").strip()
    if not url or not token:
        return {"ok": False, "ignorado": True, "motivo": "credenciais ausentes"}

    payload = json.dumps({"action": "rebuild_map", "token": token}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "text/plain;charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        return {"ok": False, "erro": str(exc)}


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Gera banco_consulta_bcms.json diretamente na pasta do Google Drive."
    )
    parser.add_argument("--acervo", type=Path, default=DEFAULT_ACERVO)
    parser.add_argument("--req-dados", type=Path, default=DEFAULT_REQ_DADOS)
    parser.add_argument("--dash-json", type=Path, default=DEFAULT_DASH_JSON)
    parser.add_argument("--saida", type=Path, default=DEFAULT_SAIDA)
    parser.add_argument("--reler-pdfs", action="store_true", help="Força releitura de todos os PDFs")
    parser.add_argument("--nao-copiar-ncs", action="store_true", help="Não copia NCs faltantes")
    parser.add_argument(
        "--sem-rebuild-drive",
        action="store_true",
        help="Não notifica a ponte Google Apps Script após gerar o banco",
    )
    args = parser.parse_args()

    banco = gerar_banco(
        acervo_dir=args.acervo,
        req_dados_dir=args.req_dados,
        dash_json_path=args.dash_json,
        saida_path=args.saida,
        reler_pdfs=args.reler_pdfs,
        copiar_ncs=not args.nao_copiar_ncs,
    )
    t = banco["meta"]["totais"]
    size_mb = args.saida.stat().st_size / (1024 * 1024)
    print(f"[OK] Banco gerado: {args.saida} ({size_mb:.2f} MB)")
    print(
        f"     NEs={t['qtd_nes']} (PDF={t['qtd_nes_com_pdf']}, Proc={t['qtd_nes_com_processo']}, "
        f"Req={t['qtd_nes_com_requisicao']}) | NCs={t['qtd_ncs']} (PDF={t['qtd_ncs_com_pdf']}) | "
        f"Empresas={t['qtd_empresas_unicas']}"
    )
    if not args.sem_rebuild_drive:
        ponte = notificar_ponte_apps_script()
        if ponte.get("ok"):
            print(
                f"[Drive] Mapa da ponte Apps Script atualizado: "
                f"{ponte.get('arquivos_mapeados')} PDF(s)."
            )
        elif ponte.get("ignorado"):
            print("[Drive] Rebuild da ponte ignorado (credenciais .env não configuradas).")
        else:
            print(f"[Aviso] Ponte Apps Script não respondeu: {ponte.get('erro')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
