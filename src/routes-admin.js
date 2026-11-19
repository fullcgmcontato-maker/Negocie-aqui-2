const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { query, tx, audit } = require("./db");
const U = require("./util");
const { assinarAdmin, exigeAdmin, exigeSuper, podeAcessarPrefeitura } = require("./auth");
const { lerPlanilha } = require("./importer");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const ip = (req) => req.ip || req.socket.remoteAddress || "";

const lLogin = process.env.NODE_ENV === "test"
  ? (q, r, n) => n()
  : rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { erro: "Muitas tentativas. Aguarde 15 minutos." } });

const num = (v, min, max) => {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n >= min && n <= max ? n : NaN;
};

/* ---------------------------------------------------------------- login */
router.post("/login", lLogin, async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const senha = String((req.body && req.body.senha) || "");
  const r = await query("SELECT * FROM admins WHERE email=$1 AND ativo", [email]);
  const a = r.rows[0];
  // confere mesmo sem usuário, para não revelar se o email existe pelo tempo de resposta
  const ok = a ? U.confereSenha(senha, a.senha_hash) : (U.confereSenha(senha, U.hashSenha("x")), false);
  if (!ok) {
    await audit("admin:?", "login_falhou", { email }, ip(req));
    return res.status(401).json({ erro: "Email ou senha incorretos." });
  }
  await audit(`admin:${a.id}`, "login", null, ip(req));
  res.json({ token: assinarAdmin(a), papel: a.papel, prefeituraId: a.prefeitura_id, email: a.email });
});

router.use(exigeAdmin);

/* ---------------------------------------------------------------- prefeituras */
router.get("/prefeituras", async (req, res) => {
  const r = req.admin.papel === "super"
    ? await query("SELECT id, slug, nome, ativo FROM prefeituras ORDER BY nome")
    : await query("SELECT id, slug, nome, ativo FROM prefeituras WHERE id=$1", [req.admin.prefeituraId]);
  res.json(r.rows);
});

router.post("/prefeituras", exigeSuper, async (req, res) => {
  const nome = String((req.body && req.body.nome) || "").trim();
  if (nome.length < 3) return res.status(400).json({ erro: "Informe o nome da prefeitura." });
  const slug = U.chavePrefeitura(nome);
  try {
    const r = await query("INSERT INTO prefeituras (slug, nome, cnpj) VALUES ($1,$2,$3) RETURNING id, slug, nome", [slug, nome, U.onlyDigits(req.body.cnpj) || null]);
    await audit(`admin:${req.admin.id}`, "prefeitura_criada", { id: r.rows[0].id, nome }, ip(req));
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ erro: "Já existe uma prefeitura com este nome." });
    throw e;
  }
});

function guarda(req, res) {
  const id = Number(req.params.id);
  if (!id || !podeAcessarPrefeitura(req.admin, id)) { res.status(403).json({ erro: "Sem permissão para esta prefeitura." }); return null; }
  return id;
}

router.get("/prefeituras/:id", async (req, res) => {
  const id = guarda(req, res); if (!id) return;
  const p = (await query("SELECT * FROM prefeituras WHERE id=$1", [id])).rows[0];
  if (!p) return res.status(404).json({ erro: "Prefeitura não encontrada." });
  const regras = (await query("SELECT codigo, corr, juros, limite FROM regras_tributarias WHERE prefeitura_id=$1 ORDER BY codigo", [id])).rows;
  const { asaas_api_key, ...pub } = p;
  res.json({ ...pub, asaas_configurado: !!asaas_api_key, regras });
});

/** Índices padrão + parcelamento + texto adicional do termo. */
router.put("/prefeituras/:id/config", async (req, res) => {
  const id = guarda(req, res); if (!id) return;
  const b = req.body || {};
  const campos = {
    corr_padrao: num(b.corr_padrao, 0, 100),
    juros_padrao: num(b.juros_padrao, 0, 100),
    limite_padrao: b.limite_padrao === "" || b.limite_padrao == null ? null : num(b.limite_padrao, 0, 1000),
    taxa_parcelamento: num(b.taxa_parcelamento, 0, 100),
    max_parcelas: num(b.max_parcelas, 1, 60),
    dias_1a_parcela: num(b.dias_1a_parcela, 0, 60),
  };
  for (const [k, v] of Object.entries(campos)) {
    if (Number.isNaN(v)) return res.status(400).json({ erro: `Valor inválido em ${k}.` });
  }
  if (campos.corr_padrao === null || campos.juros_padrao === null) return res.status(400).json({ erro: "Correção e juros padrão são obrigatórios." });
  const nome = b.nome !== undefined ? String(b.nome).trim() : null;
  if (nome !== null && nome.length < 3) return res.status(400).json({ erro: "Nome da prefeitura inválido." });

  await query(
    `UPDATE prefeituras SET corr_padrao=$2, juros_padrao=$3, limite_padrao=$4,
        taxa_parcelamento=COALESCE($5, taxa_parcelamento), max_parcelas=COALESCE($6, max_parcelas),
        dias_1a_parcela=COALESCE($7, dias_1a_parcela), nome=COALESCE($8, nome), termo_modelo=$9 WHERE id=$1`,
    [id, campos.corr_padrao, campos.juros_padrao, campos.limite_padrao, campos.taxa_parcelamento, campos.max_parcelas, campos.dias_1a_parcela, nome,
      b.termo_modelo ? String(b.termo_modelo).slice(0, 4000) : null]
  );
  if (req.admin.papel === "super" && typeof b.asaas_api_key === "string" && b.asaas_api_key.trim()) {
    await query("UPDATE prefeituras SET asaas_api_key=$2 WHERE id=$1", [id, b.asaas_api_key.trim()]);
  }
  await audit(`admin:${req.admin.id}`, "config_atualizada", { prefeituraId: id, ...campos }, ip(req));
  res.json({ ok: true });
});

/** Índices por código tributário: substitui a lista inteira. */
router.put("/prefeituras/:id/regras", async (req, res) => {
  const id = guarda(req, res); if (!id) return;
  const lista = Array.isArray(req.body && req.body.regras) ? req.body.regras : null;
  if (!lista || lista.length > 500) return res.status(400).json({ erro: "Lista de regras inválida." });
  const limpas = [];
  const vistos = new Set();
  for (const r of lista) {
    const codigo = String((r && r.codigo) || "").trim();
    if (!codigo) continue;
    const chave = U.nk(codigo);
    if (!chave) return res.status(400).json({ erro: `Código tributário inválido: ${codigo}` });
    if (vistos.has(chave)) return res.status(400).json({ erro: `Código repetido: ${codigo}` });
    vistos.add(chave);
    const corr = num(r.corr, 0, 100), juros = num(r.juros, 0, 100), limite = num(r.limite, 0, 1000);
    if ([corr, juros, limite].some(Number.isNaN)) return res.status(400).json({ erro: `Valor inválido em ${codigo}.` });
    limpas.push({ codigo, chave, corr, juros, limite });
  }
  await tx(async (db) => {
    await db.query("DELETE FROM regras_tributarias WHERE prefeitura_id=$1", [id]);
    for (const r of limpas) {
      await db.query("INSERT INTO regras_tributarias (prefeitura_id, codigo, chave, corr, juros, limite) VALUES ($1,$2,$3,$4,$5,$6)", [id, r.codigo, r.chave, r.corr, r.juros, r.limite]);
    }
  });
  await audit(`admin:${req.admin.id}`, "regras_atualizadas", { prefeituraId: id, qtd: limpas.length }, ip(req));
  res.json({ ok: true, qtd: limpas.length });
});

/* ---------------------------------------------------------------- importação da planilha */
router.post("/importar", (req, res, next) => upload.single("arquivo")(req, res, (e) => (e ? res.status(400).json({ erro: "Arquivo inválido ou maior que 15 MB." }) : next())), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: "Envie a planilha (.xlsx ou .csv)." });
  const modo = req.body.modo === "somar" ? "somar" : "substituir";
  const prefId = req.body.prefeituraId ? Number(req.body.prefeituraId) : null;
  if (prefId && !podeAcessarPrefeitura(req.admin, prefId)) return res.status(403).json({ erro: "Sem permissão para esta prefeitura." });

  const lido = await lerPlanilha(req.file.buffer, req.file.originalname || "planilha.xlsx");
  if (lido.erro) return res.status(400).json({ erro: lido.erro });

  const todas = (await query("SELECT id, slug, nome FROM prefeituras WHERE ativo")).rows;
  const porChave = new Map();
  todas.forEach((p) => { porChave.set(p.slug, p); porChave.set(U.chavePrefeitura(p.nome), p); });

  // Admin de prefeitura: tudo vai para a própria prefeitura. Super: escolhida na tela ou lida da coluna.
  const fixa = req.admin.papel === "prefeitura" ? todas.find((p) => p.id === req.admin.prefeituraId) : prefId ? todas.find((p) => p.id === prefId) : null;
  const erros = [...lido.erros];
  const aceitos = [];
  for (const it of lido.itens) {
    let p = fixa;
    if (!p) {
      p = it.prefeitura ? porChave.get(U.chavePrefeitura(it.prefeitura)) : null;
      if (!p) { erros.push({ linha: it.linha, motivo: it.prefeitura ? `Prefeitura "${it.prefeitura}" não cadastrada` : "Prefeitura não informada (escolha uma na tela ou preencha a coluna)" }); continue; }
    }
    aceitos.push({ ...it, pref: p });
  }
  if (!aceitos.length) return res.status(400).json({ erro: "Nenhuma linha válida para importar.", erros: erros.slice(0, 50), colunas: lido.colunas });

  const alvo = new Map();
  aceitos.forEach((a) => alvo.set(a.pref.id, a.pref.nome));

  const resumo = await tx(async (db) => {
    const imp = (await db.query("INSERT INTO importacoes (admin_id, arquivo, linhas_ok, linhas_erro, erros, prefeituras) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [req.admin.id, String(req.file.originalname || "").slice(0, 200), aceitos.length, erros.length, JSON.stringify(erros.slice(0, 200)), JSON.stringify([...alvo.values()])])).rows[0];

    if (modo === "substituir") {
      // só remove o que ainda está em aberto; negociados/pagos permanecem como histórico
      await db.query("DELETE FROM debitos WHERE prefeitura_id = ANY($1::int[]) AND status='aberto'", [[...alvo.keys()]]);
    }
    const cache = new Map();
    for (const a of aceitos) {
      let cid = cache.get(a.doc);
      if (!cid) {
        const c = await db.query(
          `INSERT INTO contribuintes (doc, nome, endereco) VALUES ($1,$2,$3)
           ON CONFLICT (doc) DO UPDATE SET nome=COALESCE(contribuintes.nome, EXCLUDED.nome), endereco=COALESCE(NULLIF(contribuintes.endereco,''), EXCLUDED.endereco)
           RETURNING id`, [a.doc, a.nome, a.endereco || null]);
        cid = c.rows[0].id; cache.set(a.doc, cid);
      }
      await db.query(
        "INSERT INTO debitos (prefeitura_id, contribuinte_id, codigo, descricao, valor_original, vencimento, encargos_fixos, importacao_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [a.pref.id, cid, a.codigo, a.descricao, a.original, a.vencimento, a.encargosFixos, imp.id]);
    }
    return { importacaoId: imp.id, contribuintes: cache.size };
  });

  await audit(`admin:${req.admin.id}`, "importacao", { ...resumo, ok: aceitos.length, erros: erros.length, modo, prefeituras: [...alvo.values()] }, ip(req));
  res.json({
    ok: true, modo, linhasOk: aceitos.length, linhasErro: erros.length, contribuintes: resumo.contribuintes,
    prefeituras: [...alvo.values()], colunas: lido.colunas, erros: erros.slice(0, 50),
  });
});

/* ---------------------------------------------------------------- acompanhamento */
router.get("/resumo", async (req, res) => {
  const filtro = req.admin.papel === "super" ? null : req.admin.prefeituraId;
  const r = await query(
    `SELECT p.id, p.nome,
        (SELECT count(*) FROM debitos d WHERE d.prefeitura_id=p.id AND d.status='aberto')::int AS debitos_abertos,
        (SELECT count(*) FROM negociacoes n WHERE n.prefeitura_id=p.id)::int AS negociacoes,
        (SELECT COALESCE(sum(valor_total),0) FROM negociacoes n WHERE n.prefeitura_id=p.id)::float AS valor_negociado,
        (SELECT COALESCE(sum(pc.valor),0) FROM parcelas pc JOIN negociacoes n ON n.id=pc.negociacao_id WHERE n.prefeitura_id=p.id AND pc.status='pago')::float AS valor_recebido
       FROM prefeituras p WHERE p.ativo AND ($1::int IS NULL OR p.id=$1) ORDER BY p.nome`, [filtro]);
  res.json(r.rows);
});

router.get("/negociacoes", async (req, res) => {
  const filtro = req.admin.papel === "super" ? (req.query.prefeituraId ? Number(req.query.prefeituraId) : null) : req.admin.prefeituraId;
  const r = await query(
    `SELECT n.protocolo, n.status, n.qtd_parcelas, n.valor_total::float AS valor_total, n.metodo, n.aceite_em, p.nome AS prefeitura, c.nome AS contribuinte, c.doc,
        (SELECT count(*) FROM parcelas x WHERE x.negociacao_id=n.id AND x.status='pago')::int AS pagas
       FROM negociacoes n JOIN prefeituras p ON p.id=n.prefeitura_id JOIN contribuintes c ON c.id=n.contribuinte_id
      WHERE ($1::int IS NULL OR n.prefeitura_id=$1) ORDER BY n.id DESC LIMIT 200`, [filtro]);
  res.json(r.rows);
});

/* ---------------------------------------------------------------- usuários (somente equipe Full) */
router.post("/usuarios", exigeSuper, async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const senha = String((req.body && req.body.senha) || "");
  const papel = req.body.papel === "super" ? "super" : "prefeitura";
  const prefeituraId = papel === "prefeitura" ? Number(req.body.prefeituraId) : null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ erro: "Email inválido." });
  if (senha.length < 10) return res.status(400).json({ erro: "A senha deve ter pelo menos 10 caracteres." });
  if (papel === "prefeitura" && !prefeituraId) return res.status(400).json({ erro: "Escolha a prefeitura do usuário." });
  try {
    const r = await query("INSERT INTO admins (email, senha_hash, papel, prefeitura_id) VALUES ($1,$2,$3,$4) RETURNING id", [email, U.hashSenha(senha), papel, prefeituraId]);
    await audit(`admin:${req.admin.id}`, "usuario_criado", { id: r.rows[0].id, papel, prefeituraId }, ip(req));
    res.status(201).json({ id: r.rows[0].id });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ erro: "Já existe um usuário com este email." });
    throw e;
  }
});

module.exports = router;
