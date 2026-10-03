import { adminClient } from "../_shared/supabase.ts";
import {
  decodeRequestCreationSnapshot,
  encodeRequestCreationSnapshot,
  isLegacyRequestCreationRetry,
  legacyRequestCreationMessage,
  requestCreationDetails,
  requestCreationMessage,
  requestCreationSender,
  retryableResendError,
  validRecipient,
} from "../_shared/request-creation-email.mjs";
import { requestCreationInlineImages } from "./assets.mjs";

type Delivery = {
  delivery_id: string;
  target_request_id: string;
  recipient_email: string;
  request_protocol: string;
  opened_at: string;
  delivery_attempt_count: number;
};

function secureEqual(left: string, right: string) {
  if (!left || !right || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return response({ error: "Method not allowed." }, 405);
  const suppliedSecret = request.headers.get("x-email-dispatch-secret") || "";
  if (suppliedSecret.length < 32) return response({ error: "Unauthorized." }, 401);
  const admin = adminClient();
  const credentials = await admin.rpc("get_request_creation_email_credentials").single();
  if (credentials.error) return response({ error: "Email service is not configured." }, 503);
  const dispatchSecret = credentials.data?.dispatch_secret || "";
  if (dispatchSecret.length < 32 || !secureEqual(suppliedSecret, dispatchSecret)) {
    return response({ error: "Unauthorized." }, 401);
  }
  const resendApiKey = credentials.data?.resend_api_key || "";
  if (!resendApiKey.startsWith("re_")) return response({ error: "Email service is not configured." }, 503);

  const claimed = await admin.rpc("claim_request_creation_email_jobs", { p_limit: 10 });
  if (claimed.error) return response({ error: "Email queue unavailable." }, 503);

  let accepted = 0;
  let failed = 0;
  for (const delivery of (claimed.data || []) as Delivery[]) {
    if (!validRecipient(delivery.recipient_email)) {
      await admin.rpc("mark_request_creation_email_failed", {
        p_delivery_id: delivery.delivery_id,
        p_error_code: "invalid_recipient",
        p_retryable: false,
      });
      failed += 1;
      continue;
    }

    const queued = await admin.from("request_creation_email_jobs")
      .select("provider_message_id,organization_id,student_id")
      .eq("id", delivery.delivery_id).maybeSingle();
    if (queued.error || !queued.data) {
      await admin.rpc("mark_request_creation_email_failed", {
        p_delivery_id: delivery.delivery_id,
        p_error_code: "email_template_snapshot_unavailable",
        p_retryable: true,
      });
      failed += 1;
      continue;
    }
    const legacyRetry = isLegacyRequestCreationRetry(
      delivery, queued.data.provider_message_id
    );
    let details = {};
    if (!legacyRetry) {
      if (queued.data.provider_message_id) {
        const snapshot = decodeRequestCreationSnapshot(queued.data.provider_message_id);
        if (!snapshot) {
          await admin.rpc("mark_request_creation_email_failed", {
            p_delivery_id: delivery.delivery_id,
            p_error_code: "email_template_snapshot_invalid",
            p_retryable: false,
          });
          failed += 1;
          continue;
        }
        details = snapshot;
        const student = await admin.from("students").select("email")
          .eq("id", queued.data.student_id)
          .eq("organization_id", queued.data.organization_id).maybeSingle();
        if (student.error || !student.data) {
          await admin.rpc("mark_request_creation_email_failed", {
            p_delivery_id: delivery.delivery_id,
            p_error_code: "email_recipient_check_unavailable",
            p_retryable: true,
          });
          failed += 1;
          continue;
        }
        if (String(student.data.email || "").trim().toLowerCase() !==
          delivery.recipient_email.trim().toLowerCase()) {
          await admin.rpc("mark_request_creation_email_failed", {
            p_delivery_id: delivery.delivery_id,
            p_error_code: "email_recipient_changed",
            p_retryable: false,
          });
          failed += 1;
          continue;
        }
      } else {
        details = await requestCreationDetails(admin, delivery);
        const saved = await admin.from("request_creation_email_jobs")
          .update({ provider_message_id: encodeRequestCreationSnapshot(details) })
          .eq("id", delivery.delivery_id).eq("status", "processing")
          .is("provider_message_id", null).select("id").maybeSingle();
        if (saved.error || !saved.data) {
          await admin.rpc("mark_request_creation_email_failed", {
            p_delivery_id: delivery.delivery_id,
            p_error_code: "email_template_snapshot_unavailable",
            p_retryable: true,
          });
          failed += 1;
          continue;
        }
      }
    }
    const message = legacyRetry
      ? legacyRequestCreationMessage(delivery)
      : requestCreationMessage(delivery, details);
    let providerId = "";
    let errorCode = "resend_network_error";
    let retryable = true;
    try {
      const sent = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `request-created-${delivery.target_request_id}`,
        },
        body: JSON.stringify({
          from: requestCreationSender,
          to: [delivery.recipient_email],
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(legacyRetry ? {} : { attachments: requestCreationInlineImages }),
        }),
        signal: AbortSignal.timeout(10000),
      });
      const result = await sent.json().catch(() => ({}));
      if (sent.ok && typeof result.id === "string" && result.id) {
        providerId = result.id;
      } else {
        const providerCode = typeof result.name === "string" ? result.name : "";
        errorCode = sent.ok ? "resend_missing_id" : `resend_http_${sent.status}`;
        retryable = sent.ok || retryableResendError(sent.status, providerCode);
      }
    } catch {
      errorCode = "resend_network_error";
    }

    if (providerId) {
      const marked = await admin.rpc("mark_request_creation_email_accepted", {
        p_delivery_id: delivery.delivery_id,
        p_provider_message_id: providerId,
      });
      if (!marked.error && marked.data === true) accepted += 1;
      else failed += 1;
    } else {
      await admin.rpc("mark_request_creation_email_failed", {
        p_delivery_id: delivery.delivery_id,
        p_error_code: errorCode,
        p_retryable: retryable,
      });
      failed += 1;
    }
  }

  return response({ processed: (claimed.data || []).length, accepted, failed });
});
