import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  RequestFundReleaseDto,
  FundReleaseResponseDto,
  FundReleaseDetailDto,
} from '../campaigns/dto/request-fund-release.dto';
import { Prisma } from '@prisma/client';

@Injectable()
export class MilestonesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Request fund release for an unlocked milestone
   * Only campaign creator can request
   * Milestone must be in UNLOCKED status
   */
  async requestFundRelease(
    campaignId: string,
    milestoneId: string,
    creatorId: string,
    dto: RequestFundReleaseDto,
  ): Promise<FundReleaseResponseDto> {
    // Verify campaign exists and creator is authorized
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    if (campaign.creatorId !== creatorId) {
      throw new ForbiddenException(
        'Only campaign creator can request fund release',
      );
    }

    // Verify milestone exists and is UNLOCKED
    const milestone = await this.prisma.milestone.findUnique({
      where: { id: milestoneId },
      include: { campaign: true },
    });

    if (!milestone) {
      throw new NotFoundException('Milestone not found');
    }

    if (milestone.campaignId !== campaignId) {
      throw new BadRequestException(
        'Milestone does not belong to this campaign',
      );
    }

    if (milestone.status !== 'UNLOCKED') {
      throw new BadRequestException(
        `Milestone must be in UNLOCKED status. Current status: ${milestone.status}`,
      );
    }

    // Validate amount
    const releaseAmount = parseFloat(dto.amount);
    if (releaseAmount <= 0) {
      throw new BadRequestException('Release amount must be greater than 0');
    }

    if (releaseAmount > parseFloat(milestone.targetAmount.toString())) {
      throw new BadRequestException(
        `Release amount cannot exceed milestone target of ${milestone.targetAmount}`,
      );
    }

    // Check if there's already a pending release for this milestone
    const existingRelease = await this.prisma.fundRelease.findFirst({
      where: {
        milestoneId,
        status: 'PENDING',
      },
    });

    if (existingRelease) {
      throw new BadRequestException(
        'There is already a pending fund release for this milestone',
      );
    }

    // Create fund release record
    const fundRelease = await this.prisma.fundRelease.create({
      data: {
        milestone: { connect: { id: milestoneId } },
        campaign: { connect: { id: campaignId } },
        creator: { connect: { id: creatorId } },
        amount: releaseAmount,
        status: 'PENDING',
        signaturePayload: dto.signaturePayload || null,
        releaseReason: dto.releaseReason || null,
      },
    });

    return {
      id: fundRelease.id,
      milestoneId: fundRelease.milestoneId,
      campaignId: fundRelease.campaignId,
      creatorId: fundRelease.creatorId,
      amount: fundRelease.amount.toString(),
      status: fundRelease.status,
      txHash: fundRelease.txHash,
      releaseReason: fundRelease.releaseReason,
      createdAt: fundRelease.createdAt,
      updatedAt: fundRelease.updatedAt,
    };
  }

  /**
   * Retrieve a single fund release record by ID.
   * Optionally verifies that the requesting user is the creator.
   */
  async getFundReleaseById(
    releaseId: string,
    userId?: string,
  ): Promise<FundReleaseDetailDto> {
    const fundRelease = await this.prisma.fundRelease.findUnique({
      where: { id: releaseId },
      include: {
        campaign: {
          select: {
            id: true,
            title: true,
          },
        },
      },
    });

    if (!fundRelease) {
      throw new NotFoundException('Fund release not found');
    }

    // Check authorization if userId provided
    if (userId && fundRelease.creatorId !== userId) {
      // Could also allow admin here
      throw new ForbiddenException('Not authorized to view this fund release');
    }

    return {
      id: fundRelease.id,
      milestoneId: fundRelease.milestoneId,
      campaignId: fundRelease.campaignId,
      campaignTitle: fundRelease.campaign?.title || 'Unknown',
      amount: fundRelease.amount.toString(),
      status: fundRelease.status,
      releaseReason: fundRelease.releaseReason,
      txHash: fundRelease.txHash,
      approvedAt: fundRelease.approvedAt,
      releasedAt: fundRelease.releasedAt,
      createdAt: fundRelease.createdAt,
    };
  }

  /**
   * List all fund releases for a campaign, optionally filtered by creator.
   */
  async getCampaignFundReleases(campaignId: string, creatorId?: string) {
    const where: Prisma.FundReleaseWhereInput = {
      campaignId,
    };

    // If creatorId provided, only return their releases
    if (creatorId) {
      where.creatorId = creatorId;
    }

    const fundReleases = await this.prisma.fundRelease.findMany({
      where,
      include: {
        campaign: {
          select: {
            title: true,
          },
        },
        milestone: {
          select: {
            title: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return fundReleases.map((release) => ({
      id: release.id,
      milestoneId: release.milestoneId,
      milestoneTitle: release.milestone?.title || 'Unknown',
      amount: release.amount.toString(),
      status: release.status,
      releaseReason: release.releaseReason,
      txHash: release.txHash,
      approvedAt: release.approvedAt,
      releasedAt: release.releasedAt,
      createdAt: release.createdAt,
    }));
  }

  /**
   * Aggregate fund release stats grouped by status for a campaign.
   */
  async getCampaignFundReleaseStats(campaignId: string) {
    const stats = await this.prisma.fundRelease.groupBy({
      by: ['status'],
      where: { campaignId },
      _sum: {
        amount: true,
      },
      _count: true,
    });

    const result = {
      total: 0,
      pending: { count: 0, amount: '0' },
      approved: { count: 0, amount: '0' },
      released: { count: 0, amount: '0' },
      rejected: { count: 0, amount: '0' },
      cancelled: { count: 0, amount: '0' },
    };

    for (const stat of stats) {
      result.total += stat._count;
      const status = (
        stat.status as string
      ).toLowerCase() as keyof typeof result;
      const entry = result[status];
      if (entry && typeof entry !== 'number') {
        entry.count = stat._count ?? 0;
        entry.amount = stat._sum.amount?.toString() || '0';
      }
    }

    return result;
  }

  /**
   * Cancel a PENDING fund release. Only the original creator may cancel.
   */
  async cancelFundRelease(
    releaseId: string,
    userId: string,
  ): Promise<FundReleaseResponseDto> {
    const fundRelease = await this.prisma.fundRelease.findUnique({
      where: { id: releaseId },
    });

    if (!fundRelease) {
      throw new NotFoundException('Fund release not found');
    }

    if (fundRelease.creatorId !== userId) {
      throw new ForbiddenException(
        'Only the creator can cancel this fund release',
      );
    }

    if (fundRelease.status !== 'PENDING') {
      throw new BadRequestException(
        `Cannot cancel fund release with status ${fundRelease.status}`,
      );
    }

    const updated = await this.prisma.fundRelease.update({
      where: { id: releaseId },
      data: {
        status: 'CANCELLED',
      },
    });

    return {
      id: updated.id,
      milestoneId: updated.milestoneId,
      campaignId: updated.campaignId,
      creatorId: updated.creatorId,
      amount: updated.amount.toString(),
      status: updated.status,
      txHash: updated.txHash,
      releaseReason: updated.releaseReason,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    };
  }
}
