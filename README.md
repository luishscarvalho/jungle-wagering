# Jungle Wagering

Processador distribuído de transações de apostas. Recebe operações de provedores de jogos (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) por HTTP e por SQS, aplica cada uma exatamente uma vez sobre um saldo materializado com ledger auditável e publica eventos de integração via transactional outbox.

O sistema continua correto com mensagens duplicadas, entregues fora de ordem ou processadas ao mesmo tempo por várias instâncias. As decisões, invariantes e limitações estão em [ARCHITECTURE.md](./ARCHITECTURE.md).

Stack: Bun, TypeScript strict, NestJS, MikroORM, PostgreSQL, SQS (MiniStack), Docker Compose.

## Pré-requisitos

- Docker com Compose v2
- Bun 1.x, para rodar os testes e o `sqs:send` no host (a aplicação em si roda em container)
- Portas livres: 3000, 4566 e 5432

## Setup

```bash
cp .env.example .env
bun install
docker compose up -d --build
docker compose ps
```

O `up` sobe, nesta ordem: `postgres` e `ministack`, `sqs-init` (cria as filas e sai), `migrate` (aplica as migrations e sai) e as instâncias da aplicação.

| Serviço | Papéis (`ROLES`) | Porta no host |
|---|---|---|
| `app-1` | `api,consumer,outbox,pending` | 3000 |
| `app-2` | `consumer,outbox,pending` | nenhuma |
| `app-3` | `consumer,outbox,pending` | nenhuma |

Em `docker compose ps`, as três instâncias devem aparecer como `healthy`, e `sqs-init` e `migrate` como `Exited (0)`.

Para recomeçar do zero: `docker compose down -v`.

## Testes

Integração e concorrência usam Postgres e MiniStack reais, então a stack precisa estar no ar. Cada suíte cria o próprio banco e as próprias filas, e por isso pode rodar com as instâncias da aplicação de pé.

```bash
bun run test               # unidade: domínio, mappers, config
bun run test:integration   # integração: migrations, constraints, HTTP, SQS, workers, métricas
bun run test:concurrency   # concorrência: paralelismo real e múltiplos processos
bun run test:all           # as três, nessa ordem
```

Do zero:

```bash
docker compose down -v && docker compose up -d --build && bun run test:all
```

As migrations também podem rodar no host com `bun run migration:up` e ser revertidas com `bun run migration:down`.

## API

Os exemplos usam estas variáveis:

```bash
API=http://localhost:3000
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1
```

### Criar wallet

```bash
curl -s -X POST $API/wallets \
  -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}"
```

```json
{ "id": "01a1a748-5918-7607-9d3c-1f5a71717361", "playerId": "0192f28f-...", "balance": { "amount": "1000.00", "currency": "BRL" }, "version": 1 }
```

Guarde o id:

```bash
WALLET=01a1a748-5918-7607-9d3c-1f5a71717361
```

### Submeter transação

```bash
curl -s -i -X POST $API/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:tx-1' \
  -d "{
    \"providerId\": \"provider-a\",
    \"externalTransactionId\": \"tx-1\",
    \"playerId\": \"$PLAYER\",
    \"walletId\": \"$WALLET\",
    \"roundId\": \"round-1\",
    \"gameId\": \"fortune-chimp\",
    \"kind\": \"BET\",
    \"money\": { \"amount\": \"25.00\", \"currency\": \"BRL\" }
  }"
```

```json
{ "transactionId": "01a1a748-5945-7542-ae03-30c1004229d8", "status": "PROCESSED", "balance": { "amount": "975.00", "currency": "BRL" }, "idempotentReplay": false }
```

Repetir o mesmo comando devolve a mesma resposta com `idempotentReplay: true` e não move saldo.

`REFUND` e `ROLLBACK` exigem o campo `referenceExternalTransactionId`. Se a referência ainda não chegou, a resposta é `202` com status `PENDING_REFERENCE`, e um worker reprocessa depois.

| Status | Quando |
|---|---|
| 200 | processada, ou replay de uma processada |
| 202 | aguardando a referência |
| 400 | payload inválido, moeda ou jogador divergente, `OPENING` |
| 404 | wallet ou recurso inexistente |
| 409 | conflito de idempotência, wallet duplicada |
| 422 | rejeição de negócio persistida, por exemplo `INSUFFICIENT_FUNDS` |
| 500 | transação em `FAILED`, erro inesperado |
| 503 | infraestrutura transitória, pode reenviar |

Todo erro traz `failureCode`. A taxonomia completa está no [ARCHITECTURE.md](./ARCHITECTURE.md#7-taxonomia-de-failurecode-e-mapeamento-http).

### Consultas

```bash
curl -s $API/wallets/$WALLET
curl -s "$API/wallets/$WALLET/ledger?limit=50"
curl -s "$API/wallets/$WALLET/ledger?limit=50&cursor=<nextCursor da página anterior>"
curl -s $API/wagering/transactions/<transactionId>
curl -s $API/providers/provider-a/wagering/transactions/tx-1
```

### Reconciliação

```bash
curl -s -X POST $API/wallets/$WALLET/reconciliation
```

```json
{ "walletId": "...", "storedBalance": { "amount": "975.00", "currency": "BRL" }, "calculatedBalance": { "amount": "975.00", "currency": "BRL" }, "difference": { "amount": "0.00", "currency": "BRL" }, "consistent": true, "checkedEntries": 2 }
```

Uma divergência é logada, contada em métrica e sinalizada com `consistent: false`. Nunca é corrigida.

### Health

```bash
curl -s $API/health/live    # processo vivo
curl -s $API/health/ready   # Postgres e SQS alcançáveis, 503 se não
```

## Mandar mensagem pela fila

`bun run sqs:send` publica em `wager-transactions.fifo`, com `MessageGroupId` igual ao id da wallet. Lê o endpoint e o nome da fila do `.env`.

```bash
# Aposta de 25.00 (padrões: kind BET, amount 25.00, currency BRL, provider provider-a, round round-1)
bun run sqs:send --wallet $WALLET --player $PLAYER

# Outro valor e um id externo escolhido
bun run sqs:send --wallet $WALLET --player $PLAYER --amount 10.00 --external-id tx-2

# Reversão entregue antes da referência: fica PENDING_REFERENCE até tx-3 chegar
bun run sqs:send --wallet $WALLET --player $PLAYER --kind REFUND --amount 5.00 --external-id tx-3-refund --reference tx-3
bun run sqs:send --wallet $WALLET --player $PLAYER --amount 5.00 --external-id tx-3

# Mesmo messageId duas vezes: um efeito só. Na janela de 5 min o FIFO descarta a cópia;
# depois dela, é a inbox que absorve
bun run sqs:send --wallet $WALLET --player $PLAYER --external-id tx-4 --message-id msg-4
bun run sqs:send --wallet $WALLET --player $PLAYER --external-id tx-4 --message-id msg-4

# Corpo inválido: vai para wager-transactions-dlq.fifo
bun run sqs:send --wallet $WALLET --raw 'not json'
```

O resultado aparece em `GET /wallets/$WALLET` e em `GET /providers/provider-a/wagering/transactions/<id>`. Para acompanhar o processamento:

```bash
docker compose logs -f app-1 app-2 app-3
```

## Métricas

`GET /metrics`, aberto, no formato Prometheus. Existe em toda instância, em qualquer papel. Os contadores são por processo: para o total, some as três.

```bash
curl -s localhost:3000/metrics | grep ^wagering_

# app-2 e app-3 não publicam porta no host
docker compose exec app-2 bun -e "fetch('http://localhost:3000/metrics').then(r => r.text()).then(console.log)"
```

| Métrica | Tipo | Labels | O que mede |
|---|---|---|---|
| `wagering_transactions_total` | counter | `status`, `kind` | transações entrando em um status. Uma transação pode contar mais de uma vez: `PENDING_REFERENCE`, depois `PROCESSED` |
| `wagering_refusals_total` | counter | `failure_code` | recusas sem transação gravada |
| `wagering_duplicates_total` | counter | `source`: `http_replay`, `sqs_replay`, `inbox` | duplicatas detectadas |
| `wagering_retries_total` | counter | `source`: `sqs`, `outbox`, `pending` | trabalho devolvido para nova tentativa |
| `wagering_dlq_messages_total` | counter | `reason` | mensagens enviadas pelo consumer para a DLQ |
| `wagering_lock_conflicts_total` | counter | `kind`: `lock_timeout`, `deadlock`, `unique_race` | transações perdidas por contenção |
| `wagering_outbox_lag_seconds` | gauge | | idade do evento não publicado mais antigo |
| `wagering_processing_duration_seconds` | histogram | `entry`: `http`, `sqs`, `pending` | latência de processamento, com espera de lock |
| `wagering_reconciliation_divergences_total` | counter | | reconciliações com divergência |

## Variáveis de ambiente

Com Docker Compose, as variáveis da aplicação já vêm definidas no `docker-compose.yml`. O `.env` é usado pelo Compose (`POSTGRES_*`) e pelo que roda no host: testes, migrations, `sqs:send` e `bun run dev`.

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `ROLES` | todos | papéis do processo: `api`, `consumer`, `outbox`, `pending` |
| `DATABASE_URL` | obrigatória | conexão com o Postgres |
| `DB_POOL_MAX` | `10` | tamanho do pool de conexões por instância |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` | `wagering` | credenciais do container do Postgres |
| `AWS_REGION` | obrigatória | região do SQS |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | | credenciais. O MiniStack aceita qualquer valor |
| `SQS_ENDPOINT` | obrigatória | endpoint do SQS |
| `SQS_QUEUE_NAME` | obrigatória | fila de entrada |
| `SQS_DLQ_NAME` | `wager-transactions-dlq.fifo` | dead letter queue |
| `SQS_EVENTS_QUEUE_NAME` | `wagering-events.fifo` | fila de eventos publicados pela outbox |
| `SQS_VISIBILITY_TIMEOUT_S` | `60` | visibility timeout ao receber |
| `SQS_SHUTDOWN_GRACE_MS` | `10000` | tempo para terminar o trabalho em andamento após `SIGTERM` |
| `OUTBOX_POLL_INTERVAL_MS` | `500` | intervalo do publisher quando ocioso |
| `OUTBOX_BACKOFF_BASE_MS`, `OUTBOX_BACKOFF_MAX_MS` | `1000`, `60000` | backoff de publicação |
| `PENDING_POLL_INTERVAL_MS` | `500` | intervalo do worker de referências quando ocioso |
| `PENDING_BACKOFF_BASE_MS`, `PENDING_BACKOFF_MAX_MS` | `1000`, `60000` | backoff de `PENDING_REFERENCE` |

`TEST_CRASH_AFTER_COMMIT` e `TEST_CRASH_AFTER_PUBLISH` existem só para os testes de processo: matam a instância em um ponto exato. Não defina fora deles.

## Estrutura

```text
src/domain           regras e invariantes, sem framework nem ORM
src/application      use cases e portas
src/infrastructure   db, sqs, http, workers, metrics
test/unit            sem I/O
test/integration     Postgres e MiniStack reais
test/concurrency     paralelismo real e múltiplos processos
```
