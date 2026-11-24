// Adaptadores de acesso privado ao acervo (Apps Script, Google Drive OAuth, Pasta Local e Servidor Local).

const ALLOWED_DRIVE_FOLDERS = new Set([
  "Empenhos",
  "Empenhos GVA",
  "Notas de Crédito",
  "REQUISICOES_REFORCO_ANULACAO_2026",
  "PROCESSOS ESCANEADOS 2026",
]);

function base64ToUint8Array(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

class MemoryPdfCache {
  constructor(limit = 40) {
    this.limit = limit;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return null;
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.limit) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
  }

  clear() {
    this.map.clear();
  }
}

export class LocalApiProvider {
  constructor() {
    this.id = "local_api";
    this.label = "Servidor Local (Disco / Drive sincronizado)";
    this.cache = new MemoryPdfCache(30);
  }

  async detect() {
    try {
      const res = await fetch("/api/local/status", { cache: "no-store" });
      if (!res.ok) return null;
      const json = await res.json();
      return json && json.ok ? json : null;
    } catch {
      return null;
    }
  }

  async loadDatabase(onProgress = () => {}) {
    onProgress("Carregando banco unificado do servidor local...");
    const res = await fetch("/api/local/database", { cache: "no-store" });
    if (!res.ok) {
      let msg = `Falha HTTP ${res.status}`;
      try {
        const j = await res.json();
        if (j.error) msg = j.error;
      } catch {}
      throw new Error(msg);
    }
    const database = await res.json();
    return { database, fileMap: null, label: this.label };
  }

  async fetchPdf(doc) {
    const rel = doc.caminho_relativo;
    const cached = this.cache.get(rel);
    if (cached) return cached;

    const url = `/api/local/pdf?path=${encodeURIComponent(rel)}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Não foi possível abrir o PDF (${res.status}).`);
    }
    const blob = await res.blob();
    const result = {
      mode: "blob",
      blob,
      name: doc.nome_arquivo,
      directUrl: url,
    };
    this.cache.set(rel, result);
    return result;
  }

  async refresh(onProgress) {
    this.cache.clear();
    return this.loadDatabase(onProgress);
  }
}

export class AppsScriptProvider {
  constructor(webAppUrl, token) {
    this.id = "apps_script";
    this.label = "Google Drive (Ponte Apps Script)";
    this.url = String(webAppUrl || "").trim();
    this.token = String(token || "").trim();
    this.fileMap = {};
    this.cache = new MemoryPdfCache(40);
  }

  async _call(payload) {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ ...payload, token: this.token }),
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`Erro de comunicação com Apps Script (HTTP ${res.status}).`);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error(
        "Resposta inesperada do Apps Script. Verifique se a implantação está publicada para 'Qualquer pessoa' e se a URL termina em /exec."
      );
    }
    if (!data || !data.ok) {
      throw new Error((data && data.error) || "Erro desconhecido na ponte Google Drive.");
    }
    return data;
  }

  async loadDatabase(onProgress = () => {}, forceRefresh = false) {
    onProgress("Autenticando e baixando banco do Google Drive...");
    const res = await this._call({ action: "database", forceRefresh });
    this.fileMap = res.fileMap || {};
    return {
      database: res.database,
      fileMap: this.fileMap,
      pasta: res.pasta || "Google Drive",
      label: `${this.label} · ${res.pasta || "Acervo"}`,
    };
  }

  async fetchPdf(doc) {
    const rel = doc.caminho_relativo;
    const cached = this.cache.get(rel);
    if (cached) return cached;

    const entry = this.fileMap ? this.fileMap[rel] : null;
    const res = await this._call({
      action: "pdf",
      relativePath: rel,
      fileId: entry ? entry.id : "",
    });

    if (res.mode === "drive_link") {
      return {
        mode: "drive_link",
        name: res.name || doc.nome_arquivo,
        size: res.size || doc.tamanho_bytes,
        previewUrl: res.previewUrl,
        downloadUrl: res.downloadUrl,
      };
    }

    const bytes = base64ToUint8Array(res.data);
    const blob = new Blob([bytes], { type: "application/pdf" });
    const result = {
      mode: "blob",
      blob,
      name: res.name || doc.nome_arquivo,
      fileId: res.fileId,
    };
    this.cache.set(rel, result);
    return result;
  }

  async refresh(onProgress) {
    this.cache.clear();
    return this.loadDatabase(onProgress, true);
  }
}

let gisScriptPromise = null;
function loadGisScript() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (!gisScriptPromise) {
    gisScriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client";
      s.async = true;
      s.defer = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Falha ao carregar Google Identity Services."));
      document.head.appendChild(s);
    });
  }
  return gisScriptPromise;
}

export class GoogleOAuthDriveProvider {
  constructor(clientId, folderId) {
    this.id = "google_oauth";
    this.label = "Google Drive API (OAuth 2.0)";
    this.clientId = String(clientId || "").trim();
    this.folderId = String(folderId || "").trim();
    this.accessToken = "";
    this.tokenExpiry = 0;
    this.fileMap = {};
    this.cache = new MemoryPdfCache(40);
  }

  async _ensureToken(promptMode = "consent") {
    if (this.accessToken && Date.now() < this.tokenExpiry - 30000) {
      return this.accessToken;
    }
    await loadGisScript();
    return new Promise((resolve, reject) => {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: "https://www.googleapis.com/auth/drive.readonly",
        callback: (resp) => {
          if (resp.error) {
            reject(new Error(`Autenticação Google recusada: ${resp.error}`));
            return;
          }
          this.accessToken = resp.access_token;
          this.tokenExpiry = Date.now() + Number(resp.expires_in || 3500) * 1000;
          resolve(this.accessToken);
        },
        error_callback: (err) => {
          reject(new Error((err && err.message) || "Erro no login OAuth Google."));
        },
      });
      client.requestAccessToken({ prompt: promptMode });
    });
  }

  async _driveFetch(url, isBinary = false) {
    const token = await this._ensureToken("");
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Google Drive API retornou HTTP ${res.status}.`);
    }
    return isBinary ? res.blob() : res.json();
  }

  async _listChildren(folderId) {
    const items = [];
    let pageToken = "";
    do {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
      const fields = encodeURIComponent("nextPageToken,files(id,name,mimeType,size)");
      const tok = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true${tok}`;
      const data = await this._driveFetch(url, false);
      if (Array.isArray(data.files)) {
        items.push(...data.files);
      }
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return items;
  }

  async _walkAllowed(folderId, prefix, outMap) {
    const children = await this._listChildren(folderId);
    const subWalks = [];
    for (const f of children) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        subWalks.push(this._walkAllowed(f.id, `${prefix}/${f.name}`, outMap));
      } else if (/\.pdf$/i.test(f.name)) {
        outMap[`${prefix}/${f.name}`] = { id: f.id, size: Number(f.size || 0) };
      }
    }
    if (subWalks.length) {
      await Promise.all(subWalks);
    }
  }

  async loadDatabase(onProgress = () => {}) {
    onProgress("Solicitando autorização na sua conta Google...");
    await this._ensureToken("select_account");

    onProgress("Lendo índice e mapeando subpastas no Google Drive...");
    const rootChildren = await this._listChildren(this.folderId);
    const dbEntry = rootChildren.find((f) => f.name === "banco_consulta_bcms.json");
    if (!dbEntry) {
      throw new Error(
        "Arquivo banco_consulta_bcms.json não encontrado na pasta informada do Google Drive."
      );
    }

    const dbBlob = await this._driveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(dbEntry.id)}?alt=media&supportsAllDrives=true`,
      true
    );
    const database = JSON.parse(await dbBlob.text());

    const newMap = {};
    const folderTasks = [];
    for (const item of rootChildren) {
      if (
        item.mimeType === "application/vnd.google-apps.folder" &&
        ALLOWED_DRIVE_FOLDERS.has(item.name)
      ) {
        folderTasks.push(this._walkAllowed(item.id, item.name, newMap));
      }
    }
    await Promise.all(folderTasks);
    this.fileMap = newMap;

    return {
      database,
      fileMap: this.fileMap,
      label: `${this.label} (${Object.keys(newMap).length} PDFs)`,
    };
  }

  async fetchPdf(doc) {
    const rel = doc.caminho_relativo;
    const cached = this.cache.get(rel);
    if (cached) return cached;

    const entry = this.fileMap[rel];
    if (!entry) {
      throw new Error(`Arquivo não localizado no Google Drive: ${rel}`);
    }
    const blob = await this._driveFetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`,
      true
    );
    const result = {
      mode: "blob",
      blob: new Blob([blob], { type: "application/pdf" }),
      name: doc.nome_arquivo,
      fileId: entry.id,
      previewUrl: `https://drive.google.com/file/d/${entry.id}/view`,
    };
    this.cache.set(rel, result);
    return result;
  }

  async refresh(onProgress) {
    this.cache.clear();
    return this.loadDatabase(onProgress);
  }
}

export class LocalFolderProvider {
  constructor() {
    this.id = "local_folder";
    this.label = "Pasta Local (Acervo no PC)";
    this.rootHandle = null;
    this.cache = new MemoryPdfCache(30);
  }

  async pickFolder() {
    if (typeof window.showDirectoryPicker !== "function") {
      throw new Error(
        "Seu navegador não suporta seleção direta de pasta (use Chrome/Edge atual ou iniciar_local.bat)."
      );
    }
    let handle = await window.showDirectoryPicker({ mode: "read" });
    try {
      await handle.getFileHandle("banco_consulta_bcms.json");
    } catch {
      // Caso o usuário tenha escolhido a pasta pai REPO, tenta descer em Acervo-Empenhos-BCMS-2026
      try {
        const sub = await handle.getDirectoryHandle("Acervo-Empenhos-BCMS-2026");
        await sub.getFileHandle("banco_consulta_bcms.json");
        handle = sub;
      } catch {
        throw new Error(
          "O arquivo banco_consulta_bcms.json não foi encontrado nesta pasta. Selecione Acervo-Empenhos-BCMS-2026."
        );
      }
    }
    this.rootHandle = handle;
    return handle;
  }

  async loadDatabase(onProgress = () => {}) {
    if (!this.rootHandle) {
      await this.pickFolder();
    }
    onProgress("Lendo banco_consulta_bcms.json da pasta selecionada...");
    const fh = await this.rootHandle.getFileHandle("banco_consulta_bcms.json");
    const file = await fh.getFile();
    const database = JSON.parse(await file.text());
    return {
      database,
      fileMap: null,
      label: `${this.label} · ${this.rootHandle.name}`,
    };
  }

  async fetchPdf(doc) {
    const rel = doc.caminho_relativo;
    const cached = this.cache.get(rel);
    if (cached) return cached;

    if (!this.rootHandle) {
      throw new Error("Pasta local desconectada.");
    }
    const parts = rel.split("/").filter(Boolean);
    let dir = this.rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1]);
    const file = await fh.getFile();
    const result = {
      mode: "blob",
      blob: new Blob([file], { type: "application/pdf" }),
      name: doc.nome_arquivo,
    };
    this.cache.set(rel, result);
    return result;
  }

  async refresh(onProgress) {
    this.cache.clear();
    return this.loadDatabase(onProgress);
  }
}
