import { json, isAllowedOrigin, options } from "../_shared/http.ts";
import { adminClient, publicClient } from "../_shared/supabase.ts";

const cpfDigits = (value: string) => value.replace(/\D/g, "");

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return options(request);
  if (request.method !== "POST") {
    return json(request, { error: "Método não permitido." }, 405);
  }
  if (!isAllowedOrigin(request)) {
    return json(request, { error: "Origem não autorizada." }, 403);
  }

  try {
    const payload = await request.json();
    const action = String(payload.action || "login");
    const identifier = String(payload.identifier || "").trim().toLowerCase();
    const password = String(payload.password || "");
    const recoveryMessage = {
      message:
        "Se o cadastro estiver ativo, as instruções serão enviadas ao e-mail registrado.",
    };
    const invalidResponse = () =>
      action === "recover"
        ? json(request, recoveryMessage)
        : json(request, { error: "Usuário ou senha inválidos." }, 401);

    if (action !== "login" && action !== "recover") {
      return json(request, { error: "Ação inválida." }, 400);
    }
    if (!identifier) {
      return invalidResponse();
    }

    const admin = adminClient();
    let profileQuery = admin
      .from("profiles")
      .select("email, is_active");

    if (!identifier.includes("@")) {
      const cpf = cpfDigits(identifier);
      if (cpf.length !== 11) {
        return invalidResponse();
      }
      profileQuery = profileQuery.eq("cpf_digits", cpf);
    } else {
      if (identifier.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier)) {
        return invalidResponse();
      }
      profileQuery = profileQuery.eq("email", identifier);
    }

    const { data: profile, error: profileError } = await profileQuery
      .maybeSingle();
    if (profileError || !profile?.email || !profile.is_active) {
      return invalidResponse();
    }
    const email = profile.email;

    const client = publicClient();
    if (action === "recover") {
      const appUrl = (
        Deno.env.get("APP_URL") ||
        "https://ipe-gestao-academica.spedrohenrique303.chatgpt.site"
      ).replace(/\/$/, "");
      await client.auth.resetPasswordForEmail(email, {
        redirectTo: appUrl,
      });
      return json(request, recoveryMessage);
    }

    if (password.length < 6 || password.length > 256) {
      return json(request, { error: "Usuário ou senha inválidos." }, 401);
    }

    const { data, error } = await client.auth.signInWithPassword({
      email,
      password,
    });

    if (error || !data.session || !data.user) {
      return json(request, { error: "Usuário ou senha inválidos." }, 401);
    }

    return json(request, {
      session: {
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        expires_in: data.session.expires_in,
        token_type: data.session.token_type,
      },
    });
  } catch {
    return json(request, { error: "Não foi possível concluir o acesso." }, 400);
  }
});
