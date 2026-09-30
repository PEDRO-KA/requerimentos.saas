export const requestCreationSender = "Protto by IPE <nao-responder@estudeipe.com.br>";

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function requestCreationMessage(delivery) {
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

export function retryableResendError(status, code = "") {
  return status === 429 || status >= 500 ||
    (status === 409 && code === "concurrent_idempotent_requests");
}

export function validRecipient(email) {
  return typeof email === "string" && email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
