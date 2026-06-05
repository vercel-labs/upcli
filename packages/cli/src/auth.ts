import { getAuth, inferScope, OAuth, updateAuthConfig } from "@vercel/sandbox/dist/auth/index.js";

/**
 * Credentials accepted by the Sandbox SDK. `token` may be a personal access
 * token or an OIDC token.
 */
export interface Credentials {
  token: string;
  teamId: string;
  projectId: string;
}

export type AuthState =
  // Explicit credentials from VERCEL_TOKEN/TEAM_ID/PROJECT_ID.
  | { kind: "explicit"; credentials: Credentials }
  // VERCEL_OIDC_TOKEN is present; let the SDK resolve from it (pass no creds).
  | { kind: "oidc" }
  // Reused the Vercel CLI login + inferred/created the project scope.
  | { kind: "cli"; credentials: Credentials }
  // No usable credentials found anywhere.
  | { kind: "anonymous" };

/**
 * Resolve how we will authenticate to Vercel, reusing the existing Vercel CLI
 * login when possible. We never print or log the token itself.
 *
 * Precedence: explicit env creds > OIDC token > Vercel CLI `auth.json`.
 */
export async function resolveAuth(cwd: string): Promise<AuthState> {
  const env = process.env;

  if (env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID) {
    return {
      kind: "explicit",
      credentials: {
        token: env.VERCEL_TOKEN,
        teamId: env.VERCEL_TEAM_ID,
        projectId: env.VERCEL_PROJECT_ID,
      },
    };
  }

  if (env.VERCEL_OIDC_TOKEN) {
    return { kind: "oidc" };
  }

  let auth = getAuth();
  if (!auth?.token) {
    return { kind: "anonymous" };
  }

  // Refresh an expired CLI token when a refresh token is available.
  if (auth.refreshToken && auth.expiresAt && auth.expiresAt.getTime() <= Date.now()) {
    try {
      const oauth = await OAuth();
      const next = await oauth.refreshToken(auth.refreshToken);
      auth = {
        token: next.access_token,
        refreshToken: next.refresh_token ?? auth.refreshToken,
        expiresAt: new Date(Date.now() + next.expires_in * 1000),
      };
      updateAuthConfig(auth);
    } catch {
      // Fall through: inferScope below will fail and the caller guides re-login.
    }
  }

  const token = auth.token;
  if (!token) return { kind: "anonymous" };

  // Resolve the team/project scope. Reads `.vercel/project.json` if linked,
  // otherwise resolves a team and creates a default sandbox project.
  let scope: Awaited<ReturnType<typeof inferScope>>;
  try {
    scope = await inferScope({ token, cwd });
  } catch (err) {
    // The SDK suggests `--scope`, a flag `up` does not have. Replace with
    // the VERCEL_TEAM_ID env var, which does the same thing here.
    if (err instanceof Error && err.message.includes("--scope")) {
      throw new Error(
        err.message.replace(
          /\. Specify a team explicitly with --scope <team-id-or-slug>\./,
          ". Set VERCEL_TEAM_ID=<team-id> to specify a team explicitly.",
        ),
      );
    }
    throw err;
  }
  return {
    kind: "cli",
    credentials: { token, teamId: scope.teamId, projectId: scope.projectId },
  };
}

/** Credentials to pass to the SDK, or undefined to let the SDK self-resolve. */
export function credentialsFor(state: AuthState): Credentials | undefined {
  return state.kind === "explicit" || state.kind === "cli" ? state.credentials : undefined;
}
