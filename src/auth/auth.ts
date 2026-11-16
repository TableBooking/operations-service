import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  Injectable, Inject, SetMetadata, UnauthorizedException, ForbiddenException,
  type CanActivate, type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import type { Request } from 'express';
import { environment } from '../config/runtime.js';

export type Role = 'CUSTOMER' | 'STAFF' | 'MANAGER';
export interface AuthenticatedRequest extends Request { user?: { id: string; role: Role }; }
export const Public = () => SetMetadata('operations:public', true);
export const Roles = (...roles: Role[]) => SetMetadata('operations:roles', roles);

@Injectable()
export class JwtGuard implements CanActivate {
  private readonly key: KeyObject;

  constructor(@Inject(Reflector) private readonly reflector: Reflector) {
    const pem = readFileSync(environment.JWT_PUBLIC_KEY_PATH, 'utf8');
    if (!pem.trim().startsWith('-----BEGIN PUBLIC KEY-----')) {
      throw new Error('JWT_PUBLIC_KEY_PATH must point to an RSA SPKI public key');
    }
    this.key = createPublicKey(pem);
    if (this.key.asymmetricKeyType !== 'rsa' || (this.key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
      throw new Error('JWT public key must be RSA with at least 2048 bits');
    }
  }

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>('operations:public', targets)) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const match = /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '');
    if (!match) throw new UnauthorizedException('Bearer token is required');
    try {
      const claims = jwt.verify(match[1], this.key, {
        algorithms: ['RS256'], issuer: environment.JWT_ISSUER,
        audience: environment.JWT_AUDIENCE,
      });
      if (typeof claims === 'string' || typeof claims.exp !== 'number' ||
          typeof claims.sub !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sub) ||
          !['CUSTOMER', 'STAFF', 'MANAGER'].includes(claims.role)) throw new Error('Invalid claims');
      request.user = { id: claims.sub, role: claims.role as Role };
    } catch { throw new UnauthorizedException('Invalid or expired token'); }
    const allowed = this.reflector.getAllAndOverride<Role[]>('operations:roles', targets);
    if (allowed && !allowed.includes(request.user.role)) throw new ForbiddenException('Role is not allowed');
    return true;
  }
}
