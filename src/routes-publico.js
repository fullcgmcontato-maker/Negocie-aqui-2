const express = require("express");
const rateLimit = require("express-rate-limit");
const { query, tx, audit } = require("./db");
const U = require("./util");
const { assinarContribuinte, exigeContribuinte } = require("./auth");
const N = require("./negocio");
const { cronograma } = require("./calc");
const { montarTermo } = require("./termo");
const { criarCobranca } = require("./payments");
const { enviarEmail, enviarWhatsapp, emailAcesso } = require("./notify");

const router = express.Router();

const ip = (req) => req.ip || req.socket.remoteAddress || "";
const limite = (max, janelaMin, msg, chave) =>
  rateLimit({
    windowMs: janelaMin * 60 * 1000,
    limit: max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: chave || ((req) => req.ip),
    message: { erro: msg },
    validate: { keyGeneratorIpFallback: false },
  });

const emTeste = process.env.NODE_ENV === "test";
const lConsulta = emTeste ? (q, r, n) => n() : limite(30, 15, "Muitas consultas. Tente novamente em alguns minutos.");
const lCadastro = emTeste ? (q, r, n) => n() : limite(10, 15, "Muitas tentativas de cadastro. Tente novamente em alguns minutos.");
const lKaren = emTeste ? (q, r, n) => n() : limite(30, 15, "Muitas mensagens. Aguarde alguns minutos.");

const emailMascarado = (e) => e.replace(/^(.).*(@.*)$/, "$1•••$2");
const APP_URL = () => (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");

/* ---------------------------------------------------------------- consulta */
router.post("/consulta", lConsulta, async (req, res) => {
  const doc = U.onlyDigits(req.body && req.body.doc);
  if (!U.docValido(doc)) return res.status(400).json({ erro: "CPF ou CNPJ inválido. Confira os números digitados." });

  const c = await query("SELECT id, nome FROM contribuintes WHERE doc=$1", [doc]);
  if (!c.rows.length) return res.json({ encontrado: false });
  const cid = c.rows[0].id;

  const prefs = await query(
    `SELECT DISTINCT p.* FROM debitos d JOIN prefeituras p ON p.id=d.prefeitura_id
      WHERE d.contribuinte_id=$1 AND d.status='aberto' AND p.ativo ORDER BY p.nome`,
    [cid]
  );
  if (!prefs.rows.length) return res.json({ encontrado: false });

  const hoje = U.hojeSP();
  const lista = [];
  for (const p of prefs.rows) {
    const regras = await N.carregarRegras(p.id);
    const deb = await N.debitosAbertos(cid, p.id);
    lista.push({ id: p.id, nome: p.nome, total: N.consolidar(deb, regras, p, hoje).consolidado });
  }
  await audit(`contribuinte:${cid}`, "consulta", { prefeituras: lista.map((x) => x.id) }, ip(req));
  res.json({ encontrado: true, nome: U.maskNome(c.rows[0].nome), prefeituras: lista });
});

/* ---------------------------------------------------------------- cadastro + link de acesso */
router.post("/cadastro", lCadastro, async (req, res) => {
  const b = req.body || {};
  const doc = U.onlyDigits(b.doc);
  const nome = String(b.nome || "").trim();
  const endereco = String(b.endereco || "").trim();
  const email = String(b.email || "").trim().toLowerCase();
  const whatsapp = U.onlyDigits(b.whatsapp);
  const prefeituraId = Number(b.prefeituraId);

  if (!U.docValido(doc) || !prefeituraId) return res.status(400).json({ erro: "Dados inválidos." });
  if (nome.length < 3) return res.status(400).json({ erro: "Informe o nome completo." });
  if (endereco.length < 5) return res.status(400).json({ erro: "Informe o endereço de contato." });
  if (whatsapp.length < 10 || whatsapp.length > 13) return res.status(400).json({ erro: "Informe um WhatsApp válido, com DDD." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ erro: "Informe um email válido." });
  if (b.consentimento !== true) return res.status(400).json({ erro: "É necessário aceitar o uso dos seus dados para continuar." });

  const r = await query(
    `SELECT c.id FROM contribuintes c WHERE c.doc=$1 AND EXISTS
       (SELECT 1 FROM debitos d WHERE d.contribuinte_id=c.id AND d.prefeitura_id=$2 AND d.status='aberto')`,
    [doc, prefeituraId]
  );
  if (!r.rows.length) return res.status(404).json({ erro: "Não encontramos débito em aberto para este documento nesta prefeitura." });
  const cid = r.rows[0].id;
  const pref = await N.carregarPrefeitura(prefeituraId);
  if (!pref) return res.status(404).json({ erro: "Prefeitura indisponível." });

  await query("UPDATE contribuintes SET nome=$2, endereco=$3, email=$4, whatsapp=$5 WHERE id=$1", [cid, nome, endereco, email, whatsapp]);

  const token = U.randomToken(32);
  const minutos = Number(process.env.ACESSO_MIN || 30);
  await query(
    "INSERT INTO acessos (contribuinte_id, prefeitura_id, token_hash, expira_em) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)",
    [cid, prefeituraId, U.sha256(token), String(minutos)]
  );
  const link = `${APP_URL()}/?acesso=${token}`;
  try {
    await enviarEmail(email, "Seu acesso ao Negocie Aqui", emailAcesso(link, pref.nome));
  } catch (e) {
    console.error("falha ao enviar email de acesso:", e.message);
    return res.status(502).json({ erro: "Não foi possível enviar o email agora. Tente novamente em instantes." });
  }
  await audit(`contribuinte:${cid}`, "cadastro", { prefeituraId }, ip(req));

  const resp = { enviado: true, email: emailMascarado(email) };
  // SOMENTE para demonstração/homologação sem email configurado:
  if (process.env.MOSTRAR_LINK_DE_ACESSO === "true") resp.linkDemonstracao = link;
  res.json(resp);
});

/* ---------------------------------------------------------------- troca do link por sessão */
router.get("/acesso/:token", lCadastro, async (req, res) => {
  const hash = U.sha256(req.params.token);
  const r = await query(
    `UPDATE acessos SET usado=TRUE WHERE token_hash=$1 AND NOT usado AND expira_em > now()
      RETURNING contribuinte_id, prefeitura_id`,
    [hash]
  );
  if (!r.rows.length) return res.status(401).json({ erro: "Link inválido, já utilizado ou expirado. Faça o cadastro novamente para receber outro." });
  const { contribuinte_id: cid, prefeitura_id: pid } = r.rows[0];
  const pref = await N.carregarPrefeitura(pid);
  await audit(`contribuinte:${cid}`, "acesso", { prefeituraId: pid }, ip(req));
  res.json({ token: assinarContribuinte(cid, pid), prefeitura: { id: pid, nome: pref.nome } });
});

/* ---------------------------------------------------------------- área do contribuinte */
async function contexto(req) {
  const { id: cid, prefeituraId: pid } = req.contribuinte;
  const pref = await N.carregarPrefeitura(pid);
  const regras = await N.carregarRegras(pid);
  const c = (await query("SELECT * FROM contribuintes WHERE id=$1", [cid])).rows[0];
  return { cid, pid, pref, regras, c };
}

router.get("/debito", exigeContribuinte, async (req, res) => {
  const { cid, pid, pref, regras, c } = await contexto(req);
  const hoje = U.hojeSP();
  const deb = await N.debitosAbertos(cid, pid);
  if (!deb.length) return res.status(404).json({ erro: "Nenhum débito em aberto." });
  const { linhas, consolidado } = N.consolidar(deb, regras, pref, hoje);
  res.json({
    prefeitura: { id: pref.id, nome: pref.nome },
    contribuinte: { nome: c.nome, doc: c.doc },
    hoje,
    linhas,
    consolidado,
    opcoes: N.opcoesParcelamento(consolidado, pref),
    primeiraParcelaEm: U.addDias(hoje, pref.dias_1a_parcela),
  });
});

function lerParametros(req, pref) {
  const n = Number(req.body && req.body.parcelas);
  const metodo = req.body && req.body.metodo;
  if (!Number.isInteger(n) || n < 1 || n > pref.max_parcelas) return { erro: `Escolha entre 1 e ${pref.max_parcelas} parcelas.` };
  if (metodo !== "pix" && metodo !== "boleto") return { erro: "Escolha Pix ou boleto." };
  return { n, metodo };
}

/** Pré-visualização do termo (não grava nada). */
router.post("/termo", exigeContribuinte, async (req, res) => {
  const { cid, pid, pref, regras, c } = await contexto(req);
  const p = lerParametros(req, pref);
  if (p.erro) return res.status(400).json({ erro: p.erro });
  const hoje = U.hojeSP();
  const deb = await N.debitosAbertos(cid, pid);
  if (!deb.length) return res.status(404).json({ erro: "Nenhum débito em aberto." });
  const { linhas, consolidado } = N.consolidar(deb, regras, pref, hoje);
  const op = N.opcoesParcelamento(consolidado, pref)[p.n - 1];
  const parcelas = cronograma(op.total, p.n, hoje, pref.dias_1a_parcela);
  const termo = montarTermo({ pref, contribuinte: c, debitos: linhas, consolidado, total: op.total, parcelas, hoje, metodo: p.metodo });
  res.json({ partes: termo.partes, total: op.total, valorParcela: op.valorParcela });
});

/** Confirma: recalcula tudo no servidor, registra o aceite (assinatura eletrônica) e gera a 1ª cobrança. */
router.post("/negociacao", exigeContribuinte, async (req, res) => {
  const { cid, pid, pref, regras, c } = await contexto(req);
  const p = lerParametros(req, pref);
  if (p.erro) return res.status(400).json({ erro: p.erro });
  if (!req.body || req.body.aceite !== true) return res.status(400).json({ erro: "É necessário aceitar o termo de confissão de dívida." });
  if (!c.email || !c.whatsapp) return res.status(400).json({ erro: "Cadastro incompleto." });

  const hoje = U.hojeSP();
  let resultado;
  try {
    resultado = await tx(async (db) => {
      const deb = await N.debitosAbertos(cid, pid, db, true);
      if (!deb.length) { const e = new Error("Nenhum débito em aberto."); e.http = 409; throw e; }
      const { linhas, consolidado } = N.consolidar(deb, regras, pref, hoje);
      const op = N.opcoesParcelamento(consolidado, pref)[p.n - 1];
      const parcelas = cronograma(op.total, p.n, hoje, pref.dias_1a_parcela);
      const termo = montarTermo({ pref, contribuinte: c, debitos: linhas, consolidado, total: op.total, parcelas, hoje, metodo: p.metodo });

      const agora = new Date();
      const d = new Date();
      let protocolo;
      for (let t = 0; t < 5; t++) {
        const cand = `NA-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}-${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
        const ex = await db.query("SELECT 1 FROM negociacoes WHERE protocolo=$1", [cand]);
        if (!ex.rows.length) { protocolo = cand; break; }
      }
      if (!protocolo) throw new Error("não foi possível gerar protocolo");
      const codigoAut = U.sha256(`${termo.hash}|${protocolo}|${agora.toISOString()}`).slice(0, 12).toUpperCase();

      const neg = (await db.query(
        `INSERT INTO negociacoes (protocolo, prefeitura_id, contribuinte_id, qtd_parcelas, valor_consolidado, valor_total, data_calculo, metodo,
                                  termo_texto, termo_hash, codigo_autenticacao, aceite_em, aceite_ip, aceite_agente)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
        [protocolo, pid, cid, p.n, consolidado, op.total, hoje, p.metodo, termo.texto, termo.hash, codigoAut, agora, ip(req), String(req.headers["user-agent"] || "").slice(0, 300)]
      )).rows[0];

      for (const l of linhas) {
        await db.query(
          "INSERT INTO negociacao_debitos (negociacao_id, debito_id, descricao, original, correcao, juros, dias) VALUES ($1,$2,$3,$4,$5,$6,$7)",
          [neg.id, l.id, l.descricao, l.original, l.correcao, l.juros, l.dias]
        );
      }
      await db.query("UPDATE debitos SET status='negociado' WHERE id = ANY($1::int[])", [linhas.map((l) => l.id)]);

      let primeira;
      for (const pc of parcelas) {
        const ins = await db.query("INSERT INTO parcelas (negociacao_id, numero, valor, vencimento) VALUES ($1,$2,$3,$4) RETURNING id", [neg.id, pc.numero, pc.valor, pc.vencimento]);
        if (pc.numero === 1) primeira = { id: ins.rows[0].id, ...pc };
      }

      // 1ª cobrança no gateway; se falhar, a transação inteira é desfeita (nada fica pela metade).
      let cobranca;
      try {
        cobranca = await criarCobranca({
          pref, contribuinte: c, valor: primeira.valor, vencimento: primeira.vencimento, metodo: p.metodo,
          descricao: `Parcelamento ${protocolo} – parcela 1/${p.n}`, referencia: `${protocolo}-1`,
        });
      } catch (e) {
        console.error("falha no gateway:", e.message);
        const err = new Error("Não foi possível gerar a cobrança agora. Nada foi registrado; tente novamente em instantes.");
        err.http = 502;
        throw err;
      }
      await db.query("UPDATE parcelas SET gateway_id=$2, linha_digitavel=$3, pix_copia_cola=$4, link_fatura=$5 WHERE id=$1",
        [primeira.id, cobranca.id, cobranca.linhaDigitavel, cobranca.pixCopiaCola, cobranca.link]);

      return { protocolo, codigoAut, agora, primeira, cobranca, total: op.total, n: p.n, termoHash: termo.hash };
    });
  } catch (e) {
    if (e.http) return res.status(e.http).json({ erro: e.message });
    console.error(e);
    return res.status(500).json({ erro: "Erro ao registrar a negociação." });
  }

  await audit(`contribuinte:${cid}`, "negociacao", { protocolo: resultado.protocolo, parcelas: p.n, metodo: p.metodo }, ip(req));

  // Avisos (email e WhatsApp). Falha aqui não desfaz a negociação.
  const { primeira, cobranca } = resultado;
  const venc = U.fmtData(primeira.vencimento);
  const detalhe = p.metodo === "boleto"
    ? `Boleto da 1ª parcela (${U.brl(primeira.valor)}), vencimento ${venc}.${cobranca.linhaDigitavel ? `\nLinha digitável: ${cobranca.linhaDigitavel}` : ""}${cobranca.link ? `\nBoleto: ${cobranca.link}` : ""}`
    : `Pix da 1ª parcela (${U.brl(primeira.valor)}), vencimento ${venc}.${cobranca.pixCopiaCola ? `\nPix copia e cola: ${cobranca.pixCopiaCola}` : ""}`;
  const texto = `${pref.nome} – Negocie Aqui\nProtocolo ${resultado.protocolo}\n${detalhe}`;
  enviarEmail(c.email, `Negociação ${resultado.protocolo} – ${p.metodo === "boleto" ? "seu boleto" : "seu Pix"}`, `<pre style="font-family:inherit;white-space:pre-wrap">${require("./notify").esc(texto)}</pre>`).catch((e) => console.error("email:", e.message));
  enviarWhatsapp(c.whatsapp, texto).catch((e) => console.error("whatsapp:", e.message));

  res.json({
    protocolo: resultado.protocolo,
    codigoAutenticacao: resultado.codigoAut,
    aceiteEm: resultado.agora.toISOString(),
    parcelas: resultado.n,
    total: resultado.total,
    cobranca: {
      metodo: p.metodo,
      parcela: 1,
      valor: primeira.valor,
      vencimento: primeira.vencimento,
      linhaDigitavel: cobranca.linhaDigitavel,
      pixCopiaCola: cobranca.pixCopiaCola,
      link: cobranca.link,
      simulado: !!cobranca.simulado,
    },
    enviadoPara: { email: emailMascarado(c.email), whatsapp: c.whatsapp.replace(/^(\d{2})\d+(\d{2})$/, "($1) •••••-••$2") },
  });
});

/** Acompanhamento da negociação (status e parcelas). */
router.get("/negociacao/:protocolo", exigeContribuinte, async (req, res) => {
  const n = await query("SELECT * FROM negociacoes WHERE protocolo=$1 AND contribuinte_id=$2", [req.params.protocolo, req.contribuinte.id]);
  if (!n.rows.length) return res.status(404).json({ erro: "Negociação não encontrada." });
  const parcelas = await query(
    "SELECT id, numero, valor, vencimento, status, linha_digitavel, pix_copia_cola, link_fatura FROM parcelas WHERE negociacao_id=$1 ORDER BY numero",
    [n.rows[0].id]
  );
  const x = n.rows[0];
  res.json({ protocolo: x.protocolo, status: x.status, total: x.valor_total, parcelas: parcelas.rows, codigoAutenticacao: x.codigo_autenticacao });
});

/* ---------------------------------------------------------------- Karen (assistente) */
router.post("/karen", lKaren, async (req, res) => {
  const msg = String((req.body && req.body.mensagem) || "").slice(0, 500).trim();
  if (!msg) return res.status(400).json({ erro: "Escreva sua dúvida." });
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return res.json({ resposta: "No momento só consigo orientar os passos da tela. Para outras dúvidas, procure o setor de tributos da prefeitura." });

  const hist = Array.isArray(req.body.historico) ? req.body.historico.slice(-8) : [];
  const mensagens = [];
  for (const h of hist) {
    const role = h && h.r === "u" ? "user" : "assistant";
    const content = String((h && h.t) || "").slice(0, 600);
    if (!content) continue;
    if (mensagens.length && mensagens[mensagens.length - 1].role === role) mensagens[mensagens.length - 1].content += "\n" + content;
    else mensagens.push({ role, content });
  }
  while (mensagens.length && mensagens[0].role !== "user") mensagens.shift();
  if (mensagens.length && mensagens[mensagens.length - 1].role === "user") mensagens[mensagens.length - 1].content += "\n" + msg;
  else mensagens.push({ role: "user", content: msg });

  // Nenhum dado pessoal (nome, CPF, valores) é enviado à IA: só a tela atual.
  const sistema =
    `Você é a Karen, assistente virtual do Negocie Aqui, portal de negociação de débitos municipais. ` +
    `Responda em português do Brasil, em no máximo 3 frases, de forma simples e acolhedora. ` +
    `Oriente o contribuinte no passo atual (tela: ${String(req.body.tela || "").slice(0, 30)}) e tire dúvidas gerais sobre negociar débitos com a prefeitura. ` +
    `Você não conhece valores, nomes nem documentos do contribuinte; nunca invente. ` +
    `Se perguntarem algo jurídico específico ou sobre valores, oriente a procurar o setor de tributos da prefeitura.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": chave, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: process.env.KAREN_MODEL || "claude-haiku-5-5", max_tokens: 300, system: sistema, messages: mensagens }),
    });
    if (!r.ok) throw new Error("IA respondeu " + r.status);
    const d = await r.json();
    const txt = (d.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();
    res.json({ resposta: txt || "Desculpe, não consegui responder agora." });
  } catch (e) {
    console.error("karen:", e.message);
    res.json({ resposta: "Tive um problema para responder agora. Tente de novo em instantes." });
  }
});

/* ---------------------------------------------------------------- webhook do gateway */
router.post("/webhooks/asaas", async (req, res) => {
  const esperado = process.env.ASAAS_WEBHOOK_TOKEN;
  const recebido = req.headers["asaas-access-token"];
  if ((!esperado && process.env.NODE_ENV !== "test") || recebido !== (esperado || "teste")) return res.status(401).json({ erro: "não autorizado" });

  const ev = req.body && req.body.event;
  const pid = req.body && req.body.payment && req.body.payment.id;
  if (!pid) return res.json({ ok: true });
  const pago = ev === "PAYMENT_RECEIVED" || ev === "PAYMENT_CONFIRMED";
  const vencido = ev === "PAYMENT_OVERDUE";
  if (!pago && !vencido) return res.json({ ok: true });

  const r = await query("SELECT id, negociacao_id FROM parcelas WHERE gateway_id=$1", [pid]);
  if (!r.rows.length) return res.json({ ok: true });
  const { id, negociacao_id: nid } = r.rows[0];

  await tx(async (db) => {
    if (pago) await db.query("UPDATE parcelas SET status='pago', pago_em=COALESCE(pago_em, now()) WHERE id=$1", [id]);
    else await db.query("UPDATE parcelas SET status='atrasado' WHERE id=$1 AND status='pendente'", [id]);
    const pend = await db.query("SELECT count(*)::int AS n FROM parcelas WHERE negociacao_id=$1 AND status<>'pago'", [nid]);
    if (pago && pend.rows[0].n === 0) {
      await db.query("UPDATE negociacoes SET status='quitado' WHERE id=$1", [nid]);
      await db.query("UPDATE debitos SET status='pago' WHERE id IN (SELECT debito_id FROM negociacao_debitos WHERE negociacao_id=$1)", [nid]);
    } else if (vencido) {
      await db.query("UPDATE negociacoes SET status='inadimplente' WHERE id=$1 AND status='ativo'", [nid]);
    }
  });
  await audit("sistema", "webhook_" + ev, { gatewayId: pid });
  res.json({ ok: true });
});

module.exports = router;
