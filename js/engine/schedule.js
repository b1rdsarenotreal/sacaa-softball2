// schedule.js
// Season shape:
//   Weeks 1-4  -- entirely non-conference (4-game series)
//   Weeks 5-13 -- conference round-robin (3-game series), plus a
//                 non-conference filler series for any team whose
//                 conference finishes its round-robin early (smaller
//                 conferences don't need all 9 weeks -- see CONF_WINDOW_WEEKS).
//
// Two hard constraints hold across the WHOLE season, not just within a
// phase: no team ever faces the same opponent in more than one series
// (that's two SEPARATE match-ups, not the games within one series), and no
// team gets more than one bye week. Both are enforced by a single shared
// pairing routine (assignPairings) that every phase below calls, tracking
// global state (playedPairs, byeCounts) as it goes.

const TOTAL_WEEKS = 13;
const NON_CONF_WEEKS = [1, 2, 3, 4];
const CONF_WINDOW_WEEKS = [5, 6, 7, 8, 9, 10, 11, 12, 13];
const CONF_SERIES_GAMES = 3;
const NONCONF_SERIES_GAMES = 4;
const MAX_PAIRING_ATTEMPTS = 60;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pairKey(a, b) {
  return [a, b].sort().join('|');
}

// Standard circle-method round robin. Returns an array of rounds; each round
// is an array of [teamA, teamB] pairs. Odd team counts get a "BYE" pairing
// (only used for conference round-robins, where every team in the
// conference sits out the same designated round together -- that's the one
// bye each of those teams gets, tracked into the shared byeCounts below).
function roundRobinPairings(teamNames, rng) {
  const names = shuffle(teamNames, rng);
  const hasBye = names.length % 2 !== 0;
  if (hasBye) names.push('BYE');

  const n = names.length;
  const rounds = [];
  const fixed = names[0];
  let rotating = names.slice(1);

  for (let r = 0; r < n - 1; r++) {
    const roundTeams = [fixed, ...rotating];
    const pairs = [];
    for (let i = 0; i < n / 2; i++) {
      const a = roundTeams[i];
      const b = roundTeams[n - 1 - i];
      pairs.push([a, b]); // may include a 'BYE' entry -- caller handles it
    }
    rounds.push(pairs);
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }
  return rounds;
}

// The shared pairing routine every phase uses to fill one week for a given
// pool of teams that still need something scheduled. Guarantees (across
// repeated calls, via the passed-in shared state):
//   - no two teams are paired more than once all season (playedPairs)
//   - no team receives more than one bye all season (byeCounts)
//   - same-conference pairings are avoided when avoidSameConf is set
//     (keeps "non-conference" weeks honest, and prevents accidentally
//     pre-playing a series the conference round-robin will assign later)
// Retries the whole week with a fresh shuffle if a greedy pass paints
// itself into a corner; falls back to relaxing constraints (first the bye
// cap, then same-opponent) only if every retry still fails, so a team is
// NEVER simply left unscheduled.
function assignPairings(pool, confOf, avoidSameConf, playedPairs, byeCounts, rng) {
  const validPartner = (team, other, allowRepeat) => {
    if (other === team) return false;
    if (avoidSameConf && confOf[other] === confOf[team]) return false;
    if (!allowRepeat && playedPairs.has(pairKey(team, other))) return false;
    return true;
  };

  for (let attempt = 0; attempt < MAX_PAIRING_ATTEMPTS; attempt++) {
    const remaining = shuffle(pool, rng);
    const pairs = [];
    let ok = true;
    while (remaining.length > 0) {
      const team = remaining.shift();
      const idx = remaining.findIndex((other) => validPartner(team, other, false));
      if (idx === -1) {
        if (remaining.length === 0) {
          if (byeCounts[team] > 0) { ok = false; break; } // already used their one bye -- retry instead
          pairs.push([team, null]); // bye
          continue;
        }
        ok = false;
        break;
      }
      const partner = remaining.splice(idx, 1)[0];
      pairs.push([team, partner]);
    }
    if (ok) {
      pairs.forEach(([a, b]) => {
        if (b === null) { byeCounts[a] += 1; return; }
        playedPairs.add(pairKey(a, b));
      });
      return pairs;
    }
  }

  // Every retry hit a wall (can happen late in the season when most pairs
  // are used up) -- fall back to a single relaxed greedy pass: repeats
  // allowed before a second bye is ever handed out, so the hard bye-cap
  // constraint always wins over the soft no-repeat preference.
  const remaining = shuffle(pool, rng);
  const pairs = [];
  while (remaining.length > 0) {
    const team = remaining.shift();
    let idx = remaining.findIndex((other) => validPartner(team, other, false));
    if (idx === -1) idx = remaining.findIndex((other) => validPartner(team, other, true));
    if (idx === -1 || remaining.length === 0) {
      if (byeCounts[team] === 0) { byeCounts[team] += 1; pairs.push([team, null]); continue; }
      idx = 0; // truly last resort: pair with whoever's left, repeat or not
    }
    const partner = remaining.splice(idx, 1)[0];
    pairs.push([team, partner]);
  }
  pairs.forEach(([a, b]) => { if (b !== null) playedPairs.add(pairKey(a, b)); });
  return pairs;
}

export function generateSchedule(teams, seed = 1, previousHomeMap = {}) {
  const rng = mulberry32(seed);
  const allNames = teams.map((t) => t.name);
  const confOf = Object.fromEntries(teams.map((t) => [t.name, t.conference]));
  const byConf = {};
  teams.forEach((t) => {
    byConf[t.conference] = byConf[t.conference] || [];
    byConf[t.conference].push(t.name);
  });

  // weekPlan[teamName][weekIdx] = null (unscheduled), 'BYE', or
  // { opponent, home, conferenceGame }
  const weekPlan = {};
  allNames.forEach((name) => { weekPlan[name] = new Array(TOTAL_WEEKS).fill(null); });

  const playedPairs = new Set(); // every pairing made all season, any phase
  const byeCounts = {};
  allNames.forEach((name) => { byeCounts[name] = 0; });

  const placePairs = (pairs, week, conferenceGame, rng2) => {
    const idx = week - 1;
    pairs.forEach(([a, b]) => {
      if (b === null) { weekPlan[a][idx] = 'BYE'; return; }
      const aHome = rng2() < 0.5;
      const home = aHome ? a : b;
      const away = aHome ? b : a;
      weekPlan[home][idx] = { opponent: away, home: true, conferenceGame };
      weekPlan[away][idx] = { opponent: home, home: false, conferenceGame };
    });
  };

  // --- Weeks 1-4: pure non-conference, no repeats, no team paired with a
  // conference-mate (that matchup is reserved for the round-robin below) ---
  NON_CONF_WEEKS.forEach((week) => {
    const pairs = assignPairings(allNames, confOf, true, playedPairs, byeCounts, rng);
    placePairs(pairs, week, false, rng);
  });

  // --- Weeks 5-13: conference round robin ---
  // Conference matchups flip home/away from the previous dynasty season when
  // we know it (e.g. Arizona hosted Arizona State last year -> Arizona
  // State hosts this year); falls back to the round/pair parity heuristic
  // for a brand new season or a first-ever meeting between two teams.
  Object.entries(byConf).forEach(([conf, names]) => {
    const rounds = roundRobinPairings(names, rng);
    rounds.forEach((pairs, roundIdx) => {
      const week = CONF_WINDOW_WEEKS[roundIdx];
      if (week === undefined) return; // conference has more rounds than weeks available (shouldn't happen up to 9 teams)
      const idx = week - 1;
      pairs.forEach(([a, b], pairIdx) => {
        if (a === 'BYE' || b === 'BYE') {
          const team = a === 'BYE' ? b : a;
          weekPlan[team][idx] = 'BYE';
          byeCounts[team] += 1;
          return;
        }
        const key = pairKey(a, b);
        playedPairs.add(key);
        const lastHome = previousHomeMap[key];
        let home;
        if (lastHome === a) home = b;
        else if (lastHome === b) home = a;
        else home = (roundIdx + pairIdx) % 2 === 0 ? a : b;
        const away = home === a ? b : a;
        weekPlan[home][idx] = { opponent: away, home: true, conferenceGame: true };
        weekPlan[away][idx] = { opponent: home, home: false, conferenceGame: true };
      });
    });
  });

  // --- Weeks 5-13: fill leftover weeks for conferences whose round-robin
  // finishes early (7- and 8-team conferences don't need all 9 weeks) ---
  // with non-conference filler series, same no-repeat/one-bye guarantees.
  CONF_WINDOW_WEEKS.forEach((week) => {
    const idx = week - 1;
    const open = allNames.filter((name) => weekPlan[name][idx] === null);
    if (open.length === 0) return;
    const pairs = assignPairings(open, confOf, false, playedPairs, byeCounts, rng);
    placePairs(pairs, week, false, rng);
  });

  // --- Flatten into series, then expand into individual games ---
  const series = [];
  const seen = new Set();
  teams.forEach((t) => {
    weekPlan[t.name].forEach((slot, idx) => {
      if (!slot || slot === 'BYE' || !slot.home) return;
      const week = idx + 1;
      const key = `${week}-${t.name}-${slot.opponent}`;
      if (seen.has(key)) return;
      seen.add(key);
      series.push({
        week,
        home: t.name,
        away: slot.opponent,
        conferenceGame: slot.conferenceGame,
        games: slot.conferenceGame ? CONF_SERIES_GAMES : NONCONF_SERIES_GAMES,
      });
    });
  });

  series.sort((a, b) => a.week - b.week);

  const games = [];
  let gameId = 1;
  series.forEach((s) => {
    for (let g = 0; g < s.games; g++) {
      games.push({
        id: gameId++,
        week: s.week,
        gameOfSeries: g + 1,
        seriesLength: s.games,
        home: s.home,
        away: s.away,
        conferenceGame: s.conferenceGame,
        played: false,
        result: null,
      });
    }
  });

  return {
    totalWeeks: TOTAL_WEEKS,
    games,
    homeMap: Object.fromEntries(
      series.filter((s) => s.conferenceGame).map((s) => [pairKey(s.home, s.away), s.home])
    ),
  };
}
