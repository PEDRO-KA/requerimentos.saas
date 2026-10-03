export const requestCreationSender = "Protto by IPE <nao-responder@estudeipe.com.br>";
const institutionName = "Instituto Politécnico de Ensino";

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

// Preserve the exact body for jobs that already attempted delivery before this redesign.
export function legacyRequestCreationMessage(delivery) {
  const protocol = String(delivery.request_protocol);
  const openedAt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(delivery.opened_at));
  const safeProtocol = escapeHtml(protocol);
  const safeDate = escapeHtml(openedAt);
  const subject = `Requerimento ${protocol} criado com sucesso`;
  return {
    subject,
    text: `Seu requerimento foi criado com sucesso.\n\nProtocolo: ${protocol}\nData e hora: ${openedAt} (horário de Brasília)\n\nGuarde este número para consultar a secretaria da escola.\n\nEsta é uma mensagem automática do Protto by IPE. Não responda a este e-mail.`,
    html: `<!doctype html><html lang="pt-BR" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeProtocol} — requerimento criado</title></head><body style="margin:0;background:#f5f2fb;font-family:Arial,Helvetica,sans-serif;color:#201832"><div lang="pt-BR" dir="ltr" style="max-width:560px;margin:0 auto;padding:32px 16px"><div style="background:#fff;border:1px solid #e5def1;border-radius:18px;padding:32px"><p style="margin:0 0 28px;color:#6737d8;font-size:19px;font-weight:700">protto <span style="color:#645c72;font-size:13px">by IPE</span></p><h1 style="margin:0 0 16px;font-size:24px;line-height:1.3">Requerimento criado com sucesso</h1><p style="font-size:16px;line-height:1.6">Seu requerimento foi registrado. Guarde o protocolo para consultar a secretaria da escola.</p><div style="background:#f5f2fb;border-radius:12px;padding:18px;margin:24px 0"><p style="margin:0 0 10px;font-size:15px"><strong>Protocolo:</strong> ${safeProtocol}</p><p style="margin:0;font-size:15px"><strong>Data e hora:</strong> ${safeDate} (horário de Brasília)</p></div><p style="margin:0;color:#554c64;font-size:14px;line-height:1.5">Esta é uma mensagem automática do Protto by IPE. Não responda a este e-mail.</p></div></div></body></html>`,
  };
}

function cleanText(value) {
  return String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160);
}

function detailRow(label, value) {
  return `<tr><td style="padding:0 0 5px;color:#52647c;font-size:13px;line-height:19px;font-weight:700">${label}</td></tr><tr><td style="padding:0 0 18px;color:#1b2a3d;font-size:16px;line-height:23px;word-break:break-word">${escapeHtml(value)}</td></tr>`;
}

export function requestCreationMessage(delivery, details = {}) {
  const protocol = cleanText(delivery.request_protocol);
  const openedAt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(delivery.opened_at));
  const studentName = cleanText(details.studentName);
  const requestType = cleanText(details.requestType);
  const personalized = Boolean(studentName && requestType);
  const greeting = personalized ? `Olá, ${studentName}!` : "Olá!";
  const safeProtocol = escapeHtml(protocol);
  const rows = [
    detailRow("Instituição", institutionName),
    ...(personalized ? [detailRow("Aluno", studentName), detailRow("Tipo de requerimento", requestType)] : []),
    detailRow("Data e horário do registro", `${openedAt} (horário de Brasília)`),
  ].join("");
  const text = [
    greeting,
    "Seu requerimento foi registrado com sucesso.",
    "",
    "CONFIRMAÇÃO DE REQUERIMENTO",
    `Protocolo: ${protocol}`,
    `Instituição: ${institutionName}`,
    ...(personalized ? [`Aluno: ${studentName}`, `Tipo de requerimento: ${requestType}`] : []),
    `Data e horário do registro: ${openedAt} (horário de Brasília)`,
    "",
    "Guarde este protocolo para consultar a secretaria da escola.",
    "",
    "Um abraço,",
    "Equipe do IPE",
    "",
    "Esta é uma mensagem automática do Protto by IPE. Não responda a este e-mail.",
  ].join("\n");
  const html = `<!doctype html>
<html lang="pt-BR" dir="ltr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeProtocol} — confirmação de requerimento</title></head>
<body style="margin:0;padding:0;background:#f3f6fa;color:#1b2a3d;font-family:Arial,Helvetica,sans-serif">
<div lang="pt-BR" dir="ltr" style="display:none!important;max-height:0;overflow:hidden;mso-hide:all">Requerimento ${safeProtocol} registrado com sucesso.</div>
<table lang="pt-BR" dir="ltr" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:#f3f6fa"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="border-collapse:separate;width:100%;max-width:600px;background:#ffffff;border:1px solid #e2e9f0;border-radius:16px;overflow:hidden">
<tr><td align="center" style="padding:27px 24px 20px;background:#ffffff"><img src="cid:ipe-email-logo" alt="Instituto Politécnico de Ensino" width="252" height="141" style="display:block;width:252px;max-width:100%;height:auto;border:0"></td></tr>
<tr><td style="padding:10px 32px 32px;background:#ffffff">
<p style="margin:0 0 12px;color:#205a99;font-size:12px;line-height:18px;font-weight:700;letter-spacing:1px;text-transform:uppercase">Confirmação de requerimento</p>
<h1 style="margin:0 0 18px;color:#17263a;font-size:27px;line-height:34px;font-weight:700">Seu requerimento foi registrado.</h1>
<p style="margin:0 0 9px;color:#1b2a3d;font-size:17px;line-height:26px;font-weight:700">${escapeHtml(greeting)}</p>
<p style="margin:0 0 25px;color:#3c4d62;font-size:16px;line-height:25px">Recebemos seu requerimento com sucesso. Confira os dados abaixo e guarde o protocolo para consultar a secretaria da escola.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:separate;background:#f7f9fc;border:1px solid #e2e9f0;border-radius:12px"><tr><td style="padding:22px 23px 4px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse">
<tr><td style="padding:0 0 5px;color:#205a99;font-size:12px;line-height:18px;font-weight:700;letter-spacing:1px;text-transform:uppercase">Número do protocolo</td></tr>
<tr><td style="padding:0 0 19px;color:#17263a;font-size:23px;line-height:30px;font-weight:700;word-break:break-word">${safeProtocol}</td></tr>
${rows}
</table></td></tr></table>
<p style="margin:28px 0 0;color:#1b2a3d;font-size:16px;line-height:24px">Um abraço,<br><strong>Equipe do IPE</strong></p>
<p style="margin:25px 0 0;padding-top:18px;border-top:1px solid #e2e9f0;color:#52647c;font-size:13px;line-height:20px">Esta é uma mensagem automática do Protto by IPE. Não responda a este e-mail.</p>
</td></tr>
<tr><td style="background:#ef3434"><img src="cid:ipe-email-footer" alt="" role="presentation" width="600" height="338" style="display:block;width:100%;max-width:600px;height:auto;border:0"></td></tr>
</table>
</td></tr></table>
</body></html>`;
  return { subject: `Requerimento ${protocol} criado com sucesso`, text, html };
}

export async function requestCreationDetails(admin, delivery) {
  try {
    const { data: queued, error: queueError } = await admin.from("request_creation_email_jobs")
      .select("organization_id,request_id,student_id,recipient_email")
      .eq("id", delivery.delivery_id).maybeSingle();
    if (queueError || !queued?.organization_id ||
      queued.request_id !== delivery.target_request_id ||
      String(queued.recipient_email || "").trim().toLowerCase() !==
        String(delivery.recipient_email || "").trim().toLowerCase()) return {};

    const { data: request, error: requestError } = await admin.from("requests")
      .select("organization_id,student_id,request_type_id,protocol")
      .eq("id", delivery.target_request_id)
      .eq("organization_id", queued.organization_id).maybeSingle();
    if (requestError || !request?.student_id ||
      request.student_id !== queued.student_id ||
      request.protocol !== delivery.request_protocol) return {};

    const [studentResult, typeResult] = await Promise.all([
      admin.from("students").select("full_name,email")
        .eq("id", request.student_id).eq("organization_id", request.organization_id).maybeSingle(),
      admin.from("request_types").select("name")
        .eq("id", request.request_type_id).eq("organization_id", request.organization_id).maybeSingle(),
    ]);
    const student = studentResult.data;
    const type = typeResult.data;
    if (studentResult.error || typeResult.error || !student?.full_name || !type?.name ||
      String(student.email || "").trim().toLowerCase() !==
        String(delivery.recipient_email || "").trim().toLowerCase()) return {};
    return { studentName: student.full_name, requestType: type.name };
  } catch {
    return {};
  }
}

// The existing service-only queue column temporarily holds the template inputs
// until Resend accepts the message. Acceptance replaces this with its message ID.
const snapshotPrefix = "template_v2:";

export function encodeRequestCreationSnapshot(details) {
  return snapshotPrefix + JSON.stringify({
    studentName: cleanText(details.studentName),
    requestType: cleanText(details.requestType),
  });
}

export function decodeRequestCreationSnapshot(value) {
  if (typeof value !== "string" || !value.startsWith(snapshotPrefix)) return null;
  try {
    const parsed = JSON.parse(value.slice(snapshotPrefix.length));
    if (typeof parsed.studentName !== "string" || typeof parsed.requestType !== "string") return null;
    return { studentName: parsed.studentName, requestType: parsed.requestType };
  } catch {
    return null;
  }
}

export function isLegacyRequestCreationRetry(delivery, templateSnapshot) {
  return Number(delivery.delivery_attempt_count) > 1 && !templateSnapshot;
}

export function retryableResendError(status, code = "") {
  return status === 429 || status >= 500 ||
    (status === 409 && code === "concurrent_idempotent_requests");
}

export function validRecipient(email) {
  return typeof email === "string" && email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
