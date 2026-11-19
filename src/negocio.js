/** Consultas e cálculos compartilhados entre as rotas. */
const { query } = require("./db");
const { atualizar, opcoesParcelamento } = require("./calc");
const { round2 } = require("./util");

async function carregarPrefeitura(id, db = { query }) {
  const r = await db.query("SELECT * FROM prefeituras WHERE id=$1 AND ativo", [id]);
  return r.rows[0] || null;
}

async function carregarRegras(prefeituraId, db = { query }) {
  const r = await db.query("SELECT codigo, chave, corr, juros, limite FROM regras_tributarias WHERE prefeitura_id=$1", [prefeituraId]);
  return r.rows;
}

async function debitosAbertos(contribuinteId, prefeituraId, db = { query }, travar = false) {
  const r = await db.query(
    `SELECT id, codigo, descricao, valor_original, vencimento, encargos_fixos
       FROM debitos WHERE contribuinte_id=$1 AND prefeitura_id=$2 AND status='aberto'
       ORDER BY vencimento NULLS LAST, id ${travar ? "FOR UPDATE" : ""}`,
    [contribuinteId, prefeituraId]
  );
  return r.rows;
}

/** Atualiza cada débito para a data de hoje e soma. */
function consolidar(debitos, regras, pref, hoje) {
  const linhas = debitos.map((d) => {
    const a = atualizar(d, regras, pref, hoje);
    return {
      id: d.id,
      descricao: d.descricao,
      codigo: d.codigo,
      vencimento: d.vencimento,
      original: a.original,
      correcao: a.correcao,
      juros: a.juros,
      dias: a.dias,
      total: a.total,
      indices: a.indices ? { corr: a.indices.corr, juros: a.indices.juros, limite: a.indices.limite } : null,
    };
  });
  const consolidado = round2(linhas.reduce((s, l) => s + l.total, 0));
  return { linhas, consolidado };
}

module.exports = { carregarPrefeitura, carregarRegras, debitosAbertos, consolidar, opcoesParcelamento };
