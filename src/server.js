require("dotenv").config();
const path = require("path");
const express = require("express");
const helmet = require("helmet");
const { migrate, query } = require("./db");
const U = require("./util");

function criarApp() {
  const app = express();
  app.set("trust proxy", 1); // atrás do proxy da hospedagem (IP real para limites e auditoria)
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
    })
  );
  app.use(express.json({ limit: "100kb" }));

  // captura erros de rotas async sem derrubar o processo
  const envolve = (router) => {
    router.stack.forEach((l) => {
      if (l.route) l.route.stack.forEach((s) => {
        const f = s.handle;
        if (f.length <= 3) s.handle = (req, res, next) => Promise.resolve(f(req, res, next)).catch(next);
      });
    });
    return router;
  };
  app.get("/api/saude", async (req, res) => {
    try { await query("SELECT 1"); res.json({ ok: true }); } catch { res.status(500).json({ ok: false }); }
  });
  app.use("/api/admin", envolve(require("./routes-admin")));
  app.use("/api", envolve(require("./routes-publico")));
  app.use("/api", (req, res) => res.status(404).json({ erro: "Rota não encontrada." }));

  app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: "5m", index: "index.html" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ erro: "Erro interno. Tente novamente em instantes." });
  });
  return app;
}

async function bootstrapSuper() {
  const email = (process.env.SUPERADMIN_EMAIL || "").trim().toLowerCase();
  const senha = process.env.SUPERADMIN_PASSWORD || "";
  if (!email || !senha) return;
  const r = await query("SELECT 1 FROM admins WHERE email=$1", [email]);
  if (r.rows.length) return;
  if (senha.length < 10) { console.error("SUPERADMIN_PASSWORD precisa ter 10+ caracteres; usuário não criado."); return; }
  await query("INSERT INTO admins (email, senha_hash, papel) VALUES ($1,$2,'super')", [email, U.hashSenha(senha)]);
  console.log(`Usuário administrador criado: ${email}`);
}

async function iniciar() {
  await migrate();
  await bootstrapSuper();
  const porta = Number(process.env.PORT || 3000);
  criarApp().listen(porta, () => console.log(`Negocie Aqui no ar na porta ${porta}`));
}

if (require.main === module) iniciar().catch((e) => { console.error(e); process.exit(1); });

module.exports = { criarApp, bootstrapSuper };
