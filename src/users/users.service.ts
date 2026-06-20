import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UserProfileDto, PublicUserProfileDto } from './dto/user-profile.dto';
import {
  NotificationPreferencesDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification-preferences.dto';
import { QUEUE_EXPORT } from '../queue/queue.constants';
import type { ExportDonationJobData } from './export.processor';

/** Threshold above which exports are processed via Bull queue */
const EXPORT_QUEUE_THRESHOLD = 500;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_EXPORT) private readonly exportQueue: Queue,
  ) {}

  /**
   * Get authenticated user's full profile
   */
  async getMyProfile(walletAddress: string): Promise<UserProfileDto> {
    const user = await this.prisma.user.findUnique({
      where: { walletAddress },
      include: {
        campaigns: {
          where: { status: 'ACTIVE' as const },
        },
        donations: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Calculate stats
    const totalRaised = user.campaigns.reduce(
      (sum, campaign) => sum + parseFloat(campaign.raisedAmount.toString()),
      0,
    );

    const totalDonated = user.donations.reduce(
      (sum, donation) => sum + parseFloat(donation.amount.toString()),
      0,
    );

    return {
      id: user.id,
      walletAddress: user.walletAddress || '',
      displayName: user.displayName || undefined,
      bio: user.bio || undefined,
      avatarUrl: user.avatarUrl || undefined,
      role: user.role,
      kycStatus: user.kycStatus,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      totalRaised,
      totalDonated,
      campaignCount: user.campaigns.length,
    };
  }

  /**
   * Update authenticated user's profile
   */
  async updateMyProfile(
    walletAddress: string,
    updateDto: UpdateUserDto,
  ): Promise<UserProfileDto> {
    const user = await this.prisma.user.findUnique({
      where: { walletAddress },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        displayName: updateDto.displayName ?? user.displayName,
        bio: updateDto.bio ?? user.bio,
        avatarUrl: updateDto.avatarUrl ?? user.avatarUrl,
        socialLinks: (updateDto.socialLinks ?? user.socialLinks) as any,
      },
      include: {
        campaigns: {
          where: { status: 'ACTIVE' as const },
        },
        donations: true,
      },
    });

    // Calculate stats
    const totalRaised = updated.campaigns.reduce(
      (sum, campaign) => sum + parseFloat(campaign.raisedAmount.toString()),
      0,
    );

    const totalDonated = updated.donations.reduce(
      (sum, donation) => sum + parseFloat(donation.amount.toString()),
      0,
    );

    return {
      id: updated.id,
      walletAddress: updated.walletAddress || '',
      displayName: updated.displayName || undefined,
      bio: updated.bio || undefined,
      avatarUrl: updated.avatarUrl || undefined,
      role: updated.role,
      kycStatus: updated.kycStatus,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      totalRaised,
      totalDonated,
      campaignCount: updated.campaigns.length,
    };
  }

  /**
   * Get public profile for a user by wallet address
   */
  async getPublicProfile(walletAddress: string): Promise<PublicUserProfileDto> {
    const user = await this.prisma.user.findUnique({
      where: { walletAddress },
      include: {
        campaigns: {
          where: { status: 'ACTIVE' as const },
        },
      },
    });

    if (!user) {
      throw new NotFoundException(
        `User with wallet address ${walletAddress} not found`,
      );
    }

    // Calculate stats
    const totalRaised = user.campaigns.reduce(
      (sum, campaign) => sum + parseFloat(campaign.raisedAmount.toString()),
      0,
    );

    return {
      displayName: user.displayName || undefined,
      avatarUrl: user.avatarUrl || undefined,
      bio: user.bio || undefined,
      kycStatus: user.kycStatus,
      campaignCount: user.campaigns.length,
      totalRaised,
    };
  }

  /**
   * Update KYC status for a user (admin only)
   */
  async updateKYCStatus(
    userId: string,
    status: 'VERIFIED' | 'REJECTED' | 'PENDING',
    adminId: string,
  ): Promise<{ success: boolean; message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Update KYC status
    await this.prisma.user.update({
      where: { id: userId },
      data: { kycStatus: status },
    });

    // Log to AuditLog
    await this.prisma.auditLog.create({
      data: {
        userId: adminId,
        action: 'ADMIN_ACTION',
        resourceType: 'User',
        resourceId: userId,
        details: JSON.stringify({
          action: 'KYC_STATUS_UPDATE',
          previousStatus: user.kycStatus,
          newStatus: status,
        }),
      },
    });

    // TODO: Send email notification to user
    // await this.emailService.sendKYCStatusUpdate(user.email, status);

    return {
      success: true,
      message: `User KYC status updated to ${status}`,
    };
  }

  /**
   * Get or create user by wallet address
   */
  async getOrCreateUser(walletAddress: string, email?: string) {
    let user = await this.prisma.user.findUnique({
      where: { walletAddress },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          walletAddress,
          email: email || `${walletAddress}@orbitchain.local`,
          role: 'DONOR',
        },
      });

      // Log user creation in AuditLog
      await this.prisma.auditLog.create({
        data: {
          userId: user.id,
          action: 'USER_CREATED',
          resourceType: 'User',
          resourceId: user.id,
          details: JSON.stringify({ walletAddress }),
        },
      });
    }

    return user;
  }

  /**
   * Get user's personal donation history with filters and sorting
   */
  async getUserDonationHistory(
    userId: string,
    page: number = 1,
    limit: number = 20,
    sortBy: 'amount' | 'createdAt' = 'createdAt',
    order: 'asc' | 'desc' = 'desc',
    campaignId?: string,
    startDate?: string,
    endDate?: string,
  ) {
    const skip = (page - 1) * limit;

    // Build where clause
    const where: Prisma.DonationWhereInput = {
      donorId: userId,
      status: 'CONFIRMED' as const,
      ...(campaignId && { campaignId }),
      ...(startDate || endDate
        ? {
            donatedAt: {
              ...(startDate && { gte: new Date(startDate) }),
              ...(endDate && { lte: new Date(endDate) }),
            },
          }
        : {}),
    };

    // Build orderBy
    const orderByClause = {};
    orderByClause[sortBy] = order;

    // Get total count
    const total = await this.prisma.donation.count({ where });

    // Get paginated donations
    const donations = await this.prisma.donation.findMany({
      where,
      include: {
        campaign: {
          select: {
            id: true,
            title: true,
            status: true,
          },
        },
      },
      orderBy: orderByClause,
      skip,
      take: limit,
    });

    // Format response
    const donationHistory = donations.map((donation: any) => ({
      id: donation.id,
      amount: donation.amount.toString(),
      assetCode: donation.assetCode,
      status: donation.status,
      campaignId: donation.campaignId,
      campaignTitle: donation.campaign?.title || 'Unknown Campaign',
      campaignStatus: donation.campaign?.status || 'UNKNOWN',
      txHash: donation.txHash,
      donatedAt: donation.donatedAt,
      createdAt: donation.createdAt,
    }));

    // Calculate summary
    const totalDonatedResult: any = await this.prisma.donation.aggregate({
      where,
      _sum: {
        amount: true,
      },
      _count: true,
    });

    const totalDonated: string =
      totalDonatedResult._sum?.amount?.toString() || '0';
    const totalDonations: number = totalDonatedResult._count ?? 0;
    const averageDonation =
      totalDonations > 0
        ? (parseFloat(totalDonated) / totalDonations).toString()
        : '0';

    return {
      donations: donationHistory,
      pagination: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
      summary: {
        totalDonated,
        totalDonations,
        averageDonation,
      },
    };
  }

  /**
   * Export user's donation history as CSV.
   * For large datasets (> EXPORT_QUEUE_THRESHOLD rows) the job is enqueued via
   * Bull and a jobId is returned so the client can poll for completion.
   * For small datasets the CSV is generated synchronously and returned directly.
   */
  async exportUserDonationsAsCSV(
    userId: string,
    campaignId?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<{ csv?: string; jobId?: string; queued: boolean }> {
    // Build where clause
    const where: Prisma.DonationWhereInput = {
      donorId: userId,
      status: 'CONFIRMED' as const,
    };

    if (campaignId) {
      where.campaignId = campaignId;
    }

    if (startDate || endDate) {
      where.donatedAt = {};
      if (startDate) {
        where.donatedAt.gte = new Date(startDate);
      }
      if (endDate) {
        where.donatedAt.lte = new Date(endDate);
      }
    }

    // Count rows to decide sync vs async path
    const count = await this.prisma.donation.count({ where });

    if (count > EXPORT_QUEUE_THRESHOLD) {
      // Enqueue for async processing
      const jobData: ExportDonationJobData = {
        userId,
        campaignId,
        startDate,
        endDate,
      };
      const job = await this.exportQueue.add('donation-export', jobData);
      return { queued: true, jobId: String(job.id) };
    }

    // Synchronous path for small exports
    const donations = await this.prisma.donation.findMany({
      where,
      include: {
        campaign: {
          select: { title: true },
        },
      },
      orderBy: { donatedAt: 'desc' },
    });

    const headers = [
      'Campaign',
      'Amount',
      'Asset',
      'Date',
      'Tx Hash',
      'USD Equivalent',
    ];
    const rows: string[] = [headers.map((h) => `"${h}"`).join(',')];

    for (const donation of donations) {
      const row = [
        `"${((donation as any).campaign?.title || 'Unknown').replace(/"/g, '""')}"`,
        donation.amount.toString(),
        donation.assetCode,
        donation.donatedAt.toISOString().split('T')[0],
        `"${donation.txHash || ''}"`,
        '0.00', // USD equivalent: fetched from price cache in production
      ];
      rows.push(row.join(','));
    }

    return { csv: rows.join('\n'), queued: false };
  }

  /**
   * Get notification preferences for the current user.
   * Creates default preferences if none exist.
   */
  async getNotificationPreferences(
    userId: string,
  ): Promise<NotificationPreferencesDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { notificationPreference: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // Return default preferences if none exist
    if (!user.notificationPreference) {
      return {
        donationReceived: { email: true, inApp: true },
        milestoneUnlocked: { email: true, inApp: true },
        campaignUpdate: { email: true, inApp: true },
        campaignCreated: { email: true, inApp: true },
        campaignCompleted: { email: true, inApp: true },
      };
    }

    return user.notificationPreference
      .preferences as unknown as NotificationPreferencesDto;
  }

  /**
   * Update notification preferences for the current user.
   * Creates a preference record if none exists, otherwise merges the update.
   */
  async updateNotificationPreferences(
    userId: string,
    updateDto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { notificationPreference: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const existingPrefs = user.notificationPreference?.preferences as Record<
      string,
      { email?: boolean; inApp?: boolean }
    > | null;

    // Merge existing preferences with the update
    const defaults = {
      donationReceived: { email: true, inApp: true },
      milestoneUnlocked: { email: true, inApp: true },
      campaignUpdate: { email: true, inApp: true },
      campaignCreated: { email: true, inApp: true },
      campaignCompleted: { email: true, inApp: true },
    };

    const merged = { ...defaults, ...(existingPrefs as object) };

    for (const [key, value] of Object.entries(updateDto)) {
      if (value !== undefined) {
        merged[key] = { ...merged[key], ...value };
      }
    }

    // Upsert the preference record
    const prefs = await this.prisma.notificationPreference.upsert({
      where: { userId },
      update: { preferences: merged as any },
      create: { userId, preferences: merged as any },
    });

    return prefs.preferences as unknown as NotificationPreferencesDto;
  }

  /**
   * Poll the status of an async export job.
   * Returns the CSV when the job is complete.
   */
  async getExportJobStatus(
    jobId: string,
  ): Promise<{ status: string; csv?: string; rowCount?: number }> {
    const job = await this.exportQueue.getJob(jobId);

    if (!job) {
      throw new NotFoundException(`Export job ${jobId} not found`);
    }

    const state = await job.getState();

    if (state === 'completed') {
      const result = job.returnvalue as { csv: string; rowCount: number };
      return {
        status: 'completed',
        csv: result.csv,
        rowCount: result.rowCount,
      };
    }

    if (state === 'failed') {
      return { status: 'failed' };
    }

    return { status: state };
  }
}
