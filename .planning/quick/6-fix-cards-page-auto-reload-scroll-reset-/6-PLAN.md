---
phase: quick-6
plan: 6
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/app/cards/page.tsx
autonomous: true
requirements:
  - CARDS-SCROLL-FIX
  - CARDS-PLAY-SUGGESTION
must_haves:
  truths:
    - "Browsing the cards page does not trigger scroll-to-top while reading"
    - "Background data refreshes happen silently without re-mounting content"
    - "Each card with plays shows a prominent Play Suggestion line (e.g. BET HOME -110)"
    - "Play Suggestion is the first and most visible thing in the plays section"
  artifacts:
    - path: "web/src/app/cards/page.tsx"
      provides: "Fixed scroll behavior + Play Suggestion UI"
      contains: "isInitialLoad"
  key_links:
    - from: "setInterval fetchGames"
      to: "setLoading(true)"
      via: "isInitialLoad ref"
      pattern: "isInitialLoad"
    - from: "Play.prediction + game.odds"
      to: "Play Suggestion string"
      via: "getPlaySuggestion helper"
      pattern: "getPlaySuggestion"
---

<objective>
Fix two regressions on the /cards page:

1. The 30-second setInterval calls setLoading(true) on every tick, forcing a full content unmount/remount that sends the user back to the top of the page.
2. Each card's play section shows tier/confidence/reasoning but buries the actionable bet direction — add a large "Play Suggestion" line (e.g. "BET HOME -110") as the first and most prominent element in each play row.

Purpose: Cards page is the primary action surface — it must be usable while browsing AND immediately tell the user what to do when a play fires.
Output: Updated web/src/app/cards/page.tsx with scroll-stable background refresh and Play Suggestion UI.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@web/src/app/cards/page.tsx
</context>

<tasks>

<task type="auto">
  <name>Task 1: Fix scroll-reset on background refresh</name>
  <files>web/src/app/cards/page.tsx</files>
  <action>
    The bug: `setLoading(true)` is called inside `fetchGames` on every invocation — both initial load and the setInterval ticks. When `loading` flips to true, the content block unmounts (`{!loading && games.length > 0 && ...}`), the DOM collapses, and scroll position resets to top.

    Fix using a `useRef` flag to distinguish initial load from background refresh:

    ```tsx
    const isInitialLoad = useRef(true);

    const fetchGames = async () => {
      try {
        if (isInitialLoad.current) {
          setLoading(true);
        }
        const response = await fetch('/api/games');
        const data: ApiResponse = await response.json();
        if (!response.ok || !data.success) {
          setError(data.error || 'Failed to fetch games');
          setGames([]);
          return;
        }
        setGames(data.data || []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setGames([]);
      } finally {
        setLoading(false);
        isInitialLoad.current = false;
      }
    };
    ```

    Also update the subtitle text from "auto-refreshes every 30 seconds" to "updates in background every 30s" to be accurate about the new silent behavior.

    Import `useRef` from react (add to existing import).
  </action>
  <verify>Load /cards, scroll down, wait 30 seconds — scroll position holds. On first load, the loading spinner still shows correctly.</verify>
  <done>Background fetches do not move the viewport. Initial load still shows the loading state.</done>
</task>

<task type="auto">
  <name>Task 2: Add prominent Play Suggestion to each play row</name>
  <files>web/src/app/cards/page.tsx</files>
  <action>
    Add a helper `getPlaySuggestion` that produces a concise bet label from a play and its game's odds:

    ```tsx
    const getPlaySuggestion = (play: Play, odds: GameData['odds']): string | null => {
      if (!odds) return null;
      if (play.prediction === 'HOME') {
        const line = formatOddsLine(odds.h2hHome);
        return `BET HOME ${line}`;
      }
      if (play.prediction === 'AWAY') {
        const line = formatOddsLine(odds.h2hAway);
        return `BET AWAY ${line}`;
      }
      // NEUTRAL = no directional suggestion
      return null;
    };
    ```

    Inside the plays map, render the suggestion FIRST (before tier/confidence badges) when it exists. Use large, bold, high-contrast text so it reads at a glance:

    ```tsx
    {plays.map((play, idx) => {
      const suggestion = getPlaySuggestion(play, game.odds);
      return (
        <div key={`${play.driverKey}-${idx}`} className="bg-white/5 rounded-md px-3 py-2">
          {suggestion && (
            <p className="text-base font-bold text-green-300 tracking-wide mb-1">
              {suggestion}
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap mb-1">
            {getTierBadge(play.tier)}
            {getPredictionBadge(play.prediction)}
            <span className="text-xs font-mono text-cloud/60">
              {Math.round(play.confidence * 100)}%
            </span>
            <span className="text-xs text-cloud/70 font-medium">
              {play.cardTitle}
            </span>
          </div>
          <p className="text-xs text-cloud/50 leading-snug">{play.reasoning}</p>
        </div>
      );
    })}
    ```

    For SUPER/BEST tier plays, make the suggestion text even more prominent by adding a stronger color and slightly larger text: use `text-lg` and `text-green-200` for SUPER, `text-base text-green-300` for BEST, `text-sm text-cloud/70` for WATCH with no suggestion styling (WATCH is informational, not a hard bet signal). Apply this conditional inside the suggestion render block.
  </action>
  <verify>On a card with plays, the first line of each play row shows "BET HOME -110" or "BET AWAY +120" (or similar) in large green text. NEUTRAL plays show no suggestion line. SUPER plays display the suggestion in slightly larger/brighter text than BEST plays.</verify>
  <done>Each play with a HOME or AWAY prediction immediately surfaces the bet direction and moneyline as the dominant visual element in the play row. NEUTRAL plays are unaffected.</done>
</task>

</tasks>

<verification>
After both tasks:
1. Open /cards in browser, scroll to middle of the list
2. Wait 30 seconds — page must NOT jump to top
3. Inspect a card with HOME or AWAY plays — first line of each play row shows the bet suggestion in green
4. Inspect a card with NEUTRAL plays — no suggestion line rendered
5. `cd web && npx tsc --noEmit` passes (no TypeScript errors)
</verification>

<success_criteria>
- Scrolling is stable during background refresh cycles
- "BET HOME -110" (or equivalent) is the first visible element in each directional play row
- NEUTRAL plays are unchanged
- No TypeScript errors
</success_criteria>

<output>
After completion, create `.planning/quick/6-fix-cards-page-auto-reload-scroll-reset-/6-SUMMARY.md` with what was changed and how it was verified.
</output>
