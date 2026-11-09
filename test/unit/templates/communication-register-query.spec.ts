import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListTemplatesDto } from '../../../src/templates/dto/list-templates.dto';
import { ListBroadcastsDto } from '../../../src/broadcast/dto/list-broadcasts.dto';

describe.each([ListTemplatesDto, ListBroadcastsDto])('%s register queries', (Dto) => {
  it('transforms string pagination and accepts allowlisted sorting', async () => {
    const query = plainToInstance<ListTemplatesDto | ListBroadcastsDto, object>(Dto, {
      page: '2',
      limit: '24',
      sortBy: 'name',
      sortOrder: 'asc',
    });
    expect(await validate(query)).toEqual([]);
    expect(query.page).toBe(2);
    expect(query.limit).toBe(24);
  });
  it('rejects unsupported sorting and invalid pagination', async () => {
    const query = plainToInstance<ListTemplatesDto | ListBroadcastsDto, object>(Dto, {
      page: '0',
      limit: '500',
      sortBy: 'church_id',
      sortOrder: 'sideways',
    });
    expect((await validate(query)).map((error) => error.property)).toEqual(
      expect.arrayContaining(['page', 'limit', 'sortBy', 'sortOrder']),
    );
  });
});
