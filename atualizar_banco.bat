@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================================
echo  ATUALIZADOR DO BANCO DE CONSULTA SIAFI - BCMS 2026 (GOOGLE DRIVE)
echo ============================================================================
py -3 -X utf8 scripts/gerar_banco_consulta.py %*
if errorlevel 1 (
    echo.
    echo [ERRO] Falha ao atualizar o banco de consulta.
    pause
    exit /b 1
)
echo.
echo [OK] Banco atualizado diretamente em Acervo-Empenhos-BCMS-2026\banco_consulta_bcms.json
pause
