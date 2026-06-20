import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StellarTransactionsService } from '../stellar/stellar-transactions.service';
import {
  BrowseCampaignsQueryDto,
  BrowseCampaignsResponseDto,
} from './dto/browse-campaigns.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import type { CreateUpdateDto } from './dto/create-update.dto';
import { ContractBalanceResponseDto } from './dto/contract-balance.dto';

@Injectable()
export class CampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stellarTransactions: StellarTransactionsService,
  ) {}

  /**
   * Create a new campaign with optional milestones and accepted assets.
   * Sets status to ACTIVE immediately upon creation.
   */
  async createCampaign(userId: string, dto: CreateCampaignDto) {
    if (!dto.goalAmount || parseFloat(dto.goalAmount) <= 0) {
      throw new BadRequestException(
        'goalAmount is required and must be greater than 0',
      );
    }
    const milestoneCreates = (dto.milestones || []).map((m) => ({
      title: m.title,
      description: m.description ?? null,
      targetAmount: (m.targetAmount ?? 0) as any,
      dueDate: m.dueDate ? new Date(m.dueDate) : undefined,
    }));

    const acceptedAssets = parseAcceptedAssets(dto.acceptedAssets);

    return this.prisma.campaign.create({
      data: {
        title: dto.title,
        description: dto.description ?? dto.story ?? '',
        story: dto.story ?? null,
        imageUrl: dto.coverImageUrl ?? undefined,
        category: dto.category ?? undefined,
        goalAmount: dto.goalAmount,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
        status: 'ACTIVE',
        creatorId: userId,
        contractId: dto.contractId ?? undefined,
        acceptedAssets: acceptedAssets.length > 0 ? acceptedAssets : undefined,
        milestones:
          milestoneCreates.length > 0
            ? { create: milestoneCreates }
            : undefined,
      },
      include: { milestones: true },
    });
  }

  async updateCampaign(
    userId: string,
    campaignId: string,
    dto: UpdateCampaignDto,
  ) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    return this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        title: dto.title ?? campaign.title,
        description: dto.description ?? dto.story ?? campaign.description,
        story: dto.story ?? campaign.story,
        imageUrl: dto.coverImageUrl ?? campaign.imageUrl,
      },
    });
  }

  /**
   * Browse public campaigns with pagination, filtering, and sorting
   * Excludes DRAFT campaigns from public listing
   */
  async browseCampaigns(
    query: BrowseCampaignsQueryDto,
  ): Promise<BrowseCampaignsResponseDto> {
    const { page, limit, category, status, search, sortBy } = query;
    const skip = (page - 1) * limit;

    const trimmedSearch = search?.trim();
    if (trimmedSearch) {
      if (trimmedSearch.length < 3) {
        throw new BadRequestException('Search must be at least 3 characters');
      }
      return this.browseCampaignsWithFullTextSearch({
        page,
        limit,
        skip,
        category,
        status,
        search: trimmedSearch,
      });
    }

    const where: Prisma.CampaignWhereInput = {
      status: { not: 'DRAFT' },
    };

    if (category) {
      where.category = {
        equals: category,
        mode: 'insensitive',
      };
    }

    if (status) {
      where.status = status as any;
    }

    let orderBy: Prisma.CampaignOrderByWithRelationInput;
    switch (sortBy) {
      case 'mostFunded':
        orderBy = { raisedAmount: 'desc' };
        break;
      case 'endingSoon':
        orderBy = { endDate: 'asc' };
        break;
      case 'newest':
      default:
        orderBy = { createdAt: 'desc' };
    }

    const [total, campaigns] = await this.prisma.$transaction([
      this.prisma.campaign.count({ where }),
      this.prisma.campaign.findMany({
        where,
        select: campaignBrowseSelect(),
        orderBy,
        skip,
        take: limit,
      }),
    ]);

    return { data: campaigns, total, page, limit };
  }

  /** Returns up to 6 featured, non-DRAFT campaigns sorted by recent activity */
  async getFeaturedCampaigns() {
    return this.prisma.campaign.findMany({
      where: {
        isFeatured: true,
        status: { not: 'DRAFT' },
      },
      select: campaignBrowseSelect(),
      orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
      take: 6,
    });
  }

  /** Feature a campaign (max 6 featured). Enforces the limit in a transaction. */
  async featureCampaign(campaignId: string) {
    return this.prisma.$transaction(async (tx) => {
      const campaign = await tx.campaign.findUnique({
        where: { id: campaignId },
      });
      if (!campaign) {
        throw new NotFoundException('Campaign not found');
      }

      if (campaign.isFeatured) {
        return campaign;
      }

      const featuredCount = await tx.campaign.count({
        where: { isFeatured: true },
      });
      if (featuredCount >= 6) {
        throw new BadRequestException('Maximum 6 featured campaigns allowed');
      }

      return tx.campaign.update({
        where: { id: campaignId },
        data: { isFeatured: true },
      });
    });
  }

  /**
   * Fetch on-chain contract balance from Stellar and compare with stored raisedAmount.
   * Auto-corrects discrepancies.
   */
  async getContractBalance(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });

    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }

    if (!campaign.contractId) {
      throw new BadRequestException('Campaign has no contractId set');
    }

    const balances = await this.stellarTransactions.getContractBalances(
      campaign.contractId,
    );

    // Calculate total on-chain balance
    let onChainTotal = 0;
    for (const b of balances) {
      onChainTotal += parseFloat(b.balance);
    }

    const storedRaisedAmount = parseFloat(campaign.raisedAmount.toString());
    const discrepancyDetected =
      Math.abs(onChainTotal - storedRaisedAmount) > 0.0001;

    // If discrepancy detected, update the stored raisedAmount
    if (discrepancyDetected) {
      await this.prisma.campaign.update({
        where: { id: campaignId },
        data: {
          raisedAmount: onChainTotal,
        },
      });
    }

    return {
      contractId: campaign.contractId,
      balances,
      storedRaisedAmount: campaign.raisedAmount.toString(),
      onChainTotal: onChainTotal.toString(),
      discrepancyDetected,
    };
  }

  /** Recalculate a campaign's raisedAmount from confirmed donations */
  async recalculateCampaignStats(campaignId: string) {
    const agg = await this.prisma.donation.aggregate({
      where: {
        campaignId,
        status: 'CONFIRMED',
      },
      _sum: { amount: true },
    });

    const raisedAmount = agg._sum.amount ?? new Prisma.Decimal(0);

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { raisedAmount },
    });
  }

  /**
   * GET /campaigns/:id/updates
   * Returns paginated updates sorted by createdAt DESC (10 per page).
   */
  async getCampaignUpdates(campaignId: string, page = 1) {
    const limit = 10;
    const skip = (page - 1) * limit;

    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    const [total, updates] = await this.prisma.$transaction([
      this.prisma.update.count({ where: { campaignId } }),
      this.prisma.update.findMany({
        where: { campaignId },
        select: {
          id: true,
          title: true,
          content: true,
          imageUrls: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    // Normalise imageUrls field
    const data = updates.map(({ imageUrls, ...u }) => ({
      ...u,
      imageUrls: imageUrls || [],
    }));

    return { data, total, page, limit };
  }

  /** Create a campaign update (creator only) */
  async createUpdate(campaignId: string, userId: string, dto: CreateUpdateDto) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, creatorId: true },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }
    if (campaign.creatorId !== userId) {
      throw new ForbiddenException(
        'Only the campaign creator can post updates',
      );
    }

    return this.prisma.update.create({
      data: {
        campaignId,
        creatorId: userId,
        title: dto.title,
        content: dto.content,
        imageUrls: dto.imageUrls ?? [],
      },
    });
  }

  /** Soft-delete a campaign update (creator or admin) */
  async deleteUpdate(
    campaignId: string,
    updateId: string,
    userId: string,
    isAdmin: boolean,
  ): Promise<void> {
    const update = await this.prisma.update.findUnique({
      where: { id: updateId },
      select: { id: true, creatorId: true, deletedAt: true },
    });
    if (!update) {
      throw new NotFoundException(`Update ${updateId} not found`);
    }
    if (update.creatorId !== userId && !isAdmin) {
      throw new ForbiddenException('Not authorized to delete this update');
    }
    if (update.deletedAt) {
      throw new BadRequestException('Update is already deleted');
    }

    await this.prisma.update.update({
      where: { id: updateId },
      data: { deletedAt: new Date() },
    });
  }

  /** Compute aggregate stats for a campaign: total raised, donor count, etc. */
  async getCampaignStats(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    const donations = await this.prisma.donation.findMany({
      where: { campaignId, status: 'CONFIRMED' },
      select: { amount: true, donorId: true, assetCode: true, createdAt: true },
    });

    const totalRaised = donations.reduce((sum, d) => sum + Number(d.amount), 0);
    const donorCount = new Set(donations.map((d) => d.donorId)).size;
    const uniqueAssets = [...new Set(donations.map((d) => d.assetCode))];
    const avgDonation = donations.length ? totalRaised / donations.length : 0;

    return {
      campaignId,
      totalRaised,
      donorCount,
      uniqueAssets,
      avgDonation,
      donationsPerDay: [],
      topDonors: [],
    };
  }

  private async browseCampaignsWithFullTextSearch(input: {
    page: number;
    limit: number;
    skip: number;
    category?: string;
    status?: string;
    search: string;
  }): Promise<BrowseCampaignsResponseDto> {
    const { page, limit, skip, category, status, search } = input;

    const filters = sqlCampaignFilters({ category, status });

    const [countRow, rankedRows] = await this.prisma.$transaction([
      this.prisma.$queryRaw<
        { count: number }[]
      >`        SELECT COUNT(*)::int AS count
        FROM campaigns c
        WHERE ${filters.whereSql}
          AND to_tsvector('english',
            coalesce(c.title, '') || ' ' || coalesce(c.description, '') || ' ' || coalesce(c.story, '')
          ) @@ plainto_tsquery('english', ${search})
      `,
      this.prisma.$queryRaw<{ id: string; rank: number }[]>`        SELECT c.id,
          ts_rank(
            to_tsvector('english',
              coalesce(c.title, '') || ' ' || coalesce(c.description, '') || ' ' || coalesce(c.story, '')
            ),
            plainto_tsquery('english', ${search})
          ) AS rank
        FROM campaigns c
        WHERE ${filters.whereSql}
          AND to_tsvector('english',
            coalesce(c.title, '') || ' ' || coalesce(c.description, '') || ' ' || coalesce(c.story, '')
          ) @@ plainto_tsquery('english', ${search})
        ORDER BY rank DESC, c."createdAt" DESC
        LIMIT ${limit} OFFSET ${skip}
      `,
    ]);

    const total = countRow[0]?.count ?? 0;
    const ids = rankedRows.map((r) => r.id);
    if (ids.length === 0) {
      return { data: [], total, page, limit };
    }

    const campaigns = await this.prisma.campaign.findMany({
      where: { id: { in: ids } },
      select: campaignBrowseSelect(),
    });

    const byId = new Map(campaigns.map((c) => [c.id, c]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as any[];

    return { data: ordered, total, page, limit };
  }
}

function campaignBrowseSelect() {
  return {
    id: true,
    title: true,
    description: true,
    story: true,
    goalAmount: true,
    raisedAmount: true,
    status: true,
    creatorId: true,
    startDate: true,
    endDate: true,
    imageUrl: true,
    category: true,
    isFeatured: true,
    createdAt: true,
    updatedAt: true,
    creator: {
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        walletAddress: true,
      },
    },
    _count: {
      select: {
        donations: true,
        milestones: true,
      },
    },
  } satisfies Prisma.CampaignSelect;
}

function parseAcceptedAssets(values?: string[]) {
  if (!values || values.length === 0) return [];

  return values
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => {
      if (v.toUpperCase() === 'XLM') {
        return { assetType: 'native' as const };
      }
      const [code, issuer] = v.split(':');
      if (!code || !issuer) return null;
      return { assetType: 'credit' as const, code, issuer };
    })
    .filter(Boolean) as Array<
    | { assetType: 'native' }
    | { assetType: 'credit'; code: string; issuer: string }
  >;
}

function sqlCampaignFilters(input: { category?: string; status?: string }) {
  const whereParts: Prisma.Sql[] = [Prisma.sql`c.status <> 'DRAFT'`];

  if (input.status) {
    whereParts.push(Prisma.sql`c.status = ${input.status}`);
  }

  if (input.category) {
    whereParts.push(Prisma.sql`c.category ILIKE ${input.category}`);
  }

  const whereSql =
    whereParts.length === 1
      ? whereParts[0]
      : Prisma.sql`${Prisma.join(whereParts, ' AND ')}`;

  return { whereSql };
}
