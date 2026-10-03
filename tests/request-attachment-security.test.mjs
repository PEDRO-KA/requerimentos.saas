import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/supabase-app.js", import.meta.url), "utf8");

test("caminho do anexo não é inserido no HTML do requerimento", () => {
  const detail = app.match(/window\.viewTicket = async function \(id\) \{[\s\S]*?window\.downloadReceipt = async function/)?.[0] || "";
  const dialogContent = detail.match(/dialog\(`Requerimento \$\{esc\(item\.protocol\)\}`,[\s\S]*?"Fechar", closeModal\);/)?.[0] || "";

  assert.ok(dialogContent);
  assert.doesNotMatch(dialogContent, /storage_path|onclick="downloadAttachment/);
  assert.match(dialogContent, /<button class="link" type="button">Abrir<\/button>/);
  assert.match(detail, /addEventListener\("click", \(\) => downloadAttachment\(attachments\[index\]\.storage_path\)\)/);
});
