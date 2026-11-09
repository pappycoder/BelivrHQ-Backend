import type { CellValue, Workbook, Worksheet } from 'exceljs';

export interface ExcelColumn {
  key: string;
  label: string;
  width?: number;
  numberFormat?: string;
  options?: string[];
}

export interface ExcelSheet {
  name: string;
  data: Record<string, unknown>[];
  columns?: ExcelColumn[];
  metadata?: { label: string; value: string }[];
  /** Import templates must retain their machine-readable first-row headers. */
  template?: boolean;
  inputRows?: number;
}

const colors = {
  navy: 'FF14243C',
  blue: 'FF2563EB',
  ink: 'FF243449',
  muted: 'FF64748B',
  soft: 'FFF4F7FC',
  line: 'FFE2E8F0',
  white: 'FFFFFFFF',
};

function displayLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sheetName(workbook: Workbook, requested: string): string {
  const base =
    requested
      .replace(/[\\/*?:[\]]/g, ' ')
      .replace(/^'+|'+$/g, '')
      .trim()
      .slice(0, 31) || 'Export';
  let candidate = base === '_Choices' ? 'Choices' : base;
  let index = 2;
  while (
    workbook.worksheets.some((sheet) => sheet.name.toLowerCase() === candidate.toLowerCase())
  ) {
    const suffix = ` (${index++})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
  }
  return candidate;
}

function valueOf(value: unknown): CellValue {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return value;
  return String(value);
}

function addChoices(workbook: Workbook, values: string[]): string {
  const choices = workbook.getWorksheet('_Choices') ?? workbook.addWorksheet('_Choices');
  choices.state = 'veryHidden';
  const col = choices.columnCount + 1;
  values.forEach((value, i) => {
    choices.getCell(i + 1, col).value = value;
  });
  const name = `BelivrHQChoices${col}`;
  workbook.definedNames.add(
    `'_Choices'!$${choices.getColumn(col).letter}$1:$${choices.getColumn(col).letter}$${values.length}`,
    name,
  );
  return name;
}

/** Reusable workbook styling and native spreadsheet controls. No macros. */
export function addDesignedSheet(workbook: Workbook, spec: ExcelSheet, index: number): Worksheet {
  const keys = [...new Set(spec.data.flatMap((row) => Object.keys(row)))];
  const columns: ExcelColumn[] = spec.columns
    ? [...spec.columns]
    : keys.map((key) => ({ key, label: displayLabel(key) }));
  if (!columns.length) columns.push({ key: 'record', label: 'Record' });
  const sheet = workbook.addWorksheet(sheetName(workbook, spec.name), {
    properties: { defaultRowHeight: 23, tabColor: { argb: colors.blue } },
    pageSetup: {
      paperSize: 9,
      orientation: columns.length > 5 ? 'landscape' : 'portrait',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
    },
    headerFooter: { oddFooter: '&LBelivrHQ&C&P / &N&R&D' },
  });
  const headerRow = spec.template ? 1 : 6;
  const startRow = headerRow + 1;
  const titleWidth = Math.max(2, columns.length);
  const labels = columns.map((column, i) =>
    columns.slice(0, i).some((previous) => previous.label === column.label)
      ? `${column.label} (${i + 1})`
      : column.label,
  );
  sheet.views = [
    { state: 'frozen', ySplit: headerRow, xSplit: 1, showGridLines: false, zoomScale: 90 },
  ];
  sheet.pageSetup.printTitlesRow = `${headerRow}:${headerRow}`;

  if (!spec.template) {
    sheet.mergeCells(1, 1, 1, titleWidth);
    sheet.getCell('A1').value = `BelivrHQ  /  ${spec.name}`;
    sheet.getRow(1).height = 42;
    sheet.getCell('A1').fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: colors.navy },
    };
    sheet.getCell('A1').font = {
      name: 'Aptos Display',
      size: 20,
      bold: true,
      color: { argb: colors.white },
    };
    sheet.getCell('A1').alignment = { vertical: 'middle', indent: 1 };
    sheet.mergeCells(2, 1, 2, titleWidth);
    sheet.getCell('A2').value = [
      ...(spec.metadata ?? []).map((item) => `${item.label}: ${item.value}`),
      `Generated: ${new Date().toLocaleDateString('en-NG')}`,
    ].join('  |  ');
    sheet.getRow(2).height = 28;
    sheet.getCell('A2').font = { name: 'Aptos', size: 10, color: { argb: colors.muted } };
    sheet.getCell('A2').alignment = { vertical: 'middle', wrapText: true, indent: 1 };
    sheet.mergeCells(3, 1, 3, titleWidth);
    sheet.getCell('A3').value =
      'Use the column arrows to sort and filter. Dropdown cells offer choices. Edits stay in this workbook.';
    sheet.getCell('A3').font = { name: 'Aptos', size: 10, color: { argb: colors.muted } };
    sheet.getCell('A3').alignment = { wrapText: true, vertical: 'middle', indent: 1 };
    sheet.getRow(3).height = 32;
    sheet.getCell('A4').value = 'Visible rows';
    sheet.getCell('A4').font = {
      name: 'Aptos',
      size: 11,
      bold: true,
      color: { argb: colors.blue },
    };
    sheet.getCell('B4').font = { name: 'Aptos', size: 12, bold: true, color: { argb: colors.ink } };
  }

  const rows = spec.data.map((row) => columns.map((column) => valueOf(row[column.key])));
  if (spec.template) {
    sheet.getRow(headerRow).values = labels;
    rows.forEach((row) => sheet.addRow(row));
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(2, rows.length + 1), column: columns.length },
    };
  } else if (rows.length) {
    const tableName = `BelivrHQData${index + 1}`;
    sheet.addTable({
      name: tableName,
      ref: `A${headerRow}`,
      headerRow: true,
      totalsRow: false,
      style: { theme: 'TableStyleMedium2', showRowStripes: true },
      columns: labels.map((name) => ({ name, filterButton: true })),
      rows,
    });
    const endRow = startRow + rows.length - 1;
    const countColumn = sheet.getColumn(Math.max(3, columns.length + 1));
    countColumn.hidden = true;
    rows.forEach((_, i) => {
      sheet.getCell(startRow + i, Math.max(3, columns.length + 1)).value = 1;
    });
    sheet.getCell('B4').value = {
      formula: `SUBTOTAL(109,${countColumn.letter}${startRow}:${countColumn.letter}${endRow})`,
      result: rows.length,
    };
  } else {
    sheet.getRow(headerRow).values = labels;
    sheet.getCell('B4').value = 0;
    sheet.getCell(startRow, 1).value = 'No records matched the selection.';
  }

  const header = sheet.getRow(headerRow);
  header.height = 32;
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: colors.navy } };
    cell.font = { name: 'Aptos', size: 11, bold: true, color: { argb: colors.white } };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });
  const lastRow = spec.template
    ? Math.max(startRow + rows.length - 1, spec.inputRows ?? 500)
    : startRow + Math.max(rows.length, 1) - 1;
  columns.forEach((column, colIndex) => {
    const col = colIndex + 1;
    const longest = Math.max(
      column.label.length + 5,
      ...spec.data.slice(0, 200).map((row) => String(row[column.key] ?? '').length),
    );
    sheet.getColumn(col).width = column.width ?? Math.max(15, Math.min(42, longest + 2));
    const format =
      column.numberFormat ??
      (/₦|NGN|amount|price|cost|value/i.test(column.label)
        ? '#,##0.00;[Red](#,##0.00)'
        : '#,##0.########');
    const explicitChoices = column.options;
    const detected = /^(status|gender|branch|department|role|payment.?method|event.?type)$/i.test(
      column.key,
    )
      ? [
          ...new Set(
            spec.data
              .map((row) => row[column.key])
              .filter((value): value is string => typeof value === 'string' && !!value),
          ),
        ].sort()
      : [];
    const choices = explicitChoices ?? detected;
    const choiceName =
      choices.length > 0 && choices.length <= 200 ? addChoices(workbook, choices) : undefined;
    for (let row = startRow; row <= lastRow; row++) {
      const cell = sheet.getCell(row, col);
      cell.font = { name: 'Aptos', size: 11, color: { argb: colors.ink } };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: (row - startRow) % 2 ? colors.soft : colors.white },
      };
      cell.border = { bottom: { style: 'hair', color: { argb: colors.line } } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (typeof cell.value === 'number') {
        cell.numFmt = format;
        cell.alignment.horizontal = 'right';
      }
      if (cell.value instanceof Date) cell.numFmt = 'dd mmm yyyy';
      if (choiceName)
        cell.dataValidation = {
          type: 'list',
          allowBlank: true,
          formulae: [choiceName],
          showInputMessage: true,
          promptTitle: column.label,
          prompt: spec.template
            ? 'Choose an option from the dropdown.'
            : 'Choices come from the exported rows. Workbook edits do not update BelivrHQ.',
          showErrorMessage: !!explicitChoices,
          errorStyle: 'stop',
          errorTitle: 'Choose a listed value',
          error: 'Use one of the available options.',
        };
    }
    if (/status/i.test(column.key)) {
      sheet.addConditionalFormatting({
        ref: `${sheet.getColumn(col).letter}${startRow}:${sheet.getColumn(col).letter}${lastRow}`,
        rules: [
          {
            type: 'expression',
            formulae: [`LOWER(${sheet.getColumn(col).letter}${startRow})="active"`],
            priority: 1,
            style: { font: { color: { argb: 'FF047857' }, bold: true } },
          },
          {
            type: 'expression',
            formulae: [`LOWER(${sheet.getColumn(col).letter}${startRow})="cancelled"`],
            priority: 2,
            style: { font: { color: { argb: 'FFB91C1C' }, bold: true } },
          },
        ],
      });
    }
  });
  for (let row = startRow; row <= startRow + rows.length - 1; row++) {
    const lines = Math.max(
      1,
      ...columns.map((column, i) =>
        Math.ceil(
          String(spec.data[row - startRow][column.key] ?? '').length /
            Math.max(10, (sheet.getColumn(i + 1).width ?? 20) - 3),
        ),
      ),
    );
    sheet.getRow(row).height = Math.min(409, Math.max(26, lines * 15));
  }
  sheet.pageSetup.printArea = `A1:${sheet.getColumn(columns.length).letter}${startRow + Math.max(rows.length, 1) - 1}`;
  return sheet;
}

export function initializeWorkbook(workbook: Workbook): void {
  workbook.creator = 'BelivrHQ';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
}
