-- Negocie Aqui — esquema do banco (PostgreSQL). Idempotente: roda a cada inicialização.

CREATE TABLE IF NOT EXISTS prefeituras (
  id              SERIAL PRIMARY KEY,
  slug            TEXT UNIQUE NOT NULL,
  nome            TEXT NOT NULL,                 -- ex.: "Prefeitura Municipal de Timóteo"
  cnpj            TEXT,
  corr_padrao     NUMERIC(8,4) NOT NULL DEFAULT 1,      -- correção monetária, % ao mês
  juros_padrao    NUMERIC(8,4) NOT NULL DEFAULT 0.33,   -- juros de mora, % ao dia
  limite_padrao   NUMERIC(8,4),                         -- teto dos juros, % do valor corrigido (NULL = sem teto)
  taxa_parcelamento NUMERIC(8,4) NOT NULL DEFAULT 1.2,  -- acréscimo, % ao mês por parcela adicional
  max_parcelas    INT NOT NULL DEFAULT 12,
  dias_1a_parcela INT NOT NULL DEFAULT 3,               -- vencimento da 1ª parcela: hoje + N dias
  asaas_api_key   TEXT,                                  -- chave da conta/subconta da prefeitura no gateway
  termo_modelo    TEXT,                                  -- texto jurídico próprio (NULL = modelo padrão)
  ativo           BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS regras_tributarias (
  id            SERIAL PRIMARY KEY,
  prefeitura_id INT NOT NULL REFERENCES prefeituras(id) ON DELETE CASCADE,
  codigo        TEXT NOT NULL,                  -- ex.: IPTU, ISS, TAXA-LIXO
  chave         TEXT NOT NULL,                  -- codigo normalizado (sem acento/pontuação, minúsculo)
  corr          NUMERIC(8,4),                   -- NULL = usa o padrão da prefeitura
  juros         NUMERIC(8,4),
  limite        NUMERIC(8,4),
  UNIQUE (prefeitura_id, chave)
);

CREATE TABLE IF NOT EXISTS contribuintes (
  id          SERIAL PRIMARY KEY,
  doc         TEXT UNIQUE NOT NULL,             -- CPF (11) ou CNPJ (14), só dígitos
  nome        TEXT,
  endereco    TEXT,
  email       TEXT,
  whatsapp    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS importacoes (
  id            SERIAL PRIMARY KEY,
  admin_id      INT,
  arquivo       TEXT NOT NULL,
  linhas_ok     INT NOT NULL DEFAULT 0,
  linhas_erro   INT NOT NULL DEFAULT 0,
  erros         JSONB,
  prefeituras   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS debitos (
  id              SERIAL PRIMARY KEY,
  prefeitura_id   INT NOT NULL REFERENCES prefeituras(id) ON DELETE CASCADE,
  contribuinte_id INT NOT NULL REFERENCES contribuintes(id) ON DELETE CASCADE,
  codigo          TEXT NOT NULL DEFAULT '',     -- código tributário (chave da regra de índices)
  descricao       TEXT NOT NULL,                -- ex.: "IPTU 2024"
  valor_original  NUMERIC(14,2) NOT NULL,
  vencimento      DATE,                          -- NULL = valor fixo (usa encargos_fixos)
  encargos_fixos  NUMERIC(14,2) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'aberto', -- aberto | negociado | pago
  importacao_id   INT REFERENCES importacoes(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS debitos_contrib_idx ON debitos (contribuinte_id, prefeitura_id, status);

CREATE TABLE IF NOT EXISTS acessos (
  id              SERIAL PRIMARY KEY,
  contribuinte_id INT NOT NULL REFERENCES contribuintes(id) ON DELETE CASCADE,
  prefeitura_id   INT NOT NULL REFERENCES prefeituras(id) ON DELETE CASCADE,
  token_hash      TEXT UNIQUE NOT NULL,
  expira_em       TIMESTAMPTZ NOT NULL,
  usado           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS negociacoes (
  id               SERIAL PRIMARY KEY,
  protocolo        TEXT UNIQUE NOT NULL,
  prefeitura_id    INT NOT NULL REFERENCES prefeituras(id),
  contribuinte_id  INT NOT NULL REFERENCES contribuintes(id),
  qtd_parcelas     INT NOT NULL,
  valor_consolidado NUMERIC(14,2) NOT NULL,     -- soma dos débitos atualizados na data do acordo
  valor_total      NUMERIC(14,2) NOT NULL,      -- com acréscimo do parcelamento
  data_calculo     DATE NOT NULL,
  metodo           TEXT NOT NULL,               -- pix | boleto
  status           TEXT NOT NULL DEFAULT 'ativo', -- ativo | quitado | inadimplente | cancelado
  termo_texto      TEXT NOT NULL,
  termo_hash       TEXT NOT NULL,
  codigo_autenticacao TEXT NOT NULL,
  aceite_em        TIMESTAMPTZ NOT NULL,
  aceite_ip        TEXT,
  aceite_agente    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS negociacao_debitos (
  negociacao_id INT NOT NULL REFERENCES negociacoes(id) ON DELETE CASCADE,
  debito_id     INT NOT NULL REFERENCES debitos(id),
  descricao     TEXT NOT NULL,
  original      NUMERIC(14,2) NOT NULL,
  correcao      NUMERIC(14,2) NOT NULL,
  juros         NUMERIC(14,2) NOT NULL,
  dias          INT NOT NULL,
  PRIMARY KEY (negociacao_id, debito_id)
);

CREATE TABLE IF NOT EXISTS parcelas (
  id               SERIAL PRIMARY KEY,
  negociacao_id    INT NOT NULL REFERENCES negociacoes(id) ON DELETE CASCADE,
  numero           INT NOT NULL,
  valor            NUMERIC(14,2) NOT NULL,
  vencimento       DATE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pendente', -- pendente | pago | atrasado
  gateway_id       TEXT,
  linha_digitavel  TEXT,
  pix_copia_cola   TEXT,
  link_fatura      TEXT,
  pago_em          TIMESTAMPTZ,
  UNIQUE (negociacao_id, numero)
);
CREATE INDEX IF NOT EXISTS parcelas_gateway_idx ON parcelas (gateway_id);

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  senha_hash    TEXT NOT NULL,                  -- scrypt
  papel         TEXT NOT NULL,                  -- super (equipe Full) | prefeitura
  prefeitura_id INT REFERENCES prefeituras(id) ON DELETE CASCADE,
  ativo         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auditoria (
  id         BIGSERIAL PRIMARY KEY,
  ator       TEXT NOT NULL,                     -- admin:ID | contribuinte:ID | sistema
  acao       TEXT NOT NULL,
  detalhe    JSONB,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
