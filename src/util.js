const crypto = require("crypto");

const onlyDigits = (v) => String(v ?? "").replace(/\D/g, "");

/** Normaliza texto para comparação: sem acento, sem pontuação, minúsculo. */
const nk = (t) =>
  String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** "Prefeitura Municipal de Timóteo" e "Timóteo" viram a mesma chave. */
const chavePrefeitura = (nome) =>
  nk(String(nome ?? "").replace(/^\s*(prefeitura\s+municipal\s+de|prefeitura\s+de|munic[ií]pio\s+de)\s+/i, ""));

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function cpfValido(c) {
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const dig = (base, f) => {
    let t = 0;
    for (const d of base) t += Number(d) * f--;
    const r = (t * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dig(c.slice(0, 9), 10);
  const d2 = dig(c.slice(0, 9) + d1, 11);
  return c.endsWith(`${d1}${d2}`);
}

function cnpjValido(c) {
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const dig = (base) => {
    let peso = base.length - 7, soma = 0;
    for (const d of base) {
      soma += Number(d) * peso--;
      if (peso < 2) peso = 9;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = dig(c.slice(0, 12));
  const d2 = dig(c.slice(0, 12) + d1);
  return c.endsWith(`${d1}${d2}`);
}

/** Aceita CPF (11) ou CNPJ (14), só dígitos, com dígito verificador válido. */
const docValido = (d) => (d.length === 11 ? cpfValido(d) : d.length === 14 ? cnpjValido(d) : false);

function maskNome(nome) {
  const p = String(nome || "").trim().split(/\s+/).filter(Boolean);
  if (!p.length) return "";
  return [p[0], ...p.slice(1).map((x) => (x.length > 2 ? x[0].toUpperCase() + "." : x))].join(" ");
}

const sha256 = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(senha, salt, 64).toString("hex")}`;
}
function confereSenha(senha, armazenado) {
  const [salt, hash] = String(armazenado || "").split(":");
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(senha, salt, 64);
  const orig = Buffer.from(hash, "hex");
  return orig.length === calc.length && crypto.timingSafeEqual(orig, calc);
}

/** Data de hoje (AAAA-MM-DD) no fuso de São Paulo. */
function hojeSP(base = new Date()) {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(base);
  return p; // en-CA já formata como AAAA-MM-DD
}

const addDias = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Soma meses mantendo o dia (limitado ao último dia do mês). */
function addMeses(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const alvo = new Date(Date.UTC(y, m - 1 + n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimo));
  return alvo.toISOString().slice(0, 10);
}

const diasEntre = (de, ate) => Math.floor((Date.parse(ate + "T00:00:00Z") - Date.parse(de + "T00:00:00Z")) / 864e5);

const fmtData = (iso) => iso.split("-").reverse().join("/");
const brl = (n) => Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

module.exports = {
  onlyDigits, nk, chavePrefeitura, round2, docValido, cpfValido, cnpjValido, maskNome,
  sha256, randomToken, hashSenha, confereSenha, hojeSP, addDias, addMeses, diasEntre, fmtData, brl,
};
