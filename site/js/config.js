// Utilitários de formatação financeira exata (centavos inteiros), LGPD e sanitização.

export const APP_PUBLIC_CONFIG = {
  // Opcional: o proprietário pode preencher apenas valores NÃO-SECRETOS abaixo
  // caso queira que a URL do Apps Script ou Folder ID já apareça preenchida.
  defaultAppsScriptUrl: "",
  defaultOAuthClientId: "",
  defaultDriveFolderId: "",
};

const BRL_FORMATTER = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

export function formatBRL(centavos) {
  const num = Number(centavos || 0);
  if (!Number.isFinite(num) || num === 0) {
    return BRL_FORMATTER.format(0);
  }
  const reais = Math.round(num) / 100;
  return BRL_FORMATTER.format(Object.is(reais, -0) ? 0 : reais);
}

export function formatNumberBR(valor) {
  if (valor === null || valor === undefined || valor === "") return "—";
  const s = String(valor).trim();
  const n = Number(s.replace(",", "."));
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString("pt-BR", { maximumFractionDigits: 5 });
}

export function formatBytes(bytes) {
  const b = Number(bytes || 0);
  if (!b) return "0 B";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1).replace(".", ",")} KB`;
  return `${(b / (1024 * 1024)).toFixed(2).replace(".", ",")} MB`;
}

export function formatDocumento(docFmt, tipo, mascararCpf = true) {
  if (!docFmt) return "—";
  if (tipo === "CPF" && mascararCpf) {
    const dig = String(docFmt).replace(/\D/g, "");
    if (dig.length === 11) {
      return `***.${dig.slice(3, 6)}.${dig.slice(6, 9)}-**`;
    }
  }
  return docFmt;
}

export function normalizarTexto(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(texto) {
  return String(texto ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizeCsvCell(valor) {
  let s = String(valor ?? "").replace(/\r?\n/g, " ");
  if (/^[=+\-@\t\r]/.test(s)) {
    s = "'" + s;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

export function triggerBlobDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 1500);
}

export function encodeAccessPayload(url, token) {
  const u = String(url || "").trim();
  const t = String(token || "").trim();
  const jsonBytes = new TextEncoder().encode(JSON.stringify({ u, t }));
  let bin = "";
  for (let i = 0; i < jsonBytes.length; i++) {
    bin += String.fromCharCode(jsonBytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeAccessPayload(hashString) {
  const rawHash = String(hashString || "").trim().replace(/^#/, "");
  if (!rawHash) return null;
  const params = new URLSearchParams(rawHash);
  const encoded = params.get("acesso") || (rawHash.startsWith("acesso=") ? rawHash.slice(7) : "");
  if (!encoded) return null;
  try {
    let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed.u !== "string" || typeof parsed.t !== "string") {
      return null;
    }
    const u = parsed.u.trim();
    const t = parsed.t.trim();
    if (!u.startsWith("https://script.google.com/") || !t) {
      return null;
    }
    return { u, t };
  } catch {
    return null;
  }
}
