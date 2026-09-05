import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const root = process.cwd();
const projectRef = (await readFile(path.join(root, "supabase", ".temp", "project-ref"), "utf8")).trim();
if (!/^[a-z0-9]{20}$/.test(projectRef)) throw new Error("Projeto Supabase ainda não foi vinculado pela CLI.");

const cli = process.platform === "win32"
  ? path.join(root, "node_modules", ".pnpm", "@supabase+cli-windows-x64@2.116.0", "node_modules", "@supabase", "cli-windows-x64", "bin", "supabase.exe")
  : path.join(root, "node_modules", ".bin", "supabase");
const command = spawnSync(cli, ["projects", "api-keys", "--project-ref", projectRef, "--output", "json"], {
  cwd: root,
  encoding: "utf8",
  shell: false,
  windowsHide: true,
});
if (command.status !== 0) throw new Error(command.stderr || "Não foi possível obter as chaves pela CLI.");
const parsed = JSON.parse(command.stdout);
const keys = Array.isArray(parsed) ? parsed : parsed.api_keys || parsed.keys || [];
const keyName = (item) => String(item.name || item.type || item.key_type || "").toLowerCase();
const keyValue = (item) => item.api_key || item.apiKey || item.key || item.value;
const publicEntry = keys.find((item) => /publishable/.test(keyName(item))) || keys.find((item) => /anon/.test(keyName(item)));
const secretEntry = keys.find((item) => /^secret/.test(keyName(item))) || keys.find((item) => /service_role/.test(keyName(item)));
const publishableKey = keyValue(publicEntry || {});
const secretKey = keyValue(secretEntry || {});
if (!publishableKey || !secretKey) throw new Error("A CLI não retornou as chaves pública e administrativa necessárias.");

const url = `https://${projectRef}.supabase.co`;
await writeFile(path.join(root, ".env.local"), `SUPABASE_URL=${url}\nSUPABASE_PUBLISHABLE_KEY=${publishableKey}\n`, { encoding: "utf8", mode: 0o600 });
console.log("Configuração pública gravada em .env.local; nenhuma chave secreta foi salva.");

const supabase = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const existing = await supabase.from("memberships").select("user_id").eq("role", "admin").limit(1);
if (existing.error) throw existing.error;
if (existing.data.length) {
  console.log("Um administrador já existe. Bootstrap de credencial ignorado.");
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });
const fullName = (await rl.question("Nome completo do primeiro administrador: ")).trim();
const email = (await rl.question("E-mail do administrador: ")).trim().toLowerCase();
const cpf = (await rl.question("CPF do administrador (somente números ou formatado): ")).replace(/\D/g, "");
rl.close();

function validCpf(value) {
  if (!/^\d{11}$/.test(value) || /^(\d)\1{10}$/.test(value)) return false;
  const digit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) sum += Number(value[index]) * (length + 1 - index);
    const result = (sum * 10) % 11;
    return result === 10 ? 0 : result;
  };
  return digit(9) === Number(value[9]) && digit(10) === Number(value[10]);
}

async function hiddenQuestion(label) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") throw new Error("Execute este script em um terminal interativo para informar a senha com segurança.");
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const handler = (chunk) => {
      for (const char of chunk) {
        if (char === "\u0003") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", handler); reject(new Error("Operação cancelada.")); return; }
        if (char === "\r" || char === "\n") { stdout.write("\n"); stdin.setRawMode(false); stdin.pause(); stdin.off("data", handler); resolve(value); return; }
        if (char === "\u0008" || char === "\u007f") { if (value) { value = value.slice(0, -1); stdout.write("\b \b"); } }
        else { value += char; stdout.write("•"); }
      }
    };
    stdin.on("data", handler);
  });
}

const password = await hiddenQuestion("Senha inicial (mín. 10, maiúscula, minúscula e número): ");
if (fullName.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !validCpf(cpf) || password.length < 10 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
  throw new Error("Nome, e-mail, CPF ou senha não atendem aos requisitos.");
}

const created = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: fullName, cpf },
  app_metadata: {
    organization_id: "00000000-0000-0000-0000-000000000001",
    department_id: "10000000-0000-0000-0000-000000000001",
    role: "admin",
  },
});
if (created.error || !created.data.user) throw created.error || new Error("Não foi possível criar o administrador.");

const { error: membershipError } = await supabase.from("memberships").upsert({
  organization_id: "00000000-0000-0000-0000-000000000001",
  user_id: created.data.user.id,
  department_id: "10000000-0000-0000-0000-000000000001",
  role: "admin",
  created_by: created.data.user.id,
}, { onConflict: "organization_id,user_id" });
if (membershipError) {
  await supabase.auth.admin.deleteUser(created.data.user.id);
  throw membershipError;
}

const { data: membership, error: verificationError } = await supabase
  .from("memberships")
  .select("role")
  .eq("organization_id", "00000000-0000-0000-0000-000000000001")
  .eq("user_id", created.data.user.id)
  .single();
if (verificationError || membership?.role !== "admin") {
  await supabase.auth.admin.deleteUser(created.data.user.id);
  throw verificationError || new Error("A associação administrativa não pôde ser confirmada.");
}
console.log("Primeiro administrador criado e autorizado no banco.");
