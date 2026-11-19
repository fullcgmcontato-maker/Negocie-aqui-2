/**
 * Integração com o gateway de pagamento (Asaas). Ponto único: troque aqui para Efí/Mercado Pago, se quiser.
 *
 * Cada prefeitura pode ter a própria chave (conta/subconta Asaas), para o dinheiro cair na conta do município.
 * Sem chave nenhuma, gera cobrança SIMULADA (desenvolvimento e demonstração).
 *
 * ATENÇÃO: confira os nomes de campos na documentação oficial do Asaas e teste no sandbox antes de produção.
 */
const { randomToken } = require("./util");

const BASE = () => process.env.ASAAS_BASE_URL || "https://api-sandbox.asaas.com/v3";

async function asaas(chave, metodo, rota, corpo) {
  const resp = await fetch(BASE() + rota, {
    method: metodo,
    headers: { "Content-Type": "application/json", access_token: chave, "User-Agent": "NegocieAqui/2.0" },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (dados.errors && dados.errors[0] && dados.errors[0].description) || `Asaas respondeu ${resp.status}`;
    throw new Error(msg);
  }
  return dados;
}

function simulada(metodo, valor) {
  const id = "sim_" + randomToken(6);
  return {
    id,
    simulado: true,
    linhaDigitavel: metodo === "boleto" ? "00190.00009 01234.567890 12345.678901 1 23450000012345" : null,
    pixCopiaCola: metodo === "pix" ? `00020126SIMULADO${id}5204000053039865406${valor.toFixed(2)}5802BR` : null,
    link: null,
  };
}

/**
 * @param {object} p {pref, contribuinte:{doc,nome,email,whatsapp}, valor, vencimento, metodo, descricao, referencia}
 * @returns {{id, linhaDigitavel, pixCopiaCola, link, simulado}}
 */
async function criarCobranca(p) {
  const chave = p.pref.asaas_api_key || process.env.ASAAS_API_KEY;
  if (!chave) return simulada(p.metodo, p.valor);

  const cliente = await asaas(chave, "POST", "/customers", {
    name: p.contribuinte.nome || "Contribuinte",
    cpfCnpj: p.contribuinte.doc,
    email: p.contribuinte.email || undefined,
    mobilePhone: (p.contribuinte.whatsapp || "").replace(/\D/g, "") || undefined,
    notificationDisabled: true, // quem avisa é o Negocie Aqui (email e WhatsApp)
  });
  const pg = await asaas(chave, "POST", "/payments", {
    customer: cliente.id,
    billingType: p.metodo === "pix" ? "PIX" : "BOLETO",
    value: p.valor,
    dueDate: p.vencimento,
    description: p.descricao,
    externalReference: p.referencia,
  });
  const out = { id: pg.id, simulado: false, linhaDigitavel: null, pixCopiaCola: null, link: pg.bankSlipUrl || pg.invoiceUrl || null };
  if (p.metodo === "pix") {
    const qr = await asaas(chave, "GET", `/payments/${pg.id}/pixQrCode`);
    out.pixCopiaCola = qr.payload;
  } else {
    const ln = await asaas(chave, "GET", `/payments/${pg.id}/identificationField`);
    out.linhaDigitavel = ln.identificationField;
  }
  return out;
}

module.exports = { criarCobranca };
