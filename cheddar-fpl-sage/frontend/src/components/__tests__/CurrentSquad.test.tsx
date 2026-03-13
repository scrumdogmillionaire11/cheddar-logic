import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CurrentSquad from '@/components/CurrentSquad';

describe('CurrentSquad pitch layout', () => {
  it('renders spatial pitch rows and ordered bench from backend lineup payload', () => {
    const html = renderToStaticMarkup(
      <CurrentSquad
        title="Starting XI"
        formation="4-4-2"
        startingXI={[
          { player_id: 1, name: 'José Sá', position: 'GK', team: 'WOL', expected_pts: 4.5 },
          { player_id: 2, name: 'Virgil', position: 'DEF', team: 'LIV', expected_pts: 8.7 },
          { player_id: 3, name: 'Hill', position: 'DEF', team: 'BOU', expected_pts: 5.8 },
          { player_id: 4, name: 'Mings', position: 'DEF', team: 'AVL', expected_pts: 3.9 },
          { player_id: 5, name: 'Thiaw', position: 'DEF', team: 'MIL', expected_pts: 3.7 },
          { player_id: 6, name: 'Semenyo', position: 'MID', team: 'BOU', expected_pts: 9.5 },
          { player_id: 7, name: 'B.Fernandes', position: 'MID', team: 'MUN', expected_pts: 7.6 },
          { player_id: 8, name: 'Scott', position: 'MID', team: 'BOU', expected_pts: 4.4 },
          { player_id: 9, name: 'Szoboszlai', position: 'MID', team: 'LIV', expected_pts: 3.8 },
          { player_id: 10, name: 'João Pedro', position: 'FWD', team: 'BHA', expected_pts: 8.5 },
          { player_id: 11, name: 'Bowen', position: 'FWD', team: 'WHU', expected_pts: 5.4 },
        ]}
        bench={[
          { player_id: 12, name: 'Dewsbury-Hall', position: 'MID', team: 'CHE', expected_pts: 7.0, bench_order: 1 },
          { player_id: 13, name: 'Martinez', position: 'GK', team: 'AVL', expected_pts: 3.4, bench_order: 4 },
          { player_id: 14, name: 'Chalobah', position: 'DEF', team: 'CHE', expected_pts: 2.7, bench_order: 2 },
          { player_id: 15, name: 'Calvert-Lewin', position: 'FWD', team: 'EVE', expected_pts: 3.3, bench_order: 3 },
        ]}
        captainPlayerId={10}
        viceCaptainPlayerId={6}
      />,
    );

    expect(html).toContain('Formation: 4-4-2');
    expect(html).toContain('FWD (2)');
    expect(html).toContain('MID (4)');
    expect(html).toContain('DEF (4)');
    expect(html).toContain('GK (1)');

    const benchIdx = html.indexOf('Bench (4)');
    const dkhIdx = html.indexOf('Dewsbury-Hall');
    const chalobahIdx = html.indexOf('Chalobah');
    const calvertIdx = html.indexOf('Calvert-Lewin');
    const martinezIdx = html.indexOf('Martinez');

    expect(benchIdx).toBeGreaterThan(-1);
    expect(dkhIdx).toBeGreaterThan(benchIdx);
    expect(chalobahIdx).toBeGreaterThan(dkhIdx);
    expect(calvertIdx).toBeGreaterThan(chalobahIdx);
    expect(martinezIdx).toBeGreaterThan(calvertIdx);
  });
});
