import { json, isAllowedOrigin, options } from "../_shared/http.ts";
import { requireAdmin } from "../_shared/supabase.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

const roles = new Set(["admin", "coordinator", "attendant", "student"]);

function normalizeCpf(value: string) {
  return value.replace(/\D/g, "");
}

function validCpf(value: string) {
  const cpf = normalizeCpf(value);
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const digit = (length: number) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (length + 1 - index);
    }
    const result = (sum * 10) % 11;
    return result === 10 ? 0 : result;
  };
  return digit(9) === Number(cpf[9]) && digit(10) === Number(cpf[10]);
}

function validPassword(value: string) {
  return (
    value.length >= 10 &&
    value.length <= 128 &&
    /[a-z]/.test(value) &&
    /[A-Z]/.test(value) &&
    /\d/.test(value)
  );
}

async function assertDepartment(
  admin: SupabaseClient,
  organizationId: string,
  departmentId: string | null,
) {
  if (!departmentId) return;
  const { data } = await admin
    .from("departments")
    .select("id")
    .eq("id", departmentId)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .maybeSingle();
  if (!data) throw new Error("Departamento inválido.");
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return options(request);
  if (request.method !== "POST") {
    return json(request, { error: "Método não permitido." }, 405);
  }
  if (!isAllowedOrigin(request)) {
    return json(request, { error: "Origem não autorizada." }, 403);
  }

  try {
    const { admin, user: caller, organizationId } = await requireAdmin(request);
    const payload = await request.json();
    const action = String(payload.action || "");

    if (action === "list") {
      const [{ data: profiles, error: profileError }, {
        data: memberships,
        error: membershipError,
      }, { data: departments, error: departmentError }] = await Promise.all([
        admin
          .from("profiles")
          .select("id, full_name, cpf_digits, email, is_active, created_at")
          .order("full_name"),
        admin
          .from("memberships")
          .select("user_id, department_id, role")
          .eq("organization_id", organizationId),
        admin
          .from("departments")
          .select("id, name")
          .eq("organization_id", organizationId)
          .order("name"),
      ]);

      if (profileError || membershipError || departmentError) {
        throw profileError || membershipError || departmentError;
      }

      const membershipByUser = new Map(
        (memberships || []).map((membership) => [membership.user_id, membership]),
      );
      const departmentById = new Map(
        (departments || []).map((department) => [department.id, department.name]),
      );

      return json(request, {
        users: (profiles || [])
          .map((profile) => {
            const membership = membershipByUser.get(profile.id);
            if (!membership) return null;
            return {
              ...profile,
              role: membership.role,
              department_id: membership.department_id,
              department_name: membership.department_id
                ? departmentById.get(membership.department_id) || null
                : null,
            };
          })
          .filter(Boolean),
      });
    }

    if (action === "create") {
      const fullName = String(payload.fullName || "").trim();
      const email = String(payload.email || "").trim().toLowerCase();
      const cpf = normalizeCpf(String(payload.cpf || ""));
      const password = String(payload.password || "");
      const role = String(payload.role || "student");
      const departmentId = payload.departmentId
        ? String(payload.departmentId)
        : null;

      if (
        fullName.length < 2 ||
        !email.includes("@") ||
        !validCpf(cpf) ||
        !validPassword(password) ||
        !roles.has(role)
      ) {
        return json(request, {
          error:
            "Informe nome, e-mail, CPF válido e senha com 10 caracteres, maiúscula, minúscula e número.",
        }, 400);
      }
      await assertDepartment(admin, organizationId, departmentId);

      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName, cpf },
        app_metadata: {
          organization_id: organizationId,
          department_id: departmentId,
          role,
          created_by: caller.id,
        },
      });

      if (error || !data.user) {
        return json(request, {
          error: error?.message || "Não foi possível criar o usuário.",
        }, 400);
      }

      const { error: profileError } = await admin.from("profiles").upsert({
        id: data.user.id,
        full_name: fullName,
        cpf_digits: cpf,
        email,
        is_active: true,
      }, { onConflict: "id" });
      const { error: membershipError } = await admin.from("memberships").upsert({
        organization_id: organizationId,
        user_id: data.user.id,
        department_id: departmentId,
        role,
        created_by: caller.id,
      }, { onConflict: "organization_id,user_id" });

      if (profileError || membershipError) {
        await admin.auth.admin.deleteUser(data.user.id);
        throw profileError || membershipError;
      }

      return json(request, {
        user: {
          id: data.user.id,
          full_name: fullName,
          email,
          cpf_digits: cpf,
          role,
          department_id: departmentId,
          is_active: true,
        },
      }, 201);
    }

    const userId = String(payload.userId || "");
    if (!/^[0-9a-fA-F-]{36}$/.test(userId)) {
      return json(request, { error: "Usuário inválido." }, 400);
    }

    const { data: targetMembership } = await admin
      .from("memberships")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .maybeSingle();
    if (!targetMembership) {
      return json(request, { error: "Usuário não pertence à instituição." }, 404);
    }

    if (action === "update") {
      const fullName = String(payload.fullName || "").trim();
      const email = String(payload.email || "").trim().toLowerCase();
      const cpf = normalizeCpf(String(payload.cpf || ""));
      const password = String(payload.password || "");
      const role = String(payload.role || "");
      const departmentId = payload.departmentId
        ? String(payload.departmentId)
        : null;

      if (
        fullName.length < 2 ||
        !email.includes("@") ||
        !validCpf(cpf) ||
        !roles.has(role) ||
        (password && !validPassword(password))
      ) {
        return json(request, { error: "Dados de usuário inválidos." }, 400);
      }
      if (userId === caller.id && role !== "admin") {
        return json(request, {
          error: "O administrador não pode remover o próprio acesso.",
        }, 400);
      }
      await assertDepartment(admin, organizationId, departmentId);

      const authAttributes = {
        email,
        email_confirm: true,
        user_metadata: { full_name: fullName, cpf },
        app_metadata: {
          organization_id: organizationId,
          department_id: departmentId,
          role,
        },
        ...(password ? { password } : {}),
      };

      const { error: authError } = await admin.auth.admin.updateUserById(
        userId,
        authAttributes,
      );
      if (authError) {
        return json(request, { error: authError.message }, 400);
      }

      const { error: profileError } = await admin
        .from("profiles")
        .update({
          full_name: fullName,
          cpf_digits: cpf,
          email,
        })
        .eq("id", userId);
      if (profileError) throw profileError;

      const { error: membershipError } = await admin
        .from("memberships")
        .update({ role, department_id: departmentId })
        .eq("organization_id", organizationId)
        .eq("user_id", userId);
      if (membershipError) throw membershipError;

      return json(request, { updated: true });
    }

    if (action === "deactivate" || action === "activate") {
      if (userId === caller.id && action === "deactivate") {
        return json(request, {
          error: "O administrador não pode desativar a própria conta.",
        }, 400);
      }
      const activating = action === "activate";
      const { error: authError } = await admin.auth.admin.updateUserById(
        userId,
        { ban_duration: activating ? "none" : "876000h" },
      );
      if (authError) throw authError;
      const { error: profileError } = await admin
        .from("profiles")
        .update({ is_active: activating })
        .eq("id", userId);
      if (profileError) throw profileError;
      return json(request, { active: activating });
    }

    if (action === "delete") {
      if (userId === caller.id) {
        return json(request, {
          error: "O administrador não pode excluir a própria conta.",
        }, 400);
      }
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw error;
      return json(request, { deleted: true });
    }

    return json(request, { error: "Ação inválida." }, 400);
  } catch (error) {
    if (error instanceof Response) {
      return json(
        request,
        { error: error.status === 401 ? "Sessão inválida." : "Acesso negado." },
        error.status,
      );
    }
    return json(request, {
      error: error instanceof Error
        ? error.message
        : "Não foi possível gerenciar o usuário.",
    }, 500);
  }
});
