const crypto = require("crypto");
const jwt = require("jsonwebtoken");

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET não configurado. Defina uma chave longa e secreta nas variáveis de ambiente.");
  }
  SECRET = crypto.randomBytes(32).toString("hex");
  console.warn("[aviso] JWT_SECRET ausente: usando chave temporária (as sessões caem a cada reinício).");
}

const assinarContribuinte = (contribuinteId, prefeituraId) =>
  jwt.sign({ typ: "contribuinte", sub: String(contribuinteId), pid: prefeituraId }, SECRET, { expiresIn: "45m" });

const assinarAdmin = (admin) =>
  jwt.sign({ typ: "admin", sub: String(admin.id), papel: admin.papel, pid: admin.prefeitura_id || null }, SECRET, { expiresIn: "8h" });

function ler(req, tipo) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  try {
    const p = jwt.verify(h.slice(7), SECRET);
    return p.typ === tipo ? p : null;
  } catch {
    return null;
  }
}

function exigeContribuinte(req, res, next) {
  const p = ler(req, "contribuinte");
  if (!p) return res.status(401).json({ erro: "Sessão inválida ou expirada. Abra novamente o link enviado por email." });
  req.contribuinte = { id: Number(p.sub), prefeituraId: p.pid };
  next();
}

function exigeAdmin(req, res, next) {
  const p = ler(req, "admin");
  if (!p) return res.status(401).json({ erro: "Acesso restrito. Entre com seu email e senha." });
  req.admin = { id: Number(p.sub), papel: p.papel, prefeituraId: p.pid };
  next();
}

const exigeSuper = (req, res, next) =>
  req.admin.papel === "super" ? next() : res.status(403).json({ erro: "Somente a equipe Full pode fazer isso." });

/** Admin de prefeitura só enxerga a própria; super enxerga todas. */
const podeAcessarPrefeitura = (admin, prefeituraId) =>
  admin.papel === "super" || Number(admin.prefeituraId) === Number(prefeituraId);

module.exports = { assinarContribuinte, assinarAdmin, exigeContribuinte, exigeAdmin, exigeSuper, podeAcessarPrefeitura };
