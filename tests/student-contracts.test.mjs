import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, app, lintFix] = await Promise.all([
  readFile(new URL("../supabase/migrations/202609080001_students_courses_classes.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/supabase-app.js", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/202609090001_fix_student_rpc_lint.sql", import.meta.url), "utf8"),
]);

test("mantém operador e aluno como identidades separadas no requerimento", () => {
  assert.match(migration, /requester_id, student_id,[\s\S]*auth\.uid\(\),[\s\S]*target_student_id/);
  assert.match(migration, /new\.requester_id := auth\.uid\(\)/);
  assert.doesNotMatch(migration, /new\.requester_id := coalesce/);
  assert.match(migration, /requests_student_pair_check/);
  assert.match(migration, /requests_student_enrollment_fk/);
});

test("restringe exclusão de aluno ao administrador no banco e na interface", () => {
  const deleteFunction = migration.match(/create or replace function public\.delete_student[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(deleteFunction, /array\['admin'\]::public\.app_role\[\]/);
  assert.match(deleteFunction, /delete from public\.students/);
  assert.match(app, /if \(!isAdmin\(\)\) return notify\("Somente administradores podem excluir alunos\."\)/);
});

test("protege as operações acadêmicas por organização", () => {
  for (const table of ["students", "courses", "course_classes", "student_enrollments"]) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
  assert.match(migration, /foreign key \(class_id, organization_id, course_id\)/);
  assert.match(migration, /security definer[\s\S]*set search_path = ''/);
});

test("mantém cadastro rápido e seleção por id no fluxo do requerimento", () => {
  assert.match(app, /Cadastro rápido de aluno/);
  assert.match(app, /requestDraft\.files = \[\.\.\.files\]/);
  assert.match(app, /target_student_id: requestDraft\.student\.student_id/);
  assert.match(app, /studentSearchSequence/);
});

test("limita a busca a vínculos ativos e evita PII no log de aluno", () => {
  const searchFunction = migration.match(/create or replace function public\.search_students[\s\S]*?\n\$\$;/)?.[0] || "";
  const auditFunction = migration.match(/create or replace function public\.audit_student_change[\s\S]*?\n\$\$;/)?.[0] || "";
  assert.match(searchFunction, /join public\.courses[\s\S]*c\.is_active/);
  assert.match(searchFunction, /join public\.course_classes[\s\S]*cc\.is_active/);
  assert.match(searchFunction, /translate\(/);
  assert.doesNotMatch(auditFunction, /cpf_digits|email|mobile_digits|birth_date/);
});

test("mantém a função de edição sem referências ambíguas", () => {
  assert.match(lintFix, /from public\.student_enrollments as e[\s\S]*e\.student_id = target_student_id/);
  assert.match(lintFix, /update public\.students as s/);
  assert.doesNotMatch(lintFix, /digit_position integer/);
});
