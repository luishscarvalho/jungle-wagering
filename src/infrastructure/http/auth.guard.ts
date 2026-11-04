import { type CanActivate, Injectable, SetMetadata } from "@nestjs/common";

export const IS_PUBLIC = "isPublic";

/** Marks a controller or route that must stay open once real authentication exists, such as health. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * No-op on purpose: authentication is out of scope (see ARCHITECTURE.md).
 *
 * Extension point: this guard runs on every route, as APP_GUARD. A real one would
 * inject Reflector, let routes marked with @Public() through, validate the token
 * from the external Identity Provider, and check that the authenticated provider
 * matches the providerId in the request.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}
