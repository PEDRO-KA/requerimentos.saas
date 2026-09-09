import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const read = (file) => readFile(path.join(root, file), "utf8");
const migrationFiles = (await readdir(path.join(root, "supabase", "migrations"))).filter((name) => name.endsWith(".sql")).sort();
const migrationParts = await Promise.all(migrationFiles.map((name) => read(path.join("supabase", "migrations", name))));
const migrations = migrationParts.join("\n");
const [pkg, source, app, studentUtils, config, login, admin, output] = await Promise.all([
  read("package.json"), read("gestao-academica.html"), read("src/supabase-app.js"),
  read("src/student-utils.js"), read("supabase/config.toml"),
  read("supabase/functions/login-by-identifier/index.ts"),
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
const rlsTables = ["organizations", "departments", "profiles", "memberships", "request_types", "workflow_steps", "protocol_counters", "requests", "request_events", "request_attachments", "notifications", "audit_logs", "courses", "course_classes", "students", "student_enrollments"];
for (const table of rlsTables) expect(migrations.includes(`alter table public.${table} enable row level security`), `RLS ausente em public.${table}.`);
expect(migrations.includes("shares_org_with_user"), "A política de perfis deve evitar recursão RLS.");
expect(migrations.includes("generate_protocol") && migrations.includes("advance_request"), "Funções transacionais ausentes.");
expect(migrations.includes("current_workflow_version") && migrations.includes("save_workflow_steps"), "Versionamento seguro de fluxos ausente.");
expect(app.includes(">Editar etapa</button>") && app.includes('rpc("save_workflow_steps"'), "Editor de etapas não está conectado ao fluxo versionado.");
for (const token of ["create table public.students", "create table public.courses", "create table public.course_classes", "create table public.student_enrollments", "create_request_for_student", "search_students", "delete_student"]) expect(migrations.includes(token), `Contrato acadêmico ausente: ${token}`);
expect(migrations.includes("requests_student_pair_check") && migrations.includes("student_enrollments_one_active_unique"), "Integridade aluno-vínculo-requerimento ausente.");
expect(app.includes("Cadastro rápido de aluno") && app.includes('rpc("create_request_for_student"') && source.includes('data-view="students"'), "Fluxo de alunos não está conectado à interface.");
expect(studentUtils.includes("isValidCpf") && studentUtils.includes("formatMobile"), "Utilitários de CPF e celular ausentes.");
expect(output.includes("student-utils.js"), "Os utilitários de aluno não foram injetados no build.");
expect(login.includes('action === "recover"') && admin.includes("createUser"), "Funções de autenticação incompletas.");
for (const bad of ["''admin''", "''open''", "''request-documents''"]) expect(!migrations.includes(bad), `Aspas SQL inválidas: ${bad}`);

if (failures.length) {
  console.error(failures.map((item) => `- ${item}`).join("\n"));
  process.exit(1);
}
console.log("Validação local concluída: autenticação fechada, RLS, funções e build verificados.");
