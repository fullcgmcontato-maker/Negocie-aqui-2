// Teste de ponta a ponta no navegador (Chromium). Requer o servidor rodando em E2E_URL.
const { chromium } = require("playwright");
const base = process.env.E2E_URL || "http://127.0.0.1:3111";
const api = async (m, r, b, t, form) => { const h = {}; if (t) h.authorization = "Bearer " + t; if (b) h["content-type"] = "application/json"; const x = await fetch(base + "/api" + r, { method: m, headers: h, body: form || (b ? JSON.stringify(b) : undefined) }); return x.json(); };
(async () => {
  const adm = (await api("POST", "/admin/login", { email: "equipe@full.com.br", senha: "SenhaForte123" })).token;
  await api("POST", "/admin/prefeituras", { nome: "Prefeitura Municipal de Timóteo" }, adm);
  const csv = "cpf;cnpj;nome;endereco;prefeitura;tributo;valor_original;vencimento\n52998224725;;Maria da Silva;Rua A;Prefeitura Municipal de Timóteo;IPTU;1.000,00;01/01/2025\n";
  const f = new FormData(); f.append("arquivo", new Blob([csv]), "d.csv");
  console.log("import:", JSON.stringify((await api("POST", "/admin/importar", null, adm, f))).slice(0, 120));

  const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 420, height: 900 } });
  const erros = []; pg.on("console", (m) => m.type() === "error" && erros.push(m.text())); pg.on("pageerror", (e) => erros.push(String(e)));
  await pg.goto(base);
  await pg.locator("#doc").pressSequentially("52998224725"); // digitando números de verdade
  console.log("mascara:", await pg.inputValue("#doc"));
  await pg.click("text=Consultar");
  if (await pg.locator("h1:has-text(\"mais de uma prefeitura\")").waitFor({timeout:3000}).then(()=>true).catch(()=>false)) { console.log("multi-prefeitura: escolha exibida"); await pg.click(".opt:has-text('Timóteo')"); }
  await pg.waitForSelector("text=Débito encontrado");
  await pg.screenshot({ path: "/tmp/e2e-1.png" });
  await pg.click("text=Continuar e negociar");
  await pg.fill("#nome", "Maria da Silva"); await pg.fill("#endereco", "Rua A, 10"); await pg.locator("#whatsapp").pressSequentially("31999998888"); await pg.fill("#email", "maria@exemplo.com");
  await pg.click("#cons"); await pg.click("text=Receber link de acesso");
  await pg.waitForSelector("text=Verifique seu email");
  await pg.click("text=Abrir link (modo demonstração)");
  await pg.waitForSelector("text=Detalhamento");
  await pg.click(".pc:has-text('6x')"); await pg.click(".tabs .pc:has-text('Boleto')");
  await pg.screenshot({ path: "/tmp/e2e-2.png", fullPage: true });
  await pg.click("text=Continuar para o termo");
  await pg.waitForSelector("text=Leia e assine");
  await pg.click("text=Assinar e gerar pagamento"); // sem marcar → erro
  console.log("sem aceite:", await pg.textContent("#err"));
  await pg.click("#aceite"); await pg.click("text=Assinar e gerar pagamento");
  await pg.waitForSelector("text=Pagamento da 1ª parcela");
  await pg.screenshot({ path: "/tmp/e2e-3.png" });
  await pg.click("text=Já paguei"); await pg.waitForSelector("text=Negociação concluída");
  console.log("protocolo:", await pg.textContent(".proto"));
  // Karen
  await pg.click("#fab"); await pg.fill("#ci", "Posso pagar no cartão?"); await pg.press("#ci", "Enter"); await pg.waitForTimeout(500);
  console.log("karen:", (await pg.locator(".m.a").last().textContent()).slice(0, 80));
  // admin
  const p2 = await b.newPage({ viewport: { width: 900, height: 900 } }); p2.on("pageerror", (e) => erros.push(String(e)));
  await p2.goto(base); await p2.click("#adm"); await p2.fill("#ae", "equipe@full.com.br"); await p2.fill("#as", "SenhaForte123"); await p2.click("text=Entrar");
  await p2.waitForSelector("text=Painel"); await p2.click(".admtabs >> text=Juros e correção"); await p2.waitForSelector("#cp");
  await p2.fill("#cp", "1,5"); await p2.click("text=+ Adicionar código"); await p2.locator(".rr input").first().fill("ISS"); await p2.click("text=Salvar");
  await p2.waitForSelector("text=Salvo!"); await p2.screenshot({ path: "/tmp/e2e-4.png", fullPage: true });
  await p2.click(".admtabs >> text=Negociações"); await p2.waitForSelector("text=NA-");
  console.log("erros de console/página:", erros.length ? erros : "nenhum");
  await b.close();
})().catch((e) => { console.error("E2E FALHOU", e); process.exit(1); });
