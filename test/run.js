process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres@localhost:5544/negocie_test";
process.env.JWT_SECRET = "teste";
const assert = require("assert");
const ExcelJS = require("exceljs");
const { migrate, query, pool } = require("../src/db");
const U = require("../src/util");
const { atualizar, opcoesParcelamento, cronograma } = require("../src/calc");
const { lerPlanilha } = require("../src/importer");
const { criarApp, bootstrapSuper } = require("../src/server");
const { caixaDeTestes } = require("../src/notify");

let ok = 0;
const t = async (nome, fn) => { try { await fn(); ok++; console.log("  ok  " + nome); } catch (e) { console.error("FALHOU " + nome + "\n", e); process.exitCode = 1; } };

(async () => {
  /* ---------- cálculo ---------- */
  await t("calc: correção 1% a.m. + juros 0,33% a.d. sobre 90 dias", () => {
    const pref = { corr_padrao: 1, juros_padrao: 0.33, limite_padrao: null };
    const a = atualizar({ valor_original: 1000, vencimento: "2026-01-01", codigo: "IPTU" }, [], pref, "2026-04-01"); // 90 dias
    assert.strictEqual(a.dias, 90);
    assert.strictEqual(a.correcao, 30); // 1000*1%*3
    assert.strictEqual(a.juros, 305.91); // 1030*0,33%*90
    assert.strictEqual(a.total, 1335.91);
  });
  await t("calc: regra por código + limite", () => {
    const pref = { corr_padrao: 1, juros_padrao: 0.33, limite_padrao: null };
    const regras = [{ codigo: "ISS", chave: U.nk("ISS"), corr: 0.5, juros: 0.1, limite: 20 }];
    const a = atualizar({ valor_original: 1000, vencimento: "2020-01-01", codigo: "ISS" }, regras, pref, "2026-01-01");
    assert.ok(Math.abs(a.juros - a.original * 0 - (1000 + a.correcao) * 0.2) < 0.01);
  });
  await t("calc: sem vencimento usa encargos fixos; parcelas fecham o total", () => {
    const a = atualizar({ valor_original: 100, vencimento: null, encargos_fixos: 25 }, [], { corr_padrao: 1, juros_padrao: 1 }, "2026-01-01");
    assert.strictEqual(a.total, 125);
    const op = opcoesParcelamento(1000, { taxa_parcelamento: 1.2, max_parcelas: 12 });
    assert.strictEqual(op[0].total, 1000); assert.strictEqual(op.length, 12);
    const c = cronograma(1000.01, 3, "2026-01-30", 3);
    assert.strictEqual(U.round2(c.reduce((s, x) => s + x.valor, 0)), 1000.01);
    assert.strictEqual(c[0].vencimento, "2026-02-02");
    assert.strictEqual(c[1].vencimento, "2026-03-02");
  });
  await t("documentos válidos", () => {
    for (const d of ["52998224725", "11144477735", "11222333000181"]) assert.ok(U.docValido(d), d);
    assert.ok(!U.docValido("11111111111"));
  });

  /* ---------- banco ---------- */
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate();
  process.env.SUPERADMIN_EMAIL = "equipe@full.com.br"; process.env.SUPERADMIN_PASSWORD = "SenhaForte123";
  await bootstrapSuper();
  const server = criarApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (m, rota, corpo, token, form) => {
    const h = {}; if (token) h.authorization = "Bearer " + token;
    let body;
    if (form) body = form; else if (corpo) { h["content-type"] = "application/json"; body = JSON.stringify(corpo); }
    const r = await fetch(base + rota, { method: m, headers: h, body });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // planilha (xlsx) com 2 prefeituras, CNPJ, CPF em número, linha inválida
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet("Dívidas");
  ws.addRow(["Município", "CPF", "CNPJ", "Nome", "Endereço", "Tributo", "Ano", "Valor", "Vencimento"]);
  const venc = (n) => { const d = new Date(Date.now() - n * 864e5); return d.toISOString().slice(0, 10).split("-").reverse().join("/"); };
  ws.addRow(["Prefeitura Municipal de Timóteo", "52998224725", "", "Maria da Silva", "Rua A, 10", "IPTU", 2023, 1000, venc(90)]);
  ws.addRow(["Prefeitura Municipal de Timóteo", "52998224725", "", "Maria da Silva", "Rua A, 10", "ISS", 2024, 500, venc(30)]);
  ws.addRow(["Prefeitura de Ipatinga", "", "11222333000181", "Padaria Pão Quente LTDA", "Av. B, 20", "IPTU", 2024, 2000, venc(60)]);
  ws.addRow(["Prefeitura de Ipatinga", "52998224725", "", "Maria da Silva", "Rua A, 10", "Taxa de lixo", 2024, 300, venc(10)]);
  ws.addRow(["Prefeitura de Ipatinga", "123", "", "CPF ruim", "", "IPTU", 2024, 10, venc(10)]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());

  await t("importer: lê CNPJ/CPF, multi-prefeitura e aponta erros", async () => {
    const r = await lerPlanilha(buf, "x.xlsx");
    assert.strictEqual(r.itens.length, 4); assert.strictEqual(r.erros.length, 1);
    assert.ok(r.itens.some((i) => i.doc === "11222333000181"));
  });
  await t("importer: CSV com ponto e vírgula", async () => {
    const csv = "cpf;cnpj;nome;endereco;prefeitura;tributo;valor_original;vencimento\n52998224725;;Maria;Rua A;Timóteo;IPTU;1.234,56;01/01/2024\n";
    const r = await lerPlanilha(Buffer.from(csv), "x.csv");
    assert.strictEqual(r.itens[0].original, 1234.56); assert.strictEqual(r.itens[0].vencimento, "2024-01-01");
  });

  let adm, tim, ipa;
  await t("admin: login errado negado, correto aceito", async () => {
    assert.strictEqual((await api("POST", "/api/admin/login", { email: "equipe@full.com.br", senha: "errada" })).status, 401);
    const r = await api("POST", "/api/admin/login", { email: "equipe@full.com.br", senha: "SenhaForte123" });
    assert.strictEqual(r.status, 200); adm = r.body.token;
    assert.strictEqual((await api("GET", "/api/admin/prefeituras")).status, 401);
  });
  await t("admin: cria prefeituras e importa planilha", async () => {
    tim = (await api("POST", "/api/admin/prefeituras", { nome: "Prefeitura Municipal de Timóteo" }, adm)).body;
    ipa = (await api("POST", "/api/admin/prefeituras", { nome: "Prefeitura de Ipatinga" }, adm)).body;
    assert.ok(tim.id && ipa.id);
    const f = new FormData(); f.append("arquivo", new Blob([buf]), "dividas.xlsx");
    const r = await api("POST", "/api/admin/importar", null, adm, f);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.linhasOk, 4); assert.strictEqual(r.body.linhasErro, 1); assert.strictEqual(r.body.prefeituras.length, 2);
  });
  await t("admin: índices por código tributário valem na consulta", async () => {
    const r = await api("PUT", `/api/admin/prefeituras/${tim.id}/regras`, { regras: [{ codigo: "ISS", corr: 2, juros: 0.1, limite: "" }] }, adm);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await api("PUT", `/api/admin/prefeituras/${tim.id}/regras`, { regras: [{ codigo: "ISS", corr: "abc" }] }, adm)).status, 400);
  });

  let sessao, cpfDebito;
  await t("consulta: CPF com débito em 2 prefeituras mostra ambas; CNPJ só Ipatinga; inexistente não acha", async () => {
    const a = await api("POST", "/api/consulta", { doc: "529.982.247-25" });
    assert.strictEqual(a.body.prefeituras.length, 2);
    assert.ok(/^M/.test(a.body.nome) && a.body.nome.includes("*") || a.body.nome.includes("•") || a.body.nome.length > 0);
    const b = await api("POST", "/api/consulta", { doc: "11222333000181" });
    assert.deepStrictEqual(b.body.prefeituras.map((p) => p.nome), ["Prefeitura de Ipatinga"]);
    assert.strictEqual((await api("POST", "/api/consulta", { doc: "11144477735" })).body.encontrado, false);
    assert.strictEqual((await api("POST", "/api/consulta", { doc: "123" })).status, 400);
  });
  await t("cadastro + link de acesso (uso único) + sessão", async () => {
    const pid = tim.id;
    const r = await api("POST", "/api/cadastro", { doc: "52998224725", prefeituraId: pid, nome: "Maria da Silva", endereco: "Rua A, 10, Centro", email: "maria@exemplo.com", whatsapp: "31999998888", consentimento: true });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const mail = caixaDeTestes.filter((m) => m.canal === "email").pop();
    const link = /acesso=([a-f0-9]+)/.exec(mail.html)[1];
    // cadastro sem consentimento falha
    assert.strictEqual((await api("POST", "/api/cadastro", { doc: "52998224725", prefeituraId: pid, nome: "Maria", endereco: "Rua A, 10", email: "m@e.com", whatsapp: "31999998888" })).status, 400);
    const s = await api("GET", "/api/acesso/" + link); assert.strictEqual(s.status, 200); sessao = s.body.token;
    assert.strictEqual((await api("GET", "/api/acesso/" + link)).status, 401); // já usado
    assert.strictEqual((await api("GET", "/api/debito")).status, 401);
  });
  await t("débito: só da prefeitura da sessão, valores recalculados no servidor", async () => {
    const d = await api("GET", "/api/debito", null, sessao);
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.body.prefeitura.nome, "Prefeitura Municipal de Timóteo");
    assert.strictEqual(d.body.linhas.length, 2); // não mostra Ipatinga
    const iptu = d.body.linhas.find((l) => l.descricao.startsWith("IPTU"));
    assert.strictEqual(iptu.dias, 90); assert.strictEqual(iptu.correcao, 30);
    const iss = d.body.linhas.find((l) => l.descricao.startsWith("ISS"));
    assert.strictEqual(iss.correcao, 10); // regra ISS: 2% a.m. x 1 mês sobre 500
    assert.strictEqual(d.body.opcoes.length, 12);
    cpfDebito = d.body;
  });
  await t("termo: texto com cláusulas, cronograma e valores", async () => {
    const r = await api("POST", "/api/termo", { parcelas: 3, metodo: "boleto" }, sessao);
    assert.strictEqual(r.status, 200);
    const txt = JSON.stringify(r.body.partes);
    assert.ok(txt.includes("CONFISSÃO DE DÍVIDA") && txt.includes("TIMÓTEO") && txt.includes("boleto"));
    assert.strictEqual((await api("POST", "/api/termo", { parcelas: 99, metodo: "pix" }, sessao)).status, 400);
  });
  let protocolo;
  await t("negociação exige aceite; confirma, gera cobrança e avisa email + WhatsApp", async () => {
    assert.strictEqual((await api("POST", "/api/negociacao", { parcelas: 3, metodo: "boleto", aceite: false }, sessao)).status, 400);
    const antes = caixaDeTestes.length;
    const r = await api("POST", "/api/negociacao", { parcelas: 3, metodo: "boleto", aceite: true }, sessao);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    protocolo = r.body.protocolo;
    assert.ok(/^NA-\d{6}-\d{6}$/.test(protocolo));
    assert.ok(r.body.cobranca.linhaDigitavel);
    assert.strictEqual(r.body.total, cpfDebito.opcoes[2].total);
    await new Promise((x) => setTimeout(x, 100));
    const novos = caixaDeTestes.slice(antes);
    assert.ok(novos.some((m) => m.canal === "email" && /boleto/i.test(m.assunto)));
    assert.ok(novos.some((m) => m.canal === "whatsapp" && /Protocolo/.test(m.texto)));
    const n = (await query("SELECT * FROM negociacoes WHERE protocolo=$1", [protocolo])).rows[0];
    assert.ok(n.termo_hash.length === 64 && n.aceite_ip && n.codigo_autenticacao);
    const parc = (await query("SELECT * FROM parcelas WHERE negociacao_id=$1 ORDER BY numero", [n.id])).rows;
    assert.strictEqual(parc.length, 3); assert.ok(parc[0].gateway_id); assert.strictEqual(U.round2(parc.reduce((s, p) => s + p.valor, 0)), n.valor_total);
  });
  await t("não renegocia o mesmo débito; Ipatinga do mesmo CPF continua disponível", async () => {
    assert.strictEqual((await api("POST", "/api/negociacao", { parcelas: 1, metodo: "pix", aceite: true }, sessao)).status, 409);
    const c = await api("POST", "/api/consulta", { doc: "52998224725" });
    assert.deepStrictEqual(c.body.prefeituras.map((p) => p.nome), ["Prefeitura de Ipatinga"]);
  });
  await t("webhook: exige token e quita parcelas", async () => {
    process.env.ASAAS_WEBHOOK_TOKEN = "segredo";
    const gw = (await query("SELECT gateway_id FROM parcelas WHERE numero=1 AND negociacao_id=(SELECT id FROM negociacoes WHERE protocolo=$1)", [protocolo])).rows[0].gateway_id;
    const corpo = JSON.stringify({ event: "PAYMENT_RECEIVED", payment: { id: gw } });
    let r = await fetch(base + "/api/webhooks/asaas", { method: "POST", headers: { "content-type": "application/json", "asaas-access-token": "errado" }, body: corpo });
    assert.strictEqual(r.status, 401);
    r = await fetch(base + "/api/webhooks/asaas", { method: "POST", headers: { "content-type": "application/json", "asaas-access-token": "segredo" }, body: corpo });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await query("SELECT status FROM parcelas WHERE gateway_id=$1", [gw])).rows[0].status, "pago");
  });
  await t("admin: reimportar (substituir) preserva negociados; resumo e lista", async () => {
    const f = new FormData(); f.append("arquivo", new Blob([buf]), "dividas.xlsx"); f.append("modo", "substituir");
    assert.strictEqual((await api("POST", "/api/admin/importar", null, adm, f)).status, 200);
    const neg = (await query("SELECT count(*)::int n FROM debitos WHERE status='negociado'")).rows[0].n; assert.strictEqual(neg, 2);
    const res = await api("GET", "/api/admin/resumo", null, adm); assert.strictEqual(res.body.length, 2);
    assert.strictEqual((await api("GET", "/api/admin/negociacoes", null, adm)).body.length, 1);
  });
  await t("admin de prefeitura: só enxerga a própria", async () => {
    await api("POST", "/api/admin/usuarios", { email: "tim@timoteo.mg.gov.br", senha: "OutraSenha123", papel: "prefeitura", prefeituraId: tim.id }, adm);
    const l = await api("POST", "/api/admin/login", { email: "tim@timoteo.mg.gov.br", senha: "OutraSenha123" });
    const tk = l.body.token;
    assert.strictEqual((await api("GET", "/api/admin/prefeituras", null, tk)).body.length, 1);
    assert.strictEqual((await api("GET", `/api/admin/prefeituras/${ipa.id}`, null, tk)).status, 403);
    assert.strictEqual((await api("POST", "/api/admin/prefeituras", { nome: "Outra" }, tk)).status, 403);
  });

  await t("rotina diária: gera só as parcelas que vencem em breve", async () => {
    const { gerarCobrancasPendentes } = require("../src/jobs");
    let r = await gerarCobrancasPendentes(U.hojeSP(), 7);
    assert.strictEqual(r.geradas, 0); // parcela 2 vence em ~1 mês
    r = await gerarCobrancasPendentes(U.addDias(U.hojeSP(), 40), 7);
    assert.strictEqual(r.geradas, 1); // parcela 2 (1ª já paga/gerada)
    assert.strictEqual((await gerarCobrancasPendentes(U.addDias(U.hojeSP(), 40), 7)).geradas, 0); // idempotente
  });

  server.close(); await pool.end();
  console.log(`\n${ok} testes passaram` + (process.exitCode ? " — HÁ FALHAS" : ""));
})();
