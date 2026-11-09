/**
 * @file prisma-mock.helper.ts
 * @description Generic Prisma mock factory for unit tests.
 *
 * Creates a proxy-based mock of PrismaService where every model name
 * (e.g., member, church, profile) is dynamically available with mockable
 * query methods (findMany, findUnique, create, update, delete, count).
 *
 * Usage:
 *   const prisma = createPrismaMock();
 *   prisma.member.findMany.mockResolvedValue([mockMember]);
 *
 * @module test/helpers/prisma-mock
 * @since 1.0.0
 */

export type MockPrismaModel = {
  findMany: jest.Mock;
  findUnique: jest.Mock;
  findFirst: jest.Mock;
  findFirstOrThrow: jest.Mock;
  create: jest.Mock;
  createMany: jest.Mock;
  update: jest.Mock;
  updateMany: jest.Mock;
  delete: jest.Mock;
  deleteMany: jest.Mock;
  count: jest.Mock;
  aggregate: jest.Mock;
  groupBy: jest.Mock;
  upsert: jest.Mock;
};

function createMockModel(): MockPrismaModel {
  return {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findFirstOrThrow: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn(),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
    upsert: jest.fn(),
  };
}

/**
 * Creates a mock PrismaService with dynamically-accessible model mocks.
 *
 * Any property access on the returned object creates and returns a mock model.
 * This means tests don't break when new Prisma models are added to the schema.
 *
 * @example
 * ```typescript
 * const prisma = createPrismaMock();
 *
 * // In your test:
 * prisma.member.findMany.mockResolvedValue([mockMember]);
 * prisma.member.findUnique.mockResolvedValue(mockMember);
 * prisma.member.create.mockResolvedValue(newMember);
 *
 * // Access any model — it's auto-created on first access:
 * prisma.transaction.findMany.mockResolvedValue([]);
 * ```
 */
export function createPrismaMock(): MockPrismaModel & Record<string, MockPrismaModel> {
  const models: Record<string, MockPrismaModel> = {};
  const $transactionMock = jest.fn();
  const $queryRawMock = jest.fn().mockResolvedValue([]);

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(_target, prop: string) {
      if (prop === '$queryRaw') return $queryRawMock;
      if (prop === '$transaction') {
        return $transactionMock;
      }
      if (!models[prop]) {
        models[prop] = createMockModel();
      }
      return models[prop];
    },
  };

  return new Proxy(
    { $transaction: $transactionMock } as Record<string, unknown>,
    handler,
  ) as MockPrismaModel & Record<string, MockPrismaModel>;
}

/**
 * Creates a partial mock of PrismaService for tests that only need
 * specific models mocked.
 *
 * @param overrides - Object mapping model names to partial mocks
 * @returns A mock object with the specified models and empty defaults for others
 *
 * @example
 * ```typescript
 * const prisma = createPartialPrismaMock({
 *   member: {
 *     findMany: jest.fn().mockResolvedValue([mockMember]),
 *     findUnique: jest.fn().mockResolvedValue(mockMember),
 *   },
 * });
 * ```
 */
export function createPartialPrismaMock(
  overrides: Record<string, Partial<MockPrismaModel>>,
): MockPrismaModel & Record<string, MockPrismaModel> {
  const base = createPrismaMock();

  for (const [model, methods] of Object.entries(overrides)) {
    for (const [method, impl] of Object.entries(methods)) {
      if (impl !== undefined) {
        (base[model] as unknown as Record<string, jest.Mock>)[method] = impl;
      }
    }
  }

  return base;
}
