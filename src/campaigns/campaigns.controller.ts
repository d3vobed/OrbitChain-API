import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Body,
  Req,
  Inject,
  UseGuards,
} from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import type { Cache } from 'cache-manager';
import { CampaignsService } from './campaigns.service';
import type { CampaignStats } from './interfaces/campaign-stats.interface';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard } from '../users/guards/admin.guard';
import {
  BrowseCampaignsQueryDto,
  BrowseCampaignsResponseDto,
} from './dto/browse-campaigns.dto';
import { DonationsService } from '../donations/donations.service';
import { ContractBalanceResponseDto } from './dto/contract-balance.dto';
import {
  GetCampaignDonationsQueryDto,
  GetCampaignDonationsResponseDto,
} from '../donations/dto/get-campaign-donations.dto';
import { CreateUpdateDto } from './dto/create-update.dto';

const FORBIDDEN_FIELDS = [
  'goalAmount',
  'contractId',
  'acceptedAssets',
  'milestones',
  'endDate',
];

@Controller('campaigns')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CampaignsController {
  constructor(
    private readonly campaignsService: CampaignsService,
    private readonly donationsService: DonationsService,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  @Get(':id/stats')
  @Roles('creator', 'admin')
  async getCampaignStats(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CampaignStats> {
    return this.campaignsService.getCampaignStats(id);
  }

  /** POST /campaigns — Create a new fundraising campaign */
  @Post()
  @UseGuards(JwtAuthGuard)
  async create(
    @Body() body: CreateCampaignDto,
    @Req() req: Request & { user: any },
  ) {
    const userId = req.user?.sub as string;
    return this.campaignsService.createCampaign(userId, body);
  }

  /** PATCH /campaigns/:id — Update campaign metadata (protected fields excluded) */
  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  async update(
    @Param('id') id: string,
    @Body() body: UpdateCampaignDto,
    @Req() req: Request & { user: any },
  ) {
    const sentKeys = Object.keys(body || {});
    const illegal = sentKeys.filter((k) => FORBIDDEN_FIELDS.includes(k));
    if (illegal.length > 0) {
      throw new BadRequestException(
        `Cannot update protected fields: ${illegal.join(', ')}`,
      );
    }

    return this.campaignsService.updateCampaign(req.user.id, id, body);
  }

  @Get()
  async browseCampaigns(
    @Query() query: BrowseCampaignsQueryDto,
  ): Promise<BrowseCampaignsResponseDto> {
    const cacheKey = this.generateCacheKey(query);

    const cached =
      await this.cacheManager.get<BrowseCampaignsResponseDto>(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.campaignsService.browseCampaigns(query);
    await this.cacheManager.set(cacheKey, result, 30000);

    return result;
  }

  /**
   * GET /campaigns/:id/contract-balance
   * Fetch on-chain balances for the campaign's Stellar contract account.
   * Discrepancies between on-chain and stored amounts are flagged and auto-corrected.
   */
  @Get(':id/contract-balance')
  async getContractBalance(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ContractBalanceResponseDto> {
    return this.campaignsService.getContractBalance(id);
  }

  /**
   * GET /campaigns/:campaignId/donations
   * Get paginated donations for a campaign (public leaderboard)
   */
  @Get(':campaignId/donations')
  async getCampaignDonations(
    @Param('campaignId') campaignId: string,
    @Query() query: GetCampaignDonationsQueryDto,
  ): Promise<GetCampaignDonationsResponseDto> {
    return this.donationsService.getCampaignDonations(
      campaignId,
      query.page,
      query.limit,
      query.sortBy,
      query.order,
    );
  }

  /**
   * POST /campaigns/:id/updates
   * Create a campaign update. Creator-only.
   */
  @Post(':id/updates')
  @UseGuards(JwtAuthGuard)
  async createUpdate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateUpdateDto,
    @Req() req: Request & { user: any },
  ) {
    const userId = req.user?.sub as string;
    return this.campaignsService.createUpdate(id, userId, body);
  }

  /**
   * DELETE /campaigns/:id/updates/:updateId
   * Soft-delete a campaign update. Creator or admin.
   */
  @Delete(':id/updates/:updateId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async deleteUpdate(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('updateId', ParseUUIDPipe) updateId: string,
    @Req() req: Request & { user: any },
  ): Promise<void> {
    const userId = req.user?.sub as string;
    const isAdmin = req.user?.role === 'ADMIN';
    await this.campaignsService.deleteUpdate(id, updateId, userId, isAdmin);
  }

  /**
   * GET /campaigns/:id/updates
   * Public endpoint – returns paginated campaign updates sorted by createdAt DESC
   */
  @Get(':id/updates')
  async getCampaignUpdates(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page') page: number = 1,
  ) {
    return this.campaignsService.getCampaignUpdates(id, Number(page));
  }

  private generateCacheKey(query: BrowseCampaignsQueryDto): string {
    const parts = ['campaigns'];

    if (query.category) parts.push(`category:${query.category}`);
    if (query.status) parts.push(`status:${query.status}`);
    if (query.search) parts.push(`search:${query.search}`);

    return parts.join(':');
  }
}

@Controller('admin/campaigns')
export class AdminCampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Post(':id/feature')
  @UseGuards(JwtAuthGuard, AdminGuard)
  async feature(@Param('id') id: string) {
    return this.campaignsService.featureCampaign(id);
  }
}
