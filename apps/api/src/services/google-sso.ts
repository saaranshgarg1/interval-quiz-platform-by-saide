import { OAuth2Client } from 'google-auth-library';
import { AppError } from '../auth.js';

const ALLOWED_DOMAIN = 'iitrpr.ac.in';

/** Normalise an origin for comparison ("https://Host.com/" → "https://host.com"). */
function normOrigin(o: string): string {
  return o.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Can Google sign-in work for a page served at `origin`? Google only accepts
 * sign-ins from origins listed in the OAuth client's "Authorized JavaScript
 * origins". INTERVAL_GOOGLE_ORIGINS mirrors that list (comma-separated); when it
 * is set and the origin is missing, the login page shows Google as unavailable
 * instead of letting people hit Google's error. Unset = trust every origin.
 */
export function googleSignInConfig(origin: string | undefined): {
  enabled: boolean;
  client_id: string | null;
  allowed_domain: string;
  reason: string | null;
} {
  const clientId = process.env.INTERVAL_GOOGLE_CLIENT_ID?.trim() || null;
  const base = { client_id: clientId, allowed_domain: ALLOWED_DOMAIN };
  if (!clientId) {
    return { ...base, enabled: false, reason: 'Google sign-in is not set up on this server. Use your email and password.' };
  }
  const listed = (process.env.INTERVAL_GOOGLE_ORIGINS ?? '').split(',').map(normOrigin).filter(Boolean);
  if (listed.length && (!origin || !listed.includes(normOrigin(origin)))) {
    return {
      ...base,
      enabled: false,
      reason: 'Google sign-in is not enabled for this web address yet. Use your email and password.',
    };
  }
  return { ...base, enabled: true, reason: null };
}

export async function verifyGoogleIdToken(
  idToken: string,
): Promise<{ email: string; name: string | null }> {
  const clientId = process.env.INTERVAL_GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new AppError(503, 'Google sign-in is not configured.');
  }
  const client = new OAuth2Client(clientId);
  // A malformed, expired or wrong-audience token makes the library throw;
  // report that as a rejected sign-in, not a server error.
  let ticket;
  try {
    ticket = await client.verifyIdToken({ idToken, audience: clientId });
  } catch {
    throw new AppError(401, 'Invalid Google ID token.');
  }
  const payload = ticket.getPayload();

  if (!payload) {
    throw new AppError(401, 'Invalid Google ID token.');
  }
  if (!payload.email_verified) {
    throw new AppError(401, 'Email not verified by Google.');
  }
  const email = payload.email as string;
  const domain = payload.hd as string | undefined;
  if (domain !== ALLOWED_DOMAIN && !email.endsWith(`@${ALLOWED_DOMAIN}`)) {
    throw new AppError(401, 'Only iitrpr.ac.in accounts are allowed.');
  }

  return { email, name: (payload.name as string) ?? null };
}
