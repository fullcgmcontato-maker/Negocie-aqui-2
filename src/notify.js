/**
 * Envio de email e WhatsApp.
 * Sem configuração, roda em modo SIMULADO (só registra no log), para dar para testar o fluxo inteiro.
 */
const nodemailer = require("nodemailer");

const caixaDeTestes = []; // usada nos testes automatizados
let transporter = null;

function getTransporter() {
  if (transporter || !process.env.SMTP_HOST) return transporter;
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return transporter;
}

async function enviarEmail(para, assunto, html) {
  if (process.env.NODE_ENV === "test") caixaDeTestes.push({ canal: "email", para, assunto, html });
  const t = getTransporter();
  if (!t) {
    console.log(`[email SIMULADO] para=${para} assunto="${assunto}"`);
    return { simulado: true };
  }
  await t.sendMail({ from: process.env.MAIL_FROM || "Negocie Aqui <naoresponda@negocieaqui.app.br>", to: para, subject: assunto, html });
  return { simulado: false };
}

/**
 * WhatsApp via API de um provedor (Z-API, Twilio, Meta Cloud API...).
 * Aqui vai um envio genérico: POST WHATSAPP_API_URL com {phone, message} e Bearer WHATSAPP_API_TOKEN.
 * Ajuste o corpo/cabeçalhos conforme o provedor contratado.
 */
async function enviarWhatsapp(numero, texto) {
  if (process.env.NODE_ENV === "test") caixaDeTestes.push({ canal: "whatsapp", para: numero, texto });
  const fone = String(numero || "").replace(/\D/g, "");
  if (!process.env.WHATSAPP_API_URL) {
    console.log(`[whatsapp SIMULADO] para=${fone}`);
    return { simulado: true };
  }
  const resp = await fetch(process.env.WHATSAPP_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN || ""}` },
    body: JSON.stringify({ phone: fone.startsWith("55") ? fone : "55" + fone, message: texto }),
  });
  if (!resp.ok) throw new Error(`WhatsApp respondeu ${resp.status}`);
  return { simulado: false };
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const emailAcesso = (link, prefeituraNome) => `
  <p>Olá!</p>
  <p>Use o link abaixo para acessar sua negociação com <b>${esc(prefeituraNome)}</b> no Negocie Aqui:</p>
  <p><a href="${esc(link)}">${esc(link)}</a></p>
  <p>O link vale por ${process.env.ACESSO_MIN || 30} minutos e só pode ser usado uma vez.
  Se você não pediu este acesso, ignore esta mensagem.</p>`;

module.exports = { enviarEmail, enviarWhatsapp, emailAcesso, caixaDeTestes, esc };
