import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Type } from '@nestjs/common';
import { ListCellGroupsDto } from '../../../src/admin/dto/list-cell-groups.dto';
import { ListAppointmentContactsDto } from '../../../src/appointments/dto/list-appointment-contacts.dto';
import { ListAppointmentsDto } from '../../../src/appointments/dto/list-appointments.dto';
import { ListAssetCategoriesDto } from '../../../src/assets/dto/list-asset-categories.dto';
import { ListAssetsDto } from '../../../src/assets/dto/list-assets.dto';
import { ListServicesDto } from '../../../src/attendance/dto/list-services.dto';
import { ListBranchesDto } from '../../../src/branches/dto/list-branches.dto';
import { ListCustomFieldsDto } from '../../../src/custom-fields/dto/list-custom-fields.dto';
import { ListEmailContactsDto } from '../../../src/email/dto/list-email-contacts.dto';
import { ListEventsDto } from '../../../src/events/dto/list-events.dto';
import { ListFamiliesDto } from '../../../src/family/dto/list-families.dto';
import { ListFormsDto } from '../../../src/forms/dto/list-forms.dto';
import { ListCategoriesDto } from '../../../src/giving/dto/list-categories.dto';
import { ListMembersDto } from '../../../src/members/dto/list-members.dto';
import { ListLifeEventsDto } from '../../../src/pastoral/dto/list-life-events.dto';
import { ListPastoralNotesDto } from '../../../src/pastoral/dto/list-pastoral-notes.dto';
import { ListProfilesDto } from '../../../src/profile/dto/list-profiles.dto';
import { ListSermonsDto } from '../../../src/sermons/dto/list-sermons.dto';
import { ListTemplatesDto } from '../../../src/templates/dto/list-templates.dto';
import { ListVisitorsDto } from '../../../src/visitors/dto/list-visitors.dto';
const contracts: Array<{ dto: Type<object>; field: string }> = [
  { dto: ListCellGroupsDto, field: 'archived' },
  { dto: ListAppointmentContactsDto, field: 'includeVisitors' },
  { dto: ListAppointmentsDto, field: 'archived' },
  { dto: ListAssetCategoriesDto, field: 'archived' },
  { dto: ListAssetsDto, field: 'archived' },
  { dto: ListServicesDto, field: 'archived' },
  { dto: ListBranchesDto, field: 'archived' },
  { dto: ListCustomFieldsDto, field: 'archived' },
  { dto: ListEmailContactsDto, field: 'includeSelf' },
  { dto: ListEventsDto, field: 'archived' },
  { dto: ListFamiliesDto, field: 'archived' },
  { dto: ListFormsDto, field: 'isTemplate' },
  { dto: ListFormsDto, field: 'archived' },
  { dto: ListCategoriesDto, field: 'archived' },
  { dto: ListMembersDto, field: 'archived' },
  { dto: ListLifeEventsDto, field: 'archived' },
  { dto: ListPastoralNotesDto, field: 'archived' },
  { dto: ListProfilesDto, field: 'archived' },
  { dto: ListSermonsDto, field: 'archived' },
  { dto: ListTemplatesDto, field: 'archived' },
  { dto: ListVisitorsDto, field: 'archived' },
];
describe.each(contracts)('$dto.name query flag $field', ({ dto, field }) => {
  it.each([
    ['true', true],
    ['false', false],
    [true, true],
    [false, false],
  ])(
    'preserves boolean input %j under the production implicit-conversion settings',
    (input, expected) => {
      const query = plainToInstance(
        dto,
        { kind: 'who', [field]: input },
        { enableImplicitConversion: true },
      );
      expect((query as Record<string, unknown>)[field]).toBe(expected);
      expect(validateSync(query).filter((error) => error.property === field)).toEqual([]);
    },
  );
  it.each([
    { value: '' },
    { value: 'yes' },
    { value: '0' },
    { value: '1' },
    { value: 0 },
    { value: 1 },
    { value: ['true', 'false'] },
    { value: {} },
  ])('rejects an ambiguous or repeated query value %j', ({ value }) => {
    const query = plainToInstance(
      dto,
      { kind: 'who', [field]: value },
      { enableImplicitConversion: true },
    );
    expect(validateSync(query).some((error) => error.property === field)).toBe(true);
  });
  it('retains omission without selecting an alternate archive view or recipient set', () => {
    const query = plainToInstance(dto, { kind: 'who' }, { enableImplicitConversion: true });
    expect((query as Record<string, unknown>)[field]).toBeUndefined();
    expect(validateSync(query).filter((error) => error.property === field)).toEqual([]);
  });
});
