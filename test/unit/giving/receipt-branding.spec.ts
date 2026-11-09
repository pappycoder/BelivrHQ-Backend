import { ConfigService } from '@nestjs/config';
import sharp from 'sharp';
import { ReceiptService } from '../../../src/giving/services/receipt.service';
import { loadChurchLogo } from '../../../src/common/pdf/church-logo';

describe('church-branded giving receipts', () => {
  const origin = 'https://storage.example.com';
  const url = `${origin}/storage/v1/object/public/media/churches/church-a/logo.webp`;
  const transaction = {
    id: 'transaction-a',
    receiptNumber: '2026/TIT/0001',
    amount: 1000,
    currency: 'NGN',
    categoryName: 'Tithe',
    paymentMethod: 'cash',
    createdAt: new Date('2026-10-18T12:00:00Z'),
    churchName: 'Grace Community Church',
    churchId: 'church-a',
    churchLogoUrl: url,
  };
  const service = new ReceiptService(new ConfigService({ SUPABASE_URL: origin }));

  it('uses uploaded WebP church logos in a real PDF and retains BelivrHQ identity', async () => {
    const logo = await sharp({
      create: { width: 80, height: 30, channels: 3, background: '#526f4a' },
    })
      .webp()
      .toBuffer();
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response(new Uint8Array(logo)));
    const pdf = (await service.generateReceipt(transaction)).toString('latin1');
    expect(pdf).toContain('%PDF');
    expect(pdf).toContain('/Subtype /Image');
    expect(pdf).toContain('Grace Community Church');
    expect(pdf).toContain('BelivrHQ');
    expect(global.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'error' }));
  });

  it('still produces receipts when a church logo fails to load', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Storage unavailable'));
    const pdf = (await service.generateReceipt(transaction)).toString('latin1');
    expect(pdf).toContain('Grace Community Church');
    expect(pdf).toContain('BelivrHQ');
    expect(pdf).not.toContain('/Subtype /Image');
  });

  it('rejects arbitrary origins, other churches, redirects and oversized logos', async () => {
    const fetcher = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('oversize', { headers: { 'content-length': '3000000' } }));
    for (const value of [
      url.replace(origin, 'http://127.0.0.1'),
      url.replace('church-a', 'church-b'),
      url.replace('logo.webp', '../secret.png'),
      url.replace('logo.webp', 'logo.svg'),
    ]) {
      expect(await loadChurchLogo(value, 'church-a', origin, 'media')).toBeUndefined();
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(await loadChurchLogo(url, 'church-a', origin, 'media')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
