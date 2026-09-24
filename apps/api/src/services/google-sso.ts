import { OAuth2Client } from 'google-auth-library';
import { AppError } from '../auth.js';

const ALLOWED_DOMAIN = 'iitrpr.ac.in';

export async function verifyGoogleIdToken(
  idToken: string,
): Promise<{ email: string; name: string | null }> {
  const client = new OAuth2Client(process.env.INTERVAL_GOOGLE_CLIENT_ID);
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.INTERVAL_GOOGLE_CLIENT_ID,
  });
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
