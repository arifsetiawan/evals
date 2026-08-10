import { SignJWT, jwtVerify } from 'jose';
import { prisma } from '@/lib/db';
import bcrypt from 'bcryptjs';
import { checkLoginRateLimit, recordFailedLogin, clearLoginAttempts } from '@/lib/auth/loginRateLimit';
import {
  isKnownBusinessType,
  normalizeEnabledModules,
  resolveBundleModules,
  resolveOrganizationEnabledModules,
  resolveSubscribedModules,
  tierSlugFromSkuName,
} from '@/lib/bundles';
import { resolveFeatures, tierFromSkuName } from '@/lib/features';
import { createLogger } from '@/lib/logger';
import { findUserByEmailIdentity, findUserByPhoneIdentity } from '@/lib/auth/identities';
import { canAccessOwnerSurface, resolveCustomerRoleAccess, type ActiveOrgMembership, type ActiveOrgRole } from '@/lib/auth/accessBoundary';
import type { PermissionTierSlug, RoleAppSlug } from '@/lib/auth/roleAccess';
import { withAuditContext } from '@/lib/audit/autoAudit';

const log = createLogger('app-auth');

const JWT_ISSUER = 'acme-dashboard';
const JWT_EXPIRY = '30d';
const CLIENT_APPS = new Set(['team', 'pos', 'waiter', 'kds', 'owner']);

function getJwtSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new Error('AUTH_SECRET is required for v2 app auth');
  }
  return new TextEncoder().encode(secret);
}

function inferRequiredApp(pathname: string): string | null {
  const match = pathname.match(/^\/api\/v2\/(team|pos|waiter|kds|owner)(?:\/|$)/);
  return match?.[1] ?? null;
}

export interface AppTokenPayload {
  sub: string; // userId
  email: string | null;
  name: string | null;
  role: string;
  organizationId: string;
  organizationName: string;
  onboardingStatus: string | null;
  enabledApps: string[];
  enabledModules: string[];
  modulePermissions: Record<string, { read: boolean; write: boolean; report: boolean; analytics: boolean }>;
  employeeId: string | null;
  businessType: string | null;
  orgRoleId: string | null;
  orgRoleName: string | null;
  ownerAccess: boolean;
  app: string; // team | pos | waiter | kds | owner
  enabledFeatures?: string[];
}

export type AppTokenClaims =
  Pick<AppTokenPayload, 'sub' | 'organizationId' | 'app'>
  & Partial<Omit<AppTokenPayload, 'sub' | 'organizationId' | 'app'>>;

export interface AppAuthContext {
  userId: string;
  email: string | null;
  name: string | null;
  role: string;
  organizationId: string;
  organizationName: string;
  onboardingStatus: string | null;
  enabledApps: string[];
  enabledModules: string[];
  modulePermissions: Record<string, { read: boolean; write: boolean; report: boolean; analytics: boolean }>;
  employeeId: string | null;
  businessType: string | null;
  orgRoleId: string | null;
  orgRoleName: string | null;
  ownerAccess: boolean;
  app: string;
}

function toTokenClaims(payload: AppTokenPayload): Pick<AppTokenPayload, 'sub' | 'organizationId' | 'app'> {
  return {
    sub: payload.sub,
    organizationId: payload.organizationId,
    app: payload.app,
  };
}

export async function signAppToken(payload: AppTokenPayload): Promise<string> {
  return new SignJWT(toTokenClaims(payload))
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setIssuer(JWT_ISSUER)
    .setExpirationTime(JWT_EXPIRY)
    .sign(getJwtSecret());
}

export async function verifyAppToken(token: string): Promise<AppTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret(), { issuer: JWT_ISSUER });
    const app = payload.app;
    const organizationId = payload.organizationId;
    if (
      typeof payload.sub !== 'string'
      || typeof organizationId !== 'string'
      || typeof app !== 'string'
      || !CLIENT_APPS.has(app)
    ) {
      return null;
    }
    return {
      ...(payload as Partial<AppTokenPayload>),
      sub: payload.sub,
      organizationId,
      app,
    };
  } catch {
    return null;
  }
}

type AppAuthResult =
  | { ok: true; payload: AppTokenPayload }
  | { ok: false; error: string; status: number };

type AppAuthUser = {
  id: string;
  email: string | null;
  name: string;
  userOrganizations: Array<{
    orgRoleId: string | null;
    organization: {
      id: string;
      name: string;
      onboardingStatus: string | null;
    };
  }>;
};

type AppAuthMembership = AppAuthUser['userOrganizations'][number];
export type AppLoginOrg = { id: string; name: string };

type EligibleAppMembership = {
  membership: AppAuthMembership;
  payload: AppTokenPayload;
};

type EligibleAppMembershipsResult = {
  eligible: EligibleAppMembership[];
  lastError: AppAuthResult | null;
};

async function resolveAppPayloadForMembership(
  user: { id: string; email: string | null; name: string },
  membership: AppAuthMembership,
  app: string,
): Promise<AppAuthResult> {
  const org = membership.organization;

  let enabledApps: string[] = [];
  let enabledModules: string[] = [];
  let businessType: string | null = null;
  let enabledFeatures: string[] = [];
  let permissionTierSlug: PermissionTierSlug | null = null;

  try {
    const orgApps = await prisma.organizationApp.findMany({
      where: { organizationId: org.id, isEnabled: true },
      select: { appSlug: true, config: true },
    });
    enabledApps = Array.from(new Set(orgApps.map(a => a.appSlug)));

    const hasRequestedApp = enabledApps.includes(app);
    if (!hasRequestedApp) {
      return { ok: false, error: `App '${app}' is not enabled for this organization`, status: 403 };
    }

    const dashboardApp = orgApps.find(a => a.appSlug === 'dashboard');
    if (dashboardApp?.config) {
      const config = dashboardApp.config as Record<string, unknown>;
      if (Array.isArray(config.enabledModules)) {
        enabledModules = normalizeEnabledModules(config.enabledModules as string[]);
      }
    }

    const billingSub = await prisma.billingSubscription.findFirst({
      where: { organizationId: org.id, status: 'ACTIVE', deletedAt: null },
      select: {
        businessType: true,
        tier: { select: { name: true } },
        items: { include: { sku: { select: { name: true, type: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (!billingSub) {
      return { ok: false, error: 'No active subscription', status: 403 };
    }

    businessType = billingSub.businessType || null;
    const subscribedModules = new Set(resolveSubscribedModules({ items: billingSub.items }));
    const bundleTierSlug = billingSub.tier?.name ? tierSlugFromSkuName(billingSub.tier.name) : null;
    permissionTierSlug = bundleTierSlug;
    if (businessType && isKnownBusinessType(businessType) && bundleTierSlug) {
      for (const moduleSlug of resolveBundleModules(businessType, bundleTierSlug)) {
        subscribedModules.add(moduleSlug);
      }
    }

    enabledModules = resolveOrganizationEnabledModules(
      enabledModules,
      Array.from(subscribedModules),
    );
    const featureTierSlug = tierFromSkuName((billingSub.tier as any)?.name);
    const addonFeatures = billingSub.items
      .filter(item => item.sku.type === 'FEATURE')
      .map(item => item.sku.name.toLowerCase());
    enabledFeatures = resolveFeatures(featureTierSlug, addonFeatures);
  } catch (loadErr) {
    log.error('Module resolution failed during app auth', loadErr);
    return { ok: false, error: 'Unable to resolve organization access', status: 503 };
  }

  const entitlementModules = [...enabledModules];
  let orgRole: ActiveOrgRole | null = null;

  if (!membership.orgRoleId) {
    return { ok: false, error: 'Active organization role is required', status: 403 };
  }

  try {
    const storedOrgRole = await prisma.orgRole.findFirst({
      where: { id: membership.orgRoleId, organizationId: org.id },
      select: { id: true, name: true, seatType: true, modulePermissions: true, allowedApps: true },
    });
    if (!storedOrgRole) {
      return { ok: false, error: 'Active organization role is required', status: 403 };
    }

    orgRole = {
      id: storedOrgRole.id,
      name: storedOrgRole.name,
      allowedApps: Array.isArray(storedOrgRole.allowedApps) ? storedOrgRole.allowedApps : [],
      modulePermissions: storedOrgRole.modulePermissions,
      seatType: (storedOrgRole.seatType as 'LITE' | 'STANDARD' | null) ?? null,
    };
  } catch (loadErr) {
    log.error('Org role resolution failed during app auth', loadErr);
    return { ok: false, error: 'Unable to resolve organization role', status: 503 };
  }

  const activeMembership: ActiveOrgMembership = {
    organizationId: org.id,
    role: orgRole.name,
    isActive: true,
    orgRole,
  };

  const roleAccess = resolveCustomerRoleAccess({
    membership: activeMembership,
    enabledModules,
    app: app as RoleAppSlug,
    tierSlug: permissionTierSlug,
  });
  const modulePermissions = roleAccess.modulePermissions;

  const ownerAccess = canAccessOwnerSurface({
    membership: activeMembership,
    enabledApps,
    enabledModules: entitlementModules,
  });

  if (app === 'owner' && !ownerAccess) {
    return {
      ok: false,
      error: 'Owner app requires Owner role access and Insight entitlement',
      status: 403,
    };
  }
  const resolvedEnabledModules = ownerAccess
    ? Array.from(new Set([...enabledModules, 'insight']))
    : enabledModules;

  if (app !== 'owner' && !roleAccess.canAccessApp) {
    return { ok: false, error: `Role does not allow access to the ${app} app`, status: 403 };
  }

  let employeeId: string | null = null;
  try {
    const emp = await prisma.employee.findFirst({
      where: { userId: user.id, organizationId: org.id, deletedAt: null },
      select: { id: true },
    });
    employeeId = emp?.id || null;
  } catch {
    /* non-critical */
  }

  return {
    ok: true,
    payload: {
      sub: user.id,
      email: user.email || null,
      name: user.name,
      role: orgRole.name,
      organizationId: org.id,
      organizationName: org.name,
      onboardingStatus: org.onboardingStatus,
      enabledApps,
      enabledModules: resolvedEnabledModules,
      modulePermissions,
      employeeId,
      businessType,
      orgRoleId: orgRole?.id ?? null,
      orgRoleName: orgRole?.name ?? null,
      ownerAccess,
      app,
      enabledFeatures,
    },
  };
}

async function sortMembershipsForApp(user: AppAuthUser, app: string): Promise<AppAuthMembership[]> {
  const employeeApps = new Set(['team', 'waiter', 'kds']);
  if (!employeeApps.has(app) || user.userOrganizations.length <= 1) {
    return user.userOrganizations;
  }

  const orgIds = user.userOrganizations.map(m => m.organization.id);
  const employees = await prisma.employee.findMany({
    where: { userId: user.id, organizationId: { in: orgIds }, deletedAt: null },
    select: { organizationId: true },
  });
  const employeeOrgIds = new Set(employees.map(e => e.organizationId));

  return [
    ...user.userOrganizations.filter(m => employeeOrgIds.has(m.organization.id)),
    ...user.userOrganizations.filter(m => !employeeOrgIds.has(m.organization.id)),
  ];
}

async function resolveEligibleAppMemberships(
  user: AppAuthUser,
  app: string,
): Promise<EligibleAppMembershipsResult> {
  const sorted = await sortMembershipsForApp(user, app);
  const eligible: EligibleAppMembership[] = [];
  let lastError: AppAuthResult | null = null;

  for (const membership of sorted) {
    const result = await resolveAppPayloadForMembership(user, membership, app);
    if (result.ok) {
      eligible.push({ membership, payload: result.payload });
    } else {
      lastError = result;
    }
  }

  return { eligible, lastError };
}

/**
 * Resolve app auth for a user across all their org memberships.
 * Tries each membership in order and returns the first that fully succeeds.
 * For employee-facing apps (team), prefers the org where the user has an Employee record.
 */
async function resolveAppPayloadForUser(user: AppAuthUser, app: string): Promise<AppAuthResult> {
  if (!CLIENT_APPS.has(app)) {
    return { ok: false, error: 'Invalid app', status: 400 };
  }

  if (user.userOrganizations.length === 0) {
    return { ok: false, error: 'No organization found', status: 403 };
  }

  const { eligible, lastError } = await resolveEligibleAppMemberships(user, app);
  if (eligible.length > 0) {
    return { ok: true, payload: eligible[0].payload };
  }
  return lastError ?? { ok: false, error: 'No eligible organization found', status: 403 };
}

export async function revalidateAppTokenPayload(payload: AppTokenClaims): Promise<AppAuthResult> {
  const user = await prisma.user.findFirst({
    where: {
      id: payload.sub,
      deletedAt: null,
    },
    select: {
      id: true,
      email: true,
      name: true,
      userOrganizations: {
        where: {
          organizationId: payload.organizationId,
          isActive: true,
        },
        select: {
          orgRoleId: true,
          organization: {
            select: {
              id: true,
              name: true,
              onboardingStatus: true,
            },
          },
        },
        take: 1,
      },
    },
  });

  if (!user) {
    return { ok: false, error: 'User no longer has access', status: 403 };
  }

  return resolveAppPayloadForUser(user, payload.app);
}

/**
 * Middleware wrapper for v2 app endpoints.
 * Validates Bearer JWT token and provides user context to handler.
 */
export async function withAppAuth(
  req: Request,
  handler: (ctx: AppAuthContext) => Promise<Response>,
): Promise<Response> {
  const authorization = req.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return Response.json(
      { error: { code: 'UNAUTHORIZED', message: 'Bearer token required' } },
      { status: 401 },
    );
  }

  const token = authorization.slice(7);
  const payload = await verifyAppToken(token);

  if (!payload) {
    return Response.json(
      { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } },
      { status: 401 },
    );
  }

  const requiredApp = inferRequiredApp(new URL(req.url).pathname);
  if (requiredApp && payload.app !== requiredApp) {
    return Response.json(
      { error: { code: 'FORBIDDEN', message: `Token is not valid for the ${requiredApp} app` } },
      { status: 403 },
    );
  }

  const current = await revalidateAppTokenPayload(payload);
  if (!current.ok) {
    return Response.json(
      { error: { code: current.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN', message: current.error } },
      { status: current.status },
    );
  }
  const currentPayload = current.payload;

  const reqPath = new URL(req.url).pathname;
  try {
    const res = await withAuditContext(
      {
        organizationId: currentPayload.organizationId,
        userId: currentPayload.sub,
        actorKind: 'app',
        path: reqPath,
        method: req.method,
      },
      () => handler({
        userId: currentPayload.sub,
        email: currentPayload.email,
        name: currentPayload.name,
        role: currentPayload.role,
        organizationId: currentPayload.organizationId,
        organizationName: currentPayload.organizationName,
        onboardingStatus: currentPayload.onboardingStatus,
        enabledApps: currentPayload.enabledApps,
        enabledModules: currentPayload.enabledModules,
        modulePermissions: currentPayload.modulePermissions,
        employeeId: currentPayload.employeeId,
        businessType: currentPayload.businessType,
        orgRoleId: currentPayload.orgRoleId,
        orgRoleName: currentPayload.orgRoleName,
        ownerAccess: currentPayload.ownerAccess,
        app: currentPayload.app,
      }),
    );
    // Surface handler-returned failures (4xx/5xx) in logs. Handlers return
    // Response.json({ error }, { status }) for validation/not-found instead of
    // throwing, so without this a failed request (e.g. a POS-close 400 for a
    // missing tender count) leaves ZERO server trace — the exact blind spot that
    // made an unclosed cashier session impossible to diagnose. Thrown errors
    // still hit the catch below; this covers the non-throw failure path.
    if (res && res.status >= 400) {
      log.warn(`v2 API ${req.method} ${reqPath} -> ${res.status}`, {
        organizationId: currentPayload.organizationId,
        userId: currentPayload.sub,
        app: currentPayload.app,
      });
    }
    return res;
  } catch (err) {
    log.error(`v2 API handler error ${req.method} ${reqPath}`, err);
    return Response.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
      { status: 500 },
    );
  }
}

export type AppAuthLoginResult =
  | { ok: true; payload: AppTokenPayload }
  | { ok: false; error: string; status: number }
  | { ok: 'select_org'; organizations: AppLoginOrg[]; userId: string };

/**
 * Authenticate a user for a client app (pos, kds, employee, waiter, owner).
 *
 * When `organizationId` is provided, resolve auth for that specific org.
 * When omitted and the user has multiple eligible orgs, returns
 * `{ ok: 'select_org', organizations }` so the client can prompt for a choice.
 */
export async function authenticateAppUser(
  identifier: string,
  password: string,
  app: string,
  organizationId?: string,
  ip?: string | null,
): Promise<AppAuthLoginResult> {
  if (!CLIENT_APPS.has(app)) {
    return { ok: false, error: 'Invalid app', status: 400 };
  }

  const normalized = identifier.trim().toLowerCase();

  if (!checkLoginRateLimit(normalized, ip)) {
    return { ok: false, error: 'Too many login attempts. Try again later.', status: 429 };
  }

  const orgFilter = organizationId
    ? { isActive: true, organizationId }
    : { isActive: true };

  // Support email or phone login
  const isPhone = /^[+\d]/.test(normalized) && !normalized.includes('@');
  const user = isPhone
    ? await findUserByPhoneIdentity(identifier, {
        include: {
          userOrganizations: {
            where: orgFilter,
            orderBy: { createdAt: 'asc' as const },
            include: {
              organization: {
                select: { id: true, name: true, features: true, onboardingStatus: true },
              },
            },
          },
        },
      })
    : await findUserByEmailIdentity(normalized, {
        include: {
          userOrganizations: {
            where: orgFilter,
            orderBy: { createdAt: 'asc' as const },
            include: {
              organization: {
                select: { id: true, name: true, features: true, onboardingStatus: true },
              },
            },
          },
        },
      });

  if (!user || !user.passwordHash) {
    recordFailedLogin(normalized, ip);
    return { ok: false, error: 'Invalid credentials', status: 401 };
  }

  const passwordMatch = await bcrypt.compare(password, user.passwordHash);
  if (!passwordMatch) {
    recordFailedLogin(normalized, ip);
    return { ok: false, error: 'Invalid credentials', status: 401 };
  }

  clearLoginAttempts(normalized);

  // If user has multiple eligible orgs and no specific org was requested, prompt selection.
  if (!organizationId && user.userOrganizations.length > 1) {
    const { eligible, lastError } = await resolveEligibleAppMemberships(user, app);
    if (eligible.length === 0) {
      return lastError ?? { ok: false, error: 'No eligible organization found', status: 403 };
    }
    if (eligible.length === 1) {
      return { ok: true, payload: eligible[0].payload };
    }
    return {
      ok: 'select_org',
      organizations: eligible.map(({ membership }) => ({
        id: membership.organization.id,
        name: membership.organization.name,
      })),
      userId: user.id,
    };
  }

  return resolveAppPayloadForUser(user, app);
}

/**
 * Switch the current token to a different organization.
 * Validates the user still has an active membership in the target org.
 */
export async function switchAppOrg(
  currentPayload: AppTokenClaims,
  targetOrgId: string,
): Promise<AppAuthResult> {
  const user = await prisma.user.findFirst({
    where: { id: currentPayload.sub, deletedAt: null },
    select: {
      id: true,
      email: true,
      name: true,
      userOrganizations: {
        where: { organizationId: targetOrgId, isActive: true },
        select: {
          orgRoleId: true,
          organization: {
            select: { id: true, name: true, onboardingStatus: true },
          },
        },
        take: 1,
      },
    },
  });

  if (!user || user.userOrganizations.length === 0) {
    return { ok: false, error: 'No membership in target organization', status: 403 };
  }

  return resolveAppPayloadForMembership(user, user.userOrganizations[0], currentPayload.app);
}

export async function listSelectableAppOrganizations(userId: string, app: string): Promise<AppLoginOrg[]> {
  if (!CLIENT_APPS.has(app)) return [];

  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: {
      id: true,
      email: true,
      name: true,
      userOrganizations: {
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
        select: {
          orgRoleId: true,
          organization: {
            select: { id: true, name: true, onboardingStatus: true },
          },
        },
      },
    },
  });

  if (!user) return [];

  const { eligible } = await resolveEligibleAppMemberships(user, app);
  return eligible.map(({ membership }) => ({
    id: membership.organization.id,
    name: membership.organization.name,
  }));
}
