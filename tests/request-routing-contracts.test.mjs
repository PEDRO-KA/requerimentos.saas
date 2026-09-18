import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, singleAdvanceMigration, app, config, isolatedReadme, isolatedMigration, isolatedFunction] = await Promise.all([
  readFile(new URL("../supabase/migrations/202609150001_department_request_routing.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/202609160001_single_user_advance_and_actor_sector.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/supabase-app.js", import.meta.url), "utf8"),
  readFile(new URL("../supabase/config.toml", import.meta.url), "utf8"),
  readFile(new URL("../supabase/isolated/request-completion-email/README.md", import.meta.url), "utf8"),
  readFile(new URL("../supabase/isolated/request-completion-email/migration.sql.disabled", import.meta.url), "utf8"),
  readFile(new URL("../supabase/isolated/request-completion-email/index.ts.disabled", import.meta.url), "utf8"),
]);

test("registra somente setores efetivamente visitados e mantém o fluxo versionado", () => {
  assert.match(migration, /create table public\.request_department_history/);
  assert.match(migration, /primary key \(request_id, workflow_step_id\)/);
  assert.match(migration, /new\.current_department_id[\s\S]*new\.current_step_id/);
  assert.match(migration, /ws\.workflow_version = current_request\.workflow_version/);
  assert.doesNotMatch(migration, /request_department_history[\s\S]{0,300}from public\.workflow_steps/);
});

test("separa leitura histórica de atuação no setor atual", () => {
  const access = migration.match(/create or replace function public\.can_access_request[\s\S]*?\n\$\$;/)?.[0] || "";
  const action = migration.match(/create or replace function public\.can_act_on_request[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(access, /request_department_history/);
  assert.match(access, /public\.is_org_member\(r\.organization_id\)/);
  assert.match(access, /r\.current_department_id = public\.current_department/);
  assert.doesNotMatch(access, /r\.assigned_to = auth\.uid\(\)/);
  assert.match(action, /array\['admin'\]/);
  assert.match(action, /r\.current_department_id = public\.current_department/);
  assert.doesNotMatch(action, /request_department_history/);
  assert.match(migration, /public\.can_add_request_content\(request_id\)/);
});

test("preserva origem processual sem copiar dados sensíveis", () => {
  const snapshot = migration.match(/create or replace function public\.snapshot_request_event[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(snapshot, /actor_name_snapshot/);
  assert.match(snapshot, /from_department_name_snapshot/);
  assert.match(snapshot, /to_department_name_snapshot/);
  assert.doesNotMatch(snapshot, /cpf|email|mobile|birth_date/i);
  assert.match(app, /Encaminhado de \$\{from\} para \$\{to\}/);
});

test("snapshot do setor do ator aparece ao lado do nome sem dados sensíveis", () => {
  assert.match(singleAdvanceMigration, /add column actor_department_name_snapshot text/);
  assert.match(singleAdvanceMigration, /new\.actor_department_name_snapshot/);
  assert.match(singleAdvanceMigration, /m\.organization_id = new\.organization_id/);
  assert.doesNotMatch(singleAdvanceMigration, /update public\.request_events as e/);
  assert.doesNotMatch(singleAdvanceMigration, /cpf|email|mobile|birth_date/i);
  assert.match(app, /actor_department_name_snapshot,from_department_name_snapshot/);
  assert.match(app, /esc\(eventActor\(event\)\).*esc\(eventActorDepartment\(event\)\)/);
});

test("bloqueia novo encaminhamento no banco e preserva somente o complemento", () => {
  const action = singleAdvanceMigration.match(/create or replace function public\.can_act_on_request[\s\S]*?\n\$\$;/)?.[0] || "";
  const content = singleAdvanceMigration.match(/create or replace function public\.can_add_request_content[\s\S]*?\n\$\$;/)?.[0] || "";
  const complement = singleAdvanceMigration.match(/create or replace function public\.request_complement[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(singleAdvanceMigration, /e\.actor_id = auth\.uid\(\)/);
  assert.match(singleAdvanceMigration, /e\.event_type = 'forwarded'/);
  assert.match(singleAdvanceMigration, /e\.to_status = 'completed'/);
  assert.match(action, /not public\.has_advanced_request\(r\.id\)/);
  assert.match(action, /array\['admin'\]/);
  assert.match(content, /volatile[\s\S]*for update[\s\S]*public\.can_act_on_request/);
  assert.match(singleAdvanceMigration, /public\.can_access_request\(r\.id\)/);
  assert.match(complement, /public\.can_request_complement\(current_request\.id\)/);
  assert.match(app, /hasAdvancedRequest\(eventRows, db\.user\.id\)/);
  assert.match(app, /canProcess = canActOnRequest\(item\) && \(isAdmin\(\) \|\| !hasAdvanced\)/);
  assert.match(app, /canRequestComplement \? .*Solicitar complemento/);
});

test("oferece as três visões sem ocultar itens antigos por padrão", () => {
  for (const label of ["Minha fila", "Em andamento", "Concluídos"]) assert.match(app, new RegExp(label));
  assert.match(app, /f\.period = "all"/);
  assert.match(app, /requestUtils\.requestScope/);
  assert.match(app, /Somente acompanhamento/);
});

test("combina atalhos de período com busca por data de abertura", () => {
  assert.match(app, /Data de abertura/);
  assert.match(app, /requestUtils\.matchesPeriod\(x\.created_at, f\.period\)/);
  assert.match(app, /requestUtils\.matchesDate\(x\.created_at, f\.date\)/);
  assert.match(app, /if \(key === "period"\) requestFilters\.date = ""/);
});

test("mantém a função de e-mail arquivada e fora do runtime", () => {
  assert.doesNotMatch(migration, /request_email_deliveries|email_delivery_status|pg_cron|pg_net|vault\./);
  assert.doesNotMatch(app, /dispatch-request-emails|notificado por e-mail|fila de envio/);
  assert.doesNotMatch(config, /\[functions\.dispatch-request-emails\]/);
  assert.match(isolatedReadme, /Nothing here is loaded by the frontend/);
  assert.match(isolatedMigration, /create table public\.request_email_deliveries/);
  assert.match(isolatedFunction, /Idempotency-Key/);
});
