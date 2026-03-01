import { NextRequest, NextResponse } from 'next/server';
import { Resend } from 'resend';
import { closeDatabase, getDatabase, initDb } from '@cheddar-logic/data';
import { createMagicLinkRecord } from '@/lib/auth/server';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = String(body?.email || '').trim();
    const next = typeof body?.next === 'string' ? body.next : null;

    if (!EMAIL_REGEX.test(email)) {
      return NextResponse.json(
        { success: false, error: 'Please enter a valid email address.' },
        { status: 400 }
      );
    }

    await initDb();
    getDatabase();

    const magicLinkData = createMagicLinkRecord(request, email, next);

    console.log(`[Auth] Magic link for ${magicLinkData.email}: ${magicLinkData.magicLink}`);

    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const fromEmail = process.env.EMAIL_FROM || 'CheddarLogic <noreply@cheddarlogic.com>';
      await resend.emails.send({
        from: fromEmail,
        to: magicLinkData.email,
        subject: 'Your CheddarLogic sign-in link',
        html: `
          <p>Click the link below to sign in to CheddarLogic. This link expires in 15 minutes.</p>
          <p><a href="${magicLinkData.magicLink}">Sign in to CheddarLogic</a></p>
          <p>If you didn't request this, you can ignore this email.</p>
        `,
      });
    } else {
      console.warn('[Auth] RESEND_API_KEY not set — email not sent');
    }

    return NextResponse.json({
      success: true,
      message: 'If that email is valid, a sign-in link has been sent.',
      magicLink: process.env.NODE_ENV === 'production' ? undefined : magicLinkData.magicLink,
      expiresAt: magicLinkData.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    closeDatabase();
  }
}
