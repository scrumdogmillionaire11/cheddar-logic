/**
 * Security Headers Configuration
 *
 * Implements HTTP security headers to protect against:
 * - XSS (Cross-Site Scripting)
 * - Clickjacking
 * - MIME type sniffing
 * - Insecure protocol usage
 * - Unauthorized iframe embedding
 * - Unwanted browser feature access
 */

/**
 * Content Security Policy header value
 *
 * Policy strategy:
 * - default-src 'self': Only allow resources from same origin by default
 * - script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com: Allow scripts from self, inline (Next.js), and Cloudflare Insights
 * - style-src 'self' 'unsafe-inline': Allow styles from self + inline (needed for styled-components)
 * - img-src 'self' https: data:: Allow images from self, any https, and data URIs
 * - font-src 'self' data:: Allow fonts from self and data URIs
 * - connect-src 'self' https://cloudflareinsights.com: Allow API calls to same origin and Cloudflare analytics
 * - frame-ancestors 'none': Prevent embedding in iframes
 * - form-action 'self': Only allow form submissions to same origin
 * - base-uri 'self': Only allow base tag href to same origin
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; connect-src 'self' https://cloudflareinsights.com; frame-ancestors 'none'; form-action 'self'; base-uri 'self'";

/**
 * HTTP Strict Transport Security header value
 *
 * maxAge=31536000: 1 year in seconds
 * includeSubDomains: Apply to all subdomains
 * preload: Allow inclusion in HSTS preload list for browsers
 */
export const STRICT_TRANSPORT_SECURITY =
  'max-age=31536000; includeSubDomains; preload';

/**
 * X-Frame-Options header value
 *
 * DENY: Prevent this site from being framed anywhere
 * Alternatives: SAMEORIGIN (allow framing on same origin), ALLOW-FROM uri (deprecated)
 */
export const X_FRAME_OPTIONS = 'DENY';

/**
 * X-Content-Type-Options header value
 *
 * nosniff: Prevent browser from MIME-sniffing (e.g., treating .txt as .js)
 */
export const X_CONTENT_TYPE_OPTIONS = 'nosniff';

/**
 * Referrer Policy header value
 *
 * strict-no-referrer: Never send referrer info
 * Alternatives: no-referrer, same-origin, strict-no-referrer-when-downgrade
 */
export const REFERRER_POLICY = 'strict-no-referrer';

/**
 * X-XSS-Protection header value
 *
 * 1; mode=block: Enable XSS filter in legacy browsers and block content if attack detected
 * (Modern browsers prefer CSP, but this helps with older IE/Edge versions)
 */
export const X_XSS_PROTECTION = '1; mode=block';

/**
 * Permissions-Policy header value
 *
 * Restricts access to browser features:
 * - geolocation=(): Disable geolocation access
 * - microphone=(): Disable microphone access
 * - camera=(): Disable camera access
 * - payment=(): Disable Payment Request API
 * - usb=(): Disable USB API
 */
export const PERMISSIONS_POLICY =
  'geolocation=(), microphone=(), camera=(), payment=(), usb=()';

/**
 * Security headers configuration object
 * Maps header names to values
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'Strict-Transport-Security': STRICT_TRANSPORT_SECURITY,
  'X-Frame-Options': X_FRAME_OPTIONS,
  'X-Content-Type-Options': X_CONTENT_TYPE_OPTIONS,
  'Referrer-Policy': REFERRER_POLICY,
  'X-XSS-Protection': X_XSS_PROTECTION,
  'Permissions-Policy': PERMISSIONS_POLICY,
  // Additional headers for defense in depth
  'X-Permitted-Cross-Domain-Policies': 'none',
};

/**
 * Function to create response headers with security headers
 * Used in API routes and middleware
 *
 * @param additionalHeaders - Optional headers to merge with security headers
 * @returns Headers object ready for NextResponse
 */
export function createSecurityHeaders(
  additionalHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    ...SECURITY_HEADERS,
    ...(additionalHeaders || {}),
  };
}

/**
 * Describes which headers are applied to different response types
 */
export const SECURITY_HEADERS_INFO = {
  all: [
    {
      name: 'Content-Security-Policy',
      purpose: 'Prevent XSS attacks and control resource loading',
      applies_to: ['API responses', 'HTML pages', 'Error pages'],
    },
    {
      name: 'Strict-Transport-Security',
      purpose: 'Force HTTPS for all future requests',
      applies_to: ['HTTPS responses only', '1 year validity'],
    },
    {
      name: 'X-Frame-Options',
      purpose: 'Prevent clickjacking by blocking iframe embedding',
      applies_to: ['All responses'],
    },
    {
      name: 'X-Content-Type-Options',
      purpose: 'Prevent MIME type sniffing',
      applies_to: ['All responses'],
    },
    {
      name: 'Referrer-Policy',
      purpose: 'Control referrer information leakage',
      applies_to: ['All responses'],
    },
    {
      name: 'X-XSS-Protection',
      purpose: 'Legacy XSS protection for older browsers',
      applies_to: ['All responses (for legacy browser support)'],
    },
    {
      name: 'Permissions-Policy',
      purpose: 'Restrict access to browser features (geolocation, camera, etc)',
      applies_to: ['All responses'],
    },
  ],
};
