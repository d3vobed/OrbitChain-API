import {
  Controller,
  Post,
  Delete,
  Param,
  Req,
  UseGuards,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Throttle } from '@nestjs/throttler';

interface JwtUser {
  sub: string;
  walletAddress: string;
  role: string;
}

@Controller('api-keys')
@UseGuards(JwtAuthGuard)
export class ApiKeysController {
  constructor(private readonly prisma: PrismaService) {}

  /** POST /api-keys — Generate a new API key (returns raw key only once) */
  @Post()
  async create(@Req() req: Request & { user: JwtUser }): Promise<{
    id: string;
    key: string;
    prefix: string;
    scope: string;
    createdAt: Date;
  }> {
    const rawKey = `sk_${randomBytes(32).toString('hex')}`;
    const prefix = rawKey.slice(0, 12);
    const keyHash = createHash('sha256').update(rawKey).digest('hex');

    const apiKey = await this.prisma.apiKey.create({
      data: {
        userId: req.user.sub,
        name: `API Key ${new Date().toISOString().slice(0, 10)}`,
        keyHash,
        prefix,
        scope: 'read',
      },
    });

    // Return the raw key only once — it cannot be recovered after this response
    return {
      id: apiKey.id,
      key: rawKey,
      prefix: apiKey.prefix,
      scope: apiKey.scope,
      createdAt: apiKey.createdAt,
    };
  }

  /** DELETE /api-keys/:id — Revoke an existing API key (soft-delete) */
  @Delete(':id')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async revoke(
    @Param('id') id: string,
    @Req() req: Request & { user: JwtUser },
  ): Promise<{ message: string }> {
    const apiKey = await this.prisma.apiKey.findUnique({ where: { id } });

    if (!apiKey) {
      throw new NotFoundException('API key not found');
    }

    if (apiKey.userId !== req.user.sub) {
      throw new ForbiddenException('You do not own this API key');
    }

    await this.prisma.apiKey.update({
      where: { id },
      data: { isActive: false },
    });

    return { message: 'API key revoked successfully' };
  }
}
