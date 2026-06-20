import { Injectable, OnApplicationBootstrap, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { Horizon, xdr, scValToNative, StrKey } from '@stellar/stellar-sdk';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUE_CONTRACT_EVENTS } from '../queue/queue.constants';

const STELLAR_CURSOR_KEY = 'stellar:event_listener:cursor';

/**
 * Listens for Stellar blockchain events (payments, contract events)
 * and triggers donation processing workflows.
 * Catches up on missed events on startup, then streams in real-time.
 */
@Injectable()
export class StellarEventService implements OnApplicationBootstrap {
  private readonly logger = new Logger(StellarEventService.name);
  private readonly horizonUrl: string;
  private readonly horizonServer: Horizon.Server;
  private readonly networkPassphrase: string;
  private streamCloseFn?: () => void;
  private lastCursor = 'now';
  private isConnecting = false;
  private active = true;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_CONTRACT_EVENTS)
    private readonly contractEventsQueue: Queue,
  ) {
    this.horizonUrl =
      this.config.get<string>('STELLAR_HORIZON_URL') ||
      'https://horizon-testnet.stellar.org';
    this.networkPassphrase =
      this.config.get<string>('STELLAR_NETWORK_PASSPHRASE') ||
      'Test SDF Network ; September 2015';
    this.horizonServer = new Horizon.Server(this.horizonUrl);
  }

  async onApplicationBootstrap() {
    this.logger.log('Starting Stellar Event Listener Service...');

    this.lastCursor = await this.loadStartupCursor();

    // Catch up on any missed events and start the stream
    await this.catchUpAndStartStream();
  }

  onModuleDestroy() {
    this.active = false;
    if (this.streamCloseFn) {
      try {
        this.streamCloseFn();
        this.logger.log('Horizon SSE stream closed.');
      } catch (err) {
        this.logger.error('Error closing Horizon stream:', err.message);
      }
    }
  }

  /** Catch up on missed events since last saved cursor, then start real-time streaming */
  private async catchUpAndStartStream() {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      let currentCursor = this.lastCursor;

      if (currentCursor !== 'now') {
        this.logger.log(
          `Fetching missed events since cursor: ${currentCursor}`,
        );
        let hasMore = true;
        let catchUpCount = 0;

        while (hasMore && this.active) {
          const page = await this.horizonServer
            .transactions()
            .cursor(currentCursor)
            .limit(100)
            .order('asc')
            .call();

          if (page.records && page.records.length > 0) {
            for (const tx of page.records) {
              await this.handleTransaction(tx);
              currentCursor = tx.paging_token;
              catchUpCount++;
            }
            await this.saveCursor(currentCursor);
          } else {
            hasMore = false;
          }
        }
        this.logger.log(
          `Catch up complete. Processed ${catchUpCount} transactions.`,
        );
      }

      if (this.active) {
        this.startStream(currentCursor);
      }
    } catch (err) {
      this.logger.error(
        `Error during catch-up: ${err.message}. Retrying in 5 seconds...`,
      );
      setTimeout(() => this.catchUpAndStartStream(), 5000);
    } finally {
      this.isConnecting = false;
    }
  }

  private startStream(cursor: string) {
    this.logger.log(
      `Starting real-time Horizon transaction stream from cursor: ${cursor}`,
    );
    this.streamCloseFn = this.horizonServer
      .transactions()
      .cursor(cursor)
      .stream({
        onmessage: async (tx) => {
          await this.handleTransaction(tx);
        },
        onerror: (error) => {
          this.logger.error('Horizon stream error:', error);
          this.reconnect();
        },
      });
  }

  private reconnect() {
    if (!this.active) return;
    this.logger.log('Attempting to reconnect Horizon stream in 5 seconds...');

    if (this.streamCloseFn) {
      try {
        this.streamCloseFn();
      } catch (e) {}
    }

    setTimeout(() => this.catchUpAndStartStream(), 5000);
  }

  private async handleTransaction(tx: any) {
    const resultMetaXdr = tx.result_meta_xdr;
    if (!resultMetaXdr) {
      await this.saveCursor(tx.paging_token);
      return;
    }

    const events = this.parseEvents(resultMetaXdr);
    if (events.length === 0) {
      await this.saveCursor(tx.paging_token);
      return;
    }

    try {
      const activeContracts = await this.prisma.smartContract.findMany({
        select: { contractId: true },
      });
      const contractIds = activeContracts.map((c) => c.contractId);

      if (contractIds.length === 0) {
        await this.saveCursor(tx.paging_token);
        return;
      }

      for (const event of events) {
        if (event.contractId && contractIds.includes(event.contractId)) {
          const eventType = event.topics[0];
          if (
            eventType === 'DonationReceived' ||
            eventType === 'MilestoneReleased'
          ) {
            this.logger.log(
              `Found contract event [${eventType}] from contract ID ${event.contractId} in tx ${tx.hash}`,
            );

            await this.enqueueContractEvent({
              contractId: event.contractId,
              eventType,
              topics: event.topics,
              value: event.value,
              ledger: tx.ledger_attr || tx.ledger,
              txHash: tx.hash,
              pagingToken: tx.paging_token,
              createdAt: tx.created_at || new Date().toISOString(),
            });
          }
        }
      }
    } catch (err) {
      this.logger.error(
        `Error processing transaction events in tx ${tx.hash}:`,
        err.message,
      );
    }

    await this.saveCursor(tx.paging_token);
  }

  private async saveCursor(cursor: string) {
    this.lastCursor = cursor;
    await this.prisma.eventCursor.upsert({
      where: { key: STELLAR_CURSOR_KEY },
      create: {
        key: STELLAR_CURSOR_KEY,
        cursor,
        horizonUrl: this.horizonUrl,
        networkPassphrase: this.networkPassphrase,
      },
      update: {
        cursor,
        horizonUrl: this.horizonUrl,
        networkPassphrase: this.networkPassphrase,
      },
    });
  }

  private async loadStartupCursor(): Promise<string> {
    const savedCursor = await this.prisma.eventCursor.findUnique({
      where: { key: STELLAR_CURSOR_KEY },
    });

    if (!savedCursor) {
      this.logger.log(
        'No saved cursor found in Postgres. Rolling forward to "now".',
      );
      await this.saveCursor('now');
      return 'now';
    }

    const networkMatches =
      savedCursor.networkPassphrase === this.networkPassphrase &&
      savedCursor.horizonUrl === this.horizonUrl;
    if (!networkMatches) {
      this.logger.warn(
        `Saved cursor network mismatch (saved: ${savedCursor.horizonUrl}). Rolling forward to "now".`,
      );
      await this.saveCursor('now');
      return 'now';
    }

    if (savedCursor.cursor === 'now') {
      return 'now';
    }

    const cursorIsValid = await this.isCursorValid(savedCursor.cursor);
    if (!cursorIsValid) {
      this.logger.warn(
        `Saved cursor ${savedCursor.cursor} is invalid for current network. Rolling forward to "now".`,
      );
      await this.saveCursor('now');
      return 'now';
    }

    this.logger.log(
      `Loaded last processed transaction cursor from Postgres: ${savedCursor.cursor}`,
    );
    return savedCursor.cursor;
  }

  private async isCursorValid(cursor: string): Promise<boolean> {
    try {
      await this.horizonServer.transactions().cursor(cursor).limit(1).call();
      return true;
    } catch (err) {
      this.logger.warn(
        `Failed validating saved cursor ${cursor}: ${err.message}`,
      );
      return false;
    }
  }

  private async enqueueContractEvent(payload: {
    contractId: string;
    eventType: string;
    topics: unknown[];
    value: unknown;
    ledger: number | string;
    txHash: string;
    pagingToken: string;
    createdAt: string;
  }) {
    const existing = await this.prisma.processedContractEvent.findUnique({
      where: {
        txHash_eventType: {
          txHash: payload.txHash,
          eventType: payload.eventType,
        },
      },
      select: { id: true },
    });
    if (existing) {
      this.logger.debug(
        `Skipping duplicate contract event [${payload.eventType}] for tx ${payload.txHash}`,
      );
      return;
    }

    await this.contractEventsQueue.add('process-event', payload, {
      jobId: `${payload.txHash}:${payload.eventType}`,
    });

    try {
      await this.prisma.processedContractEvent.create({
        data: {
          contractId: payload.contractId,
          eventType: payload.eventType,
          txHash: payload.txHash,
          pagingToken: payload.pagingToken,
        },
      });
    } catch (err) {
      if (this.isUniqueConstraintError(err)) {
        return;
      }
      throw err;
    }
  }

  private isUniqueConstraintError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    if (!('code' in err)) return false;
    return String(err.code) === 'P2002';
  }

  private parseEvents(resultMetaXdr: string): any[] {
    try {
      const meta = xdr.TransactionMeta.fromXDR(resultMetaXdr, 'base64');
      if (meta.v3()) {
        const sorobanMeta = meta.v3().sorobanMeta();
        if (sorobanMeta) {
          const contractEvents = sorobanMeta.events() || [];
          return contractEvents.map((event) => {
            const rawContractId = event.contractId();
            const contractId = rawContractId
              ? StrKey.encodeContract(rawContractId)
              : null;
            const body = event.body();
            const v0 = body?.v0();
            const topics = (v0?.topics() || []).map((t: any) =>
              scValToNative(t),
            );
            const rawValue = v0?.data();
            const value = rawValue ? scValToNative(rawValue) : null;

            return {
              contractId,
              topics,
              value,
            };
          });
        }
      }
    } catch (err) {
      this.logger.error(
        'Failed to parse result_meta_xdr for events:',
        err.message,
      );
    }
    return [];
  }
}
