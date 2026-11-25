# -*- coding: utf-8 -*-
"""Servidor HTTP local seguro para o sistema de consulta BCMS 2026.

Serve os arquivos estáticos de `site/` na raiz `/` e disponibiliza API local
restrita a `127.0.0.1` lendo o banco e os PDFs diretamente de `Acervo-Empenhos-BCMS-2026/`
com proteção contra path traversal.
"""

from __future__ import annotations

import argparse
import functools
import json
import mimetypes
import re
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROJETO_DIR = Path(__file__).resolve().parent.parent
SITE_DIR = PROJETO_DIR / "site"
DEFAULT_ACERVO = PROJETO_DIR.parent / "Acervo-Empenhos-BCMS-2026"
PASTAS_PERMITIDAS = {
    "Empenhos",
    "Empenhos GVA",
    "Notas de Crédito",
    "REQUISICOES_REFORCO_ANULACAO_2026",
    "PROCESSOS ESCANEADOS 2026",
}

_RE_NE_CPF_NOME = re.compile(r"^NE_\d{6}_\d{4}NE\d{6}_v\d+_\d{11}_", re.I)
_RE_UG_NE = re.compile(r"(160329|167329)_(\d{4}NE\d{6})", re.I)
_RE_PROC = re.compile(r"^PROCESSOS ESCANEADOS 2026/(160|167)[^/]*/.*NE_(\d+)", re.I)
_RE_NC_NOME = re.compile(r"^NC_(\d{6})_(\d{4}NC\d{6})_", re.I)
_CACHE_RESTRITAS: dict[str, tuple[float, set[str]]] = {}


def _carregar_chaves_restritas(acervo_dir: Path) -> set[str]:
    banco = acervo_dir / "banco_consulta_bcms.json"
    if not banco.is_file():
        return set()
    mtime = banco.stat().st_mtime
    key = str(banco.resolve())
    cached = _CACHE_RESTRITAS.get(key)
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        data = json.loads(banco.read_text(encoding="utf-8"))
        chaves = {
            str(c).upper()
            for c in ((data.get("meta") or {}).get("chaves_restritas_lgpd") or [])
        }
    except Exception:
        chaves = set()
    _CACHE_RESTRITAS[key] = (mtime, chaves)
    return chaves


def eh_pdf_restrito_lgpd(acervo_dir: Path, rel_posix: str, nome_arquivo: str) -> bool:
    """Bloqueia qualquer PDF de pagamento direto a militar (CPF/LGPD)."""
    if _RE_NE_CPF_NOME.match(nome_arquivo):
        return True
    restritas = _carregar_chaves_restritas(acervo_dir)
    if not restritas:
        return False
    m_ne = _RE_UG_NE.search(f"{rel_posix} {nome_arquivo}")
    if m_ne and f"{m_ne.group(1)}:{m_ne.group(2).upper()}" in restritas:
        return True
    m_proc = _RE_PROC.match(rel_posix)
    if m_proc:
        ug = f"{m_proc.group(1)}329"
        chave = f"2026NE{int(m_proc.group(2)):06d}"
        if f"{ug}:{chave}" in restritas:
            return True
    m_nc = _RE_NC_NOME.match(nome_arquivo)
    if m_nc and f"{m_nc.group(1)}:{m_nc.group(2).upper()}" in restritas:
        return True
    return False


def resolver_pdf_seguro(acervo_dir: Path, rel_path: str) -> Path | None:
    """Resolve um caminho relativo garantindo confinamento estrito às subpastas permitidas e bloqueio LGPD."""
    limpo = urllib.parse.unquote(rel_path or "").strip().lstrip("/\\")
    if not limpo or ".." in Path(limpo).parts:
        return None
    partes = Path(limpo).parts
    if not partes or partes[0] not in PASTAS_PERMITIDAS:
        return None
    raiz = acervo_dir.resolve()
    alvo = (raiz / limpo).resolve()
    if not alvo.is_relative_to(raiz):
        return None
    if not alvo.is_file() or alvo.suffix.lower() != ".pdf":
        return None
    rel_posix = alvo.relative_to(raiz).as_posix()
    if eh_pdf_restrito_lgpd(raiz, rel_posix, alvo.name):
        return None
    return alvo


class ConsultaRequestHandler(SimpleHTTPRequestHandler):
    """Manipulador HTTP que une arquivos estáticos de site/ com API local segura."""

    def __init__(self, *args, acervo_dir: Path, **kwargs):
        self.acervo_dir = acervo_dir.resolve()
        super().__init__(*args, directory=str(SITE_DIR), **kwargs)

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()

    def _send_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/local/status":
            banco = self.acervo_dir / "banco_consulta_bcms.json"
            self._send_json(
                200,
                {
                    "ok": True,
                    "mode": "local_server",
                    "pasta": self.acervo_dir.name,
                    "tem_banco": banco.is_file(),
                    "banco_bytes": banco.stat().st_size if banco.is_file() else 0,
                },
            )
            return

        if parsed.path == "/api/local/database":
            banco = self.acervo_dir / "banco_consulta_bcms.json"
            if not banco.is_file():
                self._send_json(
                    404,
                    {
                        "ok": False,
                        "error": "banco_consulta_bcms.json não encontrado. Execute atualizar_banco.bat.",
                    },
                )
                return
            raw = banco.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
            return

        if parsed.path == "/api/local/pdf":
            qs = urllib.parse.parse_qs(parsed.query)
            rel_path = (qs.get("path") or [""])[0]
            pdf_path = resolver_pdf_seguro(self.acervo_dir, rel_path)
            if pdf_path is None:
                self._send_json(
                    403,
                    {"ok": False, "error": "Caminho inválido, não permitido ou PDF ausente."},
                )
                return
            raw = pdf_path.read_bytes()
            download = (qs.get("download") or ["0"])[0] == "1"
            disp = "attachment" if download else "inline"
            nome_ascii = pdf_path.name.encode("ascii", "ignore").decode("ascii") or "documento.pdf"
            nome_utf8 = urllib.parse.quote(pdf_path.name)
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header(
                "Content-Disposition",
                f'{disp}; filename="{nome_ascii}"; filename*=UTF-8\'\'{nome_utf8}',
            )
            self.send_header("Cache-Control", "private, max-age=300")
            self.end_headers()
            self.wfile.write(raw)
            return

        super().do_GET()

    def guess_type(self, path: str) -> str:
        if str(path).endswith(".js") or str(path).endswith(".mjs"):
            return "application/javascript; charset=utf-8"
        if str(path).endswith(".css"):
            return "text/css; charset=utf-8"
        return mimetypes.guess_type(path)[0] or "application/octet-stream"

    def log_message(self, format: str, *args) -> None:
        # Log conciso no terminal local
        print(f"[Local] {self.address_string()} - {format % args}")


def criar_servidor(host: str = "127.0.0.1", port: int = 8765, acervo_dir: Path = DEFAULT_ACERVO) -> ThreadingHTTPServer:
    handler = functools.partial(ConsultaRequestHandler, acervo_dir=acervo_dir)
    return ThreadingHTTPServer((host, port), handler)


def main() -> int:
    parser = argparse.ArgumentParser(description="Servidor local do Acervo BCMS")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--acervo", type=Path, default=DEFAULT_ACERVO)
    args = parser.parse_args()

    srv = criar_servidor(host=args.host, port=args.port, acervo_dir=args.acervo)
    print(f"Acervo Digital BCMS local ativo em: http://{args.host}:{args.port}/")
    print(f"Pasta do Drive monitorada: {args.acervo.resolve()}")
    print("Pressione Ctrl+C para encerrar.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nEncerrando servidor local...")
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
