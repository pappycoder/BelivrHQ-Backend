import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ListServicesDto } from '../../../src/attendance/dto/list-services.dto';

describe('Service status query validation', () => {
  it.each([
    ['true', true],
    ['false', false],
    [true, true],
    [false, false],
  ])('retains status %s with the global implicit conversion enabled', (input, expected) => {
    const query = plainToInstance(
      ListServicesDto,
      { isActive: input },
      { enableImplicitConversion: true },
    );
    expect(query.isActive).toBe(expected);
    expect(validateSync(query)).toHaveLength(0);
  });
  it('rejects invalid status strings instead of treating them as active', () => {
    const query = plainToInstance(
      ListServicesDto,
      { isActive: 'paused' },
      { enableImplicitConversion: true },
    );
    expect(validateSync(query).some((error) => error.property === 'isActive')).toBe(true);
  });
  it('does not impose an active-status filter when omitted', () => {
    expect(plainToInstance(ListServicesDto, {}).isActive).toBeUndefined();
  });
});
