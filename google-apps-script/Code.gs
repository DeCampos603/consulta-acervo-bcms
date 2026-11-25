/**
 * ============================================================================
 * PONTE SEGURA GOOGLE DRIVE <-> GITHUB PAGES (ACERVO DIGITAL SIAFI — BCMS)
 * ============================================================================
 *
 * Como implantar (2 minutos):
 * 1. Abra https://script.google.com com a conta dona da pasta no Google Drive.
 * 2. Crie um novo projeto e cole todo este código em `Código.gs` (Code.gs).
 * 3. Em "Configurações do projeto" -> "Propriedades do script", adicione:
 *      - ROOT_FOLDER_ID : ID da pasta `Acervo-Empenhos-BCMS-2026` no Google Drive
 *      - ACCESS_TOKEN   : senha/token secreto forte escolhido por você
 *    (Ou preencha `configurarInicial()` abaixo, rode uma única vez e apague os valores.)
 * 4. Clique em "Implantar" -> "Nova implantação" -> "App da Web":
 *      - Executar como: "Eu"
 *      - Quem pode acessar: "Qualquer pessoa"
 *    (Nenhum dado é exposto publicamente: toda ação exige `ACCESS_TOKEN` via POST.)
 * 5. Copie a URL `/exec` gerada e informe na tela de conexão do GitHub Pages.
 */

var ALLOWED_SUBFOLDERS = [
  "Empenhos",
  "Empenhos GVA",
  "Notas de Crédito",
  "REQUISICOES_REFORCO_ANULACAO_2026",
  "PROCESSOS ESCANEADOS 2026"
];

var DB_FILENAME = "banco_consulta_bcms.json";
var MAP_FILENAME = "drive_file_map.json";
var MAP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
var MAX_BASE64_BYTES = 15 * 1024 * 1024;   // 15 MB (acima disso, retorna link direto autenticado)

/**
 * Opcional: preencha temporariamente e execute 1 vez para gravar as propriedades.
 * Depois de executar, limpe os valores antes de salvar.
 */
function configurarInicial() {
  var props = PropertiesService.getScriptProperties();
  props.setProperties({
    ROOT_FOLDER_ID: "COLE_AQUI_O_ID_DA_PASTA_Acervo-Empenhos-BCMS-2026",
    ACCESS_TOKEN: "COLE_AQUI_UM_TOKEN_SECRETO_FORTE"
  });
}

function doGet() {
  return jsonOut_({
    ok: true,
    service: "BCMS Acervo Drive Bridge",
    version: "1.0.0",
    hint: "Use POST JSON (Content-Type: text/plain) com action e token."
  });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut_({ ok: false, error: "Corpo da requisição vazio." });
    }
    var req = JSON.parse(e.postData.contents);
    var props = PropertiesService.getScriptProperties();
    var expectedToken = props.getProperty("ACCESS_TOKEN") || "";
    var rootFolderId = props.getProperty("ROOT_FOLDER_ID") || "";

    if (!expectedToken || !rootFolderId) {
      return jsonOut_({
        ok: false,
        error: "Propriedades ROOT_FOLDER_ID ou ACCESS_TOKEN não configuradas no Apps Script."
      });
    }

    if (!timingSafeEqual_(String(req.token || ""), expectedToken)) {
      return jsonOut_({ ok: false, error: "Token de acesso inválido." });
    }

    var action = String(req.action || "ping");
    var rootFolder = DriveApp.getFolderById(rootFolderId);

    if (action === "ping") {
      var dbFile = findSingleFile_(rootFolder, DB_FILENAME);
      var mapObj = loadOrBuildMap_(rootFolder, false);
      return jsonOut_({
        ok: true,
        pasta: rootFolder.getName(),
        tem_banco: Boolean(dbFile),
        atualizado_em: dbFile ? dbFile.getLastUpdated().toISOString() : null,
        arquivos_mapeados: Object.keys(mapObj.files || {}).length
      });
    }

    if (action === "database") {
      var db = findSingleFile_(rootFolder, DB_FILENAME);
      if (!db) {
        return jsonOut_({
          ok: false,
          error: "Arquivo " + DB_FILENAME + " não encontrado na pasta raiz do Drive."
        });
      }
      var databaseJson = JSON.parse(db.getBlob().getDataAsString("UTF-8"));
      var restrictedMap = buildRestrictedMap_(databaseJson);
      var mapData = loadOrBuildMap_(rootFolder, Boolean(req.forceRefresh));
      var safeFileMap = filterSafeFileMap_(mapData.files || {}, restrictedMap);
      return jsonOut_({
        ok: true,
        pasta: rootFolder.getName(),
        atualizado_em: db.getLastUpdated().toISOString(),
        database: databaseJson,
        fileMap: safeFileMap,
        mapUpdatedAt: mapData.updatedAt
      });
    }

    if (action === "rebuild_map") {
      var rebuilt = loadOrBuildMap_(rootFolder, true);
      return jsonOut_({
        ok: true,
        arquivos_mapeados: Object.keys(rebuilt.files || {}).length,
        mapUpdatedAt: rebuilt.updatedAt
      });
    }

    if (action === "pdf") {
      var mapStore = loadOrBuildMap_(rootFolder, false);
      var relPath = String(req.relativePath || "").replace(/^\/+/, "");
      var targetId = String(req.fileId || "");

      // Lista branca estrita: só libera arquivos catalogados dentro das subpastas autorizadas
      var resolved = resolveAuthorizedEntry_(mapStore.files || {}, relPath, targetId);
      if (!resolved) {
        // Tenta reconstruir o mapa caso seja um PDF recém-adicionado no Drive
        mapStore = loadOrBuildMap_(rootFolder, true);
        resolved = resolveAuthorizedEntry_(mapStore.files || {}, relPath, targetId);
      }
      if (!resolved) {
        return jsonOut_({
          ok: false,
          error: "Documento não encontrado ou fora das pastas autorizadas do acervo."
        });
      }

      var dbForCheck = findSingleFile_(rootFolder, DB_FILENAME);
      var restrictedSet = {};
      if (dbForCheck) {
        var dbJsonCheck = JSON.parse(dbForCheck.getBlob().getDataAsString("UTF-8"));
        restrictedSet = buildRestrictedMap_(dbJsonCheck);
      }
      if (isRestrictedPdf_(resolved.relPath, resolved.relPath.split("/").pop(), restrictedSet)) {
        return jsonOut_({
          ok: false,
          error: "Documento restrito pela LGPD (pagamento direto a militar)."
        });
      }

      var entry = resolved.entry;
      var file = DriveApp.getFileById(entry.id);
      if (isRestrictedPdf_(resolved.relPath, file.getName(), restrictedSet)) {
        return jsonOut_({
          ok: false,
          error: "Documento restrito pela LGPD (pagamento direto a militar)."
        });
      }
      var size = file.getSize();
      if (size > MAX_BASE64_BYTES) {
        return jsonOut_({
          ok: true,
          mode: "drive_link",
          fileId: entry.id,
          name: file.getName(),
          size: size,
          previewUrl: "https://drive.google.com/file/d/" + entry.id + "/view",
          downloadUrl: "https://drive.google.com/uc?export=download&id=" + entry.id
        });
      }

      var blob = file.getBlob();
      return jsonOut_({
        ok: true,
        mode: "base64",
        fileId: entry.id,
        name: file.getName(),
        mimeType: "application/pdf",
        size: size,
        data: Utilities.base64Encode(blob.getBytes())
      });
    }

    return jsonOut_({ ok: false, error: "Ação desconhecida: " + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function timingSafeEqual_(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  var maxLen = Math.max(a.length, b.length);
  var diff = a.length ^ b.length;
  for (var i = 0; i < maxLen; i++) {
    var ca = i < a.length ? a.charCodeAt(i) : 0;
    var cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function findSingleFile_(folder, name) {
  var it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function resolveAuthorizedEntry_(filesMap, relPath, targetId) {
  if (relPath && filesMap[relPath]) {
    return { relPath: relPath, entry: filesMap[relPath] };
  }
  if (targetId) {
    var keys = Object.keys(filesMap);
    for (var i = 0; i < keys.length; i++) {
      if (filesMap[keys[i]].id === targetId) {
        return { relPath: keys[i], entry: filesMap[keys[i]] };
      }
    }
  }
  return null;
}

function buildRestrictedMap_(databaseJson) {
  var map = {};
  var list = (databaseJson && databaseJson.meta && databaseJson.meta.chaves_restritas_lgpd) || [];
  for (var i = 0; i < list.length; i++) {
    map[String(list[i]).toUpperCase()] = true;
  }
  return map;
}

function isRestrictedPdf_(relPath, fileName, restrictedMap) {
  var name = String(fileName || "");
  var rel = String(relPath || "");
  // 1. Bloqueio direto por padrão de CPF (11 dígitos) no nome do arquivo de NE
  if (/^NE_\d{6}_\d{4}NE\d{6}_v\d+_\d{11}_/i.test(name)) {
    return true;
  }
  // 2. Bloqueio via chaves restritas (NE oficial, Requisição, Empenho GVA)
  var mNe = (rel + " " + name).match(/(160329|167329)_(\d{4}NE\d{6})/i);
  if (mNe && restrictedMap[(mNe[1] + ":" + mNe[2]).toUpperCase()]) {
    return true;
  }
  // 3. Bloqueio via Processo Escaneado (pasta 160/167 + NE_<num>)
  var mProc = rel.match(/^PROCESSOS ESCANEADOS 2026\/(160|167)[^\/]*\/.*NE_(\d+)/i);
  if (mProc) {
    var ugProc = mProc[1] + "329";
    var numPad = ("000000" + parseInt(mProc[2], 10)).slice(-6);
    if (restrictedMap[(ugProc + ":2026NE" + numPad).toUpperCase()]) {
      return true;
    }
  }
  // 4. Bloqueio de NC nominativa com CPF
  var mNc = name.match(/^NC_(\d{6})_(\d{4}NC\d{6})_/i);
  if (mNc && restrictedMap[(mNc[1] + ":" + mNc[2]).toUpperCase()]) {
    return true;
  }
  return false;
}

function filterSafeFileMap_(filesMap, restrictedMap) {
  var out = {};
  var keys = Object.keys(filesMap || {});
  for (var i = 0; i < keys.length; i++) {
    var rel = keys[i];
    var fileName = rel.split("/").pop();
    if (!isRestrictedPdf_(rel, fileName, restrictedMap)) {
      out[rel] = filesMap[rel];
    }
  }
  return out;
}

function loadOrBuildMap_(rootFolder, forceRefresh) {
  var existingFile = findSingleFile_(rootFolder, MAP_FILENAME);
  if (!forceRefresh && existingFile) {
    try {
      var parsed = JSON.parse(existingFile.getBlob().getDataAsString("UTF-8"));
      var age = Date.now() - new Date(parsed.updatedAt || 0).getTime();
      if (parsed && parsed.files && age >= 0 && age < MAP_CACHE_TTL_MS) {
        return parsed;
      }
    } catch (_ignored) {}
  }

  var filesMap = {};
  for (var i = 0; i < ALLOWED_SUBFOLDERS.length; i++) {
    var subName = ALLOWED_SUBFOLDERS[i];
    var subIt = rootFolder.getFoldersByName(subName);
    if (subIt.hasNext()) {
      walkFolder_(subIt.next(), subName, filesMap);
    }
  }

  var payload = {
    updatedAt: new Date().toISOString(),
    files: filesMap
  };
  var content = JSON.stringify(payload);
  if (existingFile) {
    existingFile.setContent(content);
  } else {
    rootFolder.createFile(MAP_FILENAME, content, MimeType.PLAIN_TEXT);
  }
  return payload;
}

function walkFolder_(folder, prefix, filesMap) {
  var files = folder.getFiles();
  while (files.hasNext()) {
    var f = files.next();
    var name = f.getName();
    if (/\.pdf$/i.test(name)) {
      filesMap[prefix + "/" + name] = {
        id: f.getId(),
        size: f.getSize()
      };
    }
  }
  var subs = folder.getFolders();
  while (subs.hasNext()) {
    var s = subs.next();
    walkFolder_(s, prefix + "/" + s.getName(), filesMap);
  }
}
