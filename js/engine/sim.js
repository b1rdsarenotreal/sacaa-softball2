// sim.js
// Simulates a single 7-inning softball game between two full game rosters
// (a 9-player batting order + a starting pitcher with relief available).
// Every plate appearance is a real batter vs a real pitcher; the engine
// tracks a full box score (batting + pitching lines) plus fielding errors,
// pitching changes, and W/L/SV decisions.

import { pickStarterForGame, buildGameRoster } from './roster.js';

function clamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

// Ratings drive every plate appearance now (Contact/Power/Eye for batters,
// Stuff/Control/Movement for pitchers, all on a 20-80 scale, mean 50). This
// replaced an earlier stat-multiplier model that could stack multiple
// multiplicative factors and produce unrealistic blowouts against weak
// pitching staffs; sigmoid-bounded rating differentials are numerically
// stable by construction and were tuned against target league-wide rates
// (roughly: ~18% K, ~9% BB, ~.320 hit-on-contact rate, ~2-3% HR per PA at
// league-average ratings).
function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

// computeLeagueAverages is kept only so callers (postseason.js, app.js)
// don't need to change their plumbing; the ratings scale is already
// self-normalizing so it isn't used by simulatePA.
export function computeLeagueAverages(teams) {
  const n = teams.length;
  const sum = (fn) => teams.reduce((a, t) => a + fn(t), 0);
  return {
    obp: sum((t) => t.batting.obp) / n,
    avg: sum((t) => t.batting.avg) / n,
    era: sum((t) => t.pitching.era) / n,
    whip: sum((t) => t.pitching.whip) / n,
  };
}

function simulatePA(batter, pitcher, rng) {
  const br = batter.ratings;
  const pr = pitcher.ratings;

  // Strikeout: pitcher Stuff vs batter Contact.
  const kDiff = (pr.stuff - br.contact) / 10;
  const pK = clamp(sigmoid(0.32 * kDiff - 1.58), 0.06, 0.35);
  if (rng() < pK) return 'K';

  // Walk: batter Eye vs pitcher Control (conditioned on not-K).
  const eyeDiff = (br.eye - pr.control) / 10;
  const pBB = clamp(sigmoid(0.32 * eyeDiff - 2.35), 0.02, 0.18);
  if (rng() < pBB) return 'BB';

  // Ball in play: batter Contact vs pitcher Movement decides hit vs out.
  const contactDiff = (br.contact - pr.movement) / 10;
  const pHitOnBip = clamp(sigmoid(0.32 * contactDiff - 0.85), 0.18, 0.42);
  if (rng() >= pHitOnBip) return 'OUT';

  // It's a hit -- Power decides the extra-base split.
  const power = br.power;
  const pHR = clamp(0.06 + (power - 50) * 0.0035, 0.018, 0.2);
  const pTriple = 0.02;
  const pDouble = clamp(0.18 + (power - 50) * 0.003, 0.08, 0.3);
  const pSingle = clamp(1 - pHR - pTriple - pDouble, 0.4, 0.9);
  const total = pHR + pTriple + pDouble + pSingle;

  const hr = rng() * total;
  if (hr < pHR) return 'HR';
  if (hr < pHR + pTriple) return '3B';
  if (hr < pHR + pTriple + pDouble) return '2B';
  return '1B';
}

function advanceRunners(bases, event, outsBefore, rng, batter) {
  // bases holds player objects (or null), not booleans, so runs can be
  // credited to the specific runner who actually crossed the plate.
  let [b1, b2, b3] = bases;
  const scorers = [];

  switch (event) {
    case 'BB': {
      if (b1 && b2 && b3) { scorers.push(b3); b3 = b2; b2 = b1; b1 = batter; }
      else if (b1 && b2) { b3 = b2; b2 = b1; b1 = batter; }
      else if (b1) { b2 = b1; b1 = batter; }
      else { b1 = batter; }
      break;
    }
    case '1B': {
      if (b3) { scorers.push(b3); b3 = null; }
      if (b2) { if (rng() < 0.55) { scorers.push(b2); } else { b3 = b2; } b2 = null; }
      if (b1) { if (rng() < 0.35) { b3 = b1; } else { b2 = b1; } b1 = null; }
      b1 = batter;
      break;
    }
    case '2B': {
      if (b3) { scorers.push(b3); b3 = null; }
      if (b2) { scorers.push(b2); b2 = null; }
      if (b1) { if (rng() < 0.5) { scorers.push(b1); } else { b3 = b1; } b1 = null; }
      b2 = batter;
      break;
    }
    case '3B': {
      if (b3) { scorers.push(b3); b3 = null; }
      if (b2) { scorers.push(b2); b2 = null; }
      if (b1) { scorers.push(b1); b1 = null; }
      b3 = batter;
      break;
    }
    case 'HR': {
      if (b3) { scorers.push(b3); b3 = null; }
      if (b2) { scorers.push(b2); b2 = null; }
      if (b1) { scorers.push(b1); b1 = null; }
      scorers.push(batter);
      break;
    }
    case 'OUT': {
      // sac fly: runner on 3rd can score on a fly out with fewer than 2 outs
      if (b3 && outsBefore < 2 && rng() < 0.35) { scorers.push(b3); b3 = null; }
      break;
    }
    default:
      break;
  }
  return { bases: [b1, b2, b3], scorers };
}

export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RELIEF_RUN_THRESHOLD = 6; // runs allowed (in the current appearance) before the bullpen gets the call
const LINEUP_SUB_CHANCE = 0.16; // odds a given lineup slot goes to a bench player for this game

// Builds the actual 9 players used for this specific game. Each slot in the
// primary lineup has a chance to be given to a bench player instead, so a
// team's bench gets real, semi-regular usage over a season rather than never
// playing. This runs on the same seeded `rng` as everything else in the
// game, so re-simulating a game (see app.js's regenerateGameResult) always
// reproduces the exact same lineup.
function selectGameLineup(gameRoster, rng) {
  const bench = gameRoster.bench || [];
  if (bench.length === 0) return gameRoster.lineup;
  return gameRoster.lineup.map((starter) => {
    if (rng() < LINEUP_SUB_CHANCE) {
      const sub = bench[Math.floor(rng() * bench.length)];
      return { ...sub, battingOrder: starter.battingOrder, position: starter.position, starterId: starter.id };
    }
    return starter;
  });
}

function makeTeamGameState(gameRoster, rng) {
  return {
    name: gameRoster.name,
    lineup: selectGameLineup(gameRoster, rng),
    battingIndex: 0,
    fieldingPct: gameRoster.fieldingPct,
    errors: 0,
    bullpenQueue: [...gameRoster.bullpen],
    appearances: [],
    currentAppearance: null,
  };
}

function startAppearance(state, pitcher) {
  const app = { pitcher, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, decision: '' };
  state.appearances.push(app);
  state.currentAppearance = app;
  return app;
}

function initBattingBox(lineup) {
  const box = {};
  lineup.forEach((p) => {
    box[p.id] = { player: p, ab: 0, h: 0, r: 0, rbi: 0, bb: 0, k: 0, doubles: 0, triples: 0, hr: 0 };
  });
  return box;
}

// Simulates one half inning. `battingState`/`fieldingState` are the mutable
// per-team game-state objects (batting order position and pitcher usage
// persist across the whole game). Mutates `battingBox` in place.
function simulateHalfInning(battingState, fieldingState, league, rng, battingBox) {
  let outs = 0;
  let bases = [null, null, null];
  let runsThisInning = 0;
  let errorOccurred = false;

  while (outs < 3) {
    const batter = battingState.lineup[battingState.battingIndex % 9];
    battingState.battingIndex += 1;
    const appearance = fieldingState.currentAppearance;
    const pitcher = appearance.pitcher;

    const event = simulatePA(batter, pitcher, rng);
    const batBox = battingBox[batter.id];

    if (event === 'K') {
      batBox.ab += 1;
      batBox.k += 1;
      appearance.k += 1;
      outs += 1;
      appearance.outs += 1;
    } else if (event === 'OUT') {
      const errChance = clamp((1 - fieldingState.fieldingPct) * 3.2, 0.015, 0.14);
      if (rng() < errChance) {
        // Reached on error: batter is safe, no out recorded, charged as a
        // team error. Any runs after this are unearned for the pitcher.
        batBox.ab += 1;
        const adv = advanceRunners(bases, '1B', outs, rng, batter);
        bases = adv.bases;
        runsThisInning += adv.scorers.length;
        adv.scorers.forEach((s) => { battingBox[s.id].r += 1; });
        appearance.r += adv.scorers.length; // unearned -- er not incremented
        errorOccurred = true;
        fieldingState.errors += 1;
      } else {
        const adv = advanceRunners(bases, 'OUT', outs, rng, batter);
        bases = adv.bases;
        outs += 1;
        appearance.outs += 1;
        if (adv.scorers.length > 0) {
          // Sac fly: RBI for the batter, run(s) for the runner(s), no AB charged.
          runsThisInning += adv.scorers.length;
          adv.scorers.forEach((s) => { battingBox[s.id].r += 1; });
          batBox.rbi += adv.scorers.length;
          appearance.r += adv.scorers.length;
          if (!errorOccurred) appearance.er += adv.scorers.length;
        } else {
          batBox.ab += 1;
        }
      }
    } else {
      if (event === 'BB') {
        batBox.bb += 1;
        appearance.bb += 1;
      } else {
        batBox.ab += 1;
        batBox.h += 1;
        appearance.h += 1;
        if (event === '2B') batBox.doubles += 1;
        if (event === '3B') batBox.triples += 1;
        if (event === 'HR') batBox.hr += 1;
      }
      const adv = advanceRunners(bases, event, outs, rng, batter);
      bases = adv.bases;
      runsThisInning += adv.scorers.length;
      adv.scorers.forEach((s) => { battingBox[s.id].r += 1; });
      batBox.rbi += adv.scorers.length;
      appearance.r += adv.scorers.length;
      if (!errorOccurred) appearance.er += adv.scorers.length;
    }

    // Bullpen call: whoever's pitching gets pulled once they've allowed too
    // many runs IN THIS APPEARANCE; the next arm in the queue inherits a
    // clean slate. No cap on how many times this can chain, so a team can
    // burn through its whole staff in a real blowout, same as real life.
    if (
      appearance.r >= RELIEF_RUN_THRESHOLD &&
      fieldingState.bullpenQueue.length > 0
    ) {
      const reliever = fieldingState.bullpenQueue.shift();
      startAppearance(fieldingState, reliever);
    }
  }
  return { runs: runsThisInning };
}

function outsToIp(outs) {
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

function creditDecisionAppearance(state) {
  let best = state.appearances[0];
  state.appearances.forEach((a) => { if (a.outs > best.outs) best = a; });
  return best;
}

function finalizeBattingBox(box) {
  return Object.values(box).map((b) => ({
    playerId: b.player.id,
    name: b.player.name,
    class: b.player.class,
    position: b.player.position,
    battingOrder: b.player.battingOrder,
    twoWay: !!b.player.twoWay,
    ab: b.ab, h: b.h, r: b.r, rbi: b.rbi, bb: b.bb, k: b.k,
    doubles: b.doubles, triples: b.triples, hr: b.hr,
  }));
}

function finalizePitchingBox(appearances) {
  return appearances.map((a) => ({
    playerId: a.pitcher.id,
    name: a.pitcher.name,
    class: a.pitcher.class,
    role: a.pitcher.role,
    twoWay: !!a.pitcher.twoWay,
    outs: a.outs,
    ip: outsToIp(a.outs),
    h: a.h, r: a.r, er: a.er, bb: a.bb, k: a.k,
    decision: a.decision,
  }));
}

// Simulate a full game. away/home are "game rosters" (see roster.js
// buildGameRoster): { name, lineup, bench, startingPitcher, bullpen, fieldingPct }.
const MERCY_INNING = 5; // earliest inning the mercy rule can end the game
const MERCY_MARGIN = 8; // run lead required

export function simulateGame(awayGameRoster, homeGameRoster, league, seed) {
  const rng = typeof seed === 'number' ? makeRng(seed) : Math.random;

  const awayState = makeTeamGameState(awayGameRoster, rng);
  const homeState = makeTeamGameState(homeGameRoster, rng);
  startAppearance(awayState, awayGameRoster.startingPitcher);
  startAppearance(homeState, homeGameRoster.startingPitcher);

  const battingBox = {
    away: initBattingBox(awayState.lineup),
    home: initBattingBox(homeState.lineup),
  };

  const awayLine = [];
  const homeLine = [];
  let awayScore = 0;
  let homeScore = 0;
  const REGULATION = 7;
  let mercyRule = false;

  let inning = 1;
  while (true) {
    const top = simulateHalfInning(awayState, homeState, league, rng, battingBox.away);
    awayScore += top.runs;
    awayLine.push(top.runs);

    const isLastScheduled = inning >= REGULATION;
    const mercyEligible = inning >= MERCY_INNING;

    if (isLastScheduled && homeScore > awayScore) {
      homeLine.push(null);
      break;
    }
    if (mercyEligible && !isLastScheduled && homeScore - awayScore >= MERCY_MARGIN) {
      // Home is already up big after the top half -- no need to bat.
      homeLine.push(null);
      mercyRule = true;
      break;
    }

    const bottom = simulateHalfInning(homeState, awayState, league, rng, battingBox.home);
    homeScore += bottom.runs;
    homeLine.push(bottom.runs);

    if (isLastScheduled && homeScore !== awayScore) break;
    if (mercyEligible && Math.abs(homeScore - awayScore) >= MERCY_MARGIN) {
      mercyRule = true;
      break;
    }
    inning += 1;
    if (inning > 30) break; // safety valve -- see winnerSide comment below
  }

  // Under real ratings this essentially never happens (both teams would
  // need to go scoreless for 30 straight innings), but if the safety valve
  // above ever does cut off a still-tied game, don't silently hand it to
  // the home team by treating "not greater" as "home wins" -- flip a coin
  // on the same seeded rng so it's at least honest and still reproducible.
  const winnerSide = awayScore === homeScore ? (rng() < 0.5 ? 'away' : 'home') : (awayScore > homeScore ? 'away' : 'home');
  const winState = winnerSide === 'away' ? awayState : homeState;
  const loseState = winnerSide === 'away' ? homeState : awayState;

  const winApp = creditDecisionAppearance(winState);
  const loseApp = creditDecisionAppearance(loseState);
  winApp.decision = 'W';
  loseApp.decision = 'L';

  const lastWinApp = winState.appearances[winState.appearances.length - 1];
  const margin = Math.abs(awayScore - homeScore);
  if (lastWinApp !== winApp && lastWinApp.outs > 0 && margin <= 3) {
    lastWinApp.decision = 'SV';
  }

  const awayBattingFinal = finalizeBattingBox(battingBox.away);
  const homeBattingFinal = finalizeBattingBox(battingBox.home);
  const awayHits = awayBattingFinal.reduce((s, b) => s + b.h, 0);
  const homeHits = homeBattingFinal.reduce((s, b) => s + b.h, 0);

  return {
    awayScore,
    homeScore,
    awayLine,
    homeLine,
    innings: awayLine.length,
    winner: winnerSide,
    mercyRule,
    lineScore: {
      away: { r: awayScore, h: awayHits, e: awayState.errors },
      home: { r: homeScore, h: homeHits, e: homeState.errors },
    },
    boxscore: {
      away: {
        batting: awayBattingFinal,
        pitching: finalizePitchingBox(awayState.appearances),
        errors: awayState.errors,
      },
      home: {
        batting: homeBattingFinal,
        pitching: finalizePitchingBox(homeState.appearances),
        errors: homeState.errors,
      },
    },
  };
}

// Simulate a best-of-N series between two team descriptors:
// { name, roster, team } where `team` is the TEAMS_BY_NAME entry (for
// fielding pct) and `roster` is that team's full roster.js roster. Starting
// pitchers rotate through the staff by game number within the series.
export function simulateSeries(teamA, teamB, league, gamesNeeded, seed) {
  const games = [];
  let winsA = 0;
  let winsB = 0;
  let g = 0;
  while (winsA < gamesNeeded && winsB < gamesNeeded) {
    const aStarter = pickStarterForGame(teamA.roster, g);
    const bStarter = pickStarterForGame(teamB.roster, g);
    const aGameRoster = buildGameRoster(teamA.name, teamA.roster, teamA.team, aStarter);
    const bGameRoster = buildGameRoster(teamB.name, teamB.roster, teamB.team, bStarter);

    const aIsHome = g % 2 === 1 && !(g === 2);
    const result = aIsHome
      ? simulateGame(bGameRoster, aGameRoster, league, seed !== undefined ? seed + g : undefined)
      : simulateGame(aGameRoster, bGameRoster, league, seed !== undefined ? seed + g : undefined);
    const aWon = aIsHome ? result.winner === 'home' : result.winner === 'away';
    if (aWon) winsA += 1; else winsB += 1;
    games.push({ ...result, aIsHome });
    g += 1;
  }
  return { games, winner: winsA > winsB ? 'A' : 'B', winsA, winsB };
}
