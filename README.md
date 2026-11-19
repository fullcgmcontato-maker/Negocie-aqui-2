# Negocie Aqui (v2)

Portal de negociação de débitos municipais, multi‑prefeitura. Node 20+, Express, PostgreSQL.

- `src/` — API (`routes-publico.js`, `routes-admin.js`), cálculo (`calc.js`), importação de planilha (`importer.js`), termo (`termo.js`), pagamentos (`payments.js`), avisos (`notify.js`), rotina diária (`jobs.js`).
- `public/` — tela do contribuinte e área da prefeitura (HTML/CSS/JS puro, sem build).
- `db/schema.sql` — banco (aplicado automaticamente ao iniciar).
- `test/run.js` — testes da API (`npm test`, usa `DATABASE_URL` de teste e **apaga** o banco). `test/e2e.js` — fluxo no navegador (Playwright).
- `render.yaml` — publicação no Render. **Leia `GUIA-PUBLICACAO.md`.**

Regras de cálculo: correção monetária % ao mês (proporcional aos dias) sobre o original; juros de mora % ao dia, simples, sobre o valor corrigido, com teto opcional; índices por código tributário (em branco = padrão da prefeitura); recalculado todo dia a partir do vencimento.
