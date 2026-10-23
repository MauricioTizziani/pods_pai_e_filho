# Pods - Pai e Filho

Controle de estoque, vendas, valores a receber, lucro e repasses da sociedade entre pai e filho. A aplicação é um PWA em Next.js e usa Supabase (Auth, Postgres e RLS).

## Preparar

1. Crie um projeto no [Supabase](https://database.new).
2. No SQL Editor, execute os arquivos de `supabase/migrations/` **em ordem crescente pelo nome**: `20261001140000_001_pods_init.sql`, `20261001150000_002_product_safety.sql`, `20261001160000_003_variant_is_ice.sql`, `20261002100000_004_consultas_cost_snapshots.sql`, `20261002110000_005_consultas_hide_credit_filter.sql`, `20261002120000_006_whatsapp_promotion.sql`, `20261007120000_007_purchase_batches.sql`, `20261023120000_008_batch_corrections.sql`, `20261023130000_009_customer_deletion.sql` e `20261023140000_010_transfer_previews.sql`.
3. Copie `.env.example` para `.env.local` e preencha:

```env
NEXT_PUBLIC_SUPABASE_URL=https://seu-projeto.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sua-chave-anon-ou-publishable
```

Use só a chave pública. A `service_role` não entra no frontend.

4. Instale e suba o sistema:

```bash
npm install
npm run dev
```

5. Abra [http://localhost:3000](http://localhost:3000) e crie a primeira conta. Ela vira **administrador**. As contas seguintes entram como **CONSULTAS** até um administrador mudar o papel em Configurações.
6. Se o pai também for operar vendas e repasses, deixe o papel dele como administrador.
7. Depois das duas contas, desligue o cadastro público em Authentication no Supabase.

O script inicial cadastra Pod 40k e Pod 30k, os sabores do 40k, o sabor Padrão do 30k e os preços da planilha:

| Produto | Tipo | Venda | Repasse ao pai | Lucro |
| --- | --- | --- | --- | --- |
| Pod 40k | Normal | R$ 150,00 | R$ 125,00 | R$ 25,00 |
| Pod 40k | Amigo | R$ 130,00 | R$ 125,00 | R$ 5,00 |
| Pod 30k | Normal | R$ 140,00 | R$ 115,00 | R$ 25,00 |
| Pod 30k | Amigo | R$ 120,00 | R$ 115,00 | R$ 5,00 |

Antes da primeira venda, registre uma compra em **Estoque > Nova compra**. Cada confirmação cria um lote novo e registra seus itens e custos históricos junto com as entradas de estoque.

### Compras e lotes

Em instalações existentes, execute `20261007120000_007_purchase_batches.sql` depois das migrations anteriores. Essa migration preserva vendas e movimentos antigos sem inventar uma origem; o saldo anterior permanece sem lote. Use **Estoque > Nova compra** para registrar cada compra independente. Use **Ajuste de estoque** somente para corrigir divergências físicas.

Vendas consomem primeiro o estoque legado sem origem conhecida e depois os lotes em FIFO, respeitando produto e sabor. O custo de cada lote é guardado na compra e o custo da venda considera as unidades alocadas. Cancelar a venda devolve cada unidade ao lote original; os lotes sem saldo são finalizados automaticamente. A tela **Lotes** está disponível em modo somente leitura para CONSULTAS e mostra os indicadores do pai; o lucro do filho permanece exclusivo do ADMIN.

ADMIN pode usar **Lotes > Associar estoque legado** para classificar saldos antigos sem alterar o estoque geral. Essa ação exige quantidade disponível e custo histórico conhecido; sem esse dado, mantenha as unidades sem lote.

### Editar lotes e corrigir a origem de vendas

Em instalações que já usam lotes, execute somente `supabase/migrations/20261023120000_008_batch_corrections.sql` no SQL Editor do Supabase. O aplicativo exige essa migration para confirmar correções. Ela não é aplicada automaticamente pelo login ou pela chave pública.

O ADMIN encontra **Editar lote** na listagem e nos detalhes dos lotes abertos. Pode corrigir a data e as observações, complementar uma entrada incompleta da mesma compra e adicionar sabores omitidos. Quantidades vendidas e saldos são apresentados para conferência. Os itens existentes mantêm produto e sabor, e os custos de itens com histórico de venda ficam protegidos. Cada compra independente continua gerando um novo lote.

Em **Vincular venda existente / corrigir lote da venda**, busque o cliente, identificador, produto ou sabor, escolha o item e a parcela de origem e informe a quantidade a realocar. As datas de ocorrência e cadastro da venda aparecem separadamente. O destino precisa ter saldo do mesmo produto e sabor e ter entrada compatível com a data real da venda. A data de cadastro da venda não limita o vínculo. Repasses já conciliados e custos históricos desconhecidos bloqueiam a correção com uma mensagem explicativa.

Antes de confirmar, confira as quantidades, os saldos e o impacto no custo e no lucro. Informe a justificativa e marque a confirmação explícita. A correção da entrada movimenta apenas a diferença; a correção de origem devolve à origem e consome no destino em uma única transação, mantendo estoque geral, venda, preços, pagamentos e repasses. O legado exige baixa já registrada e verificável e não recebe uma segunda baixa. Correções da classificação de estoque legado continuam sem alterar o estoque geral.

Cada prévia pertence ao administrador que a gerou. A confirmação revalida os dados sob travas no banco, bloqueia uma prévia desatualizada e permite reenviar a mesma solicitação sem duplicação. Os vínculos anteriores, as movimentações e a justificativa ficam preservados no histórico dos lotes e da venda. Os status automáticos de esgotamento e reabertura são mantidos; lotes finalizados ou cancelados continuam sem edição manual. CONSULTAS continua somente visualizando as informações permitidas.

Para validar as correções em PostgreSQL local em memória, sem usar credenciais nem alterar o Supabase:

```bash
npm run check:batch-corrections
```

O teste aplica todas as migrations em um banco descartável, simula os papéis de acesso e cobre diferença de entrada, saldo insuficiente, venda posterior, parcelas em vários lotes, custos diferentes, legado, dados alterados desde a prévia, reenvio, rollback, auditoria e cancelamento/edição após a realocação. O teste de concorrência revalida o saldo depois de uma operação interveniente; a execução simultânea em múltiplas conexões deve ser conferida no ambiente de homologação.

### Excluir clientes preservando as vendas

Em instalações existentes, aplique `supabase/migrations/20261023130000_009_customer_deletion.sql` após a 008. A migration reutiliza `sales.customer_name`, preenche somente descrições ausentes a partir do cadastro e mantém `sales.customer_id` opcional com `ON DELETE SET NULL`. Descrições históricas já preenchidas são preservadas exatamente.

Somente ADMIN pode usar **Excluir cliente**, na listagem ou no formulário de edição, após confirmar o nome. A operação `delete_customer` preenche nomes ausentes, desvincula todas as vendas, exclui o cadastro e registra responsável, horário, ID, nome e quantidade de vendas desvinculadas na auditoria, em uma única transação. Uma falha desfaz todas essas etapas. A exclusão direta pela API de tabelas permanece sem permissão.

Vendas recebidas, pendentes, fiadas e canceladas mantêm seus nomes, itens, preços, custos, pagamentos, repasses, estoque e lotes. Não existem outras chaves estrangeiras operacionais para clientes no esquema atual; os recebíveis e repasses pertencem às vendas. Consultas e telas já usam o nome salvo na venda, e dívidas continuam separadas pelo ID de cada venda. A edição passa a mostrar **Sem cadastro**, sem recriar nem associar clientes pelo nome.

Novas vendas vinculadas recebem o nome do cadastro no banco, mesmo se o formulário enviar outro nome. As RPCs de criação, edição e exclusão compartilham uma trava transacional adquirida antes das travas de linhas: uma criação concorrente termina antes da exclusão, ou seu ID é revalidado depois dela. Um ID já excluído gera erro e rollback; o usuário pode atualizar a página e informar o nome sem cadastro. A exclusão atualiza a listagem e invalida o cache das demais telas e seletores.

```bash
npm run check:customer-deletion
```

O teste usa PostgreSQL em memória (PGlite), sem credenciais ou acesso ao Supabase. Cobre migração, nomes históricos e ausentes, preservação financeira e de estoque/lotes, edição posterior, pesquisa, permissões, auditoria e rollback. Verifica as duas ordens possíveis de criação/exclusão; por usar uma única sessão, não substitui um teste simultâneo com duas conexões no ambiente de homologação.

### Filtros iniciais

**Dashboard**, **Relatórios** e **Repasses** iniciam no lote aberto com a compra mais recente, usando a mesma função `resolveBatchFilter`. Sem lote aberto, usam o finalizado mais recente; sem lotes válidos, usam **Todos os lotes**, incluindo o histórico sem lote. Empates usam criação, número do lote e identificador. Lotes cancelados não são selecionados automaticamente.

A seleção fica na URL e é respeitada nas atualizações e na volta de uma venda à Dashboard. **Todos os lotes** permanece disponível. Período e demais filtros são combinados com o lote. Os valores financeiros usam as alocações existentes de cada item vendido; uma venda com dois lotes contribui apenas com sua parcela em cada lote. Estoque atual, custo do estoque e alertas continuam gerais e são identificados assim na tela.

Em **Repasses**, cards, contadores e as abas de valores a enviar, futuros e pagos usam a mesma consulta completa, sem o antigo limite de 300 vendas. A escolha do lote e da aba é preservada na URL, inclusive no retorno dos detalhes da venda e após confirmar o repasse. Mudar o lote limpa seleções em grupo e a conferência de pagamento aberta. **Selecionar todas** abrange somente as vendas a enviar do filtro atual. CONSULTAS continua em leitura, com os termos do pai e sem classificação Fiado ou lucro do filho. Falhas de consulta são apresentadas separadamente de lotes sem resultados.

O pagamento existente é integral por venda. Antes de confirmar uma ou várias vendas, a tela consulta uma prévia com o valor integral e as parcelas reais por lote, incluindo histórico sem lote quando houver. Se houver parcelas fora do lote selecionado, informa esse efeito e exige a confirmação explícita do total integral. A confirmação revalida os valores, os vínculos e a elegibilidade sob travas no banco e então reutiliza a função de pagamento anterior, com seus registros e auditoria. Uma prévia desatualizada ou um pagamento repetido é recusado; não foi criado pagamento parcial por lote.

Para habilitar essa conferência em uma instalação existente, aplique `supabase/migrations/20261023140000_010_transfer_previews.sql` após a 009. Ela adiciona as RPCs de prévia e confirmação protegida e impede chamadas diretas ao endpoint de confirmação antigo. O aplicativo não aplica migrations automaticamente.

```bash
npm run check:transfer-filters
```

Esse teste usa as páginas e consultas reais com dados simulados e um PostgreSQL descartável em memória, sem credenciais nem acesso ao Supabase. Cobre seleção inicial e explícita, valores por lote e consolidados, histórico sem lote, CONSULTAS, leitura completa de mais de 300 registros, confirmação integral, dados alterados desde a prévia, permissões e prevenção de pagamento duplicado. Concorrência simultânea entre conexões deve ser conferida em homologação.

**Produtos** inicia com **Ativos**, mantendo **Inativos** e **Todos**. O status é aplicado na consulta, independentemente do estoque e dos lotes; um produto ativo sem saldo continua visível. Produtos inativos continuam incluídos no histórico de vendas e nos relatórios. Os padrões também se aplicam a CONSULTAS, com as permissões e a visão financeira do pai preservadas. Esta melhoria não exige uma nova migration.

**Estoque** consulta somente saldos de produtos ativos, incluindo os esgotados. Produtos inativos e seus sabores não aparecem na listagem, nos totais exibidos ou nas movimentações recentes dessa tela. Pesquisas e filtros de Ice são preservados; os alertas continuam usando a soma das variações ativas de cada produto. Desativar e reativar invalida o cache existente, preservando saldos, lotes e todo o histórico consultado nas demais telas. A lista distingue ausência de produtos ativos de ausência de resultados para os filtros.

Para conferir os filtros e as parcelas financeiras com dados simulados:

```bash
npm run check:batch-filters
npm run check:batch-sales
npm run check:financial-filters
npm run check:product-filters
npm run check:dashboard-filters
npm run check:stock-visibility
```

## Regras que o banco garante

- Lucro do pai = repasse ao pai − preço de custo; lucro do filho = preço de venda − repasse. O custo, o repasse e o preço de venda são valores monetários `numeric`; lucros são calculados, não digitados.
- Vendas de estoque sem lote exigem custo configurado; vendas de unidades compradas usam o custo histórico do lote. O custo, o repasse e o preço ficam salvos na venda. Custos antigos sem informação continuam desconhecidos; a aplicação não estima esses custos.
- Estoque é a soma das movimentações e baixa na confirmação da venda, tenha o cliente pago ou não.
- **A enviar ao pai agora** = repasse ainda não pago e (venda recebida ou fiado).
- **Repasse futuro** = a receber, sem fiado, com repasse ainda não pago.
- Venda fiada a receber entra em valores a receber e em “A enviar agora”, mas não aumenta o lucro recebido.
- Cancelar devolve o estoque e tira a venda dos indicadores, sem apagar o histórico.
- CONSULTAS só lê. Quem grava é o papel com permissão de escrita, também nas policies de RLS e nas funções do Postgres.

## PWA

O manifesto e o service worker permitem instalar na tela inicial. As vendas continuam exigindo internet; o worker só guarda ícones e a página de sem conexão.

O atalho instalado usa a arte arredondada de `public/brand/mobile-icon-rounded.png`. Para gerar as versões Android e Apple, execute `node scripts/generate-icons.mjs`. A logo quadrada do sistema/login (`public/brand/logo.png`) e os favicons são preservados. Depois de publicar a alteração, atalhos que ainda exibirem o ícone antigo podem ser removidos e adicionados novamente à tela inicial.

## Conferir as regras financeiras

```bash
npm run check:finance
```

## Divulgação no WhatsApp

Em instalações existentes, execute somente a nova migration `20261002120000_006_whatsapp_promotion.sql` no SQL Editor do Supabase antes de usar a divulgação. Ela adiciona as configurações sem alterar saldos, vendas, preços ou alertas de estoque baixo. Acesso de login ao aplicativo e chave pública do Supabase não permitem executar migrations.

O ADMIN configura o cabeçalho e o rodapé em **Configurações > Divulgação**. Em **Produtos > Informações para divulgação**, cadastra o nome comercial, os puffs aproximados, uma característica por linha e, opcionalmente, a ordem de exibição. Nome vazio usa o nome interno; características não cadastradas são omitidas. A migration não atribui marcas ou características aos produtos existentes. Puffs como `30000` aparecem como `30K Puffs`.

Em **Estoque > Gerar mensagem para WhatsApp**, cada clique consulta um novo snapshot do banco, independente dos filtros da tela. A prévia pode ser copiada, aberta no WhatsApp sem destinatário predefinido ou compartilhada quando o navegador oferecer compartilhamento nativo. O envio é confirmado pelo usuário no WhatsApp.

A mensagem inclui apenas produtos ativos com saldo total positivo, sabores ativos com saldo positivo e o preço da regra ativa do tipo **Normal**. Sem preço Normal válido, a geração pede a correção do cadastro. Custos, repasses, lucros, quantidades e clientes nunca fazem parte do texto. Sabores Ice reutilizam a regra existente e nomes Dual Flavor são preservados como cadastrados. Produtos seguem a ordem configurada e depois o nome interno; sabores seguem ordem alfabética pelo nome exibido. Estoque negativo gera aviso administrativo separado da mensagem.

```bash
npm run check:promotion
```

Para verificar a integração depois da migration:

1. Configure informações e preço Normal de dois produtos com estoque; gere e confira a prévia.
2. Copie e compare todo o texto com a prévia, incluindo emojis, acentos, moeda e quebras de linha.
3. Após uma venda normal, gere novamente e confira que o sabor esgotado desaparece. Se o total zerar, o bloco inteiro desaparece.
4. Sem saldo disponível, confira a mensagem de estoque vazio e as ações de copiar/enviar desabilitadas.
5. Confira em 320px que o modal, a prévia e as ações cabem na tela, inclusive com nomes longos.
6. No Android/PWA, abra o WhatsApp e confira a mensagem preenchida, escolha livre de contato/grupo e confirmação manual do envio. Compartilhar deve abrir a seleção de aplicativos quando disponível.
7. Entre como CONSULTAS e confirme que os recursos existentes permanecem acessíveis e divulgação/configurações não aparecem.
