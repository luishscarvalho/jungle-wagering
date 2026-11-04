# Arquitetura

## 1. Visão geral

O serviço aplica operações de aposta sobre wallets. A unidade de concorrência é a wallet. As garantias vêm do PostgreSQL: lock pessimista por wallet, constraints e transação única. O broker é tratado como otimização, nunca como garantia.

O código segue três camadas. `src/domain` guarda regras e invariantes, sem framework nem ORM. `src/application` guarda use cases e portas. `src/infrastructure` implementa as portas com MikroORM, SQS, NestJS e prom-client.

Um mesmo binário sobe qualquer combinação de papéis via `ROLES`. Health e métricas ficam ativos em todos.

### Fluxos

```text
                HTTP                                    SQS
  provedor -- POST /wagering/transactions     wager-transactions.fifo
                 |                                       |
                 |                               WagerConsumer (role consumer)
                 |                                 parse do envelope
                 |                                   |            |
                 |                                 válido     malformado --> DLQ + delete
                 v                                   v
           +--------------------------------------------------+
           |            ProcessWagerTransaction               |
           |  valida payload, calcula payloadHash             |
           +--------------------------------------------------+
                                 |
     =========== transação SQL (READ COMMITTED, lock_timeout 5s) ===========
     |  1. inbox: INSERT ... ON CONFLICT DO NOTHING (só SQS)               |
     |  2. idempotência: busca por chave, sem lock (detecta replay cedo)   |
     |  3. SELECT wallet FOR UPDATE                                        |
     |  4. moeda e jogador; idempotência de novo (fonte da verdade)        |
     |  5. referência, evaluateWagerPolicy                                 |
     |  6. transação + ledger + saldo + outbox + acorda quem espera        |
     =======================================================================
                                 |
                              COMMIT
                      |                     |
                 HTTP responde        SQS: delete (ack)


  Outbox (role outbox, N publishers)
     transação: SELECT ... FOR UPDATE SKIP LOCKED (cabeça de cada aggregate)
                publica em wagering-events.fifo (grupo = aggregateId, dedup = eventId)
                marca published_at, ou agenda retry com backoff
     COMMIT


  PENDING_REFERENCE (role pending, N workers)
     lê as linhas vencidas, sem lock
     para cada uma, em transação própria:
        wallet FOR UPDATE --> linha FOR UPDATE, revalidando status e vencimento
        referência chegou:    aplica (mesmo WagerSettlement da entrada)
        ainda não:            attempts + 1, próximo backoff
        tentativas esgotadas: REJECTED REFERENCE_NOT_FOUND
        erro transitório:     rollback, attempts intacto, continua vencida
        erro permanente:      rollback, depois FAILED PROCESSING_FAILED em nova transação
```

### Mensagem do SQS: como cada resultado é tratado

| Situação | Ação na fila | Inbox |
|---|---|---|
| Processada, rejeitada por negócio ou pendente de referência | ack | gravada |
| Recusa de contrato com payload válido (moeda, jogador, wallet, `OPENING`), conflito de idempotência | ack | gravada |
| `messageId` repetido com mesmo hash | ack | já existia |
| `messageId` repetido com hash diferente | DLQ + delete | já existia |
| Envelope malformado, `INVALID_PAYLOAD` | DLQ + delete | nenhuma linha |
| Erro transitório | não deleta, ajusta visibilidade com backoff | rollback |
| Erro não transitório | DLQ + delete como `PROCESSING_FAILED` | rollback |

`INVALID_PAYLOAD` não grava inbox de propósito: uma linha faria uma redelivery após crash parecer processada, e a mensagem se perderia antes de chegar à DLQ.

## 2. Decisões

### Money em bigint e NUMERIC(20,2)

Internamente, `Money` guarda centavos em `bigint`, com escala fixa 2. Nos contratos, é string decimal. No Postgres, `NUMERIC(20,2)` e moeda em `CHAR(3)` separada, e o mapper converte string para bigint e de volta.

`number` perde exatidão e é falha eliminatória. `bigint` torna soma e comparação exatas, sem dependência de biblioteca decimal. `NUMERIC` mantém a exatidão no banco e permite que as CHECKs façam aritmética (`balance_after = balance_before + amount`). `Money.from` exige exatamente 2 casas e rejeita notação científica, valores negativos e string vazia. O limite de `NUMERIC(20,2)` é validado na entrada, então um valor grande demais vira `INVALID_PAYLOAD` e não erro de banco.

`equals` com moedas diferentes retorna `false`. `add`, `subtract` e comparações lançam `CurrencyMismatchError`.

### MikroORM e estratégia transacional

MikroORM foi escolhido pelo `EntityManager.transactional()` e pelo `LockMode` explícito. Cada transação usa `em.fork().transactional()`, atrás da porta `UnitOfWork`: resolve e faz commit, rejeita e faz rollback.

Os repositórios escrevem com `em.insert` e `nativeUpdate` em vez do flush automático. O agregado de domínio não é a entidade do ORM, então não há change tracking a aproveitar, e a ordem das escritas importa: a transação precisa existir antes do ledger, que aponta para ela.

### EntitySchema na infraestrutura

`EntitySchema` e mappers ficam em `src/infrastructure/db`. O domínio não tem decorators nem conhece tipos do ORM, o que atende à exigência de `Money` sem dependência de persistência e mantém construtores privados com factories (`create`, `from`, `rehydrate`). O custo é um mapper por agregado.

### Lock pessimista

Toda operação que toca saldo faz `SELECT ... FOR UPDATE` na wallet dentro da transação. Não há lock global: wallets diferentes não disputam nada.

Optimistic locking foi descartado porque o cenário central é contenção real na mesma wallet (várias apostas, API e consumer ao mesmo tempo). Sob contenção, ele gasta trabalho em retries e precisa de limite e de um desfecho para quando o limite estoura. O lock transforma a disputa em fila, e toda decisão de negócio enxerga o saldo já atualizado. `version` continua existindo, incrementa só quando o saldo muda e é publicado em `WalletBalanceChanged`, mas não controla concorrência.

`lock_timeout` de 5s por transação evita que uma wallet quente segure conexões do pool indefinidamente. O estouro vira `503` no HTTP e retry no SQS. O worker de referências não gasta tentativa nesse caso.

### Ordem de locks

Sempre wallet primeiro, depois linhas de transação, em API, consumer e workers. Com uma ordem única, não há ciclo de espera entre eles.

A inbox é inserida antes do lock da wallet e não viola isso: cada transação insere uma única linha de inbox como primeiro passo, então ninguém espera por uma linha de inbox segurando uma wallet.

Por isso `wakeWaitingFor` só toca linhas da wallet cujo lock já está em mãos. Acordar linhas de outra wallet tomaria locks fora de ordem, e elas só poderiam terminar em `REFERENCE_MISMATCH`, então não perdem nada esperando o próprio backoff.

### Idempotência em três camadas

1. **Busca antes do lock.** Detecta replay e conflito sem entrar na fila de uma wallet quente. Também garante que reusar a chave é conflito mesmo que o novo payload aponte para uma wallet inexistente.
2. **Busca depois do lock.** É a fonte da verdade. Com READ COMMITTED, cada comando enxerga um novo snapshot, então uma duplicata concorrente na mesma wallet já está visível aqui.
3. **Unique no schema.** `idempotency_key` e `(provider_id, external_transaction_id)` são a rede de segurança para duplicatas que não dividem o lock, como a mesma chave apontando para wallets diferentes. Quem perde a corrida recebe `DuplicateTransactionError`, a transação faz rollback, e uma nova transação responde com o resultado existente.

Nada disso depende de memória. O replay devolve o resultado original, incluindo `balance_after` gravado naquele momento, e o status HTTP original (200, 202 ou 422).

### payloadHash

SHA-256 em hexadecimal do JSON canônico: chaves ordenadas recursivamente, sem espaços, campos ausentes omitidos. Campos: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`. Os campos são escolhidos por nome, então `idempotencyKey` e metadados de transporte não entram nem que o chamador passe um objeto maior.

O hash da inbox é outro: cobre o `data` inteiro da mensagem, inclusive `idempotencyKey`. Mudar a chave muda a mensagem.

### Inbox e outbox na mesma transação

Inbox, wallet, ledger, transação e outbox entram na mesma transação SQL, então ou tudo é confirmado ou nada é. Consequências:

- Crash antes do commit: nada aconteceu, e a redelivery processa do zero.
- Crash depois do commit e antes do ack: a redelivery encontra a inbox e só faz ack.
- Crash antes de publicar: o evento está na outbox, e qualquer publisher assume.

O ack e a publicação rodam depois do commit, nunca antes.

### SKIP LOCKED e ordem na outbox

Publishers usam `FOR UPDATE SKIP LOCKED`, então vários rodam sem esperar um pelo outro. Só isso não preserva ordem, e por isso um aggregate só entra no lote pelo evento não publicado mais antigo. Quem segura a cabeça tem o aggregate com exclusividade: outro publisher não consegue selecionar um evento que tem um mais antigo pendente, mesmo que a cabeça esteja em backoff.

Uma falha para o resto daquele aggregate e não afeta os outros. A publicação é at-least-once: crash entre publicar e o commit publica de novo com o mesmo `eventId`, e o consumidor deduplica por ele.

### UUIDv7

Ordenável por tempo, o que mantém o índice B-tree compacto e dá ao cursor do ledger uma ordem natural. O id do lançamento é gerado sob o lock da wallet, então ids de uma wallet seguem a ordem de commit, a menos de diferença de relógio entre instâncias (ver seção 10).

### Backoffs e limites

| O quê | Base | Fator | Teto | Limite | Motivo |
|---|---|---|---|---|---|
| `PENDING_REFERENCE` | 1s | 2x | 60s | 10 tentativas, cerca de 5 min | provedores reordenam em segundos. Passado isso, a referência provavelmente não existe, e o provedor precisa de uma resposta definitiva |
| Outbox | 1s | 2x | 60s | nenhum | evento confirmado nunca se perde. Uma fila parada aparece em `wagering_outbox_lag_seconds` |
| Consumer, erro transitório | 1s | 2x | 60s | `maxReceiveCount` = 5, redrive nativo | acompanha `ApproximateReceiveCount` |

Quando uma transação chega a um estado terminal (`PROCESSED`, `REJECTED` ou `FAILED`), ela acorda na mesma transação quem espera por ela na mesma wallet (`next_attempt_at = now()`). O backoff, então, só pesa para referências que realmente faltam, e o caso comum resolve sem espera. O atalho não gasta tentativa.

Erro transitório nunca gasta tentativa de referência: uma queda do banco não pode consumir a janela de espera.

### Papéis e desligamento

`ROLES` permite escalar consumer, outbox e pending separadamente da API. Em `SIGTERM`, o consumer interrompe o long poll, conclui o que estiver em andamento dentro de `SQS_SHUTDOWN_GRACE_MS` e devolve a visibilidade do que restar. O `stop_grace_period` do Compose (20s) é maior que essa janela, para o `SIGKILL` não atropelar o dreno.

## 3. Modelo de dados

Migrations em SQL explícito e reversíveis, em `src/infrastructure/db/migrations`. As invariantes ficam no schema, e o código de aplicação é a primeira barreira, não a única.

### `wallets`

| Constraint | Invariante |
|---|---|
| `wallets_balance_non_negative`: `balance >= 0` | saldo nunca negativo, mesmo com bug na aplicação |
| `wallets_player_currency_unique` | no máximo uma wallet por jogador e moeda |
| `wallets_id_player_currency_unique` | alvo da FK composta de `wager_transactions` |
| `wallets_currency_format`: `^[A-Z]{3}$` | moeda em ISO-4217 |
| `wallets_version_positive`: `version >= 1` | `version` começa em 1 |

### `wager_transactions`

| Constraint | Invariante |
|---|---|
| `wager_transactions_idempotency_key_unique` | uma transação por chave |
| `wager_transactions_provider_external_unique` | uma transação por `(provider, id externo)`. É por onde referências são resolvidas |
| `wager_transactions_wallet_player_currency_fk` | wallet existe, com o mesmo jogador e a mesma moeda |
| `wager_transactions_reference_fk`: `(reference_transaction_id, wallet_id, round_id)` | referência resolvida pertence à mesma wallet e rodada. Junto com a FK acima, garante também mesmo jogador e moeda |
| `wager_transactions_id_wallet_unique`, `wager_transactions_id_wallet_round_unique` | alvos das FKs compostas |
| `wager_transactions_one_reversal_per_reference`: unique parcial em `reference_transaction_id` para `REFUND`/`ROLLBACK` `PROCESSED` | uma reversão aplicada por referência, de qualquer tipo |
| `wager_transactions_processed_reversal_resolved` | reversão aplicada sempre tem referência resolvida. Sem isso, um NULL escaparia do índice acima |
| `wager_transactions_reversal_requires_reference` | `REFUND` e `ROLLBACK` sempre trazem `reference_external_transaction_id` |
| `wager_transactions_one_opening_per_wallet`: unique parcial | no máximo um `OPENING` por wallet |
| `wager_transactions_internal_provider_iff_opening` | provider `internal` se e somente se `OPENING` |
| `wager_transactions_amount_valid` | valor positivo, ou zero só em `LOSS` |
| `wager_transactions_kind_valid`, `wager_transactions_status_valid` | enumerações fechadas |
| `wager_transactions_balance_after_required` | `PROCESSED` e `REJECTED` guardam o saldo, para o replay devolver o original |
| `wager_transactions_failure_code_iff_failed` | `failure_code` se e somente se `REJECTED` ou `FAILED` |
| `wager_transactions_processed_at_iff_processed` | `processed_at` se e somente se `PROCESSED` |
| `wager_transactions_pending_reference_scheduled` | `PENDING_REFERENCE` sempre tem próxima tentativa, então nunca fica órfã |

Índice: `wager_transactions_pending_reference_due`, parcial em `next_attempt_at`, para o worker.

Linhas `OPENING` usam sentinelas em vez de NULL: `provider_id = 'internal'`, `external_transaction_id = 'opening:<walletId>'`, `idempotency_key = 'internal:opening:<walletId>'`, `round_id = game_id = 'opening'`. NULLs escapariam do unique composto. `internal` é reservado e recusado na entrada.

### `wallet_ledger_entries`

| Constraint | Invariante |
|---|---|
| Trigger `wallet_ledger_entries_append_only` em `UPDATE`, `DELETE` e `TRUNCATE` | ledger imutável. É por statement porque `TRUNCATE` não tem forma por linha |
| `wallet_ledger_entries_transaction_wallet_unique` | no máximo um lançamento por transação e wallet, a barreira final contra débito ou crédito duplicado |
| `wallet_ledger_entries_transaction_wallet_fk` | o lançamento pertence a uma transação da mesma wallet |
| `wallet_ledger_entries_wallet_fk` | wallet existe |
| `wallet_ledger_entries_arithmetic` | `balance_after = balance_before ± amount`, conforme a direção |
| `wallet_ledger_entries_balance_before_non_negative`, `wallet_ledger_entries_balance_after_non_negative` | saldo nunca negativo em nenhum ponto da história |
| `wallet_ledger_entries_amount_positive` | lançamento sempre move valor. `LOSS` não gera lançamento |
| `wallet_ledger_entries_direction_valid` | `DEBIT` ou `CREDIT` |

Índice: `wallet_ledger_entries_wallet_cursor` em `(wallet_id, id)`, que sustenta a paginação estável. A moeda não é repetida no lançamento: vem da wallet, pela FK.

### `inbox_messages`

| Constraint | Invariante |
|---|---|
| `inbox_messages_pk`: `(consumer_name, message_id)` | deduplicação persistente por consumidor |

### `outbox_messages`

`id` é o `eventId`, então a linha e o evento publicado compartilham a identidade. Índices parciais em `published_at IS NULL`: `outbox_messages_unpublished_due` (`next_attempt_at`) e `outbox_messages_unpublished_aggregate_order` (`aggregate_id, occurred_at, id`), que sustenta a checagem do evento mais antigo. Não há FK para o aggregate, porque ele é ora transação, ora wallet.

## 4. Máquina de estados da WagerTransaction

```text
create() --> PENDING  (só em memória, nunca chega a ser gravada)
                |
                |-- política aceitou ----------------> PROCESSED  (terminal)
                |-- regra violada -------------------> REJECTED   (terminal)
                '-- falta a referência --+
                                         v
                            PENDING_REFERENCE <---+
                                |  |  |  |        |
                                |  |  |  '--------+  ainda sem referência: attempts + 1
                                |  |  '------------> PROCESSED  referência chegou, política aceitou
                                |  '---------------> REJECTED   regra violada, ou tentativas esgotadas
                                '------------------> FAILED     erro não transitório no worker (terminal)
```

| De | Para | Quando |
|---|---|---|
| `PENDING` | `PROCESSED` | política aceitou, saldo e ledger aplicados |
| `PENDING` | `REJECTED` | violação de regra de negócio |
| `PENDING` | `PENDING_REFERENCE` | referência ausente ou ainda não terminal |
| `PENDING_REFERENCE` | `PENDING_REFERENCE` | retry sem referência, `attempts + 1`, novo backoff |
| `PENDING_REFERENCE` | `PROCESSED` | referência chegou e a política aceitou |
| `PENDING_REFERENCE` | `REJECTED` | regra violada, ou tentativas esgotadas (`REFERENCE_NOT_FOUND`, `REFERENCE_NOT_PROCESSED`) |
| `PENDING_REFERENCE` | `FAILED` | erro não transitório no worker (`PROCESSING_FAILED`) |

`PROCESSED`, `REJECTED` e `FAILED` são terminais: tentar transicioná-los lança `InvalidTransactionStateError`, porque é erro de programação, não caminho de negócio. `rehydrate` não revalida transições. `OPENING` nasce direto em `PROCESSED`, na mesma transação da criação da wallet.

`reject` só aceita códigos de negócio, e `fail` só aceita códigos de infraestrutura. O tipo da falha não pode ser confundido com o estado.

## 5. Eventos

| Evento | Aggregate | Quando |
|---|---|---|
| `WagerTransactionProcessed` | transação | transação aplicada, inclusive `LOSS` e `OPENING` |
| `WagerTransactionRejected` | transação | rejeição de negócio |
| `WagerTransactionPendingReference` | transação | na chegada, uma vez. Retries não repetem o anúncio |
| `WalletBalanceChanged` | wallet | somente quando o saldo muda |

Publicados em `wagering-events.fifo`, com `MessageGroupId = aggregateId` e `MessageDeduplicationId = eventId`. O `ContentBasedDeduplication` fica desligado. O payload usa `MoneyProps`, nunca a instância de `Money`.

## 6. Observabilidade

Logs em JSON com `correlationId`, `messageId`, `transactionId`, `walletId` e `providerId` quando aplicáveis. `correlationId` é a idempotency key. Erros são logados só com nome e código: a mensagem do driver pode citar parâmetros SQL, e valores não entram nos logs, com exceção da diferença de uma reconciliação divergente, que é o próprio dado de diagnóstico.

Métricas em `GET /metrics`, descritas no [README](./README.md#métricas). São incrementadas depois do commit, então um rollback nunca conta como resultado. `wagering_outbox_lag_seconds` é lida do banco no momento do scrape: é igual em toda instância, e fica `NaN` se o banco não responder, sem derrubar os contadores. Conflitos são contados na `UnitOfWork`, por onde passa todo caminho até um lock de wallet.

`/health/live` diz que o processo está vivo. `/health/ready` verifica Postgres e a existência da fila, porque o estado do MiniStack é em memória: reiniciado, ele responde, mas não tem filas.

## 7. Taxonomia de failureCode e mapeamento HTTP

| Categoria | Código | HTTP | Persistência | O provedor deve |
|---|---|---|---|---|
| Negócio | `INSUFFICIENT_FUNDS` | 422 | `REJECTED` | desistir, aposta sem saldo |
| Negócio | `REVERSAL_INSUFFICIENT_FUNDS` | 422 | `REJECTED` | investigar: reverter deixaria o saldo negativo |
| Negócio | `REFERENCE_NOT_FOUND` | 422 | `REJECTED` | investigar, a referência nunca chegou |
| Negócio | `REFERENCE_INVALID_KIND` | 422 | `REJECTED` | corrigir: tipo de referência não permitido |
| Negócio | `REFERENCE_MISMATCH` | 422 | `REJECTED` | corrigir: outro player, wallet, moeda ou rodada |
| Negócio | `REFERENCE_NOT_PROCESSED` | 422 | `REJECTED` | desistir, a referência terminou sem ser aplicada |
| Negócio | `REFERENCE_ALREADY_REVERSED` | 422 | `REJECTED` | desistir, já revertida |
| Negócio | `AMOUNT_MISMATCH` | 422 | `REJECTED` | corrigir: reversão parcial está fora de escopo |
| Contrato | `INVALID_PAYLOAD` | 400 | nenhuma | corrigir o payload |
| Contrato | `CURRENCY_MISMATCH` | 400 | nenhuma | corrigir o payload |
| Contrato | `PLAYER_MISMATCH` | 400 | nenhuma | corrigir o payload |
| Contrato | `KIND_NOT_ALLOWED` | 400 | nenhuma | não enviar `OPENING` |
| Contrato | `WALLET_NOT_FOUND` | 404 | nenhuma | corrigir, ou criar a wallet |
| Contrato | `RESOURCE_NOT_FOUND` | 404 | nenhuma | consulta sem resultado |
| Conflito | `IDEMPOTENCY_CONFLICT` | 409 | original intacta | não reenviar: a chave já foi usada com outro payload |
| Conflito | `WALLET_ALREADY_EXISTS` | 409 | original intacta | usar a wallet existente |
| Infraestrutura | `INFRASTRUCTURE_UNAVAILABLE` | 503 | rollback | reenviar com a mesma chave |
| Infraestrutura | `PROCESSING_FAILED` | 500 | `FAILED` no worker, DLQ no consumer | acionar a operação |

Sucessos: `200` processada ou replay, `202` pendente de referência. Replay devolve o status original com `idempotentReplay: true`. Isso inclui uma transação em `FAILED`, que responde 500 com `status: FAILED`.

## 8. Interpretações de regras

- **Reversão única de qualquer tipo.** A regra 7.4 proíbe reverter duas vezes "pelo mesmo tipo de operação". A leitura adotada é a mais segura: uma reversão por referência, seja `REFUND` ou `ROLLBACK`. Um `REFUND` e um `ROLLBACK` da mesma `BET` creditariam duas vezes a mesma aposta.
- **Reversão de reversão.** `ROLLBACK` de um `REFUND` é permitido pela regra 7.3 e reativa o débito da aposta. Mesmo assim, a `BET` continua marcada como revertida, porque o `REFUND` segue `PROCESSED`, então não pode ser reembolsada de novo. `ROLLBACK` de `ROLLBACK` é `REFERENCE_INVALID_KIND`.
- **Ordem de checagem da referência.** Escopo (provider, player, wallet, moeda, rodada) gera `REFERENCE_MISMATCH`. Depois vêm tipo (`REFERENCE_INVALID_KIND`), status, já revertida (`REFERENCE_ALREADY_REVERSED`), valor (`AMOUNT_MISMATCH`) e por fim saldo. Escopo vem primeiro para não revelar nada sobre transação de outra wallet. Saldo vem por último porque só importa para uma operação que seria válida.
- **Referência ainda em andamento.** Uma referência `PENDING_REFERENCE` ainda pode ser aplicada, então quem depende dela espera também. Esgotadas as tentativas, é `REFERENCE_NOT_PROCESSED`. Já uma referência `REJECTED` ou `FAILED` responde na hora, com o mesmo código.
- **`WIN` e `LOSS` com referência.** A referência é opcional e, quando vem, precisa ser uma `BET` da mesma rodada, passando pelas mesmas checagens de escopo e status. Sem ela, são aplicados direto. Não contam como reversão: vários `WIN` podem apontar para a mesma `BET`. `BET` com referência é `INVALID_PAYLOAD`.
- **`LOSS` com `0.00`.** Aceito, já que `LOSS` não move saldo e nem todo provedor informa valor. Todos os outros tipos exigem valor positivo.
- **Recusas pré-persistência.** Moeda ou jogador divergente e wallet inexistente são recusados antes de gravar qualquer linha (400 e 404). As FKs compostas tornam esse estado impossível de armazenar, então gravá-lo como `REJECTED` exigiria relaxar o schema. Vindas do SQS, são registradas na inbox e recebem ack, porque repetir não muda o resultado.
- **`REJECTED` sem `reference_transaction_id`.** Transação rejeitada guarda só `reference_external_transaction_id`, o que mantém a auditoria e não esbarra em `wager_transactions_reference_fk`, que proibiria apontar para outra wallet ou rodada. A coluna só é preenchida em `PROCESSED`.
- **`balance_after` em `REJECTED`.** Guardado também aqui, porque não há lançamento de onde tirá-lo. Sem isso, o replay não devolveria o saldo observado naquele momento.
- **Mesmo `(provider, id externo)` com outra chave.** É `IDEMPOTENCY_CONFLICT`, não replay: a identidade da operação no provedor já foi usada.
- **`FAILED` só no worker.** Na entrada (HTTP ou SQS), um erro permanente faz rollback e nenhuma linha fica: a resposta é 500, ou a mensagem vai para a DLQ. O worker é o único caminho com uma linha já gravada para marcar. `FAILED` não publica evento, porque o desafio define eventos mínimos sem esse caso. Quem precisa saber recebe log de erro e a série `wagering_transactions_total{status="FAILED"}`.

## 9. Autenticação

**Decisão: não implementar.** Autenticação não vale pontos no desafio, e o prazo foi para correção financeira, concorrência e idempotência. O ponto de extensão existe: `AuthGuard` (`src/infrastructure/http/auth.guard.ts`) está registrado como `APP_GUARD`, roda em toda rota da API e hoje retorna `true`. Health e métricas já estão marcados com `@Public()`.

**Desenho proposto com Keycloak (OIDC):**

- Um client confidencial por provedor no Keycloak, usando o fluxo client credentials. O provedor obtém um JWT de curta duração no IdP. Nenhuma senha ou tabela de usuários no serviço.
- O token carrega o `providerId`, em um claim configurado por um protocol mapper no client.
- O `AuthGuard` passa a injetar `Reflector`, deixa passar rotas `@Public()` e valida assinatura (JWKS com cache), `iss`, `aud` e `exp`. Falha vira `401`.
- O `providerId` do token é comparado ao do payload em `POST /wagering/transactions`. Divergência vira `403`. Assim, um provedor não consegue submeter nem reverter em nome de outro, e o `providerId` do corpo deixa de ser confiado.
- As consultas por provedor (`/providers/:providerId/...`) aplicam a mesma comparação. Wallets e reconciliação pedem um escopo administrativo próprio.
- Mensagens da fila seguem como canal interno confiável. A identidade nelas continua passando pelas validações de domínio, e o controle de quem publica fica na política IAM da fila.

A validação fica antes do use case, então a camada de aplicação não muda. O `401` e o `403` entrariam na taxonomia como `UNAUTHENTICATED` e `PROVIDER_MISMATCH`.

## 10. Trade-offs e limitações conhecidas

**Concorrência**

- **Hot wallet serializa.** Operações da mesma wallet rodam uma por vez, e cada espera segura uma conexão do pool. Sob contenção alta, o throughput dessa wallet é limitado pelo tempo de uma transação, e o excedente vira 503 após 5s. É o preço de manter o saldo correto sem retry. Wallets diferentes não são afetadas, até o pool esgotar. Não há teste de carga, então não há número medido.
- **Pool por instância.** O total de conexões é `DB_POOL_MAX` vezes o número de instâncias, e precisa caber em `max_connections`.
- **Saldo e ledger não estão amarrados no schema.** As CHECKs validam cada lançamento, mas nada no banco garante que `wallets.balance` é igual à soma do ledger, nem que `balance_before` continua o lançamento anterior. Isso depende do lock e do código. A reconciliação detecta a divergência, sem corrigir.

**Mensageria**

- **Redrive FIFO arrasta vizinhos.** O limite de 5 recebimentos é por mensagem, e o erro transitório de uma também devolve as seguintes do grupo. Cada mensagem seguinte acumula recebimentos sem ter falhado, e pode chegar à DLQ junto com a culpada.
- **Queda longa vai para a DLQ.** Com backoff de 1, 2, 4, 8 e 16s, o limite de 5 recebimentos se esgota em cerca de 30s, mais o tempo de cada tentativa falhar. Uma queda do Postgres maior que isso move mensagens válidas para a DLQ. O redrive é manual, e reprocessar é seguro por causa da inbox.
- **Métrica de DLQ é parcial.** `wagering_dlq_messages_total` conta o que o consumer envia. O redrive nativo do broker acontece sem passar pela aplicação, então para o total é preciso olhar `ApproximateNumberOfMessages` da DLQ.
- **Dedup FIFO na janela de 5 minutos.** O `MessageDeduplicationId` só protege dentro dessa janela. Uma redelivery depois dela chega como mensagem nova. É por isso que a garantia real é a inbox, e os testes usam dedup ids novos para simular esse caso.
- **Publicação at-least-once.** O consumidor de `wagering-events.fifo` precisa deduplicar por `eventId`.
- **Publisher segura locks durante o envio.** A transação da outbox fica aberta enquanto publica, para o crash nunca marcar como publicado o que não foi. Por isso os envios têm timeout de 5s e rodam em paralelo por aggregate.
- **Ordem da outbox depende de relógio.** A ordem por aggregate usa `(occurred_at, id)`, gerados pela aplicação. Diferença de relógio entre instâncias pode inverter dois eventos do mesmo aggregate. `walletVersion` em `WalletBalanceChanged` permite ao consumidor detectar. Não há ordem garantida entre aggregates diferentes, como uma transação e sua wallet. O mesmo vale para o cursor do ledger, baseado em UUIDv7: um relógio atrasado pode colocar um lançamento antes de um cursor já lido.
- **MiniStack guarda estado em memória.** Reiniciado, ele perde as filas e `sqs-init` não roda de novo. As instâncias ficam `unhealthy`, de propósito, até `docker compose up sqs-init`.

**Operação**

- **`FAILED` é definitivo e sem evento.** Um bug que lance erro não transitório no worker marca como `FAILED` as transações que encontrar, e não há como reabrir pela aplicação. Quem consome eventos viu `WagerTransactionPendingReference` e não recebe um desfecho. Uma queda do banco não causa isso: a marcação também falharia, e a linha continuaria vencida.
- **Inbox e outbox crescem sem limpeza.** Não há retenção. Em produção, precisariam de um expurgo, respeitando a janela de redelivery.
- **Métricas por processo.** Contadores somem ao reiniciar e são separados por instância, o que é o modelo normal do Prometheus. `app-2` e `app-3` não publicam porta no host no Compose. Não há stack de Prometheus incluída.
- **Consumer sem renovação de visibilidade.** Um lote que passe de `SQS_VISIBILITY_TIMEOUT_S` pode ser reentregue. A inbox absorve, com custo de trabalho repetido.
- **Consulta de lag faz uma varredura do índice parcial.** É barata com a outbox saudável, e fica mais cara quanto maior o atraso. Tem timeout de 2s no scrape.
