import { BadRequestException } from '@nestjs/common';
import { CustomFieldDefinition } from '@prisma/client';
import { FormFieldDto, FormFieldType } from '../forms/dto/form-field.dto';

export function intakeFields(kind: string, custom: CustomFieldDefinition[]): FormFieldDto[] {
  const field = (
    key: string,
    label: string,
    type = FormFieldType.TEXT,
    required = false,
    options?: string[],
  ) => ({ key, label, type, required, ...(options ? { options } : {}) });
  const fields = [
    field('firstName', 'First name', FormFieldType.TEXT, true),
    field('lastName', 'Last name', FormFieldType.TEXT, kind === 'members'),
    field('email', 'Email', FormFieldType.EMAIL),
    field('phone', 'Phone', FormFieldType.PHONE),
    field('whatsappNumber', 'WhatsApp', FormFieldType.PHONE),
    field(
      'gender',
      'Gender',
      FormFieldType.DROPDOWN,
      false,
      kind === 'members' ? ['male', 'female', 'other'] : ['male', 'female'],
    ),
  ];
  if (kind === 'members')
    fields.push(
      field('dateOfBirth', 'Date of birth', FormFieldType.DATE),
      field('address', 'Address'),
      field('city', 'City'),
      field('state', 'State'),
    );
  else fields.push(field('firstVisitDate', 'First visit date', FormFieldType.DATE));
  return [
    ...fields,
    ...custom.map((c) =>
      field(
        `custom:${c.id}`,
        c.name,
        c.field_type as FormFieldType,
        c.is_required,
        Array.isArray(c.options) ? (c.options as string[]) : undefined,
      ),
    ),
  ];
}
export function validateIntake(fields: FormFieldDto[], input: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  if (Object.keys(input).some((k) => !fields.some((f) => f.key === k)))
    throw new BadRequestException('Unexpected registration field');
  for (const f of fields) {
    let value = input[f.key];
    if (typeof value === 'string') value = value.trim();
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && !value.length);
    if (empty) {
      if (f.required) throw new BadRequestException(`${f.label} is required`);
      continue;
    }
    if (f.type === FormFieldType.CHECKBOX) {
      if (
        !Array.isArray(value) ||
        value.some((v) => typeof v !== 'string' || !f.options?.includes(v))
      )
        throw new BadRequestException(`Invalid ${f.label}`);
    } else {
      if (f.type !== FormFieldType.NUMBER && typeof value !== 'string')
        throw new BadRequestException(`Invalid ${f.label}`);
      if (typeof value !== 'string' && typeof value !== 'number')
        throw new BadRequestException(`Invalid ${f.label}`);
      if (String(value).length > (f.type === FormFieldType.TEXTAREA ? 4000 : 500))
        throw new BadRequestException(`${f.label} is too long`);
      if (f.type === FormFieldType.NUMBER && !Number.isFinite(Number(value)))
        throw new BadRequestException(`Invalid ${f.label}`);
      if (
        f.type === FormFieldType.DATE &&
        (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ||
          !Number.isFinite(Date.parse(String(value))) ||
          new Date(String(value)).toISOString().slice(0, 10) !== value)
      )
        throw new BadRequestException(`Invalid ${f.label}`);
      if (f.type === FormFieldType.DROPDOWN && !f.options?.includes(String(value)))
        throw new BadRequestException(`Invalid ${f.label}`);
    }
    data[f.key] = f.type === FormFieldType.NUMBER ? Number(value) : value;
  }
  return data;
}
