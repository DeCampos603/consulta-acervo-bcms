# -*- coding: utf-8 -*-
"""Testes automatizados do gerador de banco, servidor local e guarda de segurança Git."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

PROJETO = Path(__file__).resolve().parent.parent
SCRIPTS = PROJETO / "scripts"
SITE = PROJETO / "site"
ACERVO = PROJETO.parent / "Acervo-Empenhos-BCMS-2026"
BANCO_PATH = ACERVO / "banco_consulta_bcms.json"

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from gerar_banco_consulta import (  # noqa: E402
    carregar_env_local,
    classificar_favorecido_doc,
    cpf_valido,
    normalizar_tipo_empenho,
    notificar_ponte_apps_script,
    parse_data_iso,
    texto_contem_cpf_valido,
    to_centavos,
)
from servidor_local import resolver_pdf_seguro  # noqa: E402


def test_to_centavos_precisao():
    assert to_centavos("1.234,56") == 123456
    assert to_centavos("R$ 699,99") == 69999
    assert to_centavos("6899.99") == 689999
    assert to_centavos("-54.88") == -5488
    assert to_centavos(None) == 0
    assert to_centavos("") == 0
    assert to_centavos("0,00") == 0


def test_normalizacoes():
    assert normalizar_tipo_empenho("1.0") == "Ordinário"
    assert normalizar_tipo_empenho("5.0") == "Global"
    assert normalizar_tipo_empenho("3") == "Estimativo"
    assert parse_data_iso("24/11/2026") == "2026-11-24"

    t1, d1, f1 = classificar_favorecido_doc("12.388.737/0001-02")
    assert (t1, d1, f1) == ("CNPJ", "12388737000102", "12.388.737/0001-02")

    t2, d2, f2 = classificar_favorecido_doc("12345678901")
    assert (t2, d2, f2) == ("CPF", "12345678901", "123.456.789-01")

    t3, d3, f3 = classificar_favorecido_doc("115406")
    assert (t3, d3, f3) == ("UG", "115406", "115406")


def test_site_nao_contem_documentos_ou_dados_sensiveis():
    proibidos = []
    for f in SITE.rglob("*"):
        if not f.is_file():
            continue
        if f.suffix.lower() in {".pdf", ".xlsx", ".xls", ".csv", ".zip", ".db", ".sqlite"}:
            proibidos.append(str(f))
        if f.name in {"banco_consulta_bcms.json", "drive_file_map.json"}:
            proibidos.append(str(f))
    assert proibidos == [], f"Arquivos restritos dentro de site/: {proibidos}"


def test_cpf_valido_e_deteccao_texto():
    assert cpf_valido("52998224725") is True
    assert cpf_valido("11144477735") is True
    assert cpf_valido("11111111111") is False
    assert cpf_valido("00000000000") is False
    assert cpf_valido("12345678901") is False
    assert cpf_valido("12345678000195") is False

    assert texto_contem_cpf_valido("INDENIZACAO CPF 529.982.247-25 MILITAR") is True
    assert texto_contem_cpf_valido("PAGAMENTO 11144477735 AJUDA DE CUSTO") is True
    assert texto_contem_cpf_valido("TEN CEL FULANO, CPF52998224725 , RESS BAGAGEM") is True
    assert texto_contem_cpf_valido("PROTOCOLO 12345678901 MATERIAL CONSUMO") is False
    assert texto_contem_cpf_valido("EMPRESA CNPJ 12345678000195 SERVICOS") is False


@pytest.mark.skipif(not BANCO_PATH.is_file(), reason="Banco real não presente neste ambiente")
def test_integridade_banco_gerado():
    raw_text = BANCO_PATH.read_text(encoding="utf-8")
    assert not texto_contem_cpf_valido(raw_text), "CPF válido vazou no banco_consulta_bcms.json"

    banco = json.loads(raw_text)
    meta = banco["meta"]
    tot = meta["totais"]
    assert tot["qtd_nes"] == len(banco["empenhos"]) == 488
    assert tot["qtd_ncs"] == len(banco["creditos"]) == 400
    assert tot["qtd_nes_sigilo_lgpd"] == 63
    assert tot["qtd_ncs_sigilo_lgpd"] >= 47
    nc_adjacente = next(c for c in banco["creditos"] if c["id"] == "160505:2026NC408527")
    assert nc_adjacente.get("sigilo_lgpd") is True
    assert tot["qtd_ncs_com_pdf"] == 400 - tot["qtd_ncs_sigilo_lgpd"]
    assert tot["qtd_nes_com_pdf"] >= 400
    chaves_restritas = set(meta.get("chaves_restritas_lgpd") or [])
    assert len(chaves_restritas) == tot["qtd_nes_sigilo_lgpd"] + tot["qtd_ncs_sigilo_lgpd"]

    # Campos monetários devem ser int nos públicos e None/ocultos nos registros LGPD
    for ne in banco["empenhos"]:
        if ne.get("sigilo_lgpd"):
            assert ne["id"] in chaves_restritas
            assert ne["favorecido_doc"] == "OCULTO (LGPD)"
            assert ne["favorecido_doc_limpo"] == ""
            assert ne["documentos"] == []
            assert ne["itens"] == []
            for campo in (
                "valor_atual_c",
                "valor_incluido_c",
                "valor_reforcado_c",
                "valor_anulado_c",
            ):
                assert ne[campo] is None
        else:
            for campo in (
                "valor_atual_c",
                "valor_incluido_c",
                "valor_reforcado_c",
                "valor_anulado_c",
            ):
                assert isinstance(ne[campo], int)
            for doc in ne["documentos"]:
                rel = doc["caminho_relativo"]
                assert "\\" not in rel and ":" not in rel and not rel.startswith("/")
                assert (ACERVO / rel).is_file(), f"PDF ausente: {rel}"

    for nc in banco["creditos"]:
        if nc.get("sigilo_lgpd"):
            assert nc["id"] in chaves_restritas
            assert nc["documentos"] == []
            for campo in (
                "valor_total_c",
                "valor_bcms_c",
                "valor_provisionado_c",
                "valor_empenhado_c",
                "valor_disponivel_c",
            ):
                assert nc[campo] is None
        else:
            for campo in (
                "valor_total_c",
                "valor_bcms_c",
                "valor_provisionado_c",
                "valor_empenhado_c",
                "valor_disponivel_c",
            ):
                assert isinstance(nc[campo], int)
            for doc in nc["documentos"]:
                rel = doc["caminho_relativo"]
                assert (ACERVO / rel).is_file(), f"PDF NC ausente: {rel}"


@pytest.mark.skipif(not ACERVO.is_dir(), reason="Pasta do acervo não presente neste ambiente")
def test_resolver_pdf_seguro_bloqueia_traversal():
    assert resolver_pdf_seguro(ACERVO, "../Consulta-Acervo-BCMS/README.md") is None
    assert resolver_pdf_seguro(ACERVO, "banco_consulta_bcms.json") is None
    assert resolver_pdf_seguro(ACERVO, "AUDITORIA/Auditoria_Empenhos_2026.pdf") is None

    banco = json.loads(BANCO_PATH.read_text(encoding="utf-8"))
    ne_com_pdf = next(n for n in banco["empenhos"] if n["documentos"])
    nc_com_pdf = next(c for c in banco["creditos"] if c["documentos"])
    p_ne = resolver_pdf_seguro(ACERVO, ne_com_pdf["documentos"][0]["caminho_relativo"])
    p_nc = resolver_pdf_seguro(ACERVO, nc_com_pdf["documentos"][0]["caminho_relativo"])
    assert p_ne is not None and p_ne.read_bytes().startswith(b"%PDF-")
    assert p_nc is not None and p_nc.read_bytes().startswith(b"%PDF-")

    # Bloqueio LGPD no servidor local para NE de CPF, NC restrita e processo/requisição vinculados
    pdf_ne_cpf = next((ACERVO / "Empenhos").rglob("*2026NE000014*.pdf"), None)
    assert pdf_ne_cpf is not None
    assert resolver_pdf_seguro(ACERVO, pdf_ne_cpf.relative_to(ACERVO).as_posix()) is None

    nc_lgpd = next(c for c in banco["creditos"] if c.get("sigilo_lgpd"))
    pdf_nc_lgpd = next((ACERVO / "Notas de Crédito").rglob(f"*{nc_lgpd['chave']}*.pdf"), None)
    assert pdf_nc_lgpd is not None
    assert resolver_pdf_seguro(ACERVO, pdf_nc_lgpd.relative_to(ACERVO).as_posix()) is None


def test_env_e_notificar_ponte_apps_script(tmp_path, monkeypatch):
    monkeypatch.delenv("APPS_SCRIPT_URL", raising=False)
    monkeypatch.delenv("APPS_SCRIPT_TOKEN", raising=False)

    env_vazio = tmp_path / "vazio.env"
    env_vazio.write_text("# comentario\n", encoding="utf-8")
    assert carregar_env_local(env_vazio) == {}
    res_ausente = notificar_ponte_apps_script(env_vazio)
    assert res_ausente["ok"] is False and res_ausente["ignorado"] is True

    env_ok = tmp_path / "ok.env"
    env_ok.write_text(
        'APPS_SCRIPT_URL="https://script.google.com/macros/s/test/exec"\n'
        "APPS_SCRIPT_TOKEN=tok123\n",
        encoding="utf-8",
    )
    loaded = carregar_env_local(env_ok)
    assert loaded == {
        "APPS_SCRIPT_URL": "https://script.google.com/macros/s/test/exec",
        "APPS_SCRIPT_TOKEN": "tok123",
    }

    class _FakeResp:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"ok": true, "arquivos_mapeados": 1286}'

    captured = {}

    def _fake_urlopen(req, timeout=0):
        captured["url"] = req.full_url
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _FakeResp()

    monkeypatch.setattr("gerar_banco_consulta.urllib.request.urlopen", _fake_urlopen)
    res_ok = notificar_ponte_apps_script(env_ok)
    assert res_ok["ok"] is True and res_ok["arquivos_mapeados"] == 1286
    assert captured["url"] == "https://script.google.com/macros/s/test/exec"
    assert captured["body"] == {"action": "rebuild_map", "token": "tok123"}
