/**
 * Termo de Confissão de Dívida e Compromisso de Pagamento Parcelado.
 * Texto-modelo: DEVE ser validado pela Procuradoria de cada município antes do uso real.
 * Cada prefeitura pode acrescentar cláusulas próprias em prefeituras.termo_modelo.
 */
const crypto = require("crypto");
const { brl, fmtData } = require("./util");

function montarTermo({ pref, contribuinte, debitos, consolidado, total, parcelas, hoje, metodo }) {
  const principal = debitos.reduce((a, d) => a + d.original, 0);
  const encargos = consolidado - principal;
  const credor = String(pref.nome).toUpperCase();
  const docRot = contribuinte.doc.length === 14 ? "CNPJ" : "CPF";
  const docFmt = contribuinte.doc.length === 14
    ? contribuinte.doc.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5")
    : contribuinte.doc.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");

  const partes = [
    { tipo: "titulo", texto: "TERMO DE CONFISSÃO DE DÍVIDA E COMPROMISSO DE PAGAMENTO PARCELADO" },
    { tipo: "p", texto: `CREDOR: ${credor}, doravante denominado MUNICÍPIO.` },
    {
      tipo: "p",
      texto: `DEVEDOR: ${contribuinte.nome || "CONTRIBUINTE"}, ${docRot} nº ${docFmt}, com endereço para contato em ${contribuinte.endereco || "o informado no cadastro"}.`,
    },
    {
      tipo: "p",
      texto:
        `Cláusula 1ª – Da confissão. O DEVEDOR reconhece e confessa, de forma irrevogável e irretratável, ser devedor do MUNICÍPIO do crédito referente a ` +
        `${debitos.map((d) => d.descricao).join("; ")}, no valor consolidado de ${brl(consolidado)} ` +
        `(principal de ${brl(principal)}, mais correção monetária e juros de ${brl(encargos)}, apurados até ${fmtData(hoje)}). ` +
        `Esta confissão constitui ato inequívoco de reconhecimento do débito, nos termos do art. 174, parágrafo único, IV, do Código Tributário Nacional.`,
    },
    {
      tipo: "p",
      texto:
        `Cláusula 2ª – Do parcelamento. O DEVEDOR obriga-se a pagar o débito confessado em ${parcelas.length} parcela(s) mensal(is) e sucessiva(s), ` +
        `totalizando ${brl(total)}, valor que já inclui os encargos do parcelamento, conforme o cronograma abaixo:`,
    },
    { tipo: "tabela", linhas: parcelas.map((p) => ({ numero: `${p.numero}/${parcelas.length}`, vencimento: fmtData(p.vencimento), valor: brl(p.valor) })) },
    {
      tipo: "p",
      texto: `Cláusula 3ª – Da forma de pagamento. O pagamento será feito por ${metodo === "pix" ? "Pix" : "boleto bancário"}, gerado pelo portal Negocie Aqui para cada parcela.`,
    },
    {
      tipo: "p",
      texto:
        "Cláusula 4ª – Do inadimplemento. O atraso no pagamento de qualquer parcela sujeitará o DEVEDOR aos acréscimos moratórios previstos na legislação municipal " +
        "e poderá ensejar o vencimento antecipado das demais parcelas, o cancelamento do parcelamento e o prosseguimento da cobrança do saldo remanescente em dívida ativa, inclusive por via judicial.",
    },
    {
      tipo: "p",
      texto:
        "Cláusula 5ª – Dos dados pessoais. O DEVEDOR autoriza o tratamento de seus dados pessoais para fins de cobrança, constituição e controle deste parcelamento, nos termos da Lei nº 13.709/2018 (LGPD).",
    },
    {
      tipo: "p",
      texto:
        "Cláusula 6ª – Da assinatura eletrônica. As partes reconhecem como válida a assinatura eletrônica do DEVEDOR, realizada mediante aceite expresso no portal, " +
        "com registro de data, hora, endereço de rede e código de autenticação, nos termos da Lei nº 14.063/2020.",
    },
  ];
  if (pref.termo_modelo && pref.termo_modelo.trim()) partes.push({ tipo: "p", texto: `Cláusula adicional. ${pref.termo_modelo.trim()}` });

  const texto = partes
    .map((p) => (p.tipo === "tabela" ? p.linhas.map((l) => `  ${l.numero} | ${l.vencimento} | ${l.valor}`).join("\n") : p.texto))
    .join("\n\n");
  const hash = crypto.createHash("sha256").update(texto).digest("hex");
  return { partes, texto, hash };
}

module.exports = { montarTermo };
