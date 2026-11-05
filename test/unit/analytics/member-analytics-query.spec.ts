import { validate } from 'class-validator';
import { MemberAnalyticsQueryDto } from '../../../src/analytics/dto/analytics-date-range.dto';

describe('member analytics branch query', () => {
  it.each([undefined, '11111111-1111-4111-8111-111111111111'])(
    'accepts optional branch %s',
    async (branchId) => {
      const query = Object.assign(new MemberAnalyticsQueryDto(), { branchId });
      expect(await validate(query)).toEqual([]);
    },
  );

  it('rejects malformed branch IDs before reaching the service', async () => {
    const query = Object.assign(new MemberAnalyticsQueryDto(), { branchId: 'not-a-uuid' });
    expect(await validate(query)).toEqual([expect.objectContaining({ property: 'branchId' })]);
  });
});
