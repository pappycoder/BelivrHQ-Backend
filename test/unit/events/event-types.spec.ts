import { validateSync } from 'class-validator';
import { CreateEventDto } from '../../../src/events/dto/create-event.dto';
import { UpdateEventDto } from '../../../src/events/dto/update-event.dto';

describe('Event type API validation', () => {
  it.each([CreateEventDto, UpdateEventDto])('rejects service assignments in %s', (Dto) => {
    const dto = Object.assign(new Dto(), {
      title: 'Gathering',
      startDate: '2026-11-15T09:00:00Z',
      type: 'service',
    });
    expect(validateSync(dto).some((error) => error.property === 'type')).toBe(true);
  });
  it.each(['conference', 'lifecycle', 'training', 'social'])('accepts %s events', (type) => {
    const dto = Object.assign(new CreateEventDto(), {
      title: 'Gathering',
      startDate: '2026-11-15T09:00:00Z',
      type,
    });
    expect(validateSync(dto)).toHaveLength(0);
  });
  it('permits partial edits without assigning a new type to legacy events', () => {
    expect(
      validateSync(Object.assign(new UpdateEventDto(), { title: 'Renamed gathering' })),
    ).toHaveLength(0);
  });
});
