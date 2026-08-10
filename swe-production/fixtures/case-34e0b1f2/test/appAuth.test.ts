import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
  resolveCustomerRoleAccess: vi.fn(),
  prisma: {
    user: { findFirst: vi.fn() },
    organizationApp: { findMany: vi.fn() },
    billingSubscription: { findFirst: vi.fn() },
    orgRole: { findFirst: vi.fn() },
    employee: { findFirst: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: mocks.prisma,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    warn: mocks.logWarn,
    error: mocks.logError,
  }),
}));

vi.mock('@/lib/audit/autoAudit', () => ({
  withAuditContext: async (_ctx: unknown, fn: () => Promise<Response>) => fn(),
}));

vi.mock('@/lib/bundles', () => ({
  isKnownBusinessType: () => true,
  normalizeEnabledModules: (modules: string[]) => modules,
  resolveBundleModules: () => ['pos'],
  resolveOrganizationEnabledModules: (_enabled: string[], subscribed: string[]) => subscribed,
  resolveSubscribedModules: () => ['pos'],
  tierSlugFromSkuName: () => 'standard',
}));

vi.mock('@/lib/features', () => ({
  resolveFeatures: () => [],
  tierFromSkuName: () => 'standard',
}));

vi.mock('@/lib/auth/accessBoundary', () => ({
  canAccessOwnerSurface: () => false,
  resolveCustomerRoleAccess: (...args: unknown[]) => mocks.resolveCustomerRoleAccess(...args),
}));

import { signAppToken, verifyAppToken, withAppAuth, type AppTokenPayload } from '../src/appAuth';

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

function payload(overrides: Partial<AppTokenPayload> = {}): AppTokenPayload {
  return {
    sub: 'user-1',
    email: 'user@example.com',
    name: 'Test User',
    role: 'Admin',
    organizationId: 'org-1',
    organizationName: 'Test Org',
    onboardingStatus: 'COMPLETED',
    enabledApps: ['dashboard', 'owner', 'team', 'pos', 'waiter', 'kds'],
    enabledModules: Array.from({ length: 48 }, (_, index) => `module-${index}`),
    modulePermissions: Object.fromEntries(
      Array.from({ length: 48 }, (_, index) => [
        `module-${index}`,
        { read: true, write: true, report: true, analytics: false },
      ]),
    ),
    employeeId: 'emp-1',
    businessType: 'retail',
    orgRoleId: 'role-1',
    orgRoleName: 'Admin',
    ownerAccess: true,
    app: 'pos',
    enabledFeatures: ['api-access', 'deep-agent'],
    ...overrides,
  };
}

describe('app auth JWT', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCustomerRoleAccess.mockReturnValue({
      canAccessApp: true,
      modulePermissions: {
        pos: { read: true, write: true, report: true, analytics: false },
      },
    });
    process.env.AUTH_SECRET = 'test-app-auth-secret-at-least-32-bytes';
    mocks.prisma.user.findFirst.mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      name: 'Test User',
      userOrganizations: [
        {
          orgRoleId: 'role-1',
          organization: {
            id: 'org-1',
            name: 'Test Org',
            onboardingStatus: 'COMPLETED',
          },
        },
      ],
    });
    mocks.prisma.organizationApp.findMany.mockResolvedValue([
      { appSlug: 'pos', config: {} },
      { appSlug: 'dashboard', config: { enabledModules: ['pos'] } },
    ]);
    mocks.prisma.billingSubscription.findFirst.mockResolvedValue({
      businessType: 'retail',
      tier: { name: 'Standard' },
      items: [],
    });
    mocks.prisma.orgRole.findFirst.mockResolvedValue({
      id: 'role-1',
      name: 'Admin',
      seatType: 'STANDARD',
      allowedApps: ['pos'],
      modulePermissions: { pos: 'write' },
    });
    mocks.prisma.employee.findFirst.mockResolvedValue({ id: 'emp-1' });
    mocks.prisma.employee.findMany.mockResolvedValue([]);
  });

  it('signs thin Suite app tokens and leaves capability hydration server-side', async () => {
    const token = await signAppToken(payload());
    const decoded = decodeJwtPayload(token);

    expect(decoded).toMatchObject({
      sub: 'user-1',
      organizationId: 'org-1',
      app: 'pos',
      iss: 'acme-dashboard',
    });
    expect(decoded).not.toHaveProperty('enabledApps');
    expect(decoded).not.toHaveProperty('enabledModules');
    expect(decoded).not.toHaveProperty('modulePermissions');
    expect(decoded).not.toHaveProperty('organizationName');
    expect(token.length).toBeLessThan(700);
  });

  it('verifies the minimal claims needed to revalidate the session', async () => {
    const token = await signAppToken(payload({ app: 'owner' }));

    await expect(verifyAppToken(token)).resolves.toMatchObject({
      sub: 'user-1',
      organizationId: 'org-1',
      app: 'owner',
    });
  });

  it('logs handler-returned v2 failures with method, path, status, and app context', async () => {
    const token = await signAppToken(payload({ app: 'pos' }));
    const req = new Request('https://dashboard.test/api/v2/pos/sessions/session-1/close', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    const res = await withAppAuth(req, async () =>
      Response.json({ error: { code: 'BAD_REQUEST', message: 'Missing closing count' } }, { status: 400 }),
    );

    await expect(res.json()).resolves.toEqual({
      error: { code: 'BAD_REQUEST', message: 'Missing closing count' },
    });
    expect(mocks.logWarn).toHaveBeenCalledWith(
      'v2 API POST /api/v2/pos/sessions/session-1/close -> 400',
      {
        organizationId: 'org-1',
        userId: 'user-1',
        app: 'pos',
      },
    );
    expect(mocks.logError).not.toHaveBeenCalled();
  });

  it('allows a POS token to call waiter endpoints only with waiter-terminal access', async () => {
    mocks.resolveCustomerRoleAccess.mockReturnValue({
      canAccessApp: true,
      modulePermissions: {
        pos: { read: true, write: true, report: true, analytics: false },
        'fnb-service.waiter-terminals': { read: true, write: false, report: false, analytics: false },
      },
    });
    const token = await signAppToken(payload({ app: 'pos' }));
    const req = new Request('https://dashboard.test/api/v2/waiter/bootstrap', {
      headers: { authorization: `Bearer ${token}` },
    });

    const res = await withAppAuth(req, async () => Response.json({ ok: true }));

    expect(res.status).toBe(200);
  });

  it('rejects a POS token without waiter-terminal access on waiter endpoints', async () => {
    const token = await signAppToken(payload({ app: 'pos' }));
    const req = new Request('https://dashboard.test/api/v2/waiter/bootstrap', {
      headers: { authorization: `Bearer ${token}` },
    });

    const res = await withAppAuth(req, async () => Response.json({ ok: true }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: { code: 'FORBIDDEN', message: 'POS role cannot access waiter endpoints' },
    });
  });
});
