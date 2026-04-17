import { NextRequest, NextResponse } from 'next/server';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '../../../lib/api-security';
import { getPotdResponseData } from '@/lib/potd-server';
export type { PotdApiPlay, PotdBankrollSummary, PotdSchedule, PotdResponseData, PotdNominee } from '@/lib/potd-server';

export async function GET(request: NextRequest) {
  try {
    const securityCheck = performSecurityChecks(request, '/api/potd');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    const data = await getPotdResponseData();
    const response = NextResponse.json({
      success: true,
      data: {
        featuredPick: data.featuredPick,
        today: data.today,
        history: data.history,
        bankroll: data.bankroll,
        schedule: data.schedule,
        nominees: data.nominees,
        diagnosticNominees: data.diagnosticNominees,
        winnerStatus: data.winnerStatus,
      },
    });
    return addRateLimitHeaders(response, request);
  } catch (error) {
    console.error('[API] Error fetching POTD data:', error);
    const errorResponse = NextResponse.json(
      { success: false, error: String(error) },
      { status: 500 },
    );
    return addRateLimitHeaders(errorResponse, request);
  }
}
