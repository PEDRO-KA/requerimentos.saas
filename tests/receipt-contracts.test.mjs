import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const [migration, app, html, login, build] = await Promise.all([
  read("../supabase/migrations/20260918191956_request_receipt_pdf.sql"),
  read("../src/supabase-app.js"),
  read("../gestao-academica.html"),
  read("../supabase/functions/login-by-identifier/index.ts"),
  read("../scripts/build.mjs"),
]);

test("snapshot nasce ao concluir e registros anteriores são identificados", () => {
  assert.match(migration, /after insert on public\.request_events[\s\S]*capture_completed_request_receipt/);
  assert.match(migration, /if new\.to_status = 'completed'/);
  assert.match(migration, /on conflict \(request_id\) do nothing/);
  assert.match(migration, /capture_request_receipt\(r\.id, 'legacy'\)/);
  for (const key of ["'student'", "'discipline'", "'creator'", "'route'", "'observations'", "'opened_at'", "'completed_at'"]) {
    assert.ok(migration.includes(key), `Falta ${key} no snapshot.`);
  }
});

test("legados sem cadastro de aluno usam perfil apenas se o solicitante era aluno", () => {
  assert.match(migration, /when requester_membership\.role = 'student' then creator\.full_name/);
  assert.match(migration, /when requester_membership\.role = 'student' then creator\.cpf_digits/);
  assert.match(migration, /when requester_membership\.role = 'student' then creator\.email/);
  assert.match(migration, /requester_membership\.organization_id = r\.organization_id/);
});

test("comprovante e leitura de requerimentos respeitam equipe e instituição", () => {
  assert.match(migration, /alter table public\.request_receipts enable row level security/);
  assert.match(migration, /grant select on table public\.request_receipts to authenticated/);
  assert.doesNotMatch(migration, /grant (?:insert|update|delete) on table public\.request_receipts to authenticated/);
  assert.match(migration, /request_receipts_select_staff[\s\S]*has_org_role\([\s\S]*can_access_request\(request_id\)/);
  assert.match(migration, /create or replace function public\.can_access_request[\s\S]*array\['admin', 'coordinator', 'attendant'\]/);
  assert.match(migration, /create policy requests_insert_authorized[\s\S]*array\['admin', 'coordinator', 'attendant'\]/);
});

test("somente colaboradores entram e abrem requerimentos", () => {
  assert.doesNotMatch(html, /data-view="portal"/);
  assert.match(app, /if \(!isStaff\(\)\) throw new Error\("Acesso exclusivo a colaboradores\."\)/);
  assert.match(app, /rpc\("create_request_for_student_with_discipline"/);
  assert.doesNotMatch(app, /from\("requests"\)\.insert/);
  assert.match(login, /\.in\("role", \["admin", "coordinator", "attendant"\]\)/);
});

test("distribuição inclui biblioteca, logo PNG e gerador local", () => {
  for (const name of ["pdf-lib.js", "receipt-pdf.js", "ipe-logo.png"]) {
    assert.ok(build.includes(name), `Falta o arquivo ${name} no build.`);
  }
  assert.match(app, /item\.status === "completed"[\s\S]*Baixar PDF/);
  assert.match(app, /from\("request_receipts"\)/);
  assert.match(app, /protocol\.replace\(\/\[\^a-z0-9#-\]\/gi/);
  assert.match(app, /async function loadAllRequests[\s\S]*\.range\(start, start \+ pageSize - 1\)/);
});
