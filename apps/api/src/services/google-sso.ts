import { OAuth2Client } from 'google-auth-library';
import { AppError } from '../auth.js';

const ALLOWED_DOMAIN = 'iitrpr.ac.in';

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
