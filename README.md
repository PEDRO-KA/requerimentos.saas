# Protto by IPE

Sistema de gestão de requerimentos acadêmicos do Instituto Politécnico de Ensino (IPE). O Protto reúne o cadastro de alunos, a abertura de requerimentos por colaboradores, o encaminhamento entre departamentos, o histórico, os documentos e a emissão do comprovante final em PDF.

> **Estado deste repositório:** este README descreve a implementação presente no código, não certifica que toda configuração remota esteja aplicada. Antes de mexer em produção, confira o projeto Supabase conectado e o deployment em uso. Para regras obrigatórias de trabalho de pessoas e agentes, leia também [AGENTS.md](AGENTS.md).

## Sumário

- [O que está em uso](#o-que-está-em-uso)
- [Como o sistema funciona](#como-o-sistema-funciona)
- [Arquitetura e fontes de verdade](#arquitetura-e-fontes-de-verdade)
- [Dados e permissões](#dados-e-permissões)
- [Desenvolvimento local](#desenvolvimento-local)
- [Banco, funções e e-mail](#banco-funções-e-e-mail)
- [Testes e publicação](#testes-e-publicação)
- [Segurança, limites e diagnóstico](#segurança-limites-e-diagnóstico)
- [Como manter esta documentação](#como-manter-esta-documentação)

## O que está em uso

- **Acesso:** login e recuperação de senha por **e-mail**, com senha gerida pelo Supabase Auth. O gestor cria os acessos dos colaboradores. O CPF é obrigatório no cadastro administrativo, mas **não é login**. Cadastro público está desativado.
- **Público:** somente `admin`, `coordinator` e `attendant` podem usar o aplicativo. Alunos são cadastros acadêmicos, não contas com acesso ao Protto. Não há portal do aluno nem abertura de requerimentos pelo aluno nesta versão.
- **Interface:** login, painel, requerimentos, alunos, usuários, departamentos, cursos e turmas e tipos de requerimentos. Tema claro por padrão, tema escuro opcional após o login, layout responsivo, marca Protto e fonte Nunito local.
- **Operação:** colaborador abre um requerimento para um aluno cadastrado; o tipo define um fluxo versionado de departamentos; integrantes do setor atual processam a etapa. Há histórico, observações e anexos. Ao concluir, a equipe pode baixar um PDF A4 de duas vias.
- **Confirmação:** na criação de um requerimento vinculado a aluno, uma fila no Supabase solicita o e-mail de confirmação ao Resend, com o remetente `Protto by IPE <nao-responder@estudeipe.com.br>`. Falha de envio não cancela o requerimento.

Não trate elementos antigos do HTML, textos de exemplo, tabelas existentes no banco ou desejos de versões anteriores como prova de uma funcionalidade ativa. Confira o comportamento conectado em `src/supabase-app.js`, as funções e as migrações.

## Como o sistema funciona

### Acesso e perfis

1. O colaborador informa e-mail e senha. A função `login-by-identifier` aceita somente e-mail, exige perfil ativo e vínculo de colaborador e devolve erros genéricos quando o acesso não é válido. A recuperação por e-mail também usa resposta genérica para não revelar se uma conta existe.
2. Após a autenticação, o navegador carrega o perfil, o vínculo com a instituição e os dados permitidos. O Supabase Auth mantém a sessão; o banco aplica RLS (*Row Level Security*). Esconder um botão na interface **não substitui** a autorização no servidor.
3. O administrador gerencia acessos, departamentos, cursos/turmas e tipos/fluxos. Atendentes e coordenadores trabalham com os requerimentos permitidos e o cadastro de alunos. A atuação em um requerimento aberto exige o setor atual, exceto para o administrador. Setores que já participaram podem acompanhar o histórico segundo as regras do banco.
4. A interface administrativa oferece **ativar/desativar** colaboradores e departamentos. Não documente o rótulo legado “Excluir usuário” como exclusão física da conta: o fluxo conectado desativa o acesso. Tipos de requerimento podem ser excluídos pela operação protegida `delete_request_type`; se houver histórico ou vínculos, devem ser desativados em vez de removidos.

Os papéis persistidos são `admin`, `coordinator`, `attendant` e `student`. O último existe no modelo de dados por compatibilidade histórica, mas não tem acesso ao aplicativo atual. Não reative acesso estudantil alterando só o frontend: isso exigiria revisão explícita de autenticação, funções, RLS, documentos e privacidade.

### Alunos, cursos e turmas

- O cadastro de aluno guarda nome, CPF, e-mail, celular, nascimento e sexo, além de vínculo com curso e turma. CPF e celular têm validações próprias. Curso e turma podem ser ativados ou desativados; a turma precisa pertencer ao curso selecionado.
- Um colaborador pode localizar ou cadastrar rapidamente o aluno durante a abertura do requerimento. A abertura seleciona um aluno e uma matrícula/vínculo existentes; não cria uma conta de login para ele.
- As turmas IPE importadas estão registradas em `supabase/migrations/20261001004835_import_ipe_classes.sql`. A importação evita duplicatas e preserva a TE 259 que já existia. Não reaplique dados manualmente sem conferir o estado da instituição correta.

### Requerimentos e fluxo

1. O administrador cadastra um tipo, prazo e sequência de departamentos. `save_workflow_steps` cria uma **nova versão** do fluxo; requerimentos existentes continuam ligados à versão com que foram abertos. A interface permite adicionar, remover e mudar a ordem das etapas pelos controles disponíveis.
2. O colaborador seleciona aluno, tipo e matrícula, informa descrição e, se necessário, disciplina e anexos. A função `create_request_for_student_with_discipline` valida o vínculo e cria o requerimento; o banco gera um protocolo único por instituição e ano e inicia a etapa do fluxo. O envio dos arquivos ocorre em seguida.
3. A tela de requerimentos mostra a fila e o acompanhamento conforme o perfil, com busca e filtros de período, tipo, departamento, responsável e status. O detalhe apresenta descrição, documentos, eventos e ações autorizadas.
4. `advance_request` registra a ação e encaminha para a próxima etapa ou conclui na última. É permitido que um mesmo departamento apareça novamente no fluxo: para atendentes e coordenadores, o limite é **um encaminhamento por colaborador em cada etapa**, não um por requerimento inteiro; administradores mantêm a permissão global. O caso de retorno à Secretaria está coberto por `20260930193259_allow_repeat_department_step.sql` e pelos testes de roteamento.
5. Observações e pedidos de complemento usam operações próprias e ficam no histórico. O registro preserva, quando disponível, nomes e setores da época da movimentação para não reescrever o passado após alterações cadastrais.

Os estados persistidos são `open`, `in_review`, `awaiting_requester`, `forwarded`, `completed`, `rejected` e `canceled`. A interface mostra rótulos em português. Requerimentos concluídos, indeferidos ou cancelados são fechados para processamento. Como **não há portal do aluno**, um pedido de complemento não significa que o aluno possa responder no próprio sistema.

### Documentos e PDF

- Anexos ficam no bucket **privado** `request-documents`, ligados ao requerimento pela tabela `request_attachments`. Formatos aceitos na abertura: PDF, JPEG e PNG, até 10 MB por arquivo. A abertura do documento utiliza URL assinada de curta duração; nunca exponha o bucket publicamente nem construa links permanentes com caminhos de armazenamento.
- O botão **Baixar PDF** aparece para requerimentos concluídos acessíveis à equipe. O arquivo `requerimento-<protocolo>.pdf` é gerado no navegador com `pdf-lib`, em uma folha A4: via da escola com dados e percurso resumidos e espaço para assinatura; via do aluno com dados básicos, sem observações internas. Ambas trazem logo IPE e protocolo.
- `request_receipts` guarda um snapshot imutável no momento da conclusão, para que uma reimpressão não mude após edição do cadastro. Registros que já estavam concluídos quando a função foi criada têm origem `legacy`, identificada no PDF como dados consolidados posteriormente. O PDF não deve buscar dados atuais para substituir esse snapshot.

### E-mail de criação

O gatilho de inserção registra no máximo um trabalho por requerimento em `request_creation_email_jobs`. Um acionamento imediato e um agendamento periódico chamam a função `dispatch-request-creation-emails`; o Resend recebe chave de idempotência baseada no requerimento. Há tentativas limitadas, diagnóstico de falhas e limpeza dos trabalhos antigos após 30 dias. A função checa instituição, aluno, tipo e destinatário antes de personalizar a mensagem; se não puder confirmar os dados com segurança, usa conteúdo neutro. Reenvios iniciados sob o modelo anterior preservam o corpo antigo.

O e-mail contém protocolo, data/hora e, quando a verificação permite, nome do aluno e tipo do requerimento. Não contém CPF, descrição, anexos ou observações internas. Inclui HTML responsivo com imagens inline e versão em texto simples. O envio do **aviso de conclusão** está isolado e desativado em `supabase/isolated/request-completion-email/`; não o implante como se fosse parte do serviço ativo.

## Arquitetura e fontes de verdade

| Parte | Fonte principal | Responsabilidade |
| --- | --- | --- |
| Interface e identidade | `gestao-academica.html`, `src/backend.css`, imagens e `fonts/` | Estrutura visual, componentes, tema e marca. |
| Aplicação conectada | `src/supabase-app.js`, `src/student-utils.js`, `src/request-utils.js`, `src/receipt-pdf.js` | Sessão, dados, ações de tela, regras auxiliares e geração do PDF. |
| Build estático | `scripts/build.mjs`, `dist/` | Injeta somente URL e chave **publicável** do Supabase, incorpora bibliotecas locais e copia os recursos. `dist/` é gerado; não edite seus arquivos manualmente. |
| Banco | `supabase/migrations/`, `supabase/config.toml`, `supabase/seed.sql` | Modelo, RLS, funções transacionais, gatilhos e configuração local. `seed.sql` não cria usuários/senhas. |
| Serviços privilegiados | `supabase/functions/` | Login/recuperação, administração de colaboradores e envio de e-mail. Segredos ficam fora do navegador e do Git. |
| Verificação | `tests/`, `scripts/check.mjs` | Testes automatizados e verificações estáticas de contratos e do build. |
| Publicação Sites | `.openai/hosting.json` | Metadados da hospedagem Sites; não representa uma configuração de deploy automático no Vercel. |

O HTML ainda contém funções de demonstração acumuladas durante o MVP. O **build de produção** injeta `supabase.js` e `supabase-app.js`; este último sobrescreve os handlers necessários e usa dados reais do Supabase. Portanto, não implemente uma feature apenas em uma função antiga do HTML sem verificar qual handler é efetivamente executado no `dist/index.html`. A configuração é embutida **no build**, não lida dinamicamente após a publicação.

Fluxo de alto nível: navegador estático → Supabase Auth/Data API/RPC/Storage; para administração e login, navegador → Edge Functions; para o e-mail, gatilho/cron do banco → Edge Function → Resend. O Vercel hospeda o site estático, **não** essas funções do Supabase.

### Entidades principais

| Grupo | Tabelas | Relação essencial |
| --- | --- | --- |
| Instituição e acesso | `organizations`, `profiles`, `memberships`, `departments` | Vínculo associa pessoa, instituição, papel e setor. |
| Acadêmico | `courses`, `course_classes`, `students`, `student_enrollments` | Matrícula associa aluno, curso e turma. |
| Definição do processo | `request_types`, `workflow_steps` | Cada tipo tem versões de etapas; uma etapa pode apontar para um departamento ou ser terminal. |
| Execução | `requests`, `protocol_counters`, `request_events`, `request_department_history` | Protocolo, etapa e setor atuais, eventos e setores por onde passou. |
| Arquivos e comprovantes | `request_attachments`, `request_receipts` | Metadados dos objetos privados e snapshot do PDF. |
| Operação auxiliar | `notifications`, `audit_logs`, `request_creation_email_jobs` | Estruturas de notificação/auditoria e fila restrita de e-mail. |

A presença de `notifications` no banco não equivale a uma central completa de notificações na interface conectada; confirme a implementação de qualquer novo comportamento antes de anunciá-lo.

## Dados e permissões

- Cada requerimento pertence a uma instituição, aluno, tipo e versão/etapa do fluxo; guarda setor e responsável atuais, status e datas. Chaves compostas e RLS ajudam a impedir vínculos entre instituições.
- A autorização do navegador é apenas de experiência de uso. A autoridade final está em RLS, RPCs e Edge Functions. Confira funções `can_access_request`, `can_act_on_request`, `can_add_request_content` e as políticas relacionadas ao alterar fluxos ou anexos.
- Administradores têm visão institucional; colaboradores não administradores devem respeitar o setor atual e o histórico autorizado. Não amplie leitura ou escrita de alunos, anexos ou PDFs sem uma revisão explícita de privacidade e isolamento.
- `admin-users` exige administrador autenticado. A função de envio de e-mail usa segredo de despacho e cliente privilegiado no servidor; não pode ser chamada como ação aberta de usuário. A configuração do Auth local desativa cadastro público.
- Dados pessoais exigem cuidado: não coloque nomes, CPF, e-mails reais, tokens, dumps, respostas do banco ou capturas de produção em documentação, testes versionados e exemplos. Use dados fictícios.

## Desenvolvimento local

### Pré-requisitos

- Node.js **20 ou superior** e `pnpm`; dependências fixadas em `package.json` e `pnpm-lock.yaml`.
- Acesso autorizado ao projeto Supabase correto para testes conectados. A CLI do Supabase é dependência local (`pnpm supabase --help`), não é necessário instalar outra versão global.
- Para subir toda a pilha Supabase localmente, siga a documentação da versão instalada e verifique os comandos com `pnpm supabase --help`; isso é diferente de apontar a interface para o banco remoto.

### Preparação e execução

```powershell
git status --short --branch
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
# Edite .env.local localmente: URL do seu projeto e SOMENTE a chave publicável.
pnpm build
pnpm check
pnpm test
npx serve dist -l 4173
```

Abra `http://127.0.0.1:4173/`. O arquivo `.env.local` é ignorado pelo Git. `SUPABASE_URL` deve ser uma URL `https://<projeto>.supabase.co`; `SUPABASE_PUBLISHABLE_KEY` é a chave publicável (uma chave `anon` legada também é aceita pelo build). **Nunca** passe `SUPABASE_SECRET_KEY` ou `SUPABASE_SERVICE_ROLE_KEY` ao processo de build: ele rejeita essas variáveis para evitar vazamento no frontend. Sem URL e chave pública, o build entra em modo pendente e o login fica indisponível; isso não é um modo de demonstração funcional.

`pnpm setup:admin` é uma operação **privilegiada e pontual**, não parte do setup diário: exige projeto vinculado pela CLI, acesso autorizado às chaves administrativas e terminal interativo. Use apenas para criar o primeiro administrador de um ambiente novo, após revisar o script e confirmar o projeto alvo. Nunca o execute por rotina no ambiente de produção existente.

## Banco, funções e e-mail

- Migrações SQL em `supabase/migrations/` são ordenadas e versionadas. Uma mudança de banco deve nascer como nova migração; não reescreva migrações já aplicadas. Inspecione o alvo, o diff, permissões, políticas RLS, `GRANT`/`REVOKE`, gatilhos, dados existentes e plano de retorno antes de aplicar em produção. Consulte a ajuda da CLI instalada antes de escolher comandos ou flags.
- Funções executáveis ficam em `supabase/functions/<nome>/index.ts`; código compartilhado, em `_shared/`. A versão local de uma função **não** altera a função hospedada até a publicação explícita no projeto Supabase correto. O mesmo vale para migrações.
- O build do site e a função de e-mail são implantações separadas. A chave do Resend e o segredo de despacho ficam no Supabase/Vault, nunca no HTML, no `dist/`, no `.env.local` de build ou no Git. O domínio do remetente precisa continuar habilitado no Resend; confirme isso no serviço antes de testar envios reais.
- `supabase/config.toml` descreve a configuração local versionada, inclusive URLs permitidas. **Não presuma** que mudar esse arquivo atualize o painel remoto do Supabase Auth. Verifique no projeto remoto os redirecionamentos de recuperação de senha para cada origem publicada, inclusive `https://protto-ipe.vercel.app`.
- A fila de e-mail é acionada na inserção do requerimento. Não crie requerimentos reais apenas para testar template ou envio sem aprovação: prefira testes automatizados e endereços de teste do provedor. Consulte o estado da fila e os logs da função quando um e-mail não chegar; sucesso na abertura do requerimento não prova aceitação pelo Resend nem entrega na caixa postal.

## Testes e publicação

### Antes de alterar

1. Leia [AGENTS.md](AGENTS.md), registre `git status` e o diff preexistente e preserve alterações de outras pessoas.
2. Localize o contrato afetado no código, nos testes e nas migrações. Verifique se o handler está ativo no build e se o comportamento depende de uma função ou migração já publicada.
3. Para mudanças executáveis, estabeleça a linha de base de `pnpm test`, `pnpm check` e `pnpm build`; depois repita os testes do fluxo alterado e os adjacentes. O `check` é **estático/local**: não comprova sozinho o estado do Supabase remoto, do Resend ou do Vercel.
4. Siga a validação independente e a auditoria de segurança de `AGENTS.md`. Mudanças exclusivamente documentais recebem revisão proporcional.

### Ambientes e origem da publicação

- **GitHub:** `https://github.com/PEDRO-KA/requerimentos.saas`. Confira a branch e o commit antes de publicar: mudanças em uma branch de trabalho só chegam à `main` após integração pelo responsável. Git é a fonte versionada do código, não o servidor de execução.
- **Vercel:** `https://protto-ipe.vercel.app/` recebeu uma publicação inicial a partir de um pacote **local** de arquivos estáticos de `dist/`. Uma captura posterior mostra o Vercel executando `pnpm run build` a partir do repositório, mas essa implantação falhou porque o projeto esperava `public` enquanto o build gera `dist`; também apareceu em modo pendente, sinal de que URL e chave publicável do Supabase não chegaram ao build. Confira no painel qual projeto, branch e ambiente estão conectados ao Git e qual deployment está em produção: a captura, isoladamente, não comprova que todo push publica o site. Para um build conectado ao Git, configure `dist` como diretório de saída e as variáveis públicas `SUPABASE_URL` e `SUPABASE_PUBLISHABLE_KEY` no ambiente correto. Para publicação manual, gere e inspecione `dist/` antes de enviá-lo. Nunca inclua `.env.local`, migrações, segredos ou código de funções no pacote estático. Verifique o resultado e mantenha possibilidade de voltar ao deployment anterior.
- **Sites:** `.openai/hosting.json` aponta `dist/` como diretório estático do site Sites existente. Sites e Vercel são destinos distintos; atualizar um não atualiza o outro.
- **Supabase:** banco, Auth, Storage e Edge Functions têm ciclo próprio. Confirme migrações, segredos, CORS, URLs de redirecionamento e versão das funções no projeto remoto antes de declarar a publicação concluída.

As configurações remotas podem divergir dos arquivos locais. Este README **não atesta** a lista atual de redirects do Auth, os segredos, os agendamentos, a ligação Git nem o estado do último deployment do projeto Vercel; valide esses itens nos serviços antes de uma intervenção operacional. Não publique automaticamente a partir da `main` sem verificar que ela contém as mudanças aprovadas.

### Verificação mínima após publicação

- Abrir a origem publicada e conferir assets, fonte, tema, login e navegação sem erros de console.
- Confirmar entrada com colaborador ativo e bloqueio de conta inativa/não colaboradora, sem expor mensagens de enumeração de usuários.
- Conferir recuperação de senha para a origem correta sem disparar e-mails de teste a pessoas reais.
- Validar visualização por perfil e setor, anexos por URL assinada, fluxo com retorno ao mesmo departamento e PDF de requerimento concluído usando dados autorizados.
- Conferir logs das funções e da fila de e-mail; não inferir entrega ao destinatário só pelo sucesso do banco.

## Segurança, limites e diagnóstico

**Segredos:** URL e chave publicável do Supabase são valores de cliente; ainda assim, não acrescente valores reais aos exemplos. Chaves `secret`/`service_role`, credenciais do Resend, segredos de despacho e tokens de CLI devem permanecer nos gerenciadores apropriados e fora do repositório. Revise o `dist/` antes de publicá-lo. O bucket de anexos e os snapshots do PDF contêm dados sensíveis.

**Diagnóstico por sintoma:**

| Sintoma | Primeiras verificações seguras |
| --- | --- |
| Login indisponível | `.env.local` local, mensagens do build e presença da configuração pública em `dist/index.html`; depois, Auth e função `login-by-identifier`. Não imprima tokens. |
| Login funciona, recuperação volta ao lugar errado | Origem da página, allowlist remota de redirects do Auth, `APP_URL` e função de login publicada. |
| Requerimento não aparece ou botão não habilita | Perfil ativo, instituição/setor, status, etapa atual, eventos de encaminhamento dessa **etapa**, RLS e versão remota das migrações. |
| Anexo não abre | Bucket privado, metadados, políticas de Storage e geração da URL assinada; não torne o bucket público para contornar o erro. |
| PDF ausente | Status `completed`, permissão do colaborador e snapshot em `request_receipts`; diferencie `completion` de `legacy`. |
| E-mail não chegou | Endereço cadastrado, trabalho na fila, tentativas/erro, cron, função publicada, Resend e spam; não reenvie criando outro requerimento real. |
| Site novo parece antigo | Diferencie URL Sites/Vercel/local, branch Git, `dist/` efetivamente enviado e cache; um push isolado não republica o Vercel manual. |

**Limites atuais a considerar antes de escalar:** a interface carrega requerimentos em páginas de 500 até completar o conjunto visível, enquanto listas de alunos e matrículas ativas têm limite de 1.000 registros em consultas específicas. Não prometa paginação de interface ou busca global completa além do que o código entrega. Mudanças de escala devem preservar RLS, filtros por instituição/setor e a consistência das tabelas e PDFs. O sistema possui estrutura de notificações no banco, mas uma central completa deve ser especificada e implementada separadamente.

## Como manter esta documentação

Em **toda nova funcionalidade**, atualize este README no mesmo conjunto de alterações. Atualize-o também quando mudar comportamento, permissão, entidade, integração, comando, variável, requisito de ambiente, fluxo de deploy ou limitação descrita aqui. Registre **o estado implementado**, não apenas o objetivo planejado; identifique o que está em produção, o que está só no repositório e o que depende de validação remota. Se uma feature não alterar o texto, documente na revisão por que o README continua correto.

Checklist para pessoas e agentes:

1. Ler este README e [AGENTS.md](AGENTS.md) antes de editar.
2. Atualizar a seção afetada junto com código/testes/migrações, sem copiar credenciais ou dados reais.
3. Conferir comandos, nomes de arquivos e afirmações contra o estado atual; distinguir código local de serviço remoto.
4. Executar a validação proporcional e revisar o diff de documentação e segurança.
5. Pedir **autorizações separadas** antes de cada commit, push e criação de PR, conforme `AGENTS.md`. Não presumir que publicar no GitHub publica no Vercel ou no Supabase.

Este documento é um ponto de entrada mantido com o produto. Em caso de divergência, a execução atual, as migrações e a configuração remota verificada prevalecem; corrija o README na mesma entrega.
