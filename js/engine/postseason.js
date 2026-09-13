// postseason.js
// Conference tournaments (single-elim, fully rendered bracket) -> NCAA field
// selection (7 auto bids + at-large by RPI) -> Regional round (best-of-3) ->
// World Series (true 8-team double-elimination bracket). Every game is now
// simulated with real rosters, so postseason results come with full box
// scores just like the regular season.

import { simulateGame, simulateSeries } from './sim.js';
import { pickStarterForGame, buildGameRoster } from './roster.js';

function nextPowerOf2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function seedBracket(orderedTeams) {
  const size = nextPowerOf2(orderedTeams.length);
  const slots = new Array(size).fill(null);
  const seedOrder16 = [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11];
  const seedOrder8 = [1, 8, 4, 5, 2, 7, 3, 6];
  const seedOrder4 = [1, 4, 2, 3];
  const order = size === 16 ? seedOrder16 : size === 8 ? seedOrder8 : size === 4 ? seedOrder4 : [1];
  order.forEach((seedNum, slotIdx) => {
    slots[slotIdx] = orderedTeams[seedNum - 1] || null;
  });
  return slots;
}

export function roundLabel(idx, total) {
  const fromEnd = total - idx;
  if (fromEnd === 1) return 'Championship';
  if (fromEnd === 2) return 'Semifinals';
  if (fromEnd === 3) return 'Quarterfinals';
  return `Round ${idx + 1}`;
}

function runSingleElim(slots, playGame) {
  const rounds = [];
  let current = slots;
  while (current.length > 1) {
    const nextRound = [];
    const roundMatches = [];
    for (let i = 0; i < current.length; i += 2) {
      const a = current[i];
      const b = current[i + 1];
      if (a && !b) { nextRound.push(a); roundMatches.push({ a, b: null, winner: a }); continue; }
      if (b && !a) { nextRound.push(b); roundMatches.push({ a: null, b, winner: b }); continue; }
      if (!a && !b) { nextRound.push(null); roundMatches.push({ a: null, b: null, winner: null }); continue; }
      const result = playGame(a, b);
      nextRound.push(result.winner);
      roundMatches.push({ a, b, ...result });
    }
    rounds.push(roundMatches);
    current = nextRound;
  }
  return { rounds, champion: current[0] };
}

// A "descriptor" bundles what a game needs to know about a team:
// { name, roster, team, seed? }. `team` is the TEAMS_BY_NAME entry (fielding
// pct); `roster` is that team's roster.js roster.
function descriptorsFor(names, rosters, teamsByName) {
  return names.map((name, i) => ({ name, seed: i + 1, roster: rosters[name], team: teamsByName[name] }));
}

// Tracks how many elimination-bracket games each team has played, so a team
// that keeps advancing works through its rotation (SP1, then SP2, ...)
// instead of throwing the ace every single game.
function makeStarterTracker() {
  const counts = new Map();
  return (descriptor) => {
    const n = counts.get(descriptor.name) || 0;
    counts.set(descriptor.name, n + 1);
    return pickStarterForGame(descriptor.roster, n);
  };
}

export function runConferenceTournament(conferenceStandingRows, teamsByName, rosters, league, seed = 1) {
  const names = conferenceStandingRows.slice(0, 8).map((r) => r.name);
  const seeds = descriptorsFor(names, rosters, teamsByName);
  const slots = seedBracket(seeds);
  const nextStarter = makeStarterTracker();
  let g = 0;
  const { rounds, champion } = runSingleElim(slots, (a, b) => {
    const aSeed = seeds.indexOf(a);
    const bSeed = seeds.indexOf(b);
    const home = aSeed <= bSeed ? a : b;
    const away = home === a ? b : a;
    const homeGameRoster = buildGameRoster(home.name, home.roster, home.team, nextStarter(home));
    const awayGameRoster = buildGameRoster(away.name, away.roster, away.team, nextStarter(away));
    const result = simulateGame(awayGameRoster, homeGameRoster, league, seed * 1000 + g++);
    const winner = result.winner === 'home' ? home : away;
    return {
      homeScore: result.homeScore, awayScore: result.awayScore,
      innings: result.innings, awayLine: result.awayLine, homeLine: result.homeLine, mercyRule: result.mercyRule, lineScore: result.lineScore,
      winner, homeTeam: home, awayTeam: away, boxscore: result.boxscore,
    };
  });
  return { conference: conferenceStandingRows[0]?.conference, rounds, champion };
}

// Selects the 16-team national field, then seeds it 1-16.
//
// SELECTION (who gets in) stays a two-step process, same as real NCAA
// selection: each conference tournament champion gets an automatic bid,
// and the rest of the field is filled by RPI rank. One eligibility rule on
// top of that: a team with a losing overall record never makes the
// national tournament, even if it gets hot and wins its conference
// tournament -- that auto-bid is simply forfeited rather than handed to a
// sub-.500 team, and a losing record also disqualifies a team from the
// at-large pool regardless of RPI.
//
// SEEDING (the 1-16 order) is a separate step from selection, and is where
// the extra factors live: RPI is still the dominant input, blended with a
// quality-win bonus (wins over teams that finished in the final RPI top
// 10), a small bump for having won your conference tournament, strength of
// schedule (a team's opponents' win% -- already part of RPI's own formula,
// but weighted here as its own explicit factor too, same as a real
// selection committee considers it separately alongside the RPI number),
// and a head-to-head nudge for teams that beat fellow tournament teams
// during the regular season.
export function selectField(conferenceChampions, rankings, games, fieldSize = 16) {
  // Automatic bids (conference tournament champions) get in regardless of
  // overall record, same as the real NCAA -- winning your conference
  // tournament is the qualifying feat, full stop. Only at-large bids
  // require a winning record.
  const isEligible = (r) => r.wins >= r.losses;

  const autoBidNames = new Set(
    conferenceChampions
      .map((c) => c.champion?.name)
      .filter(Boolean)
  );

  const autoBids = rankings.filter((r) => autoBidNames.has(r.name));
  const atLargePool = rankings.filter((r) => !autoBidNames.has(r.name) && isEligible(r)); // already RPI-sorted
  const atLargeCount = Math.max(0, fieldSize - autoBids.length);
  const atLarge = atLargePool.slice(0, atLargeCount);
  const fieldRows = [...autoBids, ...atLarge];

  const top10Names = new Set(rankings.slice(0, 10).map((r) => r.name));
  const playedGames = games.filter((g) => g.played);

  const top10WinsFor = (name) => {
    let count = 0;
    playedGames.forEach((g) => {
      if (g.home !== name && g.away !== name) return;
      const opp = g.home === name ? g.away : g.home;
      if (!top10Names.has(opp)) return;
      const isHome = g.home === name;
      const won = isHome ? g.result.homeScore > g.result.awayScore : g.result.awayScore > g.result.homeScore;
      if (won) count += 1;
    });
    return count;
  };

  const headToHeadFor = (name, fieldNames) => {
    let w = 0; let l = 0;
    playedGames.forEach((g) => {
      if (g.home !== name && g.away !== name) return;
      const opp = g.home === name ? g.away : g.home;
      if (opp === name || !fieldNames.has(opp)) return;
      const isHome = g.home === name;
      const won = isHome ? g.result.homeScore > g.result.awayScore : g.result.awayScore > g.result.homeScore;
      if (won) w += 1; else l += 1;
    });
    return w - l;
  };

  const fieldNameSet = new Set(fieldRows.map((r) => r.name));
  const rpiVals = fieldRows.map((r) => r.rpi);
  const rpiMin = Math.min(...rpiVals);
  const rpiRange = (Math.max(...rpiVals) - rpiMin) || 1;
  const owpVals = fieldRows.map((r) => r.owp);
  const owpMin = Math.min(...owpVals);
  const owpRange = (Math.max(...owpVals) - owpMin) || 1;

  fieldRows.forEach((r) => {
    const rpiPct = (r.rpi - rpiMin) / rpiRange;
    const sosPct = (r.owp - owpMin) / owpRange; // owp = opponents' win% = strength of schedule
    const top10Wins = top10WinsFor(r.name);
    const top10Bonus = Math.min(top10Wins, 5) / 5; // quality wins matter, but cap the benefit
    const confChampBonus = autoBidNames.has(r.name) ? 1 : 0;
    const h2h = Math.max(-1, Math.min(1, headToHeadFor(r.name, fieldNameSet)));

    r.seedScore = 0.55 * rpiPct + 0.15 * top10Bonus + 0.10 * confChampBonus + 0.15 * sosPct + 0.05 * h2h;
    r.top10Wins = top10Wins;
  });

  fieldRows.sort((a, b) => b.seedScore - a.seedScore);
  fieldRows.forEach((row, i) => { row.seed = i + 1; row.berth = autoBidNames.has(row.name) ? 'Automatic' : 'At-large'; });
  return fieldRows;
}

// Regional round: best-of-3 series, standard bracket seeding.
export function runRegionals(fieldRows, teamsByName, rosters, league, seed = 1) {
  const ordered = fieldRows
    .slice()
    .sort((a, b) => a.seed - b.seed)
    .map((r) => ({ name: r.name, seed: r.seed, roster: rosters[r.name], team: teamsByName[r.name] }));
  const slots = seedBracket(ordered);
  const matchups = [];
  for (let i = 0; i < slots.length; i += 2) {
    const a = slots[i];
    const b = slots[i + 1];
    if (!a || !b) { matchups.push({ a: a || b, b: null, winner: a || b, games: [] }); continue; }
    const seriesResult = simulateSeries(a, b, league, 2, seed * 2000 + i);
    const winner = seriesResult.winner === 'A' ? a : b;
    matchups.push({ a, b, winner, games: seriesResult.games, winsA: seriesResult.winsA, winsB: seriesResult.winsB });
  }
  return matchups;
}

// True 8-team double-elimination World Series. `entrants` are descriptors
// (with `.seed` from the regional round, lower = better).
// Just the World Series' Round 1 pairing (seed 1v8, 4v5, 2v7, 3v6), with no
// games played -- for a "here's the bracket" reveal moment before actually
// simulating it. Uses the same seeding as runWorldSeries so the real thing
// matches this preview exactly once it's played.
export function previewWorldSeriesRound1(entrants) {
  const ordered = entrants.slice().sort((a, b) => a.seed - b.seed);
  const slots = seedBracket(ordered);
  const matchups = [];
  for (let i = 0; i < slots.length; i += 2) {
    const a = slots[i];
    const b = slots[i + 1];
    matchups.push({ a, b, winner: null });
  }
  return matchups;
}

export function runWorldSeries(entrants, league, seed = 1) {
  const ordered = entrants.slice().sort((a, b) => a.seed - b.seed);
  const wb1Slots = seedBracket(ordered);
  const nextStarter = makeStarterTracker();

  let g = 0;
  function playSingle(a, b) {
    const home = a.seed <= b.seed ? a : b;
    const away = home === a ? b : a;
    const homeGameRoster = buildGameRoster(home.name, home.roster, home.team, nextStarter(home));
    const awayGameRoster = buildGameRoster(away.name, away.roster, away.team, nextStarter(away));
    const result = simulateGame(awayGameRoster, homeGameRoster, league, seed * 5000 + g++);
    const winner = result.winner === 'home' ? home : away;
    const loser = winner === home ? away : home;
    return {
      a, b, homeTeam: home, awayTeam: away,
      homeScore: result.homeScore, awayScore: result.awayScore,
      innings: result.innings, awayLine: result.awayLine, homeLine: result.homeLine, mercyRule: result.mercyRule, lineScore: result.lineScore,
      winner, loser, boxscore: result.boxscore,
    };
  }

  const wb1 = [];
  for (let i = 0; i < wb1Slots.length; i += 2) wb1.push(playSingle(wb1Slots[i], wb1Slots[i + 1]));
  const wb1Winners = wb1.map((m) => m.winner);
  const wb1Losers = wb1.map((m) => m.loser);

  const wb2 = [];
  for (let i = 0; i < wb1Winners.length; i += 2) wb2.push(playSingle(wb1Winners[i], wb1Winners[i + 1]));
  const wb2Winners = wb2.map((m) => m.winner);
  const wb2Losers = wb2.map((m) => m.loser);

  const wb3 = [playSingle(wb2Winners[0], wb2Winners[1])];
  const wbChampion = wb3[0].winner;
  const wb3Loser = wb3[0].loser;

  const lb1 = [];
  for (let i = 0; i < wb1Losers.length; i += 2) lb1.push(playSingle(wb1Losers[i], wb1Losers[i + 1]));
  const lb1Winners = lb1.map((m) => m.winner);

  const lb2 = [];
  for (let i = 0; i < lb1Winners.length; i++) lb2.push(playSingle(lb1Winners[i], wb2Losers[i]));
  const lb2Winners = lb2.map((m) => m.winner);

  const lb3 = [playSingle(lb2Winners[0], lb2Winners[1])];
  const lb3Winner = lb3[0].winner;

  const lb4 = [playSingle(lb3Winner, wb3Loser)];
  const lbChampion = lb4[0].winner;

  const gf1 = playSingle(wbChampion, lbChampion);
  let champion;
  let gf2 = null;
  if (gf1.winner === wbChampion) {
    champion = wbChampion;
  } else {
    gf2 = playSingle(wbChampion, lbChampion);
    champion = gf2.winner;
  }

  return {
    winnersBracket: [wb1, wb2, wb3],
    losersBracket: [lb1, lb2, lb3, lb4],
    grandFinal: { game1: gf1, game2: gf2 },
    champion,
  };
}
