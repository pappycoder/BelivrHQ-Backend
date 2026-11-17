import { Workbook } from 'exceljs';
import { addDesignedSheet, initializeWorkbook } from '../../../src/common/excel/excel-design';

describe('Spreadsheet export and import-template contracts', () => {
  it('round-trips data types without treating untrusted strings as formulas', async () => {
    const workbook = new Workbook();
    initializeWorkbook(workbook);
    const when = new Date('2026-01-02');
    addDesignedSheet(
      workbook,
      {
        name: 'Records',
        data: [
          {
            firstName: '=HYPERLINK("bad")',
            amount: 1250.5,
            enabled: true,
            when,
            missing: null,
            extra: { toString: () => 'Label' },
          },
          { firstName: 'Ben', amount: 0, enabled: false, when, missing: undefined, extra: 'Text' },
        ],
        metadata: [{ label: 'Branch', value: 'Main' }],
      },
      0,
    );
    const loaded = new Workbook();
    await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
    const sheet = loaded.getWorksheet('Records')!;
    expect(sheet.getRow(6).values).toEqual([
      undefined,
      'First Name',
      'Amount',
      'Enabled',
      'When',
      'Missing',
      'Extra',
    ]);
    expect(sheet.getCell('A7').value).toBe('=HYPERLINK("bad")');
    expect(sheet.getCell('A7').type).toBe(3); // String, never a formula object.
    expect(sheet.getCell('B7').value).toBe(1250.5);
    expect(sheet.getCell('C7').value).toBe(true);
    expect(sheet.getCell('C8').value).toBe(false);
    expect(sheet.getCell('D7').value).toEqual(when);
    expect(sheet.getCell('E7').value).toBeNull();
    expect(sheet.getCell('F7').value).toBe('Label');
    expect(sheet.getCell('B4').value).toEqual({ formula: 'SUBTOTAL(109,G7:G8)', result: 2 });
    expect(sheet.getColumn('G').hidden).toBe(true);
    expect(sheet.getCell('A2').text).toContain('Branch: Main');
    expect(sheet.pageSetup.orientation).toBe('landscape');
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 6 });
    expect(loaded.creator).toBe('BelivrHQ');
    expect(workbook.calcProperties.fullCalcOnLoad).toBe(true);
  });

  it('keeps machine headers on row one in templates and persists strict dropdown validation', async () => {
    const workbook = new Workbook();
    const sheet = addDesignedSheet(
      workbook,
      {
        name: 'Import',
        template: true,
        inputRows: 5,
        columns: [
          { key: 'name', label: 'first_name', width: 30 },
          { key: 'status', label: 'status', options: ['active', 'inactive'] },
          { key: 'price', label: 'price', numberFormat: '0.000' },
        ],
        data: [{ name: 'Ada', status: 'active', price: 1.25 }],
      },
      0,
    );
    expect(sheet.getCell('A1').value).toBe('first_name');
    expect(sheet.getCell('A2').value).toBe('Ada');
    expect(sheet.autoFilter).toEqual({ from: { row: 1, column: 1 }, to: { row: 2, column: 3 } });
    expect(sheet.getColumn(1).width).toBe(30);
    expect(sheet.getCell('C2').numFmt).toBe('0.000');
    expect(sheet.getCell('B5').dataValidation).toMatchObject({
      type: 'list',
      formulae: ['BelivrHQChoices1'],
      showErrorMessage: true,
      errorStyle: 'stop',
      prompt: 'Choose an option from the dropdown.',
    });
    expect(workbook.getWorksheet('_Choices')!.state).toBe('veryHidden');
    const loaded = new Workbook();
    await loaded.xlsx.load(await workbook.xlsx.writeBuffer());
    expect(loaded.getWorksheet('Import')!.getCell('B5').dataValidation.type).toBe('list');
    expect(loaded.getWorksheet('_Choices')!.getColumn(1).values).toEqual([
      undefined,
      'active',
      'inactive',
    ]);
    expect(loaded.definedNames.model[0]).toMatchObject({ name: 'BelivrHQChoices1' });
  });

  it('detects distinct status choices without enforcing them on exported records', () => {
    const workbook = new Workbook();
    const sheet = addDesignedSheet(
      workbook,
      {
        name: 'Status',
        data: [
          { status: 'inactive', role: 'usher' },
          { status: 'active', role: 'usher' },
          { status: 'active', role: '' },
          { status: null, role: 123 },
        ],
      },
      0,
    );
    expect(workbook.getWorksheet('_Choices')!.getColumn(1).values).toEqual([
      undefined,
      'active',
      'inactive',
    ]);
    expect(workbook.getWorksheet('_Choices')!.getColumn(2).values).toEqual([undefined, 'usher']);
    expect(sheet.getCell('A7').dataValidation.showErrorMessage).toBe(false);
    expect(sheet.getCell('A7').dataValidation.prompt).toContain('do not update BelivrHQ');
    expect(
      (sheet.model as unknown as { conditionalFormattings: unknown[] }).conditionalFormattings,
    ).toHaveLength(1);
  });

  it.each([[], Array.from({ length: 201 }, (_, i) => String(i))].map((options) => ({ options })))(
    'omits unusable dropdown lists',
    ({ options }) => {
      const workbook = new Workbook();
      const sheet = addDesignedSheet(
        workbook,
        {
          name: 'Import',
          template: true,
          columns: [{ key: 'status', label: 'Status', options }],
          data: [],
          inputRows: 3,
        },
        0,
      );
      expect(workbook.getWorksheet('_Choices')).toBeUndefined();
      expect(sheet.getCell('A2').dataValidation).toBeUndefined();
      expect(sheet.autoFilter).toEqual({ from: { row: 1, column: 1 }, to: { row: 2, column: 1 } });
    },
  );

  it('handles empty exports and empty templates without inventing records', () => {
    const workbook = new Workbook();
    const exported = addDesignedSheet(workbook, { name: 'Empty', data: [] }, 0);
    const template = addDesignedSheet(workbook, { name: 'Blank', data: [], template: true }, 1);
    expect(exported.getCell('A6').value).toBe('Record');
    expect(exported.getCell('A7').value).toBe('No records matched the selection.');
    expect(exported.getCell('B4').value).toBe(0);
    expect(exported.pageSetup.orientation).toBe('portrait');
    expect(template.getCell('A1').value).toBe('Record');
    expect(template.getCell('A2').value).toBeNull();
    expect(template.getCell('A500').font?.name).toBe('Aptos');
  });

  it('sanitizes, bounds and deduplicates worksheet names, including reserved choice sheets', () => {
    const workbook = new Workbook();
    for (const name of [
      "'Bad/Name?'",
      'bad name',
      'x'.repeat(45),
      'x'.repeat(45),
      '///',
      '_Choices',
    ])
      addDesignedSheet(workbook, { name, data: [] }, workbook.worksheets.length);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual([
      'Bad Name',
      'bad name (2)',
      'x'.repeat(31),
      `${'x'.repeat(27)} (2)`,
      'Export',
      'Choices',
    ]);
  });

  it('disambiguates duplicate labels and keeps data aligned with explicit column order', () => {
    const workbook = new Workbook();
    const sheet = addDesignedSheet(
      workbook,
      {
        name: 'Columns',
        data: [{ amount: 7, cost: 9, omitted: 'secret' }],
        columns: [
          { key: 'cost', label: 'Value' },
          { key: 'amount', label: 'Value' },
        ],
      },
      0,
    );
    expect(sheet.getCell('A6').value).toBe('Value');
    expect(sheet.getCell('B6').value).toBe('Value (2)');
    expect(sheet.getCell('A7').value).toBe(9);
    expect(sheet.getCell('B7').value).toBe(7);
    expect(sheet.getCell('A7').numFmt).toBe('#,##0.00;[Red](#,##0.00)');
  });

  it('bounds row height and column width for long values', () => {
    const workbook = new Workbook();
    const sheet = addDesignedSheet(
      workbook,
      { name: 'Long', data: [{ description: 'x'.repeat(5000) }] },
      0,
    );
    expect(sheet.getColumn(1).width).toBe(42);
    expect(sheet.getRow(7).height).toBe(409);
  });
});
