require("dotenv").config();
const { pool } = require("../src/db");
const { gerarCobrancasPendentes } = require("../src/jobs");
gerarCobrancasPendentes().then((r) => { console.log("Rotina diária:", r); return pool.end(); }).catch((e) => { console.error(e); process.exit(1); });
