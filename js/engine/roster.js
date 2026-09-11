// roster.js
// Generates a 25-man roster per team: ~16-18 position players and ~7-9
// pitchers (fluid, always summing to 25), plus 0-2 "two-way" pitchers who
// also hit and can crack the starting lineup. Every player is built from
// RATINGS (20-80 scouting scale, mean 50) rather than raw stat lines --
// Contact/Power/Eye for hitters, Stuff/Control/Movement for pitchers -- and
// the sim engine (sim.js) turns those ratings directly into plate-appearance
// outcomes. Ratings are anchored to each team's real batting/pitching
// quality (from teams.json) so team strength is preserved, with individual
// variance layered on top.

const FIRST_NAMES = [
  'Maddie', 'Sophia', 'Ava', 'Riley', 'Emma', 'Olivia', 'Mia', 'Grace',
  'Harper', 'Ella', 'Chloe', 'Layla', 'Zoe', 'Lily', 'Addison', 'Aubrey',
  'Kayla', 'Jasmine', 'Peyton', 'Morgan', 'Taylor', 'Reagan', 'Jordyn',
  'Kennedy', 'Brooklyn', 'Alexis', 'Mackenzie', 'Sydney', 'Hailey', 'Paige',
  'Savannah', 'Bailey', 'Gabby', 'Nataly', 'Camila', 'Valentina', 'Jocelyn',
  'Makena', 'Kiana', 'Leilani', 'Skyler', 'Presley', 'Delaney', 'Josie',
  'Marley', 'Finley', 'Quinn', 'Rowan', 'Elena', 'Isabela',
  'Abigail', 'Amelia', 'Aria', 'Aubree', 'Audrey', 'Autumn',
  'Avery', 'Bella', 'Brielle', 'Brooke', 'Cadence', 'Cali', 'Cameron',
  'Charlotte', 'Claire', 'Cora', 'Daisy', 'Dakota', 'Danielle', 'Diana',
  'Eden', 'Eliana', 'Elise', 'Eloise', 'Emery', 'Evelyn', 'Everly',
  'Faith', 'Fiona', 'Gemma', 'Genevieve', 'Georgia', 'Gianna', 'Haley',
  'Hannah', 'Hazel', 'Isabella', 'Ivy', 'Jade', 'Jenna', 'Jordan',
  'Journey', 'Julia', 'Juliette', 'Kate', 'Katelyn', 'Keira', 'Kinsley',
  'Kylie', 'Lauren', 'Leah', 'Lena', 'Lexi', 'Liliana', 'London',
  'Lucy', 'Luna', 'Madeline', 'Madison', 'Maeve', 'Maggie', 'Malia',
  'Maya', 'Mckenna', 'Melanie', 'Mikayla', 'Natalie', 'Nevaeh', 'Nia',
  'Nicole', 'Nora', 'Norah', 'Paisley', 'Payton', 'Penelope', 'Piper',
  'Raelyn', 'Rebecca', 'Reese', 'Ruby', 'Ryleigh', 'Sadie', 'Samantha',
  'Sarah', 'Scarlett', 'Sienna', 'Skylar', 'Stella', 'Stevie', 'Summer',
  'Sutton', 'Tessa', 'Trinity', 'Vanessa', 'Victoria', 'Violet', 'Willa',
  'Willow', 'Yesenia', 'Zara', 'Alani', 'Analia', 'Anaya', 'Araceli',
  'Ashlyn', 'Bianca', 'Carmen', 'Catalina', 'Celeste', 'Dulce', 'Esperanza',
  'Fatima', 'Gabriela', 'Giselle', 'Guadalupe', 'Ines', 'Itzel', 'Jimena',
  'Kalani', 'Kamea', 'Keanu', 'Lani', 'Luz', 'Maritza', 'Marisol',
  'Micaela', 'Mireya', 'Moana', 'Nalani', 'Naomi', 'Noelani', 'Paloma',
  'Renata', 'Rosa', 'Sofia', 'Ximena', 'Yolanda', 'Yuki', 'Aiko',
  'Akemi', 'Emiko', 'Hana', 'Haruka', 'Kaori', 'Mei', 'Nari', 'Suki',
  'Yuna', 'Yumi', 'Haeun', 'Jia', 'Mina', 'Seoyeon', 'Sooah',
];

const LAST_NAMES = [
  'Nguyen', 'Garcia', 'Martinez', 'Johnson', 'Kim', 'Smith', 'Brown',
  'Rodriguez', 'Lopez', 'Hernandez', 'Young', 'Torres', 'Flores', 'Reyes',
  'Alvarez', 'Castillo', 'Ortiz', 'Ramirez', 'Chavez', 'Delgado', 'Vasquez',
  'Silva', 'Cabrera', 'Navarro', 'Salazar', 'Mendoza', 'Park', 'Choi',
  'Tanaka', 'Watanabe', 'Fonoti', 'Tuilagi', 'Mahelona', 'Pak', 'Ford',
  'Collins', 'Bennett', 'Foster', 'Coleman', 'Hayes', 'Sullivan', 'Ramos',
  'Cruz', 'Bishop', 'Mercer', 'Whitfield', 'Callahan', 'Donovan', 'Harmon',
  'Ellison',
  'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin', 'Thompson',
  'Robinson', 'Clark', 'Lewis', 'Walker', 'Hall', 'Allen', 'King', 'Wright',
  'Scott', 'Green', 'Baker', 'Adams', 'Nelson', 'Carter', 'Mitchell',
  'Perez', 'Roberts', 'Turner', 'Phillips', 'Campbell', 'Parker', 'Evans',
  'Edwards', 'Stewart', 'Morris', 'Rogers', 'Reed', 'Cook', 'Morgan',
  'Bell', 'Murphy', 'Bailey', 'Rivera', 'Cooper', 'Richardson', 'Cox',
  'Howard', 'Ward', 'Peterson', 'Gray', 'James', 'Watson', 'Brooks',
  'Kelly', 'Sanders', 'Price', 'Bennett', 'Wood', 'Barnes', 'Ross',
  'Henderson', 'Coleman', 'Jenkins', 'Perry', 'Powell', 'Long', 'Patterson',
  'Hughes', 'Flores', 'Washington', 'Butler', 'Simmons', 'Foster', 'Gonzales',
  'Bryant', 'Alexander', 'Russell', 'Griffin', 'Diaz', 'Hayes', 'Myers',
  'Ford', 'Hamilton', 'Graham', 'Sullivan', 'Wallace', 'Woods', 'Cole',
  'West', 'Jordan', 'Owens', 'Reynolds', 'Fisher', 'Ellis', 'Harrison',
  'Gibson', 'Mcdonald', 'Cruz', 'Marshall', 'Ortiz', 'Gomez', 'Murray',
  'Freeman', 'Wells', 'Webb', 'Simpson', 'Stevens', 'Tucker', 'Porter',
  'Hunter', 'Hicks', 'Crawford', 'Henry', 'Boyd', 'Mason', 'Morales',
  'Kennedy', 'Warren', 'Dixon', 'Ramos', 'Reyes', 'Burns', 'Gordon',
  'Shaw', 'Holmes', 'Rice', 'Robertson', 'Hunt', 'Black', 'Daniels',
  'Palmer', 'Mills', 'Nichols', 'Grant', 'Knight', 'Ferguson', 'Rose',
  'Stone', 'Hawkins', 'Dunn', 'Perkins', 'Hudson', 'Spencer', 'Gardner',
  'Stephens', 'Payne', 'Pierce', 'Berry', 'Matthews', 'Arnold', 'Wagner',
  'Willis', 'Ray', 'Watkins', 'Olson', 'Carroll', 'Duncan', 'Snyder',
  'Hart', 'Cunningham', 'Bradley', 'Lane', 'Andrews', 'Ruiz', 'Harper',
  'Fox', 'Riley', 'Armstrong', 'Carpenter', 'Weaver', 'Greene', 'Lawrence',
  'Elliott', 'Chavez', 'Sims', 'Austin', 'Peters', 'Kelley', 'Franklin',
  'Lawson', 'Fields', 'Gutierrez', 'Ryan', 'Schmidt', 'Carr', 'Vasquez',
  'Castillo', 'Wheeler', 'Chapman', 'Oliver', 'Montgomery', 'Richards',
  'Williamson', 'Johnston', 'Banks', 'Meyer', 'Bishop', 'Mccoy', 'Howell',
  'Alvarez', 'Morrison', 'Hansen', 'Fernandez', 'Garza', 'Harvey', 'Little',
  'Burton', 'Stanley', 'Nguyen', 'George', 'Jacobs', 'Reid', 'Kim', 'Fuller',
  'Lynch', 'Dean', 'Gilbert', 'Garrett', 'Romero', 'Welch', 'Larson',
  'Frazier', 'Burke', 'Hanson', 'Day', 'Mendoza', 'Moreno', 'Bowman',
  'Medina', 'Fowler', 'Brewer', 'Hoffman', 'Carlson', 'Silva', 'Pearson',
  'Holland', 'Douglas', 'Fleming', 'Jensen', 'Vargas', 'Byrd', 'Davidson',
  'Hopkins', 'May', 'Terry', 'Herrera', 'Wade', 'Soto', 'Walters',
  'Curtis', 'Neal', 'Caldwell', 'Lowe', 'Jennings', 'Barnett', 'Graves',
  'Jimenez', 'Horton', 'Shelton', 'Barrett', 'Obrien', 'Castro', 'Sutton',
  'Gregory', 'Mckinney', 'Lucas', 'Miles', 'Craig', 'Rodriquez', 'Chambers',
  'Holt', 'Lambert', 'Fletcher', 'Watts', 'Bates', 'Hale', 'Rhodes',
  'Pena', 'Beck', 'Newman', 'Haynes', 'Mcdaniel', 'Mendez', 'Bush',
  'Vaughn', 'Parks', 'Dawson', 'Santiago', 'Norris', 'Hardy', 'Love',
  'Steele', 'Curry', 'Powers', 'Schultz', 'Barker', 'Guzman', 'Page',
  'Munoz', 'Ball', 'Keller', 'Chandler', 'Weber', 'Leonard', 'Walsh',
  'Lyons', 'Ramsey', 'Wolfe', 'Schneider', 'Mullins', 'Benson', 'Sharp',
  'Bowen', 'Daniel', 'Barber', 'Cummings', 'Hines', 'Baldwin', 'Griffith',
  'Valdez', 'Hubbard', 'Salazar', 'Reeves', 'Warner', 'Stevenson', 'Burgess',
  'Santos', 'Tate', 'Cross', 'Garner', 'Mann', 'Mack', 'Moss', 'Thornton',
  'Dennis', 'Mcgee', 'Farmer', 'Delgado', 'Aguilar', 'Vega', 'Glover',
  'Manning', 'Cohen', 'Harmon', 'Rodgers', 'Robbins', 'Newton', 'Todd',
  'Blair', 'Higgins', 'Ingram', 'Reese', 'Cannon', 'Strickland', 'Townsend',
  'Potter', 'Goodwin', 'Walton', 'Rowe', 'Hampton', 'Ortega', 'Patton',
  'Swanson', 'Joseph', 'Francis', 'Goodman', 'Maldonado', 'Yates', 'Becker',
  'Erickson', 'Hoffman', 'Meyer', 'Hansen', 'Klein', 'Kirk', 'Osborne',
  'Whitfield', 'Callahan', 'Donovan', 'Ellison', 'Sinclair', 'Merritt',
  'Vance', 'Dalton', 'Pace', 'Winters', 'Zamora', 'Escobar', 'Trujillo',
  'Solis', 'Cardenas', 'Nunez', 'Contreras', 'Avila', 'Espinoza', 'Villarreal',
  'Mahoney', 'Osei', 'Adebayo', 'Okafor', 'Mensah', 'Boateng', 'Asante',
  'Suzuki', 'Sato', 'Ito', 'Yamamoto', 'Nakamura', 'Kobayashi', 'Yoshida',
  'Lee', 'Wong', 'Chen', 'Chang', 'Liu', 'Huang', 'Wu', 'Tran', 'Pham',
  'Le', 'Vo', 'Bui', 'Fonoti', 'Tuilagi', 'Mahelona', 'Tuiasosopo',
  'Faleolo', 'Iosefa', 'Kalani', 'Kahale', 'Manu', 'Tupou', 'Vaipulu',
];

const POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DP'];
const BENCH_POSITIONS = ['C', 'IF', 'IF', 'OF', 'OF', 'UTIL'];
const CLASSES = ['FR', 'SO', 'JR', 'SR'];

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Roughly bell-shaped noise centered on 0, spread about ±1.
function noise(rng) { return ((rng() + rng() + rng()) / 3 - 0.5) * 2; }

function randomName(rng, used) {
  let name;
  let guard = 0;
  do {
    const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
    const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
    name = `${first} ${last}`;
    guard += 1;
  } while (used.has(name) && guard < 30);
  used.add(name);
  return name;
}

function randomClass(rng) {
  return CLASSES[Math.floor(rng() * CLASSES.length)];
}

let playerCounter = 0;
function nextId(teamName) {
  playerCounter += 1;
  return `${teamName.replace(/\s+/g, '')}-${playerCounter}`;
}

function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
function stdev(arr) {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((x) => (x - m) ** 2))) || 1;
}

// --- Team talent baselines (20-80 scale, mean 50) -------------------------
// The imported stats (teams.json batting/pitching) are treated as a
// *historical* signal only -- which programs are traditionally strong vs.
// weak -- not as literal numbers to simulate off of. We rank every team by
// that signal and map RANK (percentile) to a talent baseline, rather than
// using the raw stat gaps between teams. This means a team's actual
// in-sim talent comes from where it falls in the league pecking order, not
// from how large an exact ERA or wOBA difference happens to be.

// Returns { [teamName]: { battingPercentile, pitchingPercentile } }, each in
// [0, 1], 1 = best in the league. Batting and pitching are ranked
// separately, so a program can be historically known for one more than the
// other, same as real programs are.
function computeHistoricalPercentiles(teams) {
  // A stat of exactly 0 almost always means "missing from the source data",
  // not "literally zero" -- a team with era:0 would otherwise read as the
  // best pitching staff ever assembled, and one with woba:0 as the worst
  // hitting team ever, producing a degenerate roster (this happened for
  // real with three teams whose source spreadsheet rows were blank). Treat
  // exact zeros as missing and fall back to the league mean before ranking.
  const meanIgnoringZero = (arr) => {
    const nonZero = arr.filter((v) => v);
    return mean(nonZero.length > 0 ? nonZero : arr);
  };
  const safe = (val, fallback) => (val ? val : fallback);

  const wobaFallback = meanIgnoringZero(teams.map((t) => t.batting.woba));
  const eraFallback = meanIgnoringZero(teams.map((t) => t.pitching.era));
  const whipFallback = meanIgnoringZero(teams.map((t) => t.pitching.whip));

  const wobas = teams.map((t) => safe(t.batting.woba, wobaFallback));
  const wobaMean = mean(wobas);
  const wobaSd = stdev(wobas);
  const eras = teams.map((t) => safe(t.pitching.era, eraFallback));
  const whips = teams.map((t) => safe(t.pitching.whip, whipFallback));
  const eraMean = mean(eras); const eraSd = stdev(eras);
  const whipMean = mean(whips); const whipSd = stdev(whips);

  const scored = teams.map((t) => {
    const woba = safe(t.batting.woba, wobaFallback);
    const era = safe(t.pitching.era, eraFallback);
    const whip = safe(t.pitching.whip, whipFallback);
    const battingZ = (woba - wobaMean) / wobaSd;
    const eraZ = (era - eraMean) / eraSd; // lower era = better = negative z is good
    const whipZ = (whip - whipMean) / whipSd;
    return { name: t.name, battingZ, pitchingZ: -(eraZ + whipZ) / 2 };
  });

  const n = teams.length;
  const result = {};
  teams.forEach((t) => { result[t.name] = {}; });
  [...scored].sort((a, b) => a.battingZ - b.battingZ)
    .forEach((s, i) => { result[s.name].battingPercentile = n > 1 ? i / (n - 1) : 0.5; });
  [...scored].sort((a, b) => a.pitchingZ - b.pitchingZ)
    .forEach((s, i) => { result[s.name].pitchingPercentile = n > 1 ? i / (n - 1) : 0.5; });
  return result;
}

const TALENT_MIN = 28;
const TALENT_RANGE = 44; // talent baseline spans TALENT_MIN..TALENT_MIN+TALENT_RANGE

export function computeTeamTalents(teams) {
  const percentiles = computeHistoricalPercentiles(teams);
  const talents = {};
  teams.forEach((t) => {
    const p = percentiles[t.name];
    talents[t.name] = {
      batting: TALENT_MIN + p.battingPercentile * TALENT_RANGE,
      pitching: TALENT_MIN + p.pitchingPercentile * TALENT_RANGE,
    };
  });
  return talents;
}

// Human label for a percentile, used for the "historically" tag shown on
// team cards -- a plain-language echo of the ranking above, not a claim
// about the current season's form.
export function tierLabel(percentile) {
  if (percentile >= 0.85) return 'Elite';
  if (percentile >= 0.65) return 'Strong';
  if (percentile >= 0.35) return 'Average';
  if (percentile >= 0.15) return 'Developing';
  return 'Rebuilding';
}

export function computeProgramTiers(teams) {
  const percentiles = computeHistoricalPercentiles(teams);
  const tiers = {};
  teams.forEach((t) => {
    const p = percentiles[t.name];
    tiers[t.name] = {
      battingTier: tierLabel(p.battingPercentile),
      pitchingTier: tierLabel(p.pitchingPercentile),
    };
  });
  return tiers;
}

function genHitterRatings(battingTalent, rng) {
  return {
    contact: Math.round(clamp(battingTalent + noise(rng) * 14, 20, 80)),
    power: Math.round(clamp(battingTalent + noise(rng) * 16, 20, 80)),
    eye: Math.round(clamp(battingTalent + noise(rng) * 14, 20, 80)),
  };
}

const PITCHER_ROLE_SHIFT = { SP1: 7, SP2: 2, SP3: -3, RP: 0 };

function genPitcherRatings(pitchingTalent, rng, role) {
  const shift = PITCHER_ROLE_SHIFT[role] ?? 0;
  const base = pitchingTalent + shift + noise(rng) * 6;
  return {
    stuff: Math.round(clamp(base + noise(rng) * 12, 20, 80)),
    control: Math.round(clamp(base + noise(rng) * 12, 20, 80)),
    movement: Math.round(clamp(base + noise(rng) * 12, 20, 80)),
  };
}

function buildPitchingStaff(team, talents, rng, usedNames) {
  const pitcherCount = 7 + Math.floor(rng() * 3); // 7, 8, or 9
  const roles = [];
  for (let i = 0; i < pitcherCount; i++) {
    if (i === 0) roles.push('SP1');
    else if (i === 1) roles.push('SP2');
    else if (i === 2) roles.push('SP3');
    else roles.push('RP');
  }
  const pitchers = roles.map((role) => ({
    id: nextId(team.name),
    name: randomName(rng, usedNames),
    class: randomClass(rng),
    role,
    twoWay: false,
    ratings: genPitcherRatings(talents.pitching, rng, role),
  }));

  // 0-2 pitchers are also hitters (two-way players).
  let twoWayBudget = 2;
  pitchers.forEach((p) => {
    if (twoWayBudget > 0 && rng() < 0.3) {
      p.twoWay = true;
      p.hitterRatings = genHitterRatings(talents.batting, rng);
      twoWayBudget -= 1;
    }
  });

  return { pitchers, hitterCount: 25 - pitcherCount };
}

function buildRosterPlayers(team, talents, hitterCount, pitchers, rng, usedNames) {
  const pureHitters = [];
  for (let i = 0; i < hitterCount; i++) {
    pureHitters.push({
      id: nextId(team.name),
      name: randomName(rng, usedNames),
      class: randomClass(rng),
      twoWay: false,
      ratings: genHitterRatings(talents.batting, rng),
    });
  }

  // Candidate pool for the 9-player starting lineup: pure hitters plus any
  // two-way pitchers, ranked by a simple overall hit-tool composite.
  const twoWayCandidates = pitchers.filter((p) => p.twoWay).map((p) => ({
    id: p.id, name: p.name, class: p.class, twoWay: true, pitcherRef: p, ratings: p.hitterRatings,
  }));
  const pool = [...pureHitters, ...twoWayCandidates];
  const composite = (p) => p.ratings.contact * 0.4 + p.ratings.power * 0.35 + p.ratings.eye * 0.25;
  const ranked = [...pool].sort((a, b) => composite(b) - composite(a));
  const starters = ranked.slice(0, 9);
  const benchPool = ranked.slice(9);

  // Build the batting order: best eye/contact leads off, best power in the
  // heart of the order, the rest fill out the bottom.
  const byEye = [...starters].sort((a, b) => (b.ratings.eye + b.ratings.contact) - (a.ratings.eye + a.ratings.contact));
  const leadoff = byEye.slice(0, 2);
  const remaining1 = starters.filter((p) => !leadoff.includes(p));
  const byPower = [...remaining1].sort((a, b) => b.ratings.power - a.ratings.power);
  const heart = byPower.slice(0, 3);
  const remaining2 = remaining1.filter((p) => !heart.includes(p));
  const rest = [...remaining2].sort((a, b) => b.ratings.contact - a.ratings.contact);

  const lineupOrder = [...leadoff, ...heart, ...rest];
  const lineup = lineupOrder.map((p, i) => ({
    id: p.id,
    name: p.name,
    class: p.class,
    twoWay: p.twoWay,
    pitcherRole: p.twoWay ? p.pitcherRef.role : null,
    battingOrder: i + 1,
    position: POSITIONS[i],
    ratings: p.ratings,
  }));

  const bench = benchPool.map((p, i) => ({
    id: p.id,
    name: p.name,
    class: p.class,
    twoWay: p.twoWay,
    position: BENCH_POSITIONS[i % BENCH_POSITIONS.length],
    ratings: p.ratings,
  }));

  return { lineup, bench };
}

export function generateRosters(teams, seed = 1) {
  const rng = mulberry32(seed);
  const talents = computeTeamTalents(teams);
  const rosters = {};
  const usedNames = new Set(); // shared across the whole league, not just one team
  teams.forEach((team) => {
    const teamTalents = talents[team.name];
    const { pitchers, hitterCount } = buildPitchingStaff(team, teamTalents, rng, usedNames);
    const { lineup, bench } = buildRosterPlayers(team, teamTalents, hitterCount, pitchers, rng, usedNames);
    rosters[team.name] = { team: team.name, lineup, bench, pitchers };
  });
  return rosters;
}

// Rotation: cycle through the starters (SP1/SP2/SP3) by game index.
export function pickStarterForGame(roster, gameIndex) {
  const starters = roster.pitchers.filter((p) => p.role.startsWith('SP'));
  return starters[gameIndex % starters.length];
}

// Package a roster + team (for fielding pct) + chosen starter into the shape
// sim.js's simulateGame expects. Bullpen is ordered so real relievers (RP)
// get the call before another starter would.
export function buildGameRoster(teamName, roster, team, startingPitcher) {
  const bullpen = roster.pitchers
    .filter((p) => p !== startingPitcher)
    .sort((a, b) => (a.role === 'RP' ? 0 : 1) - (b.role === 'RP' ? 0 : 1));
  return {
    name: teamName,
    lineup: roster.lineup,
    bench: roster.bench,
    startingPitcher,
    bullpen,
    fieldingPct: team.fielding.pct,
  };
}
