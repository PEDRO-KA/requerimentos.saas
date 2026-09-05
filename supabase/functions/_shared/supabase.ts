import { createClient } from "npm:@supabase/supabase-js@2";

export function getKeys() {
  const url = Deno.env.get("SUPABASE_URL");
  const publicKey =
    Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ||
    Deno.env.get("SUPABASE_ANON_KEY");
  const secretKey =
    Deno.env.get("SUPABASE_SECRET_KEY") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !publicKey || !secretKey) {
    throw new Error("Supabase function environment is incomplete.");
  }
  return { url, publicKey, secretKey };
}

export function publicClient(authorization?: string) {
  const { url, publicKey } = getKeys();
  return createClient(url, publicKey, {
    global: authorization
      ? { headers: { Authorization: authorization } }
      : undefined,
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function adminClient() {
  const { url, secretKey } = getKeys();
  return createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function requireAdmin(request: Request) {
  const authorization = request.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const client = publicClient(authorization);
  const { data: authData, error: authError } = await client.auth.getUser();
  if (authError || !authData.user) {
    throw new Response("Unauthorized", { status: 401 });
  }

  const admin = adminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("is_active")
    .eq("id", authData.user.id)
    .maybeSingle();

  const { data: membership } = await admin
    .from("memberships")
    .select("organization_id, role")
    .eq("user_id", authData.user.id)
    .eq("role", "admin")
    .maybeSingle();

  if (!profile?.is_active || !membership) {
    throw new Response("Forbidden", { status: 403 });
  }

  return {
    admin,
    user: authData.user,
    organizationId: membership.organization_id as string,
  };
}
