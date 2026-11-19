# Negocie Aqui — guia de publicação (passo a passo)

Tempo estimado: 1 a 2 horas para colocar no ar em modo de teste; mais alguns dias para contas de pagamento e WhatsApp serem aprovadas.

## Visão geral

```
Contribuinte ──► consulta.negocieaqui.app.br ──► Render (site Node + banco PostgreSQL + rotina diária)
                       ▲                                   │
   DNS (Hostinger/GoDaddy/Registro.br)                     ├─► Email (SMTP)
                                                           ├─► Asaas (Pix/boleto) ──webhook──► /api/webhooks/asaas
                                                           ├─► WhatsApp (provedor)
                                                           └─► Karen (API da Anthropic)
```

O seu site atual em `negocieaqui.app.br` **não precisa ser mexido**: o sistema novo vai num subdomínio (ex.: `consulta.negocieaqui.app.br`). Depois, se quiser, um subdomínio por prefeitura (ex.: `timoteo.negocieaqui.app.br`) apontando para o mesmo serviço.

---

## Passo 1 — Guardar o código no GitHub (privado)

1. Crie uma conta em github.com e um repositório **privado** chamado `negocie-aqui`.
2. Envie a pasta do projeto (sem `node_modules` e **sem `.env`** — o `.gitignore` já cuida disso):
   ```bash
   git init && git add . && git commit -m "Negocie Aqui v2"
   git branch -M main
   git remote add origin https://github.com/SEU_USUARIO/negocie-aqui.git
   git push -u origin main
   ```
   Sem Git instalado? No GitHub, use *Add file → Upload files* e arraste os arquivos.

## Passo 2 — Criar o serviço no Render

1. Crie conta em render.com e conecte o GitHub.
2. *New → Blueprint* → escolha o repositório. O arquivo `render.yaml` cria sozinho: o site, o banco PostgreSQL e a rotina diária.
3. Quando pedir os valores marcados como secretos, preencha:

| Variável | O que colocar |
|---|---|
| `APP_URL` | `https://consulta.negocieaqui.app.br` (o endereço final) |
| `SUPERADMIN_EMAIL` / `SUPERADMIN_PASSWORD` | seu login da equipe Full (senha com 10+ caracteres) |
| `ASAAS_WEBHOOK_TOKEN` | um texto longo e aleatório (você o repete no Asaas, passo 6) |
| `SMTP_*`, `MAIL_FROM` | dados do email (passo 5) — pode deixar vazio no início |
| `ANTHROPIC_API_KEY` | chave da Karen (passo 8) — opcional no início |

4. Aguarde o deploy. Abra `https://negocie-aqui.onrender.com/api/saude`: deve responder `{"ok":true}`.
5. Abra o endereço do site e entre em **Área da prefeitura** com o email/senha do `SUPERADMIN_*`.

> Planos: o banco gratuito do Render é só para teste; em produção use um plano pago (com backup). Os nomes/valores dos planos mudam — confira no painel.

## Passo 3 — Ligar o seu domínio

No Render: serviço *negocie-aqui → Settings → Custom Domains → Add* `consulta.negocieaqui.app.br`. Ele mostra um alvo (ex.: `negocie-aqui.onrender.com`).

No painel onde o DNS do domínio é gerenciado, crie um registro:

| Tipo | Nome/Host | Valor/Aponta para |
|---|---|---|
| CNAME | `consulta` | o alvo mostrado pelo Render |

- **Hostinger:** hPanel → Domínios → *Zona DNS* → adicionar registro.
- **GoDaddy:** Meus produtos → DNS → Adicionar.
- **Registro.br** (domínios `.br`): se o DNS estiver no Registro.br, use *Editar zona*; se estiver na Hostinger/GoDaddy, edite lá (olhe quais *servidores DNS* o domínio usa).

Aguarde a propagação (de minutos a algumas horas) e o Render emite o HTTPS sozinho. **Não apague** os registros que já fazem o site atual funcionar.

## Passo 4 — Cadastrar a primeira prefeitura e importar a planilha

1. Área da prefeitura → aba **Prefeituras** → cadastre o nome (ex.: *Prefeitura Municipal de Timóteo*).
2. Aba **Juros e correção** → confira correção 1% a.m. e juros 0,33% a.d.; defina **teto dos juros** (veja “Decisões importantes”) e as exceções por código tributário.
3. Aba **Planilha** → escolha a prefeitura → envie a planilha. Colunas reconhecidas automaticamente: CPF e/ou CNPJ, nome, endereço, valor, vencimento, tributo/código, ano e (se tiver várias prefeituras no mesmo arquivo) prefeitura.
4. Crie um usuário para a equipe da prefeitura (aba Prefeituras → *Novo usuário*): ele só enxerga a própria prefeitura.
5. Teste com um CPF da planilha, do começo ao fim.

## Passo 5 — Email (link de acesso e avisos)

Contrate um serviço de email transacional (ex.: Brevo, Amazon SES, Resend, Mailgun ou o SMTP do seu plano da Hostinger). Preencha `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` e `MAIL_FROM`.

Para os emails não caírem no spam, no DNS do domínio cadastre os registros **SPF** e **DKIM** que o serviço indicar (e, se possível, DMARC).

Teste: faça um cadastro com seu próprio email e veja se o link chega.

## Passo 6 — Pagamentos (Pix e boleto) com Asaas

1. Crie conta no Asaas e use primeiro o **sandbox** (`ASAAS_BASE_URL=https://api-sandbox.asaas.com/v3`, chave de sandbox em `ASAAS_API_KEY`).
2. No Asaas, cadastre o **webhook**: URL `https://consulta.negocieaqui.app.br/api/webhooks/asaas`, eventos de pagamento (recebido/confirmado/vencido) e o **token de autenticação** igual ao `ASAAS_WEBHOOK_TOKEN`.
3. Teste uma negociação com Pix e outra com boleto no sandbox e confirme que o pagamento marca a parcela como paga.
4. **Importante — conta do dinheiro:** o dinheiro precisa cair na conta *da prefeitura*, não na sua. A forma correta (subcontas Asaas por município, ou conta própria de cada prefeitura) deve ser definida em contrato e com o Asaas. O sistema aceita uma chave Asaas por prefeitura (campo `asaas_api_key`, gravado pela equipe Full).
5. Só depois do teste, troque para `https://api.asaas.com/v3` e a chave de produção.

> Os campos da API do Asaas foram implementados conforme a documentação pública, mas **devem ser validados no sandbox** antes de qualquer cobrança real.

## Passo 7 — WhatsApp

O envio genérico está em `src/notify.js` (`enviarWhatsapp`): faz `POST` em `WHATSAPP_API_URL` com `{phone, message}` e `Authorization: Bearer WHATSAPP_API_TOKEN`. Escolha um provedor (Z-API, Twilio, Meta WhatsApp Cloud API…) e **ajuste o corpo/cabeçalhos** conforme a documentação dele. Com a API oficial da Meta, mensagens iniciadas pela empresa exigem *templates* aprovados.

## Passo 8 — Karen (assistente)

Crie uma chave em console.anthropic.com e coloque em `ANTHROPIC_API_KEY`. A Karen **não recebe nome, CPF nem valores** — só a pergunta e o nome da tela. Há limite de mensagens por visitante. Sem a chave, ela mostra apenas as dicas de cada passo.

## Passo 9 — Rotina diária (parcelas 2, 3, 4…)

No fechamento do acordo é gerada a cobrança da 1ª parcela. As demais são geradas e enviadas (email + WhatsApp) pela rotina diária do Render (`negocie-aqui-rotina-diaria`, todo dia às 8h de Brasília), `DIAS_ANTECEDENCIA` dias antes do vencimento. Confirme no painel do Render que o *Cron Job* existe e rode uma vez manualmente para testar.

---

## Decisões importantes antes de usar com contribuintes reais

1. **Teto dos juros.** Juros de 0,33% ao dia **sem teto** passam de 100% em um ano (um débito de R$ 1.000 vencido há quase 2 anos passou de R$ 4.000 nos testes). Verifique a lei municipal: a multa de mora costuma ter teto (no âmbito federal, 20%) e os juros costumam seguir a Selic. Defina o **teto** na tela de juros e correção.
2. **Texto do termo.** O Termo de Confissão de Dívida em `src/termo.js` é um **modelo**. Ele deve ser revisado/aprovado pela Procuradoria de cada município (a tela permite incluir uma cláusula adicional por prefeitura).
3. **Contrato com a prefeitura:** quem é controlador e quem é operador dos dados (LGPD), prazo de guarda, para onde vai o dinheiro, suporte e responsabilidade.
4. **Aviso de privacidade:** publique política de privacidade e canal do encarregado (DPO).
5. **Senhas:** a senha `Full123` do protótipo **não existe** no sistema real. Use senhas fortes e únicas; troque as iniciais.
6. **Backups:** ative backups do banco no Render e teste a restauração.
7. **Domínio/prefeituras:** exigem que o contribuinte confie — use sempre o nome oficial da prefeitura (já aparece no topo e no termo).

## Segurança já embutida

Valores recalculados **no servidor** (o navegador não decide nada); links de acesso de uso único com validade de 30 min (armazenados só como hash); sessão com expiração; senhas de administradores com scrypt; limite de tentativas por IP; política de segurança de conteúdo (CSP) restrita; registro de auditoria; aceite eletrônico gravado com data/hora, IP, navegador, hash do texto do termo e código de autenticação; webhook protegido por token.

## Manutenção

- Logs: painel do Render → *Logs*.
- Atualizar: envie as alterações ao GitHub; o Render publica sozinho.
- Rodar localmente: `npm install`, copiar `.env.example` para `.env` (com `DATABASE_URL` de um Postgres local) e `npm start`. Testes: `npm test` (exige Postgres local de teste; **apaga** o banco apontado em `DATABASE_URL`).
