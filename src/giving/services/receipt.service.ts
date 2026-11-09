/**
 * @file receipt.service.ts
 * @description PDF receipt generation service for giving transactions.
 *
 * Generates PDF receipts with church branding, transaction details,
 * receipt numbers, and saved transaction/payment references.
 *
 * @module giving/services/receipt.service
 * @since 1.0.0
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { loadChurchLogo } from '../../common/pdf/church-logo';
import PDFDocument from 'pdfkit';
import {
  PDF_COLORS as colors,
  preparePdf,
  drawPdfHeader,
  drawPdfFooters,
} from '../../common/pdf/pdf-design';

/**
 * Transaction data needed for receipt generation.
 */
export interface ReceiptTransactionData {
  id: string;
  receiptNumber: string;
  amount: number;
  currency: string;
  categoryName: string;
  paymentMethod: string;
  createdAt: Date;
  givingDate?: Date;
  branchName?: string;
  source?: string;
  paymentReference?: string;
  paymentGateway?: string;
  notes?: string;
  churchName: string;
  churchId?: string;
  churchLogoUrl?: string;
  churchAddress?: string;
  memberName?: string;
  memberEmail?: string;
}

/**
 * Service for generating PDF receipts for giving transactions.
 * Uses PDFKit to create branded receipts with transaction details.
 */
@Injectable()
export class ReceiptService {
  private readonly logger = new Logger(ReceiptService.name);
  constructor(private readonly config: ConfigService) {}

  /**
   * Generates a PDF receipt for a transaction.
   *
   * @param data - Transaction data for the receipt
   * @returns PDF buffer
   */
  async generateReceipt(data: ReceiptTransactionData): Promise<Buffer> {
    const branding = {
      name: data.churchName,
      logo: await loadChurchLogo(
        data.churchLogoUrl,
        data.churchId,
        this.config.get<string>('SUPABASE_URL'),
        this.config.get<string>('SUPABASE_STORAGE_BUCKET', 'media'),
      ),
    };
    return new Promise((resolve, reject) => {
      try {
        const doc = new PDFDocument({
          size: 'A4',
          margins: { top: 145, bottom: 72, left: 50, right: 50 },
          bufferPages: true,
          info: {
            Title: `Giving Receipt - ${data.receiptNumber}`,
            Author: data.churchName,
            Creator: 'BelivrHQ',
            Subject: 'Giving Receipt',
          },
        });

        const chunks: Buffer[] = [];
        doc.on('data', (chunk: Buffer) => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        preparePdf(doc);
        drawPdfHeader(doc, 'Giving receipt', branding);
        doc.on('pageAdded', () => drawPdfHeader(doc, 'Giving receipt', branding));
        const contentWidth = doc.page.width - 100;
        let y = 148;

        const ensureSpace = (height: number) => {
          if (y + height > doc.page.height - 78) {
            doc.addPage();
            y = 148;
          }
        };
        const paragraph = (text: string, size = 10, bold = false, color = colors.ink) => {
          doc.font(bold ? 'BelivrHQSans-Bold' : 'BelivrHQSans').fontSize(size);
          const height = doc.heightOfString(text, { width: contentWidth, lineGap: 3 });
          ensureSpace(height + 8);
          doc.fillColor(color).text(text, 50, y, { width: contentWidth, lineGap: 3 });
          y = doc.y + 6;
        };
        const heading = (label: string) => {
          ensureSpace(55);
          doc
            .font('BelivrHQSans-Bold')
            .fontSize(9)
            .fillColor(colors.blue)
            .text(label.toUpperCase(), 50, y, { width: contentWidth });
          y += 18;
        };
        const field = (label: string, value: string) => {
          doc.font('BelivrHQSans').fontSize(10);
          const height = Math.max(
            22,
            doc.heightOfString(value, { width: contentWidth - 135, lineGap: 3 }) + 8,
          );
          ensureSpace(height);
          doc
            .font('BelivrHQSans')
            .fontSize(9)
            .fillColor(colors.muted)
            .text(label, 50, y + 4, { width: 125 });
          doc
            .font('BelivrHQSans')
            .fontSize(10)
            .fillColor(colors.ink)
            .text(value, 185, y + 3, { width: contentWidth - 135, lineGap: 3 });
          y = Math.max(y + height, doc.y + 6);
          doc
            .moveTo(50, y - 5)
            .lineTo(doc.page.width - 50, y - 5)
            .lineWidth(0.4)
            .stroke(colors.line);
        };

        paragraph(data.churchName, 22, true);
        if (data.churchAddress) paragraph(data.churchAddress, 10, false, colors.muted);
        y += 12;

        // A clear amount panel distinguishes the financial value from metadata.
        ensureSpace(84);
        doc.roundedRect(50, y, contentWidth, 70, 10).fill(colors.soft);
        doc
          .font('BelivrHQSans-Bold')
          .fontSize(8)
          .fillColor(colors.muted)
          .text('AMOUNT RECEIVED', 68, y + 16);
        const amount = `${data.currency} ${data.amount.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        let amountSize = 28;
        doc.font('BelivrHQSans-Bold').fontSize(amountSize);
        while (amountSize > 12 && doc.widthOfString(amount) > contentWidth - 36)
          doc.fontSize(--amountSize);
        doc.fillColor(colors.ink).text(amount, 68, y + 34, { width: contentWidth - 36 });
        y += 88;

        heading('Received from');
        field('Donor / source', data.memberName || data.source || 'No individual donor recorded');
        if (data.memberEmail) field('Email', data.memberEmail);
        y += 10;

        heading('Contribution details');
        field('Receipt number', data.receiptNumber);
        field('Giving date', this.formatDate(data.givingDate ?? data.createdAt, true));
        field('Recorded at', this.formatDate(data.createdAt));
        if (data.branchName) field('Branch', data.branchName);
        if (data.source) field('Linked to', data.source);
        field('Category', data.categoryName || 'Unspecified');
        field('Payment method', this.formatPaymentMethod(data.paymentMethod));
        if (data.paymentGateway && data.paymentGateway !== 'manual')
          field('Payment provider', data.paymentGateway);
        if (data.paymentReference) field('Payment reference', data.paymentReference);
        field('Transaction ID', data.id);
        if (data.notes) field('Notes', data.notes);
        y += 10;

        ensureSpace(65);
        paragraph('Thank you for your generosity.', 13, true);
        paragraph(
          'This receipt serves as proof of your giving. Keep it for your records.',
          9,
          false,
          colors.muted,
        );
        drawPdfFooters(doc, new Date());

        doc.end();
      } catch (error) {
        this.logger.error(
          `Receipt generation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        reject(error);
      }
    });
  }

  /**
   * Generates a unique receipt number.
   *
   * Format: {YEAR}/{CATEGORY_PREFIX}/{SEQUENTIAL}
   * Example: 2026/TIT/0001
   *
   * @param categoryPrefix - Short category code (e.g., 'TIT', 'OFF')
   * @param sequence - Sequential number (padded to 4 digits)
   * @returns Formatted receipt number
   */
  generateReceiptNumber(categoryPrefix: string, sequence: number): string {
    const year = new Date().getFullYear();
    const padded = sequence.toString().padStart(4, '0');
    return `${year}/${categoryPrefix}/${padded}`;
  }

  /**
   * Gets a short prefix for a category name.
   *
   * @param categoryName - Full category name
   * @returns 3-4 character uppercase prefix
   */
  getCategoryPrefix(categoryName: string): string {
    const prefixes: Record<string, string> = {
      tithe: 'TIT',
      offering: 'OFF',
      seed: 'SED',
      first_fruit: 'FRF',
      'first fruit': 'FRF',
      thanksgiving: 'TGV',
      building_project: 'BDP',
      'building project': 'BDP',
      welfare: 'WLF',
      mission: 'MSN',
    };

    const lower = categoryName.toLowerCase().trim();
    return prefixes[lower] || categoryName.substring(0, 4).toUpperCase();
  }

  /**
   * Formats a date for display on the receipt.
   */
  private formatDate(date: Date, dateOnly = false): string {
    return date.toLocaleString('en-NG', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: dateOnly ? 'UTC' : 'Africa/Lagos',
      ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }),
    });
  }

  /**
   * Formats a payment method for display.
   */
  private formatPaymentMethod(method: string): string {
    const labels: Record<string, string> = {
      paystack: 'Digital Payment (Paystack)',
      flutterwave: 'Digital Payment (Flutterwave)',
      card: 'Card',
      bank: 'Bank',
      ussd: 'USSD',
      mobile_money: 'Mobile Money',
      cash: 'Cash',
      bank_transfer: 'Bank Transfer',
    };
    return labels[method] || method;
  }
}
