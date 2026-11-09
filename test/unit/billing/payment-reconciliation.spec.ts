import { PaymentReconciliationService } from '../../../src/billing/payment-reconciliation.service';
import { workersEnabled } from '../../../src/queues/workers-enabled';
jest.mock('../../../src/queues/workers-enabled', () => ({ workersEnabled: jest.fn(() => true) }));

describe('payment recovery', () => {
  const subscriptionFind = jest.fn(),
    givingFind = jest.fn(),
    expire = jest.fn();
  const billing = { reconcilePayment: jest.fn(), reconcileAdjustments: jest.fn() };
  const giving = { reconcilePayment: jest.fn(), reconcileAdjustments: jest.fn() };
  let worker: PaymentReconciliationService;
  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(workersEnabled).mockReturnValue(true);
    subscriptionFind.mockResolvedValue([]);
    givingFind.mockResolvedValue([]);
    worker = new PaymentReconciliationService(
      {
        subscriptionPayment: { findMany: subscriptionFind, updateMany: expire },
        transaction: { findMany: givingFind },
      } as never,
      billing as never,
      { name: 'flutterwave', isConfigured: () => true } as never,
      { name: 'paystack', isConfigured: () => true } as never,
      giving as never,
    );
  });
  it('recovers both gateways and all financial states without a seven-day cutoff', async () => {
    subscriptionFind.mockResolvedValue([{ reference: 's', church_id: 'a' }]);
    givingFind.mockResolvedValue([{ id: 'g', payment_reference: 'p', church_id: 'b' }]);
    await worker.reconcile();
    expect(subscriptionFind.mock.calls[0][0].where).toMatchObject({
      gateway: { in: ['flutterwave', 'paystack'] },
      status: { in: ['pending', 'failed', 'success', 'reversed'] },
    });
    expect(subscriptionFind.mock.calls[0][0].where).not.toHaveProperty('created_at');
    expect(billing.reconcilePayment).toHaveBeenCalledWith('a', 's');
    expect(billing.reconcileAdjustments).toHaveBeenCalledWith('a', 's');
    expect(giving.reconcilePayment).toHaveBeenCalledWith('b', 'p');
    expect(giving.reconcileAdjustments).toHaveBeenCalledWith('b', 'p');
    expect(expire.mock.calls[0][0].data).toMatchObject({
      checkout_close_reason: 'expired',
      checkout_url: null,
    });
  });
  it('rotates bounded batches and isolates individual provider failures', async () => {
    subscriptionFind.mockResolvedValueOnce(
      Array.from({ length: 25 }, (_, i) => ({ reference: `s${i}`, church_id: 'a' })),
    );
    billing.reconcilePayment.mockRejectedValueOnce(new Error('outage'));
    await worker.reconcile();
    await worker.reconcile();
    expect(billing.reconcilePayment).toHaveBeenCalledTimes(25);
    expect(subscriptionFind.mock.calls[1][0].where.reference).toEqual({ gt: 's24' });
    await worker.reconcile();
    expect(subscriptionFind.mock.calls[2][0].where).not.toHaveProperty('reference');
  });
  it('does not run on HTTP-only instances', async () => {
    jest.mocked(workersEnabled).mockReturnValue(false);
    await worker.reconcile();
    expect(subscriptionFind).not.toHaveBeenCalled();
    expect(givingFind).not.toHaveBeenCalled();
  });
  it('continues after a failed scan', async () => {
    subscriptionFind.mockRejectedValueOnce(new Error('database'));
    await worker.reconcile();
    await worker.reconcile();
    expect(subscriptionFind).toHaveBeenCalledTimes(2);
  });
});
