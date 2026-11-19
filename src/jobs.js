/**
 * Rotina diária: gera a cobrança (boleto/Pix) das próximas parcelas e avisa o contribuinte por email e WhatsApp.
 * No Render: Cron Job "node scripts/rotina-diaria.js" todo dia cedo (ver render.yaml).
 */
const { query } = require("./db");
const U = require("./util");
const { criarCobranca } = require("./payments");
const { enviarEmail, enviarWhatsapp, esc } = require("./notify");

async function gerarCobrancasPendentes(hoje = U.hojeSP(), antecedenciaDias = Number(process.env.DIAS_ANTECEDENCIA || 7)) {
  const limite = U.addDias(hoje, antecedenciaDias);
  const r = await query(
    `SELECT pc.id, pc.numero, pc.valor, pc.vencimento, n.id AS neg_id, n.protocolo, n.metodo, n.qtd_parcelas,
            p.id AS pref_id, p.nome AS pref_nome, p.asaas_api_key, c.doc, c.nome, c.email, c.whatsapp
       FROM parcelas pc JOIN negociacoes n ON n.id=pc.negociacao_id JOIN prefeituras p ON p.id=n.prefeitura_id JOIN contribuintes c ON c.id=n.contribuinte_id
      WHERE pc.gateway_id IS NULL AND pc.status='pendente' AND n.status='ativo' AND pc.vencimento <= $1
      ORDER BY pc.vencimento LIMIT 500`, [limite]);
  let geradas = 0, falhas = 0;
  for (const x of r.rows) {
    try {
      const cob = await criarCobranca({
        pref: { asaas_api_key: x.asaas_api_key }, contribuinte: { doc: x.doc, nome: x.nome, email: x.email, whatsapp: x.whatsapp },
        valor: x.valor, vencimento: x.vencimento < hoje ? hoje : x.vencimento, metodo: x.metodo,
        descricao: `Parcelamento ${x.protocolo} – parcela ${x.numero}/${x.qtd_parcelas}`, referencia: `${x.protocolo}-${x.numero}`,
      });
      await query("UPDATE parcelas SET gateway_id=$2, linha_digitavel=$3, pix_copia_cola=$4, link_fatura=$5 WHERE id=$1", [x.id, cob.id, cob.linhaDigitavel, cob.pixCopiaCola, cob.link]);
      const det = x.metodo === "boleto"
        ? `${cob.linhaDigitavel ? `Linha digitável: ${cob.linhaDigitavel}\n` : ""}${cob.link ? `Boleto: ${cob.link}` : ""}`
        : `${cob.pixCopiaCola ? `Pix copia e cola: ${cob.pixCopiaCola}` : ""}`;
      const texto = `${x.pref_nome} – Negocie Aqui\nParcela ${x.numero}/${x.qtd_parcelas} do acordo ${x.protocolo}: ${U.brl(x.valor)}, vence em ${U.fmtData(x.vencimento)}.\n${det}`;
      if (x.email) await enviarEmail(x.email, `Parcela ${x.numero}/${x.qtd_parcelas} – acordo ${x.protocolo}`, `<pre style="font-family:inherit;white-space:pre-wrap">${esc(texto)}</pre>`).catch((e) => console.error("email:", e.message));
      if (x.whatsapp) await enviarWhatsapp(x.whatsapp, texto).catch((e) => console.error("whatsapp:", e.message));
      geradas++;
    } catch (e) { falhas++; console.error(`parcela ${x.id}:`, e.message); }
  }
  return { geradas, falhas };
}

module.exports = { gerarCobrancasPendentes };
