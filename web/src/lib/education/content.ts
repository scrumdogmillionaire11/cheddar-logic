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
      'Most bettors are playing the wrong game. They\'re trying to be right today. Sharp bettors are trying to be profitable over 1,000 bets. That shift—from certainty to probability—is everything.',
    sections: [
      {
        title: 'What This Actually Means',
        paragraphs: [
          'There are no "locks." There are only outcomes with different probabilities and prices that are good or bad relative to those probabilities.',
          'A bet isn\'t "Will this team win?" It\'s "Is this priced wrong given the likelihood of outcomes?"',
        ],
      },
      {
        title: 'Core Principle',
        paragraphs: [
          'The goal is not being right every time. The goal is making better decisions than baseline over a large sample.',
          'If you consistently take 55% edges at -110, you win long term. If you chase 50/50 coin flips at bad prices, you lose—no matter how "sharp" your reads feel.',
        ],
      },
      {
        title: 'Every Bet Is a Distribution, Not a Prediction',
        paragraphs: [
          'Instead of thinking "This team wins," think: Team A wins ~58%, Team B wins ~42%.',
          'Now compare that to the market. If the book is pricing Team A like they win 65%… that\'s a bad bet, even if they win tonight.',
        ],
      },
      {
        title: 'Treat Outcomes as Weighted, Not Binary',
        paragraphs: [
          'Bad bettors think: Win = good decision; Loss = bad decision.',
          'That\'s how you end up reinforcing terrible habits.',
          'Sharp thinking: A losing bet can be correct. A winning bet can be terrible.',
          'You\'re evaluating decision quality, not short-term results.',
        ],
      },
      {
        title: 'Use Confidence Bands',
        paragraphs: [
          'Not all edges are equal. You should mentally bucket plays like:',
        ],
        bullets: [
          'Strong Edge (Play) → Clear gap between model and market',
          'Thin Edge (Lean) → Slight advantage, more variance',
          'No Edge (Pass) → Market is efficient',
        ],
        callout:
          'If you can\'t clearly place a bet into one of these buckets… you don\'t have an edge—you have a guess.',
      },
      {
        title: 'Separate Signal From Noise',
        paragraphs: [
          'Most slates are noisy. Injuries unclear. Lines efficient. Market already adjusted.',
          'This is where most people force action.',
          'Sharp approach: If signal isn\'t strong → PASS. Volume comes from good spots, not constant betting.',
        ],
      },
      {
        title: 'Judge Process, Then Results',
        paragraphs: [
          'Short term: Anything can happen. Variance dominates.',
          'Long term: Edge shows up. Bad habits get exposed.',
          'Real questions: Did you beat the price? Was your probability estimate better than the market? Would you take that bet 100 times?',
        ],
      },
      {
        title: 'What Most Bettors Get Wrong',
        paragraphs: [
          'They overreact to short-term results. Confuse confidence with edge. Chase "being right" instead of being profitable. Bet every game instead of only mispriced ones.',
          'That\'s how you end up with high win rate and negative bankroll.',
        ],
      },
    ],
    takeawaysTitle: 'Remember',
    takeaways: [
      'Probability is not certainty—it\'s range + uncertainty',
      'Markets are often efficient—your job is to find mistakes, not outcomes',
      'The only thing you control is decision quality',
    ],
    resources: [],
  },
  {
    slug: 'understanding-expected-value',
    title: 'Understanding Expected Value',
    summary:
      'Learn how expected value helps rank options when outcomes are uncertain.',
    intro:
      'If you only take one concept seriously in betting, make it this one. Expected value (EV) is how you decide whether a bet is worth making, not whether it will win.',
    sections: [
      {
        title: 'What EV Actually Is',
        paragraphs: [
          'EV answers one question: "If I placed this same bet 1,000 times… would I make money?"',
          'It\'s a long-run average, not a prediction for tonight.',
        ],
      },
      {
        title: 'The Core Idea',
        paragraphs: [
          'Every bet has two ingredients: Probability (how often it should win) and Price (what you\'re getting paid).',
          'EV is simply comparing those two things.',
        ],
      },
      {
        title: 'Simple Example',
        paragraphs: [
          'You believe a bet wins 55% of the time. The book is pricing it like it wins 52.4% (that\'s -110).',
          'That gap = your edge. Over time, you profit from that difference, even though you\'ll still lose ~45% of the time.',
        ],
      },
      {
        title: 'What EV Is NOT',
        paragraphs: [
          'The biggest misconception: Positive EV ≠ "this will win"',
          'You can make a great EV bet and lose. You can make a terrible EV bet and win.',
          'That\'s variance doing its job.',
        ],
      },
      {
        title: 'EV Is a Long-Run Game',
        paragraphs: [
          'You don\'t "realize" EV in one bet. You realize it over 100 bets, 500 bets, 1,000+ bets.',
          'Short term = noise. Long term = signal.',
        ],
      },
      {
        title: 'Always Compare EV',
        paragraphs: [
          'Don\'t view it in isolation. Is this better than other options on the slate? Is this the best use of bankroll right now?',
          'Sometimes the correct move is: "There are no good bets today."',
        ],
      },
      {
        title: 'Small Edges Matter More Than Big Opinions',
        paragraphs: [
          'You don\'t need 70% win rates or "locks." You need consistent 2–5% edges.',
          'That\'s where real money comes from.',
        ],
      },
      {
        title: 'EV Without Discipline Is Useless',
        paragraphs: [
          'You can find edge and still lose if you bet too much on one game, stack correlated bets, or chase losses.',
          'That\'s why EV must be paired with risk control and exposure limits.',
        ],
      },
    ],
    takeawaysTitle: 'Key Takeaways',
    takeaways: [
      'EV is about process, not outcomes',
      'Good bets lose all the time',
      'Bad bets win just enough to trick you',
    ],
    outro:
      'Your job isn\'t to win today. Your job is to make decisions that would win over time.',
    resources: [],
  },
  {
    slug: 'data-sources-and-methodology',
    title: 'Data Sources and Methodology',
    summary:
      'See how source quality, freshness, and transparent logic improve trust in analytics outputs.',
    intro:
      'You can\'t build sharp outputs on bad inputs. Most betting mistakes don\'t come from bad models—they come from bad data, stale data, or misunderstood data. If the inputs are wrong, the decision is wrong.',
    sections: [
      {
        title: 'The Core Principle',
        paragraphs: [
          'Reliable decisions require reliable inputs.',
          'That means: Fresh data, Verified sources, Transparent logic.',
          'Not: "The model said so."',
        ],
      },
      {
        title: 'What Actually Matters',
        paragraphs: [
          'There are three things that determine whether your data is usable:',
        ],
      },
      {
        title: '1) Quality',
        paragraphs: [
          'Is the data accurate? Is it coming from a trusted source? Is it consistent across books / feeds?',
          'Bad examples: Mismatched odds, Missing player roles, Incorrect line assignments.',
        ],
      },
      {
        title: '2) Freshness',
        paragraphs: [
          'How recent is the data? Has anything changed since it was pulled?',
          'This is where most people get wrecked: Injury updates, Line movement, Starting lineup changes.',
          'A "good" bet 2 hours ago can be a terrible bet now.',
        ],
      },
      {
        title: '3) Context',
        paragraphs: [
          'Raw data without context is dangerous.',
          'Example: A player averages 4 shots per game… but his minutes just dropped, his role changed, his opponent suppresses volume.',
          'Same number → completely different meaning.',
        ],
      },
      {
        title: 'Check Freshness Before You Bet',
        paragraphs: [
          'Before locking anything in, ask: Are lineups confirmed? Are goalies/starters confirmed? Has the line already moved?',
          'Your system already enforces this: Unconfirmed inputs → downgrade or PASS. Missing key data → unsafe for plays.',
        ],
        callout: 'If you skip this step, you\'re betting outdated information.',
      },
      {
        title: 'Avoid Black-Box Thinking',
        paragraphs: [
          'If you can\'t explain why a play exists or what variables are driving it, you shouldn\'t trust it.',
          'Good models: Show drivers, Show assumptions, Show uncertainty.',
          'Bad models: "Trust me, it\'s a play."',
        ],
      },
      {
        title: 'Prefer Explainable Signals',
        paragraphs: [
          'Strong signals: Role (minutes, usage, TOI), Matchup dynamics, Pace / environment, Price vs projection.',
          'Not: Vague "trends", Cherry-picked stats, Narrative-based reasoning.',
        ],
      },
      {
        title: 'Document Blind Spots',
        paragraphs: [
          'Every model has weaknesses. Sharp approach: Call them out, Adjust for them, Sometimes PASS because of them.',
          'Examples: Unknown starting goalie, Player minutes uncertainty, Missing market data.',
        ],
      },
    ],
    takeawaysTitle: 'Remember',
    takeaways: [
      'Data is only useful if it\'s current, accurate, and contextualized',
      'Transparency builds trust—and better decisions',
      'Uncertainty should be visible, not hidden',
    ],
    outro:
      'It\'s better to miss a bet than to bet on bad information.',
    resources: [],
  },
];

export function getEducationArticleBySlug(
  slug: string,
): EducationArticle | undefined {
  return EDUCATION_ARTICLES.find((article) => article.slug === slug);
}
