const fs = require("fs");
const path = require("path");
const pg = require("pg");
const { Pool } = pg;

// DATE volta como texto "AAAA-MM-DD" (sem fuso) e NUMERIC como número.
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const url = process.env.DATABASE_URL;
const ssl = process.env.DATABASE_SSL === "false" || !url || /localhost|127\.0\.0\.1|\/tmp\//.test(url)
  ? false
  : { rejectUnauthorized: false }; // Railway/Render exigem SSL

const pool = new Pool({ connectionString: url, ssl, max: 10 });

const query = (text, params) => pool.query(text, params);

/** Executa várias queries na mesma transação. */
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, "..", "db", "schema.sql"), "utf8");
  await pool.query(sql);
}

async function audit(ator, acao, detalhe, ip) {
  try {
    await pool.query("INSERT INTO auditoria (ator, acao, detalhe, ip) VALUES ($1,$2,$3,$4)", [
      ator, acao, detalhe ? JSON.stringify(detalhe) : null, ip || null,
    ]);
  } catch (e) {
    console.error("falha ao gravar auditoria:", e.message);
  }
}

module.exports = { pool, query, tx, migrate, audit };
