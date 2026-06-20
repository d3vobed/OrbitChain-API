import { Module, forwardRef } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CampaignsModule } from '../campaigns/campaigns.module';
import { PrismaModule } from '../prisma/prisma.module';
import { StellarModule } from '../stellar/stellar.module';
import { DonationsController } from './donations.controller';
import { DonationsService } from './donations.service';
import { AdminTipsController } from './admin-tips.controller';

/** Module providing donation creation, verification, history, and CSV export */
@Module({
  imports: [
    PrismaModule,
    AuthModule,
    StellarModule,
    forwardRef(() => CampaignsModule),
  ],
  controllers: [DonationsController, AdminTipsController],
  providers: [DonationsService, JwtAuthGuard],
  exports: [DonationsService],
})
export class DonationsModule {}
