import { join } from 'path';

export const PDF_COLORS = {
  navy: '#173D3E',
  blue: '#526F4A',
  ink: '#183B40',
  muted: '#586D61',
  line: '#D3DED2',
  soft: '#F1F5E9',
  green: '#047857',
};

/** Assets are copied into dist by Nest, so no network request is needed. */
const asset = (name: string) => join(__dirname, '../../assets/pdf', name);

export function preparePdf(doc: PDFKit.PDFDocument): void {
  doc.registerFont('BelivrHQSans', asset('DejaVuSans.ttf'));
  doc.registerFont('BelivrHQSans-Bold', asset('DejaVuSans-Bold.ttf'));
  doc.font('BelivrHQSans');
}

export function drawPdfHeader(
  doc: PDFKit.PDFDocument,
  label: string,
  branding?: { name: string; logo?: Buffer },
): void {
  const { x, y } = doc;
  doc.save();
  doc.rect(0, 0, doc.page.width, 112).fill(PDF_COLORS.navy);
  doc.rect(0, 112, doc.page.width, 4).fill('#D6ED97');
  if (branding) {
    let textX = 50;
    if (branding.logo) {
      doc.roundedRect(40, 24, 64, 64, 6).fill('#FCFCF9');
      doc.image(branding.logo, 45, 29, { fit: [54, 54], align: 'center', valign: 'center' });
      textX = 118;
    }
    doc
      .font('BelivrHQSans-Bold')
      .fontSize(16)
      .fillColor('#FFFFFF')
      .text(branding.name, textX, 31, {
        width: doc.page.width - textX - 185,
        height: 48,
        ellipsis: true,
      });
    doc
      .font('BelivrHQSans')
      .fontSize(8)
      .fillColor('#D6ED97')
      .text('Powered by BelivrHQ', textX, 88, { lineBreak: false });
  } else {
    doc.image(asset('belivrhq-lockup-light.png'), 40, 16, { fit: [145, 80] });
  }
  doc
    .font('BelivrHQSans-Bold')
    .fontSize(13)
    .fillColor('#FFFFFF')
    .text(label.toUpperCase(), doc.page.width - 180, 51, {
      width: 130,
      align: 'right',
      lineBreak: false,
    });
  doc.restore();
  doc.x = x;
  doc.y = y;
}

export function drawPdfFooters(doc: PDFKit.PDFDocument, generatedAt: Date): void {
  const pages = doc.bufferedPageRange();
  for (let i = pages.start; i < pages.start + pages.count; i++) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    doc.save();
    doc
      .moveTo(50, height - 58)
      .lineTo(width - 50, height - 58)
      .lineWidth(0.5)
      .stroke(PDF_COLORS.line);
    doc
      .font('BelivrHQSans')
      .fontSize(8)
      .fillColor(PDF_COLORS.muted)
      .text(
        `Powered by BelivrHQ  ·  ${generatedAt.toLocaleDateString('en-NG', { day: '2-digit', month: 'short', year: 'numeric' })}`,
        50,
        height - 43,
        { lineBreak: false },
      );
    doc.text(`${i - pages.start + 1} / ${pages.count}`, width - 100, height - 43, {
      width: 50,
      align: 'right',
      lineBreak: false,
    });
    doc.restore();
    doc.page.margins.bottom = bottomMargin;
  }
}
