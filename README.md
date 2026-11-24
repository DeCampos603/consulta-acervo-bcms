# Acervo Digital SIAFI — BCMS 2026 (Consulta de Empenhos e Notas de Crédito)

Sistema institucional de consulta, pesquisa combinada, auditoria cruzada e download de **Notas de Empenho (NE)**, **Notas de Crédito (NC)**, **Requisições** e **Processos Escaneados** do **Batalhão Central de Manutenção e Suprimento (BCMS)** — UGs `160329 (OGU)` e `167329 (Fundo do Exército)`.

> **Segurança e Privacidade por Arquitetura:** Este repositório contém **apenas o código estático da interface** (`site/`) e os scripts locais de geração. **Nenhum PDF, planilha ou dado real (`banco_consulta_bcms.json`) é enviado ao Git/GitHub.** Todos os documentos e o banco de dados permanecem privados no seu **Google Drive** (`Acervo-Empenhos-BCMS-2026/`).

---

## 1. Como funciona a arquitetura

1. **Banco Unificado no Google Drive (`Acervo-Empenhos-BCMS-2026/banco_consulta_bcms.json`)**
   - Gerado pelo script `scripts/gerar_banco_consulta.py` (ou 1 clique em `atualizar_banco.bat`).
   - Consolida os PDFs oficiais das NEs e NCs, dados de liquidação/pagamento/rastreabilidade do `Dashboard-Credito-BCMS`, requisições de reforço/anulação/iniciais, empenhos GVA e processos escaneados.
2. **Frontend Estático no GitHub Pages (`site/`)**
   - Funciona 100% no navegador sem backend exposto publicamente.
   - Conecta-se ao seu Google Drive privado usando um de 3 provedores:
     - **Google Apps Script Bridge (`google-apps-script/Code.gs`) — Recomendado (2 min):** implanta um Web App na sua própria conta Google protegido por um token secreto (`ACCESS_TOKEN`) e lista branca de pastas. Sem necessidade de criar projeto no Google Cloud Console.
     - **Google Drive API v3 (OAuth 2.0 / GIS):** login direto com conta Google autorizada na pasta do Drive.
     - **Pasta Local / Servidor Local (`iniciar_local.bat`):** lê diretamente da pasta `G:\Meu Drive\REPO\Acervo-Empenhos-BCMS-2026` no computador.

---

## 2. Como ativar a conexão com seu Google Drive (2 minutos)

1. Gere ou atualize o banco no Drive clicando em **`atualizar_banco.bat`** (ou rodando `py -3 -X utf8 scripts/gerar_banco_consulta.py`). Confirme que o arquivo `banco_consulta_bcms.json` apareceu dentro de `Acervo-Empenhos-BCMS-2026/`.
2. Abra a pasta `Acervo-Empenhos-BCMS-2026` no Google Drive Web e copie o **ID da pasta** na URL (`https://drive.google.com/drive/folders/<ID_DA_PASTA>`).
3. Acesse [https://script.google.com](https://script.google.com) com a conta Google dona do Drive e clique em **Novo projeto**.
4. Cole o conteúdo completo de [`google-apps-script/Code.gs`](google-apps-script/Code.gs).
5. Em **Configurações do projeto → Propriedades do script** (ou executando `configurarInicial` uma única vez), defina:
   - `ROOT_FOLDER_ID`: o ID da pasta `Acervo-Empenhos-BCMS-2026`
   - `ACCESS_TOKEN`: uma senha/token forte de sua escolha (ex.: gerada em um gerenciador de senhas)
6. Clique em **Implantar → Nova implantação → App da Web**:
   - **Executar como:** `Eu (sua conta)`
   - **Quem pode acessar:** `Qualquer pessoa` *(o acesso aos dados é bloqueado pelo `ACCESS_TOKEN` validado via `POST` em tempo constante e restrito às subpastas do acervo)*
7. Copie a **URL do App da Web** (`https://script.google.com/macros/s/.../exec`), abra o sistema no GitHub Pages, cole a URL e o `ACCESS_TOKEN` e clique em **Conectar**.
8. **Para compartilhar com o grupo do batalhão (acesso em 1 clique):** já conectado, clique em **Copiar Link p/ Grupo** na barra superior e cole no grupo. Quem clicar entra direto no acervo (sem digitar URL nem senha); quem acessar a página raiz sem esse link vê apenas a tela de bloqueio vazia. Para revogar o acesso a qualquer momento, basta alterar `ACCESS_TOKEN` nas *Propriedades do script* no Apps Script e gerar um novo link.

---

## 3. Como usar localmente (sem configurar nada na nuvem)

- **Opção A (1 clique):** execute `iniciar_local.bat` (abre `http://127.0.0.1:8765/` com acesso instantâneo ao banco e a todos os PDFs do disco local).
- **Opção B (Chrome/Edge direto no GitHub Pages):** na tela de conexão do site publicado, selecione a aba **Pasta Local (PC)** e aponte para `G:\Meu Drive\REPO\Acervo-Empenhos-BCMS-2026`.

---

## 4. Testes Automatizados

```powershell
cd "g:\Meu Drive\REPO\Consulta-Acervo-BCMS"
py -3 -m pytest tests/ -v
```
