export type EducationResourceLink = {
  label: string;
  href: string;
  external?: boolean;
};

export type EducationSection = {
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  callout?: string;
};

export type EducationArticle = {
  slug: string;
  title: string;
  summary: string;
  intro: string;
  points?: string[];
  sections?: EducationSection[];
  takeawaysTitle?: string;
  takeaways?: string[];
  outro?: string;
  resources: EducationResourceLink[];
};

// Add or edit entries here to update the full /education experience.
export const EDUCATION_ARTICLES: EducationArticle[] = [
  {
    slug: 'getting-started-fpl-analytics',
    title: 'Getting Started with FPL Analytics',
    summary:
      'Fantasy Premier League is won by probability, not vibes. Use projections and structure to make better decisions over time.',
    intro:
      'At its core, FPL analytics turns football performance data into projected points for transfers, captaincy, and chip decisions. If you want to move beyond gut feel and hype cycles, focus on forward-looking process and disciplined decision rules.',
    sections: [
      {
        title: '1) Start With Projections, Not Points',
        paragraphs: [
          "Last week's points do not matter as much as next week's expected points.",
          'A strong model projects next gameweek output plus short- and medium-term horizons so decisions are based on where points are likely to come from, not where they already came from.',
          'If you are not projecting forward, you are reacting. Reaction is usually late.',
        ],
        bullets: [
          'Next gameweek projected points',
          'Short-term horizon (next 4 GWs)',
          'Medium-term horizon (next 6 GWs)',
        ],
      },
      {
        title: '2) Minutes Are King',
        paragraphs: [
          'Expected minutes drive everything. A 90-minute player with slightly lower upside often beats a rotation-risk attacker.',
          'Before you even look at goals or assists, ask if the player will be on the pitch.',
        ],
        bullets: ['MINUTES_RISK', 'NAILED_90', 'INJURY_SHADOW'],
        callout: 'Ask first: will this player be on the pitch?',
      },
      {
        title: '3) Fixtures Matter, But Not Blindly',
        paragraphs: [
          'Fixture difficulty should be quantified, not guessed.',
          'Do not chase one green fixture. Plan runs of fixtures and check whether they align with your squad structure.',
        ],
        bullets: [
          'Attack difficulty (1-5 scale)',
          'Defense difficulty (1-5 scale)',
          'Double and blank gameweeks',
          'Short-term fixture clusters',
        ],
      },
      {
        title: '4) Tier Your Squad',
        paragraphs: [
          'Not all 15 players are equal. Tiering reveals structural weakness and tells you whether to make targeted moves or consider wildcard paths.',
          'Stop asking who scored last week. Ask where your squad is structurally weak.',
        ],
        bullets: [
          'Tier 1: Core',
          'Tier 2: Solid',
          'Tier 3: Replace Soon',
          'Tier 4: Dead Spot',
        ],
      },
      {
        title: '5) Transfers Must Beat the Hit',
        paragraphs: [
          'Taking a -4 is math, not emotion.',
          'If a hit is unlikely to return enough value over the next four gameweeks, it is usually poor process.',
        ],
        bullets: [
          'Delta next4 expected points',
          'Delta next6 expected points',
          'Structural improvements',
          'Volatility stacking',
          'No sideways transfers or hit-threshold violations',
        ],
      },
      {
        title: '6) Captaincy Is a Risk Decision',
        paragraphs: [
          'Captain is not automatically the highest raw projection.',
          'When options are close, shield. When upside clearly leads, swing. Treat captaincy as risk management.',
        ],
        bullets: [
          'Projected points',
          'Minutes security',
          'Fixture difficulty',
          'Volatility',
          'Optional effective ownership context',
        ],
      },
    ],
    takeawaysTitle: 'The Big Picture',
    takeaways: ['Project forward', 'Quantify structure', 'Enforce discipline'],
    outro:
      'If you can project next 6, identify structural weakness, respect hit thresholds, and avoid rotation traps, you will outperform recency-bias decision making over time. Data does not make you perfect. It makes you consistent, and consistency wins mini-leagues.',
    resources: [
      {
        label: 'Official FPL Rules',
        href: 'https://fantasy.premierleague.com/help/rules',
        external: true,
      },
      { label: 'FPL Landing Page', href: '/fpl' },
      { label: 'Results Dashboard', href: '/results' },
    ],
  },
  {
    slug: 'probabilistic-thinking-in-sports',
    title: 'Probabilistic Thinking in Sports',
    summary:
      'Shift from certainty-based predictions to ranges, uncertainty, and repeatable edge-seeking.',
    intro:
      'The goal is not being right every time. The goal is making better decisions than baseline over a large sample.',
    points: [
      'Treat each call as a weighted outcome, not a lock.',
      'Use confidence bands to separate strong actions from low-signal noise.',
      'Judge process first, then outcome quality over longer windows.',
    ],
    resources: [{ label: 'Educational Disclaimer', href: '/legal/disclaimer' }],
  },
  {
    slug: 'understanding-expected-value',
    title: 'Understanding Expected Value',
    summary:
      'Learn how expected value helps rank options when outcomes are uncertain.',
    intro:
      'Expected value (EV) is a long-run average concept. It supports disciplined decisions when short-term variance is unavoidable.',
    points: [
      'Positive EV does not mean guaranteed short-term wins.',
      'Compare expected value across alternatives, not in isolation.',
      'Pair EV with risk controls to avoid overexposure to correlated outcomes.',
    ],
    resources: [{ label: 'Results Dashboard', href: '/results' }],
  },
  {
    slug: 'data-sources-and-methodology',
    title: 'Data Sources and Methodology',
    summary:
      'See how source quality, freshness, and transparent logic improve trust in analytics outputs.',
    intro:
      'Reliable decisions require reliable inputs. Source validation and clear transformation rules are essential.',
    points: [
      'Check timestamp freshness and injury/news latency before finalizing decisions.',
      'Prefer explainable model drivers over black-box output when possible.',
      'Document known blind spots so uncertainty is explicit to end users.',
    ],
    resources: [{ label: 'The Cheddar Board', href: '/cards' }],
  },
];

export function getEducationArticleBySlug(
  slug: string,
): EducationArticle | undefined {
  return EDUCATION_ARTICLES.find((article) => article.slug === slug);
}
