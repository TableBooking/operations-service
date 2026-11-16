import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { environment } from './config/runtime.js';
import { databaseOptions } from './database/options.js';
import { JwtGuard } from './auth/auth.js';
import { HealthController } from './health/health.controller.js';
import { Clock } from './operations/domain.js';
import { CatalogService } from './operations/catalog.service.js';
import { ReservationService } from './operations/reservation.service.js';
import { PublicController, OperationsController } from './operations/controllers.js';
import { MessagingService } from './messaging/messaging.service.js';

@Module({
  imports: [TypeOrmModule.forRoot({ ...databaseOptions(environment), retryAttempts: 3, retryDelay: 2000 })],
  controllers: [HealthController, PublicController, OperationsController],
  providers: [Clock,CatalogService,ReservationService,MessagingService,{ provide: APP_GUARD, useClass: JwtGuard }],
})
export class AppModule {}
