import {
  Controller,
  Post,
  Param,
  Body,
  UseGuards,
  Request,
  ParseUUIDPipe,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { SuspendCampaignDto } from './dtos/suspend-campaign.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  /** POST /admin/campaigns/:id/suspend — Suspend a campaign (admin only) */
  @Post('campaigns/:id/suspend')
  async suspendCampaign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendCampaignDto,
    @Request() req: any,
  ): Promise<{ message: string }> {
    return this.adminService.suspendCampaign(
      id,
      dto,
      req.user.sub,
      req.user.email,
    );
  }
}
