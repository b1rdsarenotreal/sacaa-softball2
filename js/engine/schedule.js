// schedule.js
// Season shape:
//   Weeks 1-4  -- entirely non-conference (4-game series)
//   Weeks 5-13 -- conference round-robin (3-game series). Any team without a
//                 conference game that week (bye rotation on odd-sized
//                 conferences, or a conference whose round-robin finishes
//                 early) either plays a non-conference series that week or
//                 takes a bye outright -- decided per-matchup by BYE_CHANCE,
//                 so it's fluid rather than a fixed pattern.

const TOTAL_WEEKS = 13;
const NON_CONF_WEEKS = [1, 2, 3, 4];
const CONF_WINDOW_WEEKS = [5, 6, 7, 8, 9, 10, 11, 12, 13];
const CONF_SERIES_GAMES = 3;
const NONCONF_SERIES_GAMES = 4;
const BYE_CHANCE = 0.3; // odds an open pairing in weeks 5-13 becomes two byes instead of a series

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

// Standard circle-method round robin. Returns an array of rounds; each round
// is an array of [teamA, teamB] pairs. Odd team counts get a "BYE" pairing.
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
      if (a !== 'BYE' && b !== 'BYE') pairs.push([a, b]);
    }
    rounds.push(pairs);
    rotating = [rotating[rotating.length - 1], ...rotating.slice(0, -1)];
  }
  return rounds;
}

// Try to find a pairing partner for `team` within `pool`, preferring a team
// from a different conference (keeps "non-conference" weeks honest) but
// falling back to any available team so nobody gets stranded.
function findPartner(team, pool, used, confOf) {
  let candidate = pool.find(
    (other) => other !== team && !used.has(other) && confOf[other] !== confOf[team]
  );
  if (!candidate) {
    candidate = pool.find((other) => other !== team && !used.has(other));
  }
  return candidate || null;
}

export function generateSchedule(teams, seed = 1) {
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

  // --- Weeks 1-4: pure non-conference ---
  NON_CONF_WEEKS.forEach((week) => {
    const idx = week - 1;
    const open = shuffle(allNames, rng);
    const used = new Set();
    open.forEach((team) => {
      if (used.has(team)) return;
      const opponent = findPartner(team, open, used, confOf);
      if (!opponent) { weekPlan[team][idx] = 'BYE'; return; }
      const aHome = rng() < 0.5;
      const home = aHome ? team : opponent;
      const away = aHome ? opponent : team;
      weekPlan[home][idx] = { opponent: away, home: true, conferenceGame: false };
      weekPlan[away][idx] = { opponent: home, home: false, conferenceGame: false };
      used.add(team); used.add(opponent);
    });
  });

  // --- Weeks 5-13: conference round robin ---
  Object.entries(byConf).forEach(([conf, names]) => {
    const rounds = roundRobinPairings(names, rng);
    rounds.forEach((pairs, roundIdx) => {
      const week = CONF_WINDOW_WEEKS[roundIdx];
      if (week === undefined) return; // conference has more rounds than weeks available (shouldn't happen up to 9 teams)
      const idx = week - 1;
      pairs.forEach(([a, b], pairIdx) => {
        const aHome = (roundIdx + pairIdx) % 2 === 0;
        const home = aHome ? a : b;
        const away = aHome ? b : a;
        weekPlan[home][idx] = { opponent: away, home: true, conferenceGame: true };
        weekPlan[away][idx] = { opponent: home, home: false, conferenceGame: true };
      });
    });
  });

  // --- Weeks 5-13: fill leftover open slots (bye rotations, short conferences) ---
  CONF_WINDOW_WEEKS.forEach((week) => {
    const idx = week - 1;
    const open = shuffle(allNames.filter((name) => weekPlan[name][idx] === null), rng);
    const used = new Set();
    open.forEach((team) => {
      if (used.has(team)) return;
      const candidate = findPartner(team, open, used, confOf);
      if (!candidate) { weekPlan[team][idx] = 'BYE'; return; }
      if (rng() < BYE_CHANCE) {
        weekPlan[team][idx] = 'BYE';
        weekPlan[candidate][idx] = 'BYE';
        used.add(team); used.add(candidate);
        return;
      }
      const aHome = rng() < 0.5;
      const home = aHome ? team : candidate;
      const away = aHome ? candidate : team;
      weekPlan[home][idx] = { opponent: away, home: true, conferenceGame: false };
      weekPlan[away][idx] = { opponent: home, home: false, conferenceGame: false };
      used.add(team); used.add(candidate);
    });
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

  return { totalWeeks: TOTAL_WEEKS, games };
}
