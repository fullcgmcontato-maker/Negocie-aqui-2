/**
 * Leitura de planilhas (.xlsx / .csv) com débitos.
 * Reconhece títulos de coluna flexíveis (ex.: "CNPJ do Contribuinte", "Razão Social", "Valor da Dívida").
 * Retorna linhas normalizadas + lista de erros por linha; não grava nada no banco.
 */
const ExcelJS = require("exceljs");
const { onlyDigits, nk, docValido, round2 } = require("./util");

const ROTULOS = {
  cod: "Código tributário", venc: "Vencimento", mun: "Prefeitura", nome: "Nome", orig: "Valor",
  mj: "Multa/juros", end: "Endereço", ano: "Ano", trib: "Tributo",
};

function colunaDe(titulo) {
  const k = nk(titulo);
  if (!k) return null;
  const cnpj = k.includes("cnpj"), cpf = k.includes("cpf");
  if (cnpj && cpf) return "doc";
  if (cnpj) return "cnpj";
  if (cpf) return "cpf";
  if (k === "documento" || k === "doc") return "doc";
  if (k.includes("vencimento") || k === "venc" || k === "dtvenc" || k.includes("datavenc")) return "venc";
  if (k.includes("prefeitura") || k.includes("municipio") || k === "cidade") return "mun";
  if (k.startsWith("cod") || k.includes("codigo")) return "cod";
  if (/multa|juros|encargo|acrescimo/.test(k)) return "mj";
  if (/nome|razao|contribuinte|devedor|titular/.test(k)) return "nome";
  if (/endereco|logradouro/.test(k)) return "end";
  if (k.startsWith("ano") || k.includes("exercicio")) return "ano";
  if (/tributo|receita|natureza/.test(k)) return "trib";
  if (/valor|divida|principal|saldo|total/.test(k)) return "orig";
  return null;
}

/** Aceita "1.240,50", "R$ 1240.5", 1240.5. Retorna NaN se não for número. */
function numero(v) {
  if (typeof v === "number") return v;
  let t = String(v ?? "").replace(/R\$|\s/g, "");
  if (!t) return NaN;
  if (t.includes(",")) t = t.replace(/\./g, "").replace(",", ".");
  return Number(t);
}

/** Retorna "AAAA-MM-DD", "" (vazio) ou null (inválido). */
function data(v) {
  if (v === "" || v === null || v === undefined) return "";
  let d;
  if (v instanceof Date) d = v;
  else if (typeof v === "number") {
    if (v < 20000 || v > 80000) return null;
    d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5);
  } else {
    const t = String(v).trim();
    if (!t) return "";
    let m = t.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/);
    if (m) {
      let y = +m[3];
      if (y < 100) y += 2000;
      d = new Date(Date.UTC(y, +m[2] - 1, +m[1]));
      if (d.getUTCDate() !== +m[1] || d.getUTCMonth() !== +m[2] - 1) return null;
    } else {
      m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (!m) return null;
      d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
      if (d.getUTCDate() !== +m[3]) return null;
    }
  }
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

function parseCsv(texto) {
  const primeira = texto.split(/\r?\n/)[0] || "";
  const cont = { ";": 0, ",": 0, "\t": 0 };
  for (const ch of primeira) if (ch in cont) cont[ch]++;
  const sep = Object.keys(cont).sort((a, b) => cont[b] - cont[a])[0];
  const linhas = [];
  let l = [], cel = "", asp = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (asp) {
      if (ch === '"') { if (texto[i + 1] === '"') { cel += '"'; i++; } else asp = false; }
      else cel += ch;
    } else if (ch === '"') asp = true;
    else if (ch === sep) { l.push(cel); cel = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && texto[i + 1] === "\n") i++;
      l.push(cel); cel = ""; linhas.push(l); l = [];
    } else cel += ch;
  }
  if (cel || l.length) { l.push(cel); linhas.push(l); }
  return linhas;
}

function valorCelula(c) {
  const v = c.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "object" && !(v instanceof Date)) {
    if ("result" in v) return v.result ?? "";
    if ("richText" in v) return v.richText.map((x) => x.text).join("");
    if ("text" in v) return v.text;
    return "";
  }
  return v;
}

/** Lê o arquivo e devolve [{nome, linhas:[[...]]}] (uma entrada por aba; CSV tem uma só). */
async function lerArquivo(buffer, nomeArquivo) {
  if (/\.xlsx$/i.test(nomeArquivo)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    return wb.worksheets.map((ws) => {
      const linhas = [];
      ws.eachRow({ includeEmpty: true }, (row) => {
        const arr = [];
        for (let i = 1; i <= row.cellCount; i++) arr.push(valorCelula(row.getCell(i)));
        linhas[row.number - 1] = arr;
      });
      for (let i = 0; i < linhas.length; i++) if (!linhas[i]) linhas[i] = [];
      return { nome: ws.name, linhas };
    });
  }
  if (/\.xls$/i.test(nomeArquivo)) throw new Error("Arquivo .xls antigo não é suportado. Salve como .xlsx ou .csv.");
  let texto;
  try { texto = new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { texto = new TextDecoder("windows-1252").decode(buffer); }
  return [{ nome: "", linhas: parseCsv(texto.replace(/^﻿/, "")) }];
}

function lerFolha(linhas) {
  let h = -1, map = {}, docCols = [];
  for (let i = 0; i < Math.min(linhas.length, 15); i++) {
    const m = {}, dc = [];
    (linhas[i] || []).forEach((c, j) => {
      const k = colunaDe(c);
      if (!k) return;
      const t = String(c).trim();
      if (k === "cpf" || k === "cnpj" || k === "doc") dc.push({ j, k, t });
      else if (!(k in m)) m[k] = { j, t };
    });
    if (dc.length && m.nome && m.orig) { h = i; map = m; docCols = dc; break; }
  }
  if (h < 0) return { erro: "Não encontrei as colunas obrigatórias (cpf e/ou cnpj, nome e valor) no início do arquivo." };

  const itens = [], erros = [];
  for (let i = h + 1; i < linhas.length; i++) {
    const r = linhas[i] || [];
    if (r.every((c) => String(c ?? "").trim() === "")) continue;
    const ln = i + 1;
    const nome = String(r[map.nome.j] ?? "").trim();
    const docs = new Set();
    let ruim = "";
    for (const dc of docCols) {
      const v = r[dc.j];
      let g;
      if (typeof v === "number") g = Number.isFinite(v) ? String(Math.round(v)) : "";
      else {
        const t = String(v ?? "").trim();
        if (/^\d[\d.,]*\s*e\s*\+?\d+$/i.test(t)) { ruim = "Documento em notação científica (formate a coluna como Texto no Excel)"; continue; }
        g = t.replace(/\D/g, "");
      }
      if (!g) continue;
      if (g.length > 14) { ruim = "CPF/CNPJ com mais de 14 números"; continue; }
      docs.add(g.length > 11 ? g.padStart(14, "0") : g.padStart(dc.k === "cnpj" ? 14 : 11, "0"));
    }
    if (!docs.size) { erros.push({ linha: ln, motivo: ruim || "CPF/CNPJ vazio" }); continue; }
    const doc = [...docs][0];
    if (docs.size > 1) { erros.push({ linha: ln, motivo: "CPF e CNPJ diferentes na mesma linha" }); continue; }
    if (!docValido(doc)) { erros.push({ linha: ln, motivo: (doc.length === 11 ? "CPF" : "CNPJ") + " inválido (dígito verificador)" }); continue; }
    if (!nome) { erros.push({ linha: ln, motivo: "Nome vazio" }); continue; }
    const orig = numero(r[map.orig.j]);
    if (!Number.isFinite(orig) || orig <= 0) { erros.push({ linha: ln, motivo: "Valor inválido" }); continue; }
    let fixos = 0;
    if (map.mj && String(r[map.mj.j] ?? "").trim() !== "") {
      fixos = numero(r[map.mj.j]);
      if (!Number.isFinite(fixos) || fixos < 0) { erros.push({ linha: ln, motivo: "Multa/juros inválido" }); continue; }
    }
    let venc = "";
    if (map.venc) {
      venc = data(r[map.venc.j]);
      if (venc === null) { erros.push({ linha: ln, motivo: "Vencimento inválido (use dd/mm/aaaa)" }); continue; }
    }
    const txt = (k) => (map[k] ? String(r[map[k].j] ?? "").trim() : "");
    const ano = txt("ano"), trib = txt("trib"), cod = txt("cod");
    itens.push({
      linha: ln,
      doc,
      nome,
      endereco: txt("end"),
      prefeitura: txt("mun"),
      codigo: cod || trib,
      descricao: ((trib || cod || "Débito") + (ano ? " " + ano : "")).trim(),
      original: round2(orig),
      vencimento: venc || null,
      encargosFixos: venc ? 0 : round2(fixos),
    });
  }
  const colunas = [
    ...docCols.map((d) => `${d.k.toUpperCase()} ← ${d.t}`),
    ...Object.entries(map).map(([k, v]) => `${ROTULOS[k]} ← ${v.t}`),
  ];
  return { itens, erros, colunas };
}

/** Lê todas as abas e junta. */
async function lerPlanilha(buffer, nomeArquivo) {
  const folhas = await lerArquivo(buffer, nomeArquivo);
  const out = { itens: [], erros: [], colunas: [] };
  const falhas = [];
  for (const f of folhas) {
    const r = lerFolha(f.linhas);
    if (r.erro) { falhas.push(r.erro); continue; }
    if (!out.colunas.length) out.colunas = r.colunas;
    out.itens.push(...r.itens);
    r.erros.forEach((e) => out.erros.push(folhas.length > 1 ? { ...e, motivo: `[${f.nome}] ${e.motivo}` } : e));
  }
  if (!out.itens.length && !out.erros.length && falhas.length) return { erro: falhas[0] };
  return out;
}

module.exports = { lerPlanilha, numero, data, colunaDe };
