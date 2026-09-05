import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const read = (file) => readFile(path.join(root, file), "utf8");
const [pkg, source, app, config, core, access, workflow, login, admin, output] = await Promise.all([
  read("package.json"), read("gestao-academica.html"), read("src/supabase-app.js"), read("supabase/config.toml"),
  read("supabase/migrations/202609040001_core_schema.sql"), read("supabase/migrations/202609040002_access_control.sql"),
  read("supabase/migrations/202609040003_workflow_functions.sql"), read("supabase/functions/login-by-identifier/index.ts"),
  read("supabase/functions/admin-users/index.ts"), read("dist/index.html"),
]);
const failures = [];
const expect = (condition, message) => { if (!condition) failures.push(message); };

const manifest = JSON.parse(pkg);
expect(manifest.devDependencies?.supabase === "2.116.0", "A CLI do Supabase deve estar fixada em 2.116.0.");
expect(/^2\./.test(manifest.dependencies?.["@supabase/supabase-js"] || ""), "O cliente Supabase deve estar fixado.");
for (const token of ["admin123", "atendente123", "coord123", "Cadastre-se"]) expect(!source.includes(token), `Conteúdo inseguro no HTML: ${token}`);
expect(source.includes("data.credentials={}"), "As credenciais locais devem permanecer vazias.");
expect(!/SUPABASE_(SECRET|SERVICE_ROLE)/.test(app), "O frontend não pode referenciar chaves secretas.");
expect(!/sb_secret_|service_role/i.test(output), "O build contém marcador de chave secreta.");
expect(output.includes("supabase-app.js") && output.includes("supabase.js"), "Os scripts do Supabase não foram injetados.");
expect(config.includes("enable_signup = false"), "O cadastro público deve estar desativado.");
expect(/\[auth\.email\][\s\S]*?enable_signup = true/.test(config), "O provedor de e-mail deve continuar habilitado.");
expect((access.match(/enable row level security/g) || []).length === 12, "Todas as 12 tabelas públicas devem usar RLS.");
expect(access.includes("shares_org_with_user"), "A política de perfis deve evitar recursão RLS.");
expect(workflow.includes("generate_protocol") && workflow.includes("advance_request"), "Funções transacionais ausentes.");
expect(login.includes('action === "recover"') && admin.includes("createUser"), "Funções de autenticação incompletas.");
for (const bad of ["''admin''", "''open''", "''request-documents''"]) expect(!(core + access + workflow).includes(bad), `Aspas SQL inválidas: ${bad}`);

if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log("Validação local concluída: autenticação fechada, RLS, funções e build verificados.");
