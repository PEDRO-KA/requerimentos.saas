import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [migration, app] = await Promise.all([
  readFile(new URL("../supabase/migrations/20260919192327_delete_request_type.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/supabase-app.js", import.meta.url), "utf8"),
]);

test("exclusão de tipo exige administrador da mesma instituição", () => {
  assert.match(migration, /security definer[\s\S]*set search_path = ''/);
  assert.match(migration, /has_org_role\([\s\S]*target_organization_id[\s\S]*array\['admin'\]/);
  assert.match(migration, /rt\.organization_id = target_organization_id/);
  assert.match(migration, /revoke all on function public\.delete_request_type\(uuid, uuid\) from public, anon/);
  assert.match(migration, /grant execute on function public\.delete_request_type\(uuid, uuid\) to authenticated/);
});

test("histórico impede exclusão e fluxos sem uso podem ser removidos", () => {
  assert.match(migration, /from public\.requests as r[\s\S]*r\.organization_id = target_organization_id[\s\S]*r\.request_type_id = target_request_type_id/);
  assert.match(migration, /Request type has request history and cannot be deleted/);
  assert.match(migration, /delete from public\.request_types as rt/);
});

test("interface oferece botão e confirmação visual sem caixa nativa", () => {
  assert.match(app, /confirmDeleteRequirementType\('\$\{t\.id\}'\)[\s\S]*>Excluir<\/button>/);
  assert.match(app, /dialog\("Excluir tipo de requerimento"[\s\S]*role="alert"[\s\S]*rpc\("delete_request_type"/);
  assert.match(app, /Desative-o para impedir novos usos/);
  assert.doesNotMatch(app, /\b(?:alert|confirm|prompt)\s*\(/);
});
