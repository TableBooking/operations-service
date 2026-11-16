import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { ErrorFilter } from './common/error.filter.js';
import { uuidPattern } from './operations/domain.js';
export async function createApplication(logger: false | undefined = undefined) {
  const app = await NestFactory.create(AppModule,{logger});
  const access = new Logger('OperationsHTTP');
  app.setGlobalPrefix('api');
  app.use((request: Request,response: Response,next: NextFunction) => {
    const supplied = request.header('X-Correlation-Id') ?? '';
    const id = uuidPattern.test(supplied) ? supplied : randomUUID();
    request.headers['x-correlation-id']=id;
    response.setHeader('X-Correlation-Id',id);
    response.once('finish',() => access.log(JSON.stringify({correlationId:id,method:request.method,path:request.path,status:response.statusCode})));
    next();
  });
  app.useGlobalPipes(new ValidationPipe({whitelist:true,forbidNonWhitelisted:true,transform:true}));
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  return app;
}
