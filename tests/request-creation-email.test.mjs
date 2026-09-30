import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  requestCreationMessage,
  requestCreationSender,
  retryableResendError,
  validRecipient,
} from "../supabase/functions/_shared/request-creation-email.mjs";

const delivery = {
  request_protocol: "#2026-0042",
  opened_at: "2026-09-29T17:40:00.000Z",
  request_type_name: "Assunto reservado",
  description: "Descrição confidencial",
  cpf_digits: "12345678909",
};

test("a confirmação contém apenas protocolo e data no horário da escola", () => {
  const message = requestCreationMessage(delivery);
  assert.equal(requestCreationSender, "Protto by IPE <nao-responder@estudeipe.com.br>");
  assert.match(message.subject, /#2026-0042/);
  assert.match(message.text, /29\/09\/2026.*14:40/);
  assert.match(message.html, /lang="pt-BR" dir="ltr"/);
  assert.match(message.html, /<h1/);
  for (const secret of [delivery.request_type_name, delivery.description, delivery.cpf_digits]) {
    assert.ok(!`${message.subject}${message.text}${message.html}`.includes(secret));
  }
  assert.match(message.text, /Não responda a este e-mail/);
});

test("o protocolo é escapado no HTML", () => {
  const message = requestCreationMessage({ ...delivery, request_protocol: "<script>alert(1)</script>" });
  assert.ok(!message.html.includes("<script>"));
  assert.match(message.html, /&lt;script&gt;/);
});

test("endereços inválidos falham sem impedir a criação do requerimento", () => {
  assert.equal(validRecipient("aluno@exemplo.com.br"), true);
  for (const email of ["", "sem-arroba", "aluno@", "aluno @exemplo.com", null]) {
    assert.equal(validRecipient(email), false);
  }
});

test("somente falhas transitórias são repetidas", () => {
  assert.equal(retryableResendError(429), true);
  assert.equal(retryableResendError(503), true);
  assert.equal(retryableResendError(409, "concurrent_idempotent_requests"), true);
  assert.equal(retryableResendError(409, "invalid_idempotent_request"), false);
  assert.equal(retryableResendError(422), false);
});

test("a fila nasce com o requerimento e não envia para histórico anterior", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20260929204746_request_creation_email.sql", import.meta.url), "utf8");
  const expiryMigration = await readFile(new URL("../supabase/migrations/20260929204907_request_creation_email_claim_expiry.sql", import.meta.url), "utf8");
  const dispatcher = await readFile(new URL("../supabase/functions/dispatch-request-creation-emails/index.ts", import.meta.url), "utf8");
  assert.match(migration, /after insert on public\.requests/);
  assert.match(migration, /if new\.student_id is null then return new/);
  assert.match(migration, /request_id uuid not null unique/);
  assert.doesNotMatch(migration, /insert into public\.request_creation_email_jobs[\s\S]*?from public\.requests/);
  assert.match(migration, /for update of queued skip locked/);
  assert.match(migration, /23 hours/);
  assert.match(migration, /private\.purge_request_creation_email_jobs\(\)/);
  assert.match(migration, /delete from public\.request_creation_email_jobs as delivery\s+where delivery\.created_at < now\(\) - interval '30 days'/);
  assert.match(migration, /request-creation-email-purge-daily/);
  assert.match(expiryMigration, /queued\.created_at > now\(\) - interval '30 days'/);
  assert.match(dispatcher, /Idempotency-Key.*request-created-/);
  assert.match(dispatcher, /x-email-dispatch-secret/);
  assert.doesNotMatch(dispatcher, /publicClient\(|auth\.getUser\(/);
});
