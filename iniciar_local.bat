@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================================
echo  INICIANDO CONSULTA DE EMPENHOS E CREDITOS - BCMS 2026 (MODO LOCAL)
echo ============================================================================
start "" http://127.0.0.1:8765/
py -3 -X utf8 scripts/servidor_local.py
pause
