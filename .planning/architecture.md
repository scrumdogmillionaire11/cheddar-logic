# Cheddar Logic LLC Fullstack Architecture Document

*Generated: January 16, 2026*  
*Created by: Winston (Architect)*

## Introduction

This document outlines the complete fullstack architecture for **Cheddar Logic LLC**, including backend systems, frontend implementation, and their integration. It serves as the single source of truth for AI-driven development, ensuring consistency across the entire technology stack.

This unified approach combines what would traditionally be separate backend and frontend architecture documents, streamlining the development process for modern fullstack applications where these concerns are increasingly intertwined.

### Project Scope Clarification

**✅ IN SCOPE - Brand Website/Landing Page:**
- Professional presence for Cheddar Logic LLC
- Open methodology education and content
- Subscription signup and management via Stripe
- Discord community gating and access control
- Marketing and conversion optimization
- User dashboard for subscription and Discord status

**❌ OUT OF SCOPE:**
- NBA analytics engine (separate repository)
- Sports data processing or storage
- Complex analytics computations
- Live sports data integration

**Key Insight:** This project is a **SaaS marketing and subscription website** that connects users to external analytics delivered via Discord.

### Starter Template Decision

**Selected:** **T3 Stack** as the foundation

**Rationale:** The T3 Stack (Next.js + TypeScript + tRPC + Prisma + Tailwind) provides:
- Type-safe end-to-end development preventing runtime errors
- Clear, consistent patterns ideal for AI agent development
- Excellent developer experience with minimal configuration
- Perfect alignment with the analytical transparency requirements

**Components:**
- Next.js 14 for full-stack React development
- TypeScript for compile-time type safety
- tRPC for type-safe API layer
- Prisma for type-safe database access
- Tailwind CSS for utility-first styling

### Change Log

| Date | Version | Description | Author |
|------|---------|-------------|---------|
| 2026-01-16 | 1.0 | Initial fullstack architecture for Cheddar Logic LLC | Winston (Architect) |

---

## High Level Architecture

### Technical Summary

Cheddar Logic employs a **modern Jamstack architecture** with server-side capabilities, built on the T3 Stack foundation. The system combines **Next.js 14** for both static site generation and API routes, **TypeScript** for end-to-end type safety, **tRPC** for type-safe APIs, and **Prisma** for database management. The architecture supports your "Open Methodology, Gated Participation, Professional Execution" model through a **tiered access system** with public educational content, Discord community integration, and subscription-gated professional features. **Vercel deployment** provides optimal performance for your analytical components, while **PlanetScale MySQL** handles user management and subscription data. The design prioritizes **AI developer productivity** through consistent patterns, explicit typing, and clear separation of concerns.

### Platform and Infrastructure Choice

**Platform:** **Vercel + PlanetScale + Discord API**

**Key Services:**
- **Vercel:** Next.js hosting, serverless functions, edge caching, built-in CI/CD
- **PlanetScale:** Serverless MySQL for user management and subscription data  
- **Clerk:** Authentication with Discord OAuth integration
- **Stripe:** Subscription and payment processing
- **Discord API:** Community integration and access verification
- **Upstash Redis:** Caching and rate limiting for API endpoints

**Deployment Regions:** Primary US-East (majority user base), with global edge caching via Vercel's CDN

**Rationale:** This stack provides the scalability needed for a SaaS marketing platform while supporting complex authentication flows required for tiered Discord access. Vercel's edge network ensures fast delivery of educational content globally, while PlanetScale handles user and subscription management efficiently.

### Repository Structure

**Structure:** **Monorepo using T3 Stack patterns**

**Monorepo Tool:** Built-in Next.js workspace capabilities with Turborepo for build optimization

**Package Organization:**
- **Single Next.js application** with clear internal organization following T3 conventions
- **Shared utilities** in `src/lib/` for common business logic
- **tRPC routers** providing type-safe API boundaries
- **Prisma schema** as single source of truth for all data models

### High Level Architecture Diagram

```mermaid
graph TB
    subgraph "Users"
        U1[Public Visitors]
        U2[Discord Community]
        U3[Paid Subscribers]
    end

    subgraph "Frontend (Next.js)"
        WEB[Web Application]
        API[API Routes]
        TRPC[tRPC Endpoints]
    end

    subgraph "Authentication & Access Control"
        CLERK[Clerk Auth]
        DISCORD[Discord OAuth]
        RBAC[Role-Based Access]
    end

    subgraph "Core Services"
        CONTENT[Content Management]
        SUB[Subscription Management]
        WEBHOOK[Discord Integration]
        USER[User Management]
    end

    subgraph "Data Layer"
        DB[(PlanetScale DB)]
        CACHE[(Upstash Redis)]
        FILES[Vercel Blob Storage]
    end

    subgraph "External Integrations"
        STRIPE[Stripe Payments]
        DISCORD_API[Discord API]
    end

    U1 --> WEB
    U2 --> WEB
    U3 --> WEB

    WEB --> TRPC
    TRPC --> API
    
    API --> CLERK
    CLERK --> DISCORD
    CLERK --> RBAC

    API --> CONTENT
    API --> SUB
    API --> WEBHOOK
    API --> USER

    CONTENT --> DB
    SUB --> STRIPE
    WEBHOOK --> DISCORD_API
    USER --> DB

    API --> CACHE
    API --> FILES
```

### Architectural Patterns

- **T3 Stack Pattern:** Type-safe full-stack development with Next.js + tRPC + Prisma + TypeScript - _Rationale:_ Prevents runtime errors through compile-time type checking, essential for AI agent development accuracy

- **Serverless-First Architecture:** Vercel serverless functions for all API logic - _Rationale:_ Scales automatically with traffic spikes, cost-effective for startup phase, zero server management

- **API-First Design:** All data access through tRPC procedures with full TypeScript inference - _Rationale:_ Enables AI agents to understand exact API contracts, prevents integration errors

- **Role-Based Access Control (RBAC):** Tiered access matching "Open → Gated → Professional" model - _Rationale:_ Supports business model of progressive value delivery through subscription tiers

- **Discord-Centric Integration:** OAuth-based community gating and access verification - _Rationale:_ Aligns with Discord-first analytics delivery, ensures only subscribers access premium community

- **Content Management System:** Flexible CMS for methodology documentation and case studies - _Rationale:_ Supports "Open Methodology" positioning with tier-based content access

---

## Tech Stack

**⚠️ CRITICAL: This is the DEFINITIVE technology selection for the entire project. All AI development must use these exact versions.**

### Technology Stack Table

| Category | Technology | Version | Purpose | Rationale |
|----------|------------|---------|---------|-----------|
| **Frontend Language** | TypeScript | 5.3.3 | Type-safe development | Prevents runtime errors, essential for AI agent accuracy |
| **Frontend Framework** | Next.js | 14.1.0 | Full-stack React framework | SSG + API routes + optimizations, perfect for content strategy |
| **UI Component Library** | Radix UI | 1.0.4 | Headless accessible components | Matches analytical transparency requirements, AI-friendly patterns |
| **Styling Framework** | Tailwind CSS | 3.4.1 | Utility-first CSS | Specified in UX spec, consistent design system |
| **State Management** | Zustand | 4.4.7 | Lightweight state management | Simple patterns for AI agents, avoids Redux complexity |
| **Backend Language** | TypeScript | 5.3.3 | Same as frontend | Single language across stack, type sharing |
| **Backend Framework** | Next.js API Routes | 14.1.0 | Serverless API endpoints | Integrated with frontend, Vercel-optimized |
| **API Layer** | tRPC | 10.45.1 | Type-safe API calls | End-to-end type safety, prevents API integration errors |
| **Database** | PlanetScale MySQL | 8.0 | Serverless MySQL database | Handles user/subscription queries, scales automatically |
| **Database ORM** | Prisma | 5.9.1 | Type-safe database client | Perfect for AI agents - generated types prevent DB errors |
| **Cache** | Upstash Redis | Latest | Edge caching and rate limiting | Fast access for frequently accessed user data |
| **Authentication** | Clerk | 4.29.2 | Auth with Discord OAuth | Supports community gating model perfectly |
| **File Storage** | Vercel Blob | Latest | Image and asset storage | Integrated with Vercel deployment |
| **Payments** | Stripe | 14.15.0 | Subscription management | Industry standard for subscription business model |
| **Discord Integration** | Discord.js | 14.14.1 | Discord API client | Essential for community access verification |
| **Validation** | Zod | 3.22.4 | Runtime type validation | Used throughout tRPC, prevents bad data |
| **Date Handling** | date-fns | 3.3.1 | Date utilities | Subscription billing requires robust date handling |
| **HTTP Client** | Built-in fetch | Native | API requests | No external dependency needed |
| **Frontend Testing** | Vitest | 1.2.2 | Fast unit testing | Better performance than Jest, TypeScript native |
| **React Testing** | Testing Library | 14.1.2 | Component testing | Standard for React component testing |
| **Backend Testing** | Vitest | 1.2.2 | API endpoint testing | Consistent testing framework across stack |
| **E2E Testing** | Playwright | 1.41.2 | End-to-end testing | Better than Cypress for complex subscription flows |
| **Build Tool** | Next.js | 14.1.0 | Built-in build system | Optimized bundling and deployment |
| **Package Manager** | pnpm | 8.15.1 | Fast package management | Efficient for monorepo, faster than npm |
| **Linting** | ESLint | 8.56.0 | Code quality | Prevents common mistakes in AI-generated code |
| **Formatting** | Prettier | 3.2.5 | Code formatting | Consistent formatting across AI contributions |
| **Type Checking** | TypeScript | 5.3.3 | Static analysis | Compile-time error prevention |
| **Deployment** | Vercel | Latest | Serverless hosting | Optimal for Next.js, global edge network |
| **CI/CD** | Vercel | Built-in | Continuous deployment | Integrated with Git, automatic deployments |
| **Monitoring** | Vercel Analytics | Latest | Performance monitoring | Built-in monitoring and error tracking |
| **Logging** | Console + Vercel | Built-in | Application logging | Simple logging with Vercel integration |
| **Environment Config** | Next.js Env | Built-in | Environment variables | Type-safe environment configuration |

---

## Data Models

### User

**Purpose:** Core user entity managing authentication, profile, and subscription relationship for Discord community access

**Key Attributes:**
- `id`: string - Unique user identifier (UUID)
- `email`: string - Primary email for authentication and billing
- `name`: string - Display name for community recognition
- `createdAt`: DateTime - Account creation timestamp
- `updatedAt`: DateTime - Last profile modification
- `subscriptionTier`: enum - Current access level (FREE, COMMUNITY, PROFESSIONAL)
- `stripeCustomerId`: string? - Stripe customer reference for billing
- `discordId`: string? - Discord user ID for community access verification

#### TypeScript Interface
```typescript
interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  subscriptionTier: SubscriptionTier;
  stripeCustomerId?: string;
  discordId?: string;
  
  // Relations
  subscription?: Subscription;
  discordLink?: DiscordLink;
}

enum SubscriptionTier {
  FREE = 'FREE',
  COMMUNITY = 'COMMUNITY', 
  PROFESSIONAL = 'PROFESSIONAL'
}
```

**Relationships:**
- Has one `Subscription` (current active subscription)
- Has one `DiscordLink` (Discord account connection)

### Subscription

**Purpose:** Manages Stripe subscription lifecycle and tier-based access control for Discord community features

**Key Attributes:**
- `id`: string - Unique subscription identifier
- `userId`: string - Reference to owning user
- `stripeSubscriptionId`: string - Stripe subscription reference
- `tier`: enum - Subscription tier level
- `status`: enum - Current subscription state
- `currentPeriodStart`: DateTime - Current billing cycle start
- `currentPeriodEnd`: DateTime - Current billing cycle end
- `cancelAtPeriodEnd`: boolean - Cancellation flag for end of cycle
- `createdAt`: DateTime - Subscription creation timestamp
- `updatedAt`: DateTime - Last subscription modification

#### TypeScript Interface
```typescript
interface Subscription {
  id: string;
  userId: string;
  stripeSubscriptionId: string;
  tier: SubscriptionTier;
  status: SubscriptionStatus;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  createdAt: Date;
  updatedAt: Date;
  
  // Relations
  user: User;
}

enum SubscriptionStatus {
  ACTIVE = 'ACTIVE',
  CANCELED = 'CANCELED',
  PAST_DUE = 'PAST_DUE',
  INCOMPLETE = 'INCOMPLETE'
}
```

**Relationships:**
- Belongs to one `User`

### DiscordLink

**Purpose:** Manages Discord OAuth connection and community access verification based on subscription status

**Key Attributes:**
- `id`: string - Unique link identifier
- `userId`: string - Reference to connected user
- `discordId`: string - Discord user ID
- `discordUsername`: string - Discord username for display
- `accessToken`: string? - Discord OAuth access token (encrypted)
- `refreshToken`: string? - Discord refresh token (encrypted)
- `guildMember`: boolean - Whether user is in Discord server
- `verifiedAt`: DateTime? - When access was last verified
- `createdAt`: DateTime - Initial Discord connection
- `updatedAt`: DateTime - Last connection update

#### TypeScript Interface
```typescript
interface DiscordLink {
  id: string;
  userId: string;
  discordId: string;
  discordUsername: string;
  accessToken?: string; // encrypted
  refreshToken?: string; // encrypted
  guildMember: boolean;
  verifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  
  // Relations
  user: User;
}
```

**Relationships:**
- Belongs to one `User`

### Content

**Purpose:** CMS for methodology documentation, case studies, and educational content supporting the "Open Methodology" positioning

**Key Attributes:**
- `id`: string - Unique content identifier
- `slug`: string - URL-friendly identifier
- `title`: string - Content title
- `description`: string? - SEO meta description
- `content`: text - Full markdown content
- `contentType`: enum - Content category
- `accessLevel`: enum - Required access tier to view
- `published`: boolean - Publication status
- `publishedAt`: DateTime? - Publication timestamp
- `createdAt`: DateTime - Content creation
- `updatedAt`: DateTime - Last content modification
- `authorId`: string? - Content creator reference

#### TypeScript Interface
```typescript
interface Content {
  id: string;
  slug: string;
  title: string;
  description?: string;
  content: string; // Markdown
  contentType: ContentType;
  accessLevel: AccessLevel;
  published: boolean;
  publishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  authorId?: string;
}

enum ContentType {
  METHODOLOGY = 'METHODOLOGY',
  CASE_STUDY = 'CASE_STUDY',
  FRAMEWORK = 'FRAMEWORK',
  BLOG_POST = 'BLOG_POST'
}

enum AccessLevel {
  PUBLIC = 'PUBLIC',
  COMMUNITY = 'COMMUNITY',
  PROFESSIONAL = 'PROFESSIONAL'
}
```

**Relationships:**
- Belongs to one `User` (author)

---

## API Specification

### tRPC Router Definitions

```typescript
// src/server/api/root.ts
export const appRouter = createTRPCRouter({
  auth: authRouter,
  subscription: subscriptionRouter,
  discord: discordRouter,
  content: contentRouter,
  user: userRouter,
});

// Authentication Router
// src/server/api/routers/auth.ts
export const authRouter = createTRPCRouter({
  // Get current user session
  getSession: publicProcedure
    .query(({ ctx }) => {
      return ctx.session;
    }),

  // Update user profile
  updateProfile: protectedProcedure
    .input(z.object({
      name: z.string().min(2).max(50),
      email: z.string().email(),
    }))
    .mutation(async ({ ctx, input }) => {
      return await ctx.prisma.user.update({
        where: { id: ctx.session.user.id },
        data: input,
      });
    }),

  // Delete user account
  deleteAccount: protectedProcedure
    .mutation(async ({ ctx }) => {
      // Handle Stripe subscription cancellation
      // Handle Discord unlinking
      // Delete user data
      return await ctx.prisma.user.delete({
        where: { id: ctx.session.user.id },
      });
    }),
});

// Subscription Management Router
// src/server/api/routers/subscription.ts
export const subscriptionRouter = createTRPCRouter({
  // Get current subscription status
  getCurrent: protectedProcedure
    .query(async ({ ctx }) => {
      return await ctx.prisma.subscription.findUnique({
        where: { userId: ctx.session.user.id },
        include: { user: true },
      });
    }),

  // Create Stripe checkout session
  createCheckout: protectedProcedure
    .input(z.object({
      tier: z.enum(['COMMUNITY', 'PROFESSIONAL']),
      successUrl: z.string().url(),
      cancelUrl: z.string().url(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Create Stripe checkout session
      const session = await stripe.checkout.sessions.create({
        customer_email: ctx.session.user.email,
        line_items: [{
          price: getPriceIdForTier(input.tier),
          quantity: 1,
        }],
        mode: 'subscription',
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        metadata: {
          userId: ctx.session.user.id,
          tier: input.tier,
        },
      });
      
      return { checkoutUrl: session.url };
    }),

  // Create Stripe portal session for subscription management
  createPortal: protectedProcedure
    .input(z.object({
      returnUrl: z.string().url(),
    }))
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.session.user.id },
      });
      
      if (!user?.stripeCustomerId) {
        throw new TRPCError({ 
          code: 'NOT_FOUND', 
          message: 'No active subscription found' 
        });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: user.stripeCustomerId,
        return_url: input.returnUrl,
      });
      
      return { portalUrl: session.url };
    }),

  // Webhook handler for Stripe events
  handleWebhook: publicProcedure
    .input(z.object({
      signature: z.string(),
      body: z.string(),
    }))
    .mutation(async ({ input }) => {
      // Verify webhook signature
      // Handle subscription events
      // Update database accordingly
      return { received: true };
    }),
});

// Discord Integration Router  
// src/server/api/routers/discord.ts
export const discordRouter = createTRPCRouter({
  // Get Discord connection status
  getConnection: protectedProcedure
    .query(async ({ ctx }) => {
      return await ctx.prisma.discordLink.findUnique({
        where: { userId: ctx.session.user.id },
      });
    }),

  // Initialize Discord OAuth flow
  getOAuthUrl: protectedProcedure
    .input(z.object({
      redirectUri: z.string().url(),
    }))
    .query(({ input }) => {
      const params = new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        redirect_uri: input.redirectUri,
        response_type: 'code',
        scope: 'identify guilds.join',
        state: generateSecureState(),
      });
      
      return { 
        url: `https://discord.com/api/oauth2/authorize?${params.toString()}` 
      };
    }),

  // Complete Discord OAuth flow
  completeOAuth: protectedProcedure
    .input(z.object({
      code: z.string(),
      state: z.string(),
    }))
    .mutation(async ({ ctx, input }) => {
      // Exchange code for access token
      // Get Discord user info
      // Add user to guild if subscribed
      // Save Discord link to database
      
      const discordUser = await getDiscordUser(accessToken);
      
      return await ctx.prisma.discordLink.upsert({
        where: { userId: ctx.session.user.id },
        create: {
          userId: ctx.session.user.id,
          discordId: discordUser.id,
          discordUsername: discordUser.username,
          accessToken: encrypt(accessToken),
          refreshToken: encrypt(refreshToken),
          guildMember: await addToGuild(discordUser.id),
        },
        update: {
          discordUsername: discordUser.username,
          accessToken: encrypt(accessToken),
          refreshToken: encrypt(refreshToken),
          verifiedAt: new Date(),
        },
      });
    }),

  // Unlink Discord account
  disconnect: protectedProcedure
    .mutation(async ({ ctx }) => {
      return await ctx.prisma.discordLink.delete({
        where: { userId: ctx.session.user.id },
      });
    }),

  // Verify guild membership
  verifyMembership: protectedProcedure
    .mutation(async ({ ctx }) => {
      const link = await ctx.prisma.discordLink.findUnique({
        where: { userId: ctx.session.user.id },
      });
      
      if (!link) {
        throw new TRPCError({ 
          code: 'NOT_FOUND', 
          message: 'Discord account not linked' 
        });
      }

      const isMember = await checkGuildMembership(link.discordId);
      
      return await ctx.prisma.discordLink.update({
        where: { id: link.id },
        data: { 
          guildMember: isMember,
          verifiedAt: new Date(),
        },
      });
    }),
});

// Content Management Router
// src/server/api/routers/content.ts
export const contentRouter = createTRPCRouter({
  // Get public content list
  getPublic: publicProcedure
    .input(z.object({
      type: z.enum(['METHODOLOGY', 'CASE_STUDY', 'FRAMEWORK', 'BLOG_POST']).optional(),
      limit: z.number().min(1).max(50).default(10),
    }))
    .query(async ({ ctx, input }) => {
      return await ctx.prisma.content.findMany({
        where: {
          published: true,
          accessLevel: 'PUBLIC',
          ...(input.type && { contentType: input.type }),
        },
        select: {
          id: true,
          slug: true,
          title: true,
          description: true,
          contentType: true,
          publishedAt: true,
        },
        orderBy: { publishedAt: 'desc' },
        take: input.limit,
      });
    }),

  // Get single content piece by slug
  getBySlug: publicProcedure
    .input(z.object({
      slug: z.string(),
    }))
    .query(async ({ ctx, input }) => {
      const content = await ctx.prisma.content.findUnique({
        where: { slug: input.slug, published: true },
      });
      
      if (!content) {
        throw new TRPCError({ 
          code: 'NOT_FOUND', 
          message: 'Content not found' 
        });
      }

      // Check access permissions
      if (content.accessLevel !== 'PUBLIC') {
        if (!ctx.session?.user) {
          throw new TRPCError({ 
            code: 'UNAUTHORIZED', 
            message: 'Login required' 
          });
        }
        
        const user = await ctx.prisma.user.findUnique({
          where: { id: ctx.session.user.id },
        });
        
        if (!hasAccessToTier(user?.subscriptionTier, content.accessLevel)) {
          throw new TRPCError({ 
            code: 'FORBIDDEN', 
            message: 'Subscription required' 
          });
        }
      }
      
      return content;
    }),

  // Get user-accessible content
  getUserContent: protectedProcedure
    .query(async ({ ctx }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.session.user.id },
      });
      
      const accessLevels = getAccessLevelsForTier(user?.subscriptionTier);
      
      return await ctx.prisma.content.findMany({
        where: {
          published: true,
          accessLevel: { in: accessLevels },
        },
        orderBy: { publishedAt: 'desc' },
      });
    }),
});

// User Dashboard Router
// src/server/api/routers/user.ts  
export const userRouter = createTRPCRouter({
  // Get complete dashboard data
  getDashboard: protectedProcedure
    .query(async ({ ctx }) => {
      const user = await ctx.prisma.user.findUnique({
        where: { id: ctx.session.user.id },
        include: {
          subscription: true,
          discordLink: true,
        },
      });
      
      return {
        user,
        hasActiveSubscription: user?.subscription?.status === 'ACTIVE',
        discordConnected: !!user?.discordLink,
        accessibleContent: await getContentCountByTier(user?.subscriptionTier),
      };
    }),
});
```

### API Design Decisions

1. **tRPC Type Safety** - All endpoints fully typed, prevents runtime errors for AI agents
2. **Subscription-First** - User access determined by Stripe subscription status  
3. **Discord Integration** - Complete OAuth flow with guild membership management
4. **Content Gating** - Tier-based access control for methodology content
5. **Error Handling** - Consistent TRPC error codes for predictable frontend handling

---

## Components

**Cross-Cutting Invariants (Apply to every component):**

* **Server-authoritative access**: components never decide eligibility; they only render states returned by APIs
* **No urgency / timing language**: no "today / now / best / top / signal"
* **No implied action**: no "do this" flows; only "available / unavailable" states and explanation
* **Abstention/suppression is first-class**: absence is rendered as an explicit analytical state with reasons

---

### **1) Public Landing Composition**

#### `LandingPageShell`

**Responsibility:** Layout + content composition only (no policy logic)

**Consumes:**
- `content.getPublicIndex`
- `content.getPublicFeatured`
- `system.getStatus` (optional, non-user-specific)

**Renders:**
- `HeroPositioningPanel`
- `OpenMethodologyPreview`
- `FrameworkPrinciplesStrip`
- `CaseStudyTeasers`
- `ComplianceContextBanner` (required wrapper)

#### `HeroPositioningPanel`

**Responsibility:** Establish *what this is* and *what it is not*

**Required content rules:**
- "Statistical decision-support" framing
- "No directives / no guarantees" disclaimer block

**Consumes:** Static content (SSG) or `content.getPublicHero`

#### `OpenMethodologyPreview`

**Responsibility:** Show publicly available framework artifacts and examples

**Consumes:** `content.getPublicFeatured`

**States:**
- `Ready` (content available)
- `Empty` (no content published)
- `Error` (service unavailable)

#### `CommunityParticipationPreview`

**Responsibility:** Preview what community participation looks like (examples), without implying access as purchase-driven

**Consumes:** `community.getPreview` (curated, moderated excerpts)

**States:**
- `PublicPreviewOnly` (default)
- No "join now" language; only "participation eligibility is earned + verified"

---

### **2) Authentication & Identity**

#### `AuthGate`

**Responsibility:** Render one of: anonymous view, authenticated view, or restricted view. Never performs access checks beyond session existence.

**Consumes:** `auth.getSession`

**States:**
- `Anonymous`
- `Authenticated`
- `AuthError`

---

### **3) Subscription / Entitlement Surfaces (Server-Driven)**

#### `EntitlementStatusCard`

**Responsibility:** Display user entitlement state + reasons returned by backend

**Consumes:** `entitlements.getStatus`

**States** *(must map 1:1 to backend enum)*:
- `PUBLIC_ONLY`
- `COMMUNITY_ELIGIBLE`
- `COMMUNITY_ACTIVE`
- `PROFESSIONAL_ACTIVE`
- `RESTRICTED` (e.g., chargeback/fraud)
- `UNKNOWN` (safe default)

**Renders:** "What's available" + "Why this state" + "What's required to change state" (requirements, not directives)

#### `SubscriptionPortalPanel`

**Responsibility:** Launch Stripe portal/checkout via backend-issued URLs. Zero pricing persuasion language.

**Consumes:**
- `subscription.getCurrent`
- `subscription.createCheckoutSession`
- `subscription.createBillingPortalSession`

**States:**
- `NoSubscription`
- `Active`
- `PastDue`
- `Canceled`
- `PortalUnavailable`

**Non-negotiable:** UI never infers Discord access from Stripe alone

---

### **4) Discord Connection & Access (Separation of Concerns)**

#### `DiscordConnectionPanel`

**Responsibility:** Show connection status, allow linking/unlinking

**Consumes:**
- `discord.getConnectionStatus`
- `discord.getOAuthUrl`
- `discord.disconnect`

**States:**
- `NotConnected`
- `Connected`
- `Error`

#### `CommunityAccessStatus`

**Responsibility:** Show whether the user is recognized as eligible/active in the community system

**Consumes:** `community.getAccessStatus` (server authoritative, derived from: entitlements + discord membership + policy)

**States:**
- `INELIGIBLE` (with reason codes)
- `ELIGIBLE_NOT_LINKED`
- `ELIGIBLE_NOT_MEMBER`
- `ACTIVE_MEMBER`
- `SUSPENDED`

**Important:** This is *not* a "gating UI." It is a **status renderer**

---

### **5) Content System (Public + Restricted)**

#### `ContentIndex`

**Responsibility:** List content with visibility rules applied server-side

**Consumes:** `content.getIndex` (returns items already filtered + each item includes `visibility` + `access_reason`)

**States:**
- `Ready`
- `Empty`
- `Error`

#### `ContentViewer`

**Responsibility:** Render a single content artifact (MDX/Markdown). Display context banners and limitation notes.

**Consumes:** `content.getBySlug`

**States:**
- `PUBLIC`
- `RESTRICTED` (render `AccessExplanationPanel`)
- `NOT_FOUND`
- `ERROR`

#### `AccessExplanationPanel`

**Responsibility:** Explain restriction in neutral terms using server-provided reason codes

**Consumes:** Props only (from `content.getBySlug` response)

**Prohibited:** Any language implying urgency or "upgrade" persuasion framing

---

### **6) Educational Instrumentation (Non-Gamified)**

#### `ConceptExposureMap`

**Responsibility:** Show what concepts the user has encountered (introduced/explored/revisited), not "progress"

**Consumes:** `learning.getExposureSummary`

**States:**
- `Empty` (new user)
- `Ready`
- `Error`

#### `ReadingSessionTracker` (invisible component/service)

**Responsibility:** Capture engagement events for learning analytics without creating performance claims

**Consumes:** `learning.trackEvent` (batched)

**Event types:**
- `CONTENT_VIEW`
- `SECTION_EXPAND`
- `GLOSSARY_OPEN`
- `CASE_STUDY_STEP_VIEW`
- `SESSION_END`

---

### **7) Abstention / Suppression Surfaces (Core Differentiator)**

#### `AnalyticalStatePanel`

**Responsibility:** Render analytical state results with explicit suppression handling

**Consumes:** `analysis.getState` (or per-domain equivalent)

**States:**
- `OUTPUT_AVAILABLE` (with uncertainty bands + assumptions)
- `SUPPRESSED_LOW_CONFIDENCE` (with reason codes)
- `SUPPRESSED_DATA_CONSTRAINT` (with missing inputs list)
- `SUPPRESSED_MODEL_DISAGREEMENT`
- `ERROR`

**Required:**
- `UncertaintyFootnote`
- `AssumptionsList`
- `InvalidationFactors` (what could change the state)

---

### **8) Required Wrappers (Global)**

#### `ComplianceContextBanner` *(must appear on all analytical pages)*

**Responsibility:** Fixed, consistent language explaining:
- "analysis and education"
- "no directives"
- "uncertainty and limitations"

No page-level exceptions.

---

### **Component Integration Diagram (Corrected)**

```mermaid
graph TB
  subgraph Public
    LP[LandingPageShell]
    H[HeroPositioningPanel]
    OMP[OpenMethodologyPreview]
    CPI[CommunityParticipationPreview]
    CI[ContentIndex]
    CV[ContentViewer]
  end

  subgraph Identity
    AG[AuthGate]
    ES[EntitlementStatusCard]
  end

  subgraph Subscription
    SPP[SubscriptionPortalPanel]
  end

  subgraph Discord
    DCP[DiscordConnectionPanel]
    CAS[CommunityAccessStatus]
  end

  subgraph Learning
    CEM[ConceptExposureMap]
    RST[ReadingSessionTracker]
  end

  subgraph Analysis
    ASP[AnalyticalStatePanel]
    CCB[ComplianceContextBanner]
  end

  LP --> H
  LP --> OMP
  LP --> CPI
  CI --> CV
  CV --> RST
  CV --> CEM

  AG --> ES
  ES --> SPP
  ES --> DCP
  DCP --> CAS

  CV --> CCB
  ASP --> CCB
```

---

### **Development Patterns (Enforced)**

#### Component Template Contract

* `props.ts` defines a strict interface
* `view.tsx` is pure rendering
* `model.ts` maps API responses → view states
* `copy.ts` pulls only from approved phrase registry
* `state.ts` only for local UI state (never entitlements)

#### Access Control Rule

All gating decisions happen in:
* `content.getBySlug`
* `content.getIndex`
* `community.getAccessStatus`
* `entitlements.getStatus`

Components never "figure it out."

---

## Database Schema

Transform the conceptual data models into concrete **Prisma schema** for PlanetScale MySQL implementation.

### Prisma Schema Definition

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider     = "mysql"
  url          = env("DATABASE_URL")
  relationMode = "prisma"
}

// Core user entity with authentication and subscription relationship
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  // Subscription tier for access control
  subscriptionTier SubscriptionTier @default(FREE)
  
  // Stripe integration
  stripeCustomerId String? @unique
  
  // Discord integration (optional)
  discordId String? @unique

  // Relations
  subscription Subscription?
  discordLink  DiscordLink?
  authoredContent Content[] @relation("ContentAuthor")

  @@map("users")
}

// Subscription management with Stripe lifecycle
model Subscription {
  id                   String             @id @default(cuid())
  userId               String             @unique
  stripeSubscriptionId String             @unique
  tier                 SubscriptionTier
  status               SubscriptionStatus
  currentPeriodStart   DateTime
  currentPeriodEnd     DateTime
  cancelAtPeriodEnd    Boolean            @default(false)
  createdAt            DateTime           @default(now())
  updatedAt            DateTime           @updatedAt

  // Relations
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@map("subscriptions")
}

// Discord OAuth integration and community access
model DiscordLink {
  id              String    @id @default(cuid())
  userId          String    @unique
  discordId       String    @unique
  discordUsername String
  accessToken     String?   // Encrypted in application layer
  refreshToken    String?   // Encrypted in application layer
  guildMember     Boolean   @default(false)
  verifiedAt      DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  // Relations
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([discordId])
  @@map("discord_links")
}

// Content management system for methodology and educational materials
model Content {
  id          String      @id @default(cuid())
  slug        String      @unique
  title       String
  description String?     @db.Text
  content     String      @db.LongText // Markdown content
  contentType ContentType
  accessLevel AccessLevel @default(PUBLIC)
  published   Boolean     @default(false)
  publishedAt DateTime?
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt
  authorId    String?

  // Relations
  author User? @relation("ContentAuthor", fields: [authorId], references: [id], onDelete: SetNull)

  @@index([slug])
  @@index([contentType])
  @@index([accessLevel])
  @@index([published])
  @@index([authorId])
  @@map("content")
}

// Learning analytics for educational instrumentation (non-gamified)
model LearningEvent {
  id         String           @id @default(cuid())
  userId     String?          // Optional for anonymous tracking
  sessionId  String           // Session identifier
  eventType  LearningEventType
  contentId  String?          // Reference to content if applicable
  metadata   Json?            // Flexible event data
  timestamp  DateTime         @default(now())

  // Relations
  user    User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  content Content? @relation(fields: [contentId], references: [id], onDelete: SetNull)

  @@index([userId])
  @@index([sessionId])
  @@index([eventType])
  @@index([contentId])
  @@index([timestamp])
  @@map("learning_events")
}

// System configuration and feature flags
model SystemConfig {
  id        String   @id @default(cuid())
  key       String   @unique
  value     Json
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("system_config")
}

// Enums matching TypeScript interfaces
enum SubscriptionTier {
  FREE
  COMMUNITY
  PROFESSIONAL

  @@map("subscription_tier")
}

enum SubscriptionStatus {
  ACTIVE
  CANCELED
  PAST_DUE
  INCOMPLETE
  UNPAID

  @@map("subscription_status")
}

enum ContentType {
  METHODOLOGY
  CASE_STUDY
  FRAMEWORK
  BLOG_POST

  @@map("content_type")
}

enum AccessLevel {
  PUBLIC
  COMMUNITY
  PROFESSIONAL

  @@map("access_level")
}

enum LearningEventType {
  CONTENT_VIEW
  SECTION_EXPAND
  GLOSSARY_OPEN
  CASE_STUDY_STEP_VIEW
  SESSION_START
  SESSION_END

  @@map("learning_event_type")
}
```

### Schema Design Decisions

#### **PlanetScale Optimization**
- **`relationMode = "prisma"`** - Required for PlanetScale serverless MySQL
- **Explicit indexes** - Optimized query performance for subscription and content access patterns
- **`@map`** directives - Clean table/column naming conventions

#### **Security & Compliance**
- **Encrypted tokens** - Discord OAuth tokens encrypted at application layer, not database
- **Cascade deletions** - Proper cleanup when users delete accounts
- **Optional user tracking** - Learning events support anonymous sessions for privacy

#### **Analytical Transparency Support**
- **LearningEvent model** - Captures educational engagement without gamification
- **Flexible metadata** - JSON field supports various event types and analytical requirements
- **Content versioning** - `updatedAt` tracking for methodology evolution

#### **Subscription Business Model**
- **Stripe-native fields** - Direct mapping to Stripe webhook events
- **Tier-based access** - Clean enum structure supporting your business model progression
- **Discord integration** - Separate concern from subscription for compliance clarity

### Migration Strategy

#### **Initial Migration**
```sql
-- Auto-generated by Prisma
-- Creates all tables with proper indexes and constraints
-- Optimized for PlanetScale's distributed architecture
```

#### **Seed Data Requirements**
```typescript
// prisma/seed.ts - Essential system configuration
const seedData = {
  systemConfig: [
    { key: 'maintenance_mode', value: false },
    { key: 'registration_enabled', value: true },
    { key: 'community_access_enabled', value: true }
  ],
  content: [
    // Initial methodology content with PUBLIC access level
    // Case studies and framework documentation
  ]
};
```

### Database Performance Considerations

#### **Query Optimization**
- **Content access queries** - Indexed by `accessLevel` and `published` status
- **User dashboard queries** - Single query with relations for complete user state
- **Learning analytics** - Optimized for time-series analysis with timestamp indexes

#### **Scaling Patterns**
- **Read replicas** - PlanetScale automatic read scaling for content delivery
- **Connection pooling** - Prisma connection management optimized for serverless
- **Query caching** - Redis layer for frequently accessed methodology content

---

## Project Structure

**T3 Stack file organization optimized for AI agent development** with clear separation of concerns and predictable patterns.

### Root Directory Structure

```plaintext
cheddar-logic/
├── .env.example                    # Environment template with all required variables
├── .env.local                      # Local development environment (gitignored)
├── .gitignore                      # Standard Next.js + T3 Stack ignores
├── README.md                       # Project setup and development instructions
├── package.json                    # Dependencies matching tech stack table
├── tsconfig.json                   # TypeScript configuration with strict settings
├── tailwind.config.ts              # Tailwind CSS configuration with design system
├── next.config.mjs                 # Next.js configuration for Vercel deployment
├── postcss.config.js               # PostCSS configuration for Tailwind
├── prettier.config.js              # Prettier formatting rules
├── eslint.config.js                # ESLint rules preventing AI agent mistakes
├── vitest.config.ts                # Vitest configuration for testing
├── playwright.config.ts            # Playwright E2E testing configuration
├── vercel.json                     # Vercel deployment configuration
├── prisma/                         # Database schema and migrations
│   ├── schema.prisma              # Complete schema from Database Schema section
│   ├── seed.ts                    # Initial data seeding script
│   └── migrations/                # Prisma migration history
├── public/                         # Static assets optimized for performance
│   ├── favicon.ico
│   ├── robots.txt
│   ├── sitemap.xml
│   └── images/                    # Optimized images (WebP/AVIF)
├── docs/                          # Project documentation
│   ├── brief.md                   # Project brief
│   └── architecture.md            # This architecture document
└── src/                           # All application source code
    ├── app/                       # Next.js 14 App Router structure
    ├── components/                # React components following design patterns
    ├── server/                    # tRPC server-side logic
    ├── lib/                       # Shared utilities and configurations
    ├── styles/                    # Global CSS and Tailwind customizations
    └── types/                     # Shared TypeScript type definitions
```

### App Router Structure (src/app/)

```plaintext
src/app/
├── layout.tsx                     # Root layout with compliance banner
├── page.tsx                       # Landing page (LandingPageShell)
├── loading.tsx                    # Global loading component
├── error.tsx                      # Global error boundary
├── not-found.tsx                  # 404 page with methodology links
├── globals.css                    # Global Tailwind styles
├── api/                           # API routes for external integrations
│   ├── auth/                      # Clerk authentication callbacks
│   │   └── [...nextauth]/
│   │       └── route.ts
│   ├── trpc/                      # tRPC API endpoint
│   │   └── [trpc]/
│   │       └── route.ts
│   ├── webhooks/                  # External service webhooks
│   │   ├── stripe/
│   │   │   └── route.ts           # Stripe subscription webhooks
│   │   └── discord/
│   │       └── route.ts           # Discord OAuth callbacks
│   └── cron/                      # Scheduled background tasks
│       └── cleanup/
│           └── route.ts
├── dashboard/                     # Protected user dashboard area
│   ├── layout.tsx                 # Dashboard-specific layout
│   ├── page.tsx                   # Dashboard overview
│   ├── profile/
│   │   └── page.tsx               # Profile management
│   ├── subscription/
│   │   └── page.tsx               # Subscription management
│   └── discord/
│       └── page.tsx               # Discord connection management
├── content/                       # Content management and display
│   ├── page.tsx                   # Content index
│   ├── [slug]/
│   │   └── page.tsx               # Individual content viewer
│   └── methodology/
│       ├── page.tsx               # Methodology overview
│       └── [section]/
│           └── page.tsx           # Methodology sections
├── auth/                          # Authentication pages
│   ├── signin/
│   │   └── page.tsx               # Sign-in page
│   ├── signup/
│   │   └── page.tsx               # Sign-up page
│   └── discord-callback/
│       └── page.tsx               # Discord OAuth callback handler
└── legal/                         # Legal and compliance pages
    ├── privacy/
    │   └── page.tsx               # Privacy policy
    ├── terms/
    │   └── page.tsx               # Terms of service
    └── disclaimer/
        └── page.tsx               # Analytical disclaimer
```

### Components Organization (src/components/)

```plaintext
src/components/
├── ui/                            # Base UI components (Radix + Tailwind)
│   ├── button.tsx                 # Button variants and states
│   ├── card.tsx                   # Card layouts for content display
│   ├── dialog.tsx                 # Modal and dialog components
│   ├── form.tsx                   # Form components with validation
│   ├── input.tsx                  # Input field variants
│   ├── loading.tsx                # Loading spinners and skeletons
│   └── typography.tsx             # Text components with design system
├── layout/                        # Layout and navigation components
│   ├── header.tsx                 # Site header with navigation
│   ├── footer.tsx                 # Site footer with legal links
│   ├── navigation.tsx             # Main navigation component
│   └── compliance-banner.tsx     # Required compliance context banner
├── auth/                          # Authentication related components
│   ├── auth-gate.tsx              # Authentication state renderer
│   ├── signin-form.tsx            # Sign-in form component
│   ├── signup-form.tsx            # Sign-up form component
│   └── user-menu.tsx              # Authenticated user menu
├── subscription/                  # Subscription management components
│   ├── entitlement-status-card.tsx    # Server-driven entitlement display
│   ├── subscription-portal-panel.tsx  # Stripe portal integration
│   ├── subscription-plans.tsx         # Tier comparison display
│   └── billing-history.tsx            # Billing history component
├── discord/                       # Discord integration components
│   ├── discord-connection-panel.tsx   # Connection status and OAuth
│   ├── community-access-status.tsx    # Community eligibility status
│   ├── oauth-callback.tsx             # OAuth flow completion
│   └── community-preview.tsx          # Public community preview
├── content/                       # Content system components
│   ├── content-index.tsx              # Content listing with access control
│   ├── content-viewer.tsx             # MDX content renderer
│   ├── access-explanation-panel.tsx   # Neutral restriction explanations
│   ├── methodology-preview.tsx        # Public methodology preview
│   └── case-study-teaser.tsx          # Case study preview cards
├── landing/                       # Landing page specific components
│   ├── hero-positioning-panel.tsx     # Value proposition without CTAs
│   ├── open-methodology-preview.tsx   # Public framework preview
│   ├── community-participation-preview.tsx  # Community examples
│   └── framework-principles-strip.tsx      # Core principles display
├── dashboard/                     # Dashboard specific components
│   ├── dashboard-overview.tsx         # Complete dashboard state
│   ├── activity-summary.tsx           # User activity overview
│   └── quick-actions.tsx              # Available actions panel
├── learning/                      # Educational instrumentation components
│   ├── concept-exposure-map.tsx       # Learning progress tracking
│   ├── reading-session-tracker.tsx    # Invisible engagement tracking
│   └── learning-analytics.tsx         # Educational analytics display
├── analysis/                      # Analytical transparency components
│   ├── analytical-state-panel.tsx     # State with suppression handling
│   ├── uncertainty-footnote.tsx       # Uncertainty explanations
│   ├── assumptions-list.tsx           # Model assumptions display
│   └── invalidation-factors.tsx       # What could change analysis
└── providers/                     # Context providers and wrappers
    ├── trpc-provider.tsx              # tRPC client configuration
    ├── auth-provider.tsx              # Clerk authentication provider
    ├── theme-provider.tsx             # Theme and design system provider
    └── toast-provider.tsx             # Notification system provider
```

### Server-Side Organization (src/server/)

```plaintext
src/server/
├── api/                           # tRPC API implementation
│   ├── root.ts                    # Main router combining all routers
│   ├── trpc.ts                    # tRPC configuration and middleware
│   └── routers/                   # Individual API routers
│       ├── auth.ts                # Authentication router
│       ├── subscription.ts        # Subscription management router
│       ├── discord.ts             # Discord integration router
│       ├── content.ts             # Content management router
│       ├── user.ts                # User management router
│       ├── learning.ts            # Learning analytics router
│       └── system.ts              # System configuration router
├── auth/                          # Authentication configuration
│   ├── config.ts                  # Clerk configuration
│   ├── middleware.ts              # Auth middleware for protected routes
│   └── permissions.ts             # Permission checking utilities
├── db/                            # Database configuration and utilities
│   ├── index.ts                   # Prisma client initialization
│   ├── migrations.ts              # Migration utilities
│   └── seed.ts                    # Database seeding functions
├── integrations/                  # External service integrations
│   ├── stripe/                    # Stripe payment processing
│   │   ├── client.ts              # Stripe client configuration
│   │   ├── webhooks.ts            # Webhook event handlers
│   │   └── subscriptions.ts       # Subscription management
│   ├── discord/                   # Discord API integration
│   │   ├── client.ts              # Discord client configuration
│   │   ├── oauth.ts               # OAuth flow handling
│   │   └── guild-management.ts    # Guild membership management
│   └── redis/                     # Redis caching integration
│       ├── client.ts              # Redis client configuration
│       └── cache.ts               # Caching utilities
├── services/                      # Business logic services
│   ├── user-service.ts            # User management business logic
│   ├── subscription-service.ts    # Subscription business logic
│   ├── content-service.ts         # Content management business logic
│   ├── discord-service.ts         # Discord integration business logic
│   └── analytics-service.ts       # Learning analytics business logic
└── utils/                         # Server-side utilities
    ├── encryption.ts              # Token encryption/decryption
    ├── validation.ts              # Zod schema validation
    ├── errors.ts                  # Error handling utilities
    └── logging.ts                 # Logging configuration
```

### Shared Libraries (src/lib/)

```plaintext
src/lib/
├── utils.ts                       # Common utility functions
├── constants.ts                   # Application constants
├── env.ts                         # Environment variable validation
├── config.ts                      # Application configuration
├── types.ts                       # Shared TypeScript types
├── validations.ts                 # Zod validation schemas
├── hooks/                         # Custom React hooks
│   ├── use-auth.ts                # Authentication hook
│   ├── use-subscription.ts        # Subscription status hook
│   ├── use-discord.ts             # Discord connection hook
│   └── use-content.ts             # Content access hook
├── stores/                        # Zustand state management
│   ├── auth-store.ts              # Authentication state
│   ├── ui-store.ts                # UI state management
│   └── learning-store.ts          # Learning progress state
├── api/                           # API client utilities
│   ├── trpc.ts                    # tRPC client configuration
│   └── types.ts                   # API response types
└── analytics/                     # Learning analytics utilities
    ├── events.ts                  # Event tracking functions
    ├── tracking.ts                # User activity tracking
    └── reporting.ts               # Analytics reporting utilities
```

### Type Definitions (src/types/)

```plaintext
src/types/
├── index.ts                       # Main type exports
├── auth.ts                        # Authentication types
├── subscription.ts                # Subscription and billing types
├── discord.ts                     # Discord integration types
├── content.ts                     # Content management types
├── learning.ts                    # Learning analytics types
├── api.ts                         # API request/response types
└── components.ts                  # Component prop types
```

### Key File Organization Principles

#### **AI Agent Optimization**
- **Predictable structure** - Every component type has a consistent location
- **Single responsibility** - Each file has one clear purpose
- **Type-first development** - Types defined before implementation
- **Clear naming conventions** - Self-documenting file and folder names

#### **T3 Stack Conventions**
- **App Router patterns** - Server and client components properly separated
- **tRPC organization** - Routers grouped by domain, not by CRUD operations
- **Prisma integration** - Database logic centralized in dedicated folders
- **Server-side first** - All business logic happens on the server

#### **Compliance Requirements**
- **Legal pages** - Dedicated section for privacy policy, terms, disclaimers
- **Compliance banner** - Global component required on all analytical pages
- **Access control** - Server-authoritative patterns throughout

#### **Development Efficiency**
- **Hot reload optimization** - File structure supports fast development iteration
- **Test co-location** - Test files adjacent to implementation files
- **Build optimization** - Structure optimized for Next.js and Vercel deployment

---

## Development Workflow

**Complete development setup and deployment procedures optimized for AI agent development** with clear step-by-step instructions.

### Local Development Setup

#### Prerequisites

```bash
# Required software versions (matching tech stack)
node --version    # v18.17.0 or higher
pnpm --version    # v8.15.1 or higher
git --version     # v2.34.0 or higher

# Install pnpm if not available
npm install -g pnpm@8.15.1
```

#### Initial Project Setup

```bash
# Clone repository
git clone <repository-url>
cd cheddar-logic

# Install dependencies
pnpm install

# Copy environment template
cp .env.example .env.local

# Setup database
pnpm db:setup

# Run initial migration and seed
pnpm db:migrate
pnpm db:seed

# Start development server
pnpm dev
```

#### Environment Configuration

```bash
# .env.local - Required environment variables
# Database
DATABASE_URL="mysql://username:password@localhost:3306/cheddar_logic"

# Authentication (Clerk)
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_..."
CLERK_SECRET_KEY="sk_test_..."
NEXT_PUBLIC_CLERK_SIGN_IN_URL="/auth/signin"
NEXT_PUBLIC_CLERK_SIGN_UP_URL="/auth/signup"
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL="/dashboard"
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL="/dashboard"

# Stripe Integration
STRIPE_SECRET_KEY="sk_test_..."
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY="pk_test_..."
STRIPE_WEBHOOK_SECRET="whsec_..."
STRIPE_COMMUNITY_PRICE_ID="price_..."
STRIPE_PROFESSIONAL_PRICE_ID="price_..."

# Discord Integration
DISCORD_CLIENT_ID="..."
DISCORD_CLIENT_SECRET="..."
DISCORD_BOT_TOKEN="..."
DISCORD_GUILD_ID="..."
DISCORD_REDIRECT_URI="http://localhost:3000/auth/discord-callback"

# Redis (Upstash)
REDIS_URL="redis://..."
REDIS_TOKEN="..."

# Application
NEXT_PUBLIC_APP_URL="http://localhost:3000"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-secret-here"

# Feature Flags
NEXT_PUBLIC_REGISTRATION_ENABLED="true"
NEXT_PUBLIC_COMMUNITY_ACCESS_ENABLED="true"
NEXT_PUBLIC_MAINTENANCE_MODE="false"
```

#### Development Commands

```bash
# Development server with hot reload
pnpm dev

# Type checking
pnpm type-check

# Linting and formatting
pnpm lint
pnpm lint:fix
pnpm format

# Database management
pnpm db:migrate          # Run migrations
pnpm db:generate         # Generate Prisma client
pnpm db:seed             # Seed database
pnpm db:reset            # Reset database
pnpm db:studio           # Open Prisma Studio

# Testing
pnpm test                # Run unit tests
pnpm test:watch          # Run tests in watch mode
pnpm test:coverage       # Run tests with coverage
pnpm test:e2e            # Run Playwright E2E tests
pnpm test:e2e:ui         # Run E2E tests with UI

# Build and deployment
pnpm build               # Production build
pnpm start               # Start production server
pnpm preview             # Preview production build locally
```

### AI Agent Development Patterns

#### Component Development Workflow

```bash
# 1. Create component directory structure
mkdir -p src/components/domain/component-name
cd src/components/domain/component-name

# 2. Create required files
touch props.ts           # TypeScript interface definitions
touch view.tsx           # Pure rendering component
touch model.ts           # API response mapping logic
touch copy.ts            # Approved copy/text content
touch state.ts           # Local UI state (if needed)
touch index.ts           # Barrel export

# 3. Implement following the component template contract
# 4. Write tests
touch component-name.test.tsx

# 5. Update barrel exports
# Add to src/components/index.ts
```

#### API Development Workflow

```bash
# 1. Define data model in Prisma schema
# Edit prisma/schema.prisma

# 2. Generate migration
pnpm db:migrate dev --name add-feature-name

# 3. Create tRPC router
# src/server/api/routers/feature-name.ts

# 4. Add router to root
# Update src/server/api/root.ts

# 5. Generate types
pnpm db:generate

# 6. Test API endpoints
pnpm test src/server/api/routers/feature-name.test.ts
```

### Testing Strategy

#### Unit Testing

```typescript
// Component test template
import { render, screen } from '@testing-library/react';
import { TRPCProvider } from '@/lib/api/trpc-provider';
import { ComponentName } from './component-name';

describe('ComponentName', () => {
  const renderComponent = (props = {}) => {
    return render(
      <TRPCProvider>
        <ComponentName {...props} />
      </TRPCProvider>
    );
  };

  it('renders correctly with required props', () => {
    renderComponent({ requiredProp: 'value' });
    expect(screen.getByRole('...'));
  });

  it('handles loading state correctly', () => {
    // Test loading states
  });

  it('handles error state correctly', () => {
    // Test error handling
  });
});
```

#### API Testing

```typescript
// tRPC router test template
import { createTRPCMsw } from 'msw-trpc';
import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';

describe('Feature API Router', () => {
  const trpcMsw = createTRPCMsw(appRouter);

  it('returns correct data for authenticated user', async () => {
    const ctx = await createTRPCContext({
      session: { user: { id: 'user-id' } }
    });
    
    const caller = appRouter.createCaller(ctx);
    const result = await caller.feature.getData();
    
    expect(result).toEqual({ /* expected data */ });
  });
});
```

#### E2E Testing

```typescript
// Playwright E2E test template
import { test, expect } from '@playwright/test';

test.describe('Subscription Flow', () => {
  test('user can complete subscription signup', async ({ page }) => {
    // Navigate to landing page
    await page.goto('/');
    
    // Sign up for account
    await page.click('[data-testid="signup-button"]');
    // ... authentication flow
    
    // Navigate to subscription
    await page.click('[data-testid="subscription-portal"]');
    
    // Complete Stripe checkout (test mode)
    // ... checkout flow
    
    // Verify subscription status
    await expect(page.locator('[data-testid="subscription-status"]'))
      .toContainText('COMMUNITY');
  });
});
```

### Deployment Architecture

#### Vercel Configuration

```json
// vercel.json
{
  "framework": "nextjs",
  "buildCommand": "pnpm build",
  "devCommand": "pnpm dev",
  "installCommand": "pnpm install",
  "functions": {
    "src/app/api/**/*.ts": {
      "maxDuration": 30
    }
  },
  "env": {
    "DATABASE_URL": "@database-url",
    "CLERK_SECRET_KEY": "@clerk-secret-key",
    "STRIPE_SECRET_KEY": "@stripe-secret-key",
    "DISCORD_CLIENT_SECRET": "@discord-client-secret",
    "REDIS_URL": "@redis-url"
  },
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        {
          "key": "X-Content-Type-Options",
          "value": "nosniff"
        },
        {
          "key": "X-Frame-Options",
          "value": "DENY"
        },
        {
          "key": "X-XSS-Protection",
          "value": "1; mode=block"
        }
      ]
    }
  ]
}
```

#### Environment Strategy

| Environment | Purpose | Deployment | Database | Features |
|-------------|---------|------------|----------|-----------|
| **Development** | Local development | `pnpm dev` | Local MySQL | All features enabled |
| **Preview** | PR previews | Auto-deploy | Staging DB | Feature flags controlled |
| **Staging** | Pre-production testing | Manual deploy | Staging DB | Production-like config |
| **Production** | Live environment | Auto-deploy main | Production DB | Full compliance enabled |

#### Deployment Pipeline

```mermaid
graph LR
    DEV[Local Development] --> PR[Pull Request]
    PR --> PREVIEW[Vercel Preview]
    PREVIEW --> REVIEW[Code Review]
    REVIEW --> MERGE[Merge to Main]
    MERGE --> STAGING[Staging Deploy]
    STAGING --> TEST[E2E Testing]
    TEST --> PROD[Production Deploy]
    
    PROD --> MONITOR[Monitoring]
    MONITOR --> ALERTS[Error Alerts]
```

#### Continuous Integration

```yaml
# .github/workflows/ci.yml
name: CI/CD Pipeline

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '18'
          cache: 'pnpm'
      
      - name: Install dependencies
        run: pnpm install
      
      - name: Type check
        run: pnpm type-check
      
      - name: Lint
        run: pnpm lint
      
      - name: Unit tests
        run: pnpm test
      
      - name: E2E tests
        run: pnpm test:e2e
        env:
          DATABASE_URL: ${{ secrets.TEST_DATABASE_URL }}

  deploy:
    needs: test
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Deploy to Vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args: '--prod'
```

### Monitoring and Maintenance

#### Error Tracking

```typescript
// src/lib/monitoring.ts
import { captureException } from '@sentry/nextjs';

export const handleError = (error: Error, context?: Record<string, any>) => {
  console.error('Application Error:', error, context);
  
  if (process.env.NODE_ENV === 'production') {
    captureException(error, {
      tags: { component: context?.component },
      extra: context,
    });
  }
};
```

#### Health Checks

```typescript
// src/app/api/health/route.ts
export async function GET() {
  try {
    // Check database connection
    await prisma.$queryRaw`SELECT 1`;
    
    // Check Redis connection
    await redis.ping();
    
    return Response.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        redis: 'connected'
      }
    });
  } catch (error) {
    return Response.json({
      status: 'unhealthy',
      error: error.message
    }, { status: 500 });
  }
}
```

#### Performance Monitoring

```typescript
// src/lib/analytics.ts
export const trackPerformance = (metric: string, value: number) => {
  if (typeof window !== 'undefined') {
    // Track Core Web Vitals
    const navigation = performance.getEntriesByType('navigation')[0];
    
    // Send to analytics service
    fetch('/api/analytics/performance', {
      method: 'POST',
      body: JSON.stringify({
        metric,
        value,
        timestamp: Date.now(),
        url: window.location.pathname
      })
    });
  }
};
```

### Team Collaboration

#### Development Guidelines

1. **Branch Strategy**: Feature branches from `develop`, merge to `main` for production
2. **Commit Messages**: Conventional commits format (`feat:`, `fix:`, `docs:`, etc.)
3. **Code Reviews**: Required for all changes, focus on compliance and security
4. **Documentation**: Update architecture docs for any structural changes

#### AI Agent Guidelines

1. **Follow established patterns** - Don't deviate from component template contracts
2. **Server-authoritative access** - Never implement client-side access control
3. **Type-first development** - Define interfaces before implementation
4. **Test coverage** - Minimum 80% coverage for new features
5. **Compliance first** - All analytical content requires compliance wrappers

---

## Key Architectural Decisions

### 1. Simplified Scope Focus
- **Website-only architecture** - No sports data processing in this repository
- **Discord-centric delivery** - All analytics delivered via external Discord integration
- **SaaS marketing focus** - Optimized for conversion and subscription management

### 2. AI Development Optimization
- **Type safety everywhere** - End-to-end TypeScript prevents runtime errors
- **Consistent patterns** - T3 Stack provides predictable development patterns
- **Explicit specifications** - All APIs, data models, and components fully documented

### 3. Business Model Support
- **Tiered access system** - FREE → COMMUNITY → PROFESSIONAL progression
- **Discord community gating** - Subscription verification for Discord server access
- **Stripe-native subscription management** - Industry-standard billing integration

### 4. Scalability & Performance
- **Serverless-first architecture** - Auto-scaling with zero server management
- **Edge caching** - Global content delivery via Vercel CDN
- **Database optimization** - PlanetScale serverless MySQL for efficient queries

---

## Next Steps

This architecture document provides the complete foundation for AI-driven development of the Cheddar Logic brand website. The next phase involves:

1. **Component Architecture** - Define React component patterns and organization
2. **Frontend Implementation** - Create specific component templates for AI agents
3. **Database Schema** - Transform data models into Prisma schema
4. **Project Structure** - Define exact file organization for the codebase
5. **Development Workflow** - Establish local development and deployment procedures

The architecture is optimized for AI agent implementation with clear patterns, explicit typing, and comprehensive documentation of all integration points.