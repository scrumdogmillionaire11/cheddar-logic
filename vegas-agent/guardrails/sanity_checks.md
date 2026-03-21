# Sanity Checks

Run before final verdict:

- Price sanity: is the quoted line current and tradable?
- Math sanity: do implied probability, edge, and EV reconcile?
- Data sanity: are required drivers present and fresh?
- Context sanity: did market move invalidate entry?
- Risk sanity: is size compatible with bankroll and slate exposure?

If any check fails, downgrade at least one level or mark `PASS`.
