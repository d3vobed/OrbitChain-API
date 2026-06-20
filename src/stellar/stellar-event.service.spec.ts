import { StellarEventService } from './stellar-event.service';

describe('StellarEventService', () => {
  const createService = () => {
    const config = {
      get: jest.fn((key: string, fallback?: string) => {
        if (key === 'STELLAR_HORIZON_URL')
          return 'https://horizon-testnet.stellar.org';
        if (key === 'STELLAR_NETWORK_PASSPHRASE') {
          return 'Test SDF Network ; September 2015';
        }
        return fallback;
      }),
    };

    const prisma = {
      eventCursor: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      processedContractEvent: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
      smartContract: {
        findMany: jest.fn(),
      },
    };

    const queue = {
      add: jest.fn(),
    };

    const service = new StellarEventService(
      config as never,
      prisma as never,
      queue as never,
    );

    (service as any).horizonServer = {
      transactions: () => ({
        cursor: () => ({
          limit: () => ({
            call: jest.fn().mockResolvedValue({ records: [] }),
          }),
        }),
      }),
    };

    return { service, prisma, queue };
  };

  it('rolls forward to now when cursor is missing', async () => {
    const { service, prisma } = createService();
    prisma.eventCursor.findUnique.mockResolvedValue(null);

    const cursor = await (service as any).loadStartupCursor();

    expect(cursor).toBe('now');
    expect(prisma.eventCursor.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ cursor: 'now' }),
        update: expect.objectContaining({ cursor: 'now' }),
      }),
    );
  });

  it('uses saved cursor when network matches and cursor validates', async () => {
    const { service, prisma } = createService();
    prisma.eventCursor.findUnique.mockResolvedValue({
      key: 'stellar:event_listener:cursor',
      cursor: '12345',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    const cursor = await (service as any).loadStartupCursor();

    expect(cursor).toBe('12345');
    expect(prisma.eventCursor.upsert).not.toHaveBeenCalled();
  });

  it('skips queueing duplicate contract events by txHash and eventType', async () => {
    const { service, prisma, queue } = createService();
    prisma.processedContractEvent.findUnique.mockResolvedValue({ id: 'seen' });

    await (service as any).enqueueContractEvent({
      contractId: 'C123',
      eventType: 'DonationReceived',
      topics: [],
      value: {},
      ledger: 1,
      txHash: 'tx1',
      pagingToken: 'pt1',
      createdAt: new Date().toISOString(),
    });

    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.processedContractEvent.create).not.toHaveBeenCalled();
  });
});
