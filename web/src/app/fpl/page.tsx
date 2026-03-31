import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import FPLPageClient from '@/components/fpl-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function FPLPage() {
  try {
    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const auth = getAccessTokenAuthResult(accessToken, RESOURCE.FPL_SAGE);
    // if (!auth.isAuthenticated) {
    //   redirect('/login?next=/fpl');
    // }
    // if (!auth.isEntitled) {
    //   redirect('/subscribe?next=/fpl');
    // }

    // Feature flag: FPL_PRODUCT_SHELL=true enables the new multi-tab product shell.
    // Server-side only (no NEXT_PUBLIC_ prefix) — evaluated at request time, never
    // baked into the client bundle.
    //
    // Using await import() inside the function body instead of next/dynamic at
    // module scope avoids a Next.js 16 App Router bug where next/dynamic emits a
    // webpack client-manifest entry with a _next/-prefixed chunk path. The webpack
    // runtime then prepends /_next/ again, producing /_next/_next/… 404s.
    // With await import() the client component is included via RSC streaming
    // (not lazy chunk loading), so no client manifest entry is created.
    if (process.env.FPL_PRODUCT_SHELL === 'true') {
      const { default: FPLProductShell } = await import('@/components/fpl-product-shell');
      return <FPLProductShell />;
    }

    return <FPLPageClient />;
  } finally {
    try {
      closeDatabaseReadOnly();
    } catch (error) {
      console.warn('[fpl] closeDatabaseReadOnly failed during page teardown', error);
    }
  }
}
