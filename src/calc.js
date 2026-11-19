/**
 * Cálculo dos débitos. ÚNICA fonte da verdade dos valores cobrados:
 * o front só exibe o que a API devolve, nunca calcula.
 *
 * Regras (conforme combinado):
 *  - Correção monetária: % ao mês, proporcional aos dias de atraso (dias/30), sobre o valor original.
 *  - Juros de mora: % ao dia, simples, sobre o valor corrigido (original + correção).
 *  - Limite opcional dos juros, em % do valor corrigido.
 *  - Índices por código tributário; campo vazio usa o padrão da prefeitura.
 *  - Sem data de vencimento: vale o valor fixo de encargos importado.
 */
const { nk, round2, diasEntre, addDias, addMeses } = require("./util");

function indicesDe(debito, regras, pref) {
  const k = nk(debito.codigo || debito.descricao || "");
  let r = null;
  if (k) r = regras.find((u) => u.chave === k) || regras.find((u) => u.chave && k.startsWith(u.chave)) || null;
  const pick = (v, padrao) => (v !== null && v !== undefined ? Number(v) : padrao !== null && padrao !== undefined ? Number(padrao) : null);
  return {
    corr: pick(r && r.corr, pref.corr_padrao),
    juros: pick(r && r.juros, pref.juros_padrao),
    limite: pick(r && r.limite, pref.limite_padrao),
    regra: r ? r.codigo : null,
  };
}

function atualizar(debito, regras, pref, hoje) {
  const original = Number(debito.valor_original);
  if (!debito.vencimento) {
    const fixos = round2(Number(debito.encargos_fixos || 0));
    return { original, correcao: 0, juros: fixos, dias: 0, total: round2(original + fixos), indices: null };
  }
  const ind = indicesDe(debito, regras, pref);
  const dias = Math.max(0, diasEntre(debito.vencimento, hoje));
  const correcao = round2((original * ind.corr / 100) * (dias / 30));
  const base = original + correcao;
  let juros = base * ind.juros / 100 * dias;
  if (ind.limite !== null) juros = Math.min(juros, base * ind.limite / 100);
  juros = round2(juros);
  return { original, correcao, juros, dias, total: round2(original + correcao + juros), indices: ind };
}

/** Opções 1x..Nx: acréscimo de taxa_parcelamento % ao mês por parcela adicional. */
function opcoesParcelamento(valorConsolidado, pref) {
  const taxa = Number(pref.taxa_parcelamento) / 100;
  const out = [];
  for (let n = 1; n <= Number(pref.max_parcelas); n++) {
    const total = round2(valorConsolidado * (1 + taxa * (n - 1)));
    out.push({ parcelas: n, total, valorParcela: round2(total / n) });
  }
  return out;
}

/** Cronograma: 1ª parcela em hoje + dias_1a_parcela, demais mês a mês. A última absorve a diferença de centavos. */
function cronograma(total, n, hoje, diasPrimeira) {
  const primeira = addDias(hoje, Number(diasPrimeira));
  const base = round2(total / n);
  const parcelas = [];
  for (let i = 0; i < n; i++) {
    const valor = i === n - 1 ? round2(total - base * (n - 1)) : base;
    parcelas.push({ numero: i + 1, vencimento: addMeses(primeira, i), valor });
  }
  return parcelas;
}

module.exports = { indicesDe, atualizar, opcoesParcelamento, cronograma };
