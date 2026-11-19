(function () {
  "use strict";

  /* ---------- utilidades ---------- */
  const $ = (id) => document.getElementById(id);
  const brl = (n) => Number(n).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  const fd = (iso) => (iso ? iso.split("-").reverse().join("/") : "—");
  const dig = (s) => String(s || "").replace(/\D/g, "");

  // Constrói DOM sem innerHTML: textos dos contribuintes nunca são interpretados como HTML.
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "class") e.className = v;
      else if (k === "value") e.value = v;
      else if (k === "checked") e.checked = !!v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  const memo = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(k); if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { return null; } };

  async function api(metodo, rota, corpo, token, form) {
    const headers = {};
    if (token) headers.authorization = "Bearer " + token;
    let body;
    if (form) body = form; else if (corpo) { headers["content-type"] = "application/json"; body = JSON.stringify(corpo); }
    let r;
    try { r = await fetch("/api" + rota, { method: metodo, headers, body }); }
    catch { throw new Error("Sem conexão com o servidor. Verifique sua internet e tente de novo."); }
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(dados.erro || "Erro inesperado."); e.status = r.status; e.dados = dados; throw e; }
    return dados;
  }

  /* ---------- estado ---------- */
  const S = { tela: "lookup", doc: "", consulta: null, pref: null, cadastro: null, token: memo("na_tk"), debito: null, parcelas: null, metodo: "pix", neg: null, adm: null };
  const ETAPAS = { lookup: 0, found: 0, choose: 0, notfound: 0, register: 1, sent: 1, debt: 2, term: 3, payment: 4, done: 4 };
  const NOMES = ["Consulta", "Cadastro", "Dívida", "Termo", "Pagamento"];

  const KAREN = {
    lookup: "Oi, eu sou a Karen! Vou te ajudar a negociar sua dívida. Para começar, digite seu CPF ou CNPJ e toque em Consultar.",
    choose: "Você tem débito em mais de uma prefeitura. Escolha com qual deseja negociar agora; depois você pode voltar e negociar a outra.",
    found: "Encontrei um débito no seu nome. Toque em Continuar para fazer um rápido cadastro e receber seu acesso por email.",
    notfound: "Não encontrei débito para este documento. Confira os números ou procure o setor de tributos da prefeitura.",
    register: "Preencha seus dados de contato. Vou enviar um link de acesso para o seu email, que vale por pouco tempo.",
    sent: "Pronto! Abra seu email e clique no link. Se não achar, olhe também a caixa de spam.",
    debt: "Aqui está o detalhamento do seu débito, atualizado hoje. Escolha em quantas parcelas quer pagar e a forma: Pix ou boleto.",
    term: "Leia o termo com calma. Ao marcar a caixa e confirmar, você assina eletronicamente o acordo.",
    payment: "Falta pouco! Pague a primeira parcela para formalizar o acordo.",
    done: "Acordo registrado! Guarde o protocolo. As próximas parcelas vencem nas datas do termo.",
    admin: "Área restrita da prefeitura e da equipe Full: importe a planilha e ajuste juros e correção.",
  };

  function ir(tela) { S.tela = tela; render(); window.scrollTo(0, 0); karenDica(); }

  function render() {
    const app = $("app"); app.replaceChildren();
    $("shell").classList.toggle("wide", S.tela === "admin");
    const v = VIEWS[S.tela]; app.append(...[].concat(v()).flat(Infinity).filter(Boolean));
    const st = $("steps"); st.replaceChildren();
    if (S.tela !== "admin") {
      NOMES.forEach((n, i) => st.append(h("span", { class: i === ETAPAS[S.tela] ? "on" : "" }, h("i", {}, i + 1), h("em", {}, n))));
      $("sub").textContent = S.pref ? S.pref.nome : "Serviço oficial do município";
    } else $("sub").textContent = "Área da prefeitura";
  }

  const voltar = (para) => h("button", { class: "back", onclick: () => ir(para) }, "← Voltar");
  const erro = () => h("div", { class: "err", id: "err", role: "alert" });
  const mostraErro = (m) => { const e = $("err"); if (e) e.textContent = m || ""; };
  async function acao(btn, fn) {
    btn.disabled = true; mostraErro("");
    try { await fn(); } catch (e) { mostraErro(e.message); } finally { btn.disabled = false; }
  }

  /* ---------- máscara CPF/CNPJ ---------- */
  function maskDoc(v) {
    const d = dig(v).slice(0, 14);
    if (d.length <= 11) return d.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
    return d.replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d)/, "$1-$2");
  }
  const maskFone = (v) => { const d = dig(v).slice(0, 11); return d.length > 6 ? `(${d.slice(0, 2)}) ${d.slice(2, d.length - 4)}-${d.slice(-4)}` : d.length > 2 ? `(${d.slice(0, 2)}) ${d.slice(2)}` : d; };

  /* ---------- telas ---------- */
  const VIEWS = {
    lookup() {
      const i = h("input", { id: "doc", inputmode: "numeric", autocomplete: "off", placeholder: "000.000.000-00 ou 00.000.000/0000-00", value: S.doc, maxlength: 18,
        oninput: (e) => { e.target.value = maskDoc(e.target.value); }, onkeydown: (e) => { if (e.key === "Enter") go.click(); } });
      const go = h("button", { class: "btn", onclick: () => acao(go, async () => {
        S.doc = dig(i.value);
        if (S.doc.length !== 11 && S.doc.length !== 14) throw new Error("Digite um CPF (11 números) ou CNPJ (14 números).");
        const r = await api("POST", "/consulta", { doc: S.doc });
        S.consulta = r;
        if (!r.encontrado) return ir("notfound");
        if (r.prefeituras.length === 1) { S.pref = r.prefeituras[0]; return ir("found"); }
        S.pref = null; ir("choose");
      }) }, "Consultar");
      return [h("div", { class: "eb" }, "Consulta de débitos"), h("h1", {}, "Negocie seus débitos com a prefeitura"),
        h("p", { class: "s" }, "Informe seu CPF ou CNPJ para ver se há débitos em aberto e conhecer as condições de pagamento."),
        h("label", { for: "doc" }, "CPF ou CNPJ"), i, go, erro()];
    },
    notfound() {
      return [voltar("lookup"), h("h1", {}, "Nenhum débito encontrado"),
        h("p", { class: "s" }, "Não localizamos débitos em aberto para este documento. Confira os números ou procure o setor de tributos da sua prefeitura."),
        h("button", { class: "btn g", onclick: () => ir("lookup") }, "Consultar outro documento")];
    },
    choose() {
      return [voltar("lookup"), h("div", { class: "eb" }, "Olá, " + S.consulta.nome), h("h1", {}, "Encontramos débitos em mais de uma prefeitura"),
        h("p", { class: "s" }, "Escolha com qual deseja negociar agora:"),
        S.consulta.prefeituras.map((p) => h("button", { class: "opt", onclick: () => { S.pref = p; ir("found"); } }, h("b", {}, p.nome), h("span", {}, "Valor atualizado hoje: " + brl(p.total))))];
    },
    found() {
      return [voltar(S.consulta.prefeituras.length > 1 ? "choose" : "lookup"), h("div", { class: "eb" }, "Olá, " + S.consulta.nome), h("h1", {}, "Débito encontrado"),
        h("p", { class: "s" }, "Encontramos débito em aberto junto a ", h("b", {}, S.pref.nome), ":"),
        h("div", { class: "amt" }, brl(S.pref.total)), h("div", { class: "cap" }, "valor atualizado até hoje (juros e correção calculados por dia)"),
        h("button", { class: "btn", onclick: () => ir("register") }, "Continuar e negociar")];
    },
    register() {
      const c = S.cadastro || {};
      const f = (id, rot, extra) => [h("label", { for: id }, rot), h("input", { id, value: c[id] || "", ...extra })];
      const ck = h("input", { type: "checkbox", id: "cons" });
      const go = h("button", { class: "btn", onclick: () => acao(go, async () => {
        S.cadastro = { nome: $("nome").value.trim(), endereco: $("endereco").value.trim(), whatsapp: $("whatsapp").value, email: $("email").value.trim() };
        const r = await api("POST", "/cadastro", { doc: S.doc, prefeituraId: S.pref.id, ...S.cadastro, consentimento: $("cons").checked });
        S.enviado = r; ir("sent");
      }) }, "Receber link de acesso");
      return [voltar("found"), h("div", { class: "eb" }, "Cadastro"), h("h1", {}, "Seus dados de contato"),
        h("p", { class: "s" }, "Enviaremos um link de acesso para o seu email."),
        f("nome", "Nome completo", { autocomplete: "name" }), f("endereco", "Endereço de contato", { autocomplete: "street-address" }),
        f("whatsapp", "WhatsApp (com DDD)", { inputmode: "tel", placeholder: "(31) 99999-9999", autocomplete: "tel", oninput: (e) => { e.target.value = maskFone(e.target.value); } }),
        f("email", "Email", { type: "email", autocomplete: "email" }),
        h("label", { class: "ck", for: "cons" }, ck, h("span", {}, "Autorizo o uso dos meus dados para esta negociação e para o envio do boleto/Pix por email e WhatsApp (LGPD).")),
        go, erro()];
    },
    sent() {
      const r = S.enviado || {};
      return [h("div", { class: "seal" }, "OK", h("small", {}, "enviado")), h("h1", { class: "center" }, "Verifique seu email"),
        h("p", { class: "s center" }, "Enviamos o link de acesso para ", h("b", {}, r.email || "seu email"), ". Ele vale por 30 minutos e só pode ser usado uma vez."),
        r.linkDemonstracao ? h("a", { class: "btn g", href: r.linkDemonstracao, style: null, role: "button" }, "Abrir link (modo demonstração)") : null,
        h("button", { class: "btn g", onclick: () => ir("register") }, "Corrigir meus dados / reenviar")];
    },
    debt() {
      const d = S.debito; if (!d) return [h("p", { class: "s" }, "Carregando…")];
      const sel = S.parcelas ? d.opcoes[S.parcelas - 1] : null;
      const rows = d.linhas.map((l) => h("tr", {}, h("td", {}, l.descricao, h("div", { class: "sm" }, l.vencimento ? `venc. ${fd(l.vencimento)} · ${l.dias} dias` : "valor fixo")), h("td", { class: "r" }, brl(l.original)), h("td", { class: "r" }, brl(l.correcao + l.juros)), h("td", { class: "r" }, brl(l.total))));
      const cards = d.opcoes.map((o) => h("button", { class: "pc" + (S.parcelas === o.parcelas ? " on" : ""), onclick: () => { S.parcelas = o.parcelas; render(); }, "aria-pressed": String(S.parcelas === o.parcelas) }, h("b", {}, o.parcelas + "x"), h("span", {}, brl(o.valorParcela))));
      const mt = (m, t) => h("button", { class: "pc" + (S.metodo === m ? " on" : ""), onclick: () => { S.metodo = m; render(); } }, t);
      const go = h("button", { class: "btn", disabled: !S.parcelas, onclick: () => acao(go, async () => { await carregaTermo(); ir("term"); }) }, "Continuar para o termo");
      return [h("div", { class: "eb" }, "Seu débito · " + d.prefeitura.nome), h("h1", {}, "Detalhamento"),
        h("div", { class: "tw" }, h("table", { class: "dt" }, h("thead", {}, h("tr", {}, h("th", {}, "Débito"), h("th", { class: "r" }, "Original"), h("th", { class: "r" }, "Encargos"), h("th", { class: "r" }, "Atualizado"))), h("tbody", {}, rows),
          h("tfoot", {}, h("tr", {}, h("td", { colspan: 3 }, "Total em " + fd(d.hoje)), h("td", { class: "r" }, brl(d.consolidado)))))),
        h("div", { class: "note" }, "Os valores são atualizados diariamente (correção monetária e juros de mora) até a data do acordo."),
        h("label", {}, "Escolha o número de parcelas"), h("div", { class: "grid" }, cards),
        sel ? h("div", { class: "plan" }, h("b", {}, `${sel.parcelas}x de ${brl(sel.valorParcela)}`), h("span", {}, `Total ${brl(sel.total)} · 1ª parcela em ${fd(d.primeiraParcelaEm)}`)) : null,
        h("label", {}, "Forma de pagamento"), h("div", { class: "tabs" }, mt("pix", "Pix"), mt("boleto", "Boleto")),
        go, erro()];
    },
    term() {
      const t = S.termo; if (!t) return [h("p", { class: "s" }, "Carregando…")];
      const corpo = t.partes.map((p) => {
        if (p.tipo === "titulo") return h("p", {}, h("b", {}, p.texto));
        if (p.tipo === "tabela") return h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Parcela"), h("th", {}, "Vencimento"), h("th", { class: "r" }, "Valor"))), h("tbody", {}, p.linhas.map((l) => h("tr", {}, h("td", {}, l.numero), h("td", {}, l.vencimento), h("td", { class: "r" }, l.valor)))));
        return h("p", {}, p.texto);
      });
      const ck = h("input", { type: "checkbox", id: "aceite" });
      const go = h("button", { class: "btn", onclick: () => acao(go, async () => {
        if (!ck.checked) throw new Error("Marque a caixa para assinar o termo.");
        S.neg = await api("POST", "/negociacao", { parcelas: S.parcelas, metodo: S.metodo, aceite: true }, S.token);
        ir("payment");
      }) }, "Assinar e gerar pagamento");
      return [voltar("debt"), h("div", { class: "eb" }, "Termo de confissão de dívida"), h("h1", {}, "Leia e assine"), h("div", { class: "term", tabindex: 0 }, corpo),
        h("label", { class: "ck", for: "aceite" }, ck, h("span", {}, "Li e concordo com o termo acima. Declaro que este aceite eletrônico vale como minha assinatura.")), go, erro()];
    },
    payment() {
      const n = S.neg, c = n.cobranca;
      const copia = (txt, b) => navigator.clipboard.writeText(txt).then(() => { b.textContent = "Copiado!"; }).catch(() => { b.textContent = "Selecione e copie"; });
      let corpo;
      if (c.metodo === "pix") {
        const qr = h("div", { class: "qr", id: "qr" });
        const b = h("button", { class: "btn g", onclick: () => copia(c.pixCopiaCola, b) }, "Copiar código Pix");
        setTimeout(() => { try { const q = qrcode(0, "M"); q.addData(c.pixCopiaCola); q.make(); qr.innerHTML = q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); const s = qr.firstChild; if (s) { s.setAttribute("width", "200"); s.setAttribute("height", "200"); } } catch {} }, 0);
        corpo = [h("p", { class: "s center" }, "Escaneie o QR Code no app do seu banco ou use o Pix copia e cola:"), qr, h("div", { class: "mono" }, c.pixCopiaCola), b];
      } else {
        const b = h("button", { class: "btn g", onclick: () => copia(c.linhaDigitavel, b) }, "Copiar linha digitável");
        corpo = [h("div", { class: "note" }, `Seu boleto foi enviado por email (${n.enviadoPara.email}) e por WhatsApp (${n.enviadoPara.whatsapp}).`),
          c.linhaDigitavel ? [h("p", { class: "s" }, "Linha digitável:"), h("div", { class: "mono" }, c.linhaDigitavel), b] : null,
          c.link ? h("a", { class: "btn", href: c.link, target: "_blank", rel: "noopener", role: "button" }, "Abrir boleto") : null];
      }
      return [h("div", { class: "eb" }, "Pagamento da 1ª parcela"), h("h1", {}, `${brl(c.valor)} · vence ${fd(c.vencimento)}`),
        c.simulado ? h("div", { class: "note" }, "Modo de demonstração: esta cobrança é simulada e não gera pagamento real.") : null,
        corpo, h("button", { class: "btn", onclick: () => ir("done") }, "Já paguei / concluir")];
    },
    done() {
      const n = S.neg;
      return [h("div", { class: "seal" }, "ACORDO", h("small", {}, "registrado")), h("h1", { class: "center" }, "Negociação concluída"),
        h("div", { class: "proto" }, n.protocolo), h("p", { class: "s center" }, `Código de autenticação do termo: ${n.codigoAutenticacao}`),
        h("p", { class: "s center" }, `${n.parcelas} parcela(s), total ${brl(n.total)}. As demais parcelas serão enviadas por email e WhatsApp perto do vencimento.`),
        h("button", { class: "btn g", onclick: () => { S.token = null; memo("na_tk", null); S.debito = S.parcelas = S.termo = S.neg = null; S.pref = null; ir("lookup"); } }, "Encerrar")];
    },
    admin() { return ADM.view(); },
  };

  async function carregaDebito() { S.debito = await api("GET", "/debito", null, S.token); }
  async function carregaTermo() { S.termo = await api("POST", "/termo", { parcelas: S.parcelas, metodo: S.metodo }, S.token); }

  /* ---------- link de acesso ---------- */
  async function trataAcesso() {
    const t = new URLSearchParams(location.search).get("acesso");
    if (!t) return false;
    history.replaceState(null, "", location.pathname); // tira o token da barra de endereços
    S.tela = "debt"; render();
    try {
      const r = await api("GET", "/acesso/" + encodeURIComponent(t));
      S.token = r.token; memo("na_tk", r.token); S.pref = { id: r.prefeitura.id, nome: r.prefeitura.nome };
      await carregaDebito(); ir("debt");
    } catch (e) {
      S.tela = "lookup"; render();
      $("err") && ($("err").textContent = e.message);
    }
    return true;
  }

  /* ---------- Karen ---------- */
  const hist = [];
  function msg(r, t) { const m = h("div", { class: "m " + r }, t); $("cb").append(m); $("cb").scrollTop = 1e6; return m; }
  function karenDica() {
    const t = KAREN[S.tela]; if (!t) return;
    if (hist.length && hist[hist.length - 1].t === t) return;
    hist.push({ r: "a", t }); msg("a", t);
  }
  async function karenEnvia() {
    const i = $("ci"), t = i.value.trim(); if (!t) return;
    i.value = ""; msg("u", t); const espera = msg("a", "…");
    try {
      const r = await api("POST", "/karen", { mensagem: t, tela: S.tela, historico: hist.slice(-8) });
      espera.textContent = r.resposta; hist.push({ r: "u", t }, { r: "a", t: r.resposta });
    } catch (e) { espera.textContent = e.message; }
  }
  $("fab").addEventListener("click", () => { $("cp").classList.toggle("open"); if (!$("cb").children.length) karenDica(); });
  $("cs").addEventListener("click", karenEnvia);
  $("ci").addEventListener("keydown", (e) => { if (e.key === "Enter") karenEnvia(); });

  /* ---------- área da prefeitura ---------- */
  const ADM = {
    aba: "planilha", prefs: [], cfg: null, regras: [], msg: "", resultado: null, lista: [], resumo: [],
    async entrar(email, senha) {
      const r = await api("POST", "/admin/login", { email, senha });
      S.adm = r; memo("na_adm", r.token);
      await this.carregar();
    },
    async carregar() {
      this.prefs = await api("GET", "/admin/prefeituras", null, S.adm.token);
      const id = this.prefId || (this.prefs[0] && this.prefs[0].id);
      this.prefId = id;
      if (id) await this.carregaCfg(id);
      ir("admin");
    },
    async carregaCfg(id) {
      this.prefId = id; this.cfg = await api("GET", "/admin/prefeituras/" + id, null, S.adm.token); this.regras = this.cfg.regras.map((r) => ({ ...r }));
    },
    sair() { S.adm = null; memo("na_adm", null); ir("lookup"); },
    view() {
      if (!S.adm) {
        const e = h("input", { type: "email", id: "ae", autocomplete: "username" }), s = h("input", { type: "password", id: "as", autocomplete: "current-password", onkeydown: (ev) => { if (ev.key === "Enter") go.click(); } });
        const go = h("button", { class: "btn", onclick: () => acao(go, () => this.entrar(e.value, s.value)) }, "Entrar");
        return [voltar("lookup"), h("div", { class: "eb" }, "Acesso restrito"), h("h1", {}, "Área da prefeitura"), h("p", { class: "s" }, "Entre com o email e a senha fornecidos pela equipe Full."), h("label", { for: "ae" }, "Email"), e, h("label", { for: "as" }, "Senha"), s, go, erro()];
      }
      const aba = (k, t) => h("button", { class: "pc" + (this.aba === k ? " on" : ""), onclick: async () => { this.aba = k; this.msg = ""; if (k === "neg") this.lista = await api("GET", "/admin/negociacoes", null, S.adm.token).catch(() => []); if (k === "resumo") this.resumo = await api("GET", "/admin/resumo", null, S.adm.token).catch(() => []); render(); } }, t);
      const seletor = this.prefs.length > 1 ? [h("label", { for: "ps" }, "Prefeitura"), h("select", { id: "ps", onchange: async (ev) => { await this.carregaCfg(Number(ev.target.value)); render(); } }, this.prefs.map((p) => h("option", { value: p.id, selected: p.id === this.prefId }, p.nome)))] : [];
      const abas = { planilha: () => this.vPlanilha(), indices: () => this.vIndices(), neg: () => this.vNeg(), resumo: () => this.vResumo(), pref: () => this.vPref() };
      return [h("div", { class: "eb" }, S.adm.email + " · " + (S.adm.papel === "super" ? "equipe Full" : "prefeitura")), h("h1", {}, "Painel"),
        h("div", { class: "admtabs" }, aba("planilha", "Planilha"), aba("indices", "Juros e correção"), aba("neg", "Negociações"), aba("resumo", "Resumo"), S.adm.papel === "super" ? aba("pref", "Prefeituras") : null,
          h("button", { class: "pc", onclick: () => this.sair() }, "Sair")),
        seletor, abas[this.aba](), this.msg ? h("div", { class: this.msg.startsWith("!") ? "err" : "ok" }, this.msg.replace(/^!/, "")) : null];
    },
    vPlanilha() {
      let arquivo = null, modo = "substituir";
      const drop = h("div", { class: "drop", tabindex: 0, role: "button" }, "Toque para escolher a planilha (.xlsx ou .csv) ou arraste aqui");
      const inp = h("input", { type: "file", accept: ".xlsx,.csv,.txt", class: "hide", onchange: (e) => { arquivo = e.target.files[0]; drop.textContent = arquivo ? arquivo.name : "Escolher planilha"; } });
      drop.addEventListener("click", () => inp.click());
      drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
      drop.addEventListener("dragleave", () => drop.classList.remove("over"));
      drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); arquivo = e.dataTransfer.files[0]; if (arquivo) drop.textContent = arquivo.name; });
      const go = h("button", { class: "btn", onclick: () => acao(go, async () => {
        if (!arquivo) throw new Error("Escolha a planilha primeiro.");
        const f = new FormData(); f.append("arquivo", arquivo); f.append("modo", modo); if (this.prefId) f.append("prefeituraId", this.prefId);
        this.resultado = await api("POST", "/admin/importar", null, S.adm.token, f); this.msg = ""; render();
      }) }, "Importar");
      const r = this.resultado;
      const res = r ? [h("div", { class: "sum" }, h("div", {}, h("b", {}, r.linhasOk), "linhas importadas"), h("div", {}, h("b", {}, r.contribuintes), "contribuintes"), h("div", { class: "er" }, h("b", {}, r.linhasErro), "com erro")),
        h("p", { class: "sm" }, "Prefeituras: " + r.prefeituras.join(", ")), h("p", { class: "sm" }, "Colunas reconhecidas: " + r.colunas.join(" · ")),
        r.erros.length ? h("div", { class: "tw" }, h("table", { class: "dt" }, h("thead", {}, h("tr", {}, h("th", {}, "Linha"), h("th", {}, "Problema"))), h("tbody", {}, r.erros.map((x) => h("tr", {}, h("td", {}, x.linha), h("td", {}, x.motivo)))))) : null] : null;
      return [h("p", { class: "s" }, "Colunas: CPF e/ou CNPJ, nome, endereço, valor, vencimento, tributo/código e (opcional) prefeitura. A prefeitura selecionada acima recebe os débitos; se a planilha tiver várias prefeituras, deixe a coluna preenchida."),
        drop, inp,
        h("label", { class: "lbl2" }, h("input", { type: "radio", name: "modo", checked: true, onchange: () => { modo = "substituir"; } }), "Substituir os débitos em aberto desta prefeitura (mantém os já negociados)"),
        h("label", { class: "lbl2" }, h("input", { type: "radio", name: "modo", onchange: () => { modo = "somar"; } }), "Somar aos débitos existentes"),
        go, erro(), res];
    },
    vIndices() {
      if (!this.cfg) return [h("p", { class: "s" }, "Nenhuma prefeitura disponível.")];
      const c = this.cfg;
      const campo = (id, rot, val, passo) => [h("label", { for: id }, rot), h("input", { id, inputmode: "decimal", value: val === null || val === undefined ? "" : String(val).replace(".", ",") })];
      const linhas = this.regras.map((r, i) => h("div", { class: "rr" }, h("input", { value: r.codigo, placeholder: "Código tributário (ex.: IPTU)", oninput: (e) => { r.codigo = e.target.value; } }),
        h("div", { class: "r3" }, ["corr", "juros", "limite"].map((k) => h("input", { inputmode: "decimal", placeholder: { corr: "Corr. % mês", juros: "Juros % dia", limite: "Teto juros %" }[k], value: r[k] === null || r[k] === undefined ? "" : String(r[k]).replace(".", ","), oninput: (e) => { r[k] = e.target.value; } }))),
        h("button", { class: "back", onclick: () => { this.regras.splice(i, 1); render(); } }, "remover")));
      const salvar = h("button", { class: "btn", onclick: () => acao(salvar, async () => {
        const v = (id) => $(id).value.trim();
        await api("PUT", `/admin/prefeituras/${this.prefId}/config`, { corr_padrao: v("cp"), juros_padrao: v("jp"), limite_padrao: v("lp"), taxa_parcelamento: v("tp"), max_parcelas: v("mp"), dias_1a_parcela: v("dp"), nome: v("nm"), termo_modelo: $("tm").value }, S.adm.token);
        await api("PUT", `/admin/prefeituras/${this.prefId}/regras`, { regras: this.regras.filter((r) => String(r.codigo).trim()) }, S.adm.token);
        await this.carregaCfg(this.prefId); this.msg = "Salvo! Os novos índices valem já nas próximas consultas."; render();
      }) }, "Salvar");
      return [h("p", { class: "s" }, "Índices padrão da prefeitura e exceções por código tributário. Campo em branco na exceção usa o padrão."),
        campo("nm", "Nome da prefeitura (aparece para o contribuinte)", c.nome), campo("cp", "Correção monetária padrão (% ao mês)", c.corr_padrao), campo("jp", "Juros de mora padrão (% ao dia)", c.juros_padrao),
        campo("lp", "Teto dos juros (% do valor corrigido) — vazio = sem teto", c.limite_padrao), campo("tp", "Acréscimo por parcela adicional (% ao mês)", c.taxa_parcelamento), campo("mp", "Máximo de parcelas", c.max_parcelas), campo("dp", "Dias até a 1ª parcela", c.dias_1a_parcela),
        h("label", { for: "tm" }, "Cláusula adicional do termo (opcional, validada pela Procuradoria)"), h("textarea", { id: "tm", rows: 3, class: "ta" }, c.termo_modelo || ""),
        h("label", {}, "Exceções por código tributário"), linhas, h("button", { class: "btn g", onclick: () => { this.regras.push({ codigo: "", corr: null, juros: null, limite: null }); render(); } }, "+ Adicionar código"), salvar, erro()];
    },
    vNeg() {
      return [h("div", { class: "tw" }, h("table", { class: "dt" }, h("thead", {}, h("tr", {}, ["Protocolo", "Contribuinte", "Prefeitura", "Total", "Parcelas", "Situação"].map((x) => h("th", {}, x)))),
        h("tbody", {}, this.lista.map((n) => h("tr", {}, h("td", {}, n.protocolo), h("td", {}, n.contribuinte || "—"), h("td", {}, n.prefeitura), h("td", {}, brl(n.valor_total)), h("td", {}, `${n.pagas}/${n.qtd_parcelas}`), h("td", {}, n.status)))))), this.lista.length ? null : h("p", { class: "s" }, "Nenhuma negociação ainda.")];
    },
    vResumo() {
      return [h("div", { class: "tw" }, h("table", { class: "dt" }, h("thead", {}, h("tr", {}, ["Prefeitura", "Débitos em aberto", "Negociações", "Negociado", "Recebido"].map((x) => h("th", {}, x)))),
        h("tbody", {}, this.resumo.map((r) => h("tr", {}, h("td", {}, r.nome), h("td", {}, r.debitos_abertos), h("td", {}, r.negociacoes), h("td", {}, brl(r.valor_negociado)), h("td", {}, brl(r.valor_recebido)))))))];
    },
    vPref() {
      const n = h("input", { id: "np", placeholder: "Ex.: Prefeitura Municipal de Timóteo" });
      const go = h("button", { class: "btn", onclick: () => acao(go, async () => { await api("POST", "/admin/prefeituras", { nome: n.value }, S.adm.token); n.value = ""; this.prefId = null; await this.carregar(); this.aba = "pref"; this.msg = "Prefeitura criada."; render(); }) }, "Cadastrar prefeitura");
      const em = h("input", { id: "ue", type: "email", placeholder: "email do usuário" }), se = h("input", { id: "us", type: "password", placeholder: "senha (mín. 10 caracteres)", autocomplete: "new-password" });
      const sel = h("select", { id: "up" }, this.prefs.map((p) => h("option", { value: p.id }, p.nome)));
      const go2 = h("button", { class: "btn g", onclick: () => acao(go2, async () => { await api("POST", "/admin/usuarios", { email: em.value, senha: se.value, papel: "prefeitura", prefeituraId: Number(sel.value) }, S.adm.token); em.value = se.value = ""; this.msg = "Usuário criado."; render(); }) }, "Criar usuário da prefeitura");
      return [h("label", { for: "np" }, "Nova prefeitura"), n, go, h("label", {}, "Novo usuário (acesso só à prefeitura escolhida)"), sel, em, se, go2, erro()];
    },
  };
  $("adm").addEventListener("click", () => {
    if (S.adm && !ADM.prefs.length) ADM.carregar().catch(() => { S.adm = null; memo("na_adm", null); ir("admin"); });
    else ir("admin");
  });

  /* ---------- início ---------- */
  render();
  (async () => {
    const adm = memo("na_adm");
    if (adm) { try { const email = JSON.parse(atob(adm.split(".")[1])); S.adm = { token: adm, email: "sessão ativa", papel: email.papel, prefeituraId: email.pid }; } catch { memo("na_adm", null); } }
    if (!(await trataAcesso())) karenDica();
  })();
})();
