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

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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

  // A couple of conferences are meant to read as genuinely the weakest in
  // the league -- even their best program shouldn't land as an Elite,
  // nationally-elite-caliber team. Cap how high a percentile teams in these
  // conferences can reach, rescaling proportionally so relative strength
  // *within* the conference is still preserved (their best team is still
  // clearly their best team -- it just tops out around "Strong" instead of
  // "Elite").
  const CAPPED_CONFERENCE_CEILING = { GNAC: 0.78, PWC: 0.78 };
  teams.forEach((t) => {
    const cap = CAPPED_CONFERENCE_CEILING[t.conference];
    if (cap === undefined) return;
    result[t.name].battingPercentile *= cap;
    result[t.name].pitchingPercentile *= cap;
  });

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

// Raw 0-1 "historical program strength" per team (average of the batting and
// pitching percentiles above), for anything that wants a continuous prestige
// value rather than a tier label -- e.g. a coaches-poll-style ranking that
// leans on brand-name reputation as well as this season's results.
export function computeProgramPrestige(teams) {
  const percentiles = computeHistoricalPercentiles(teams);
  const prestige = {};
  teams.forEach((t) => {
    const p = percentiles[t.name];
    prestige[t.name] = (p.battingPercentile + p.pitchingPercentile) / 2;
  });
  return prestige;
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

// Sorts a set of hitters into a batting order: better hitters generally bat
// higher, but jitter keeps it from being a rigid formula. `jitterAmount`
// controls how much shuffling happens -- exported so sim.js can call this
// fresh every game with a jitter that shrinks as the season goes on (an
// early-season lineup is still in flux; a late-season one has settled into
// the coach's preferred order).
export function orderBattingLineup(players, rng, jitterAmount = 13) {
  const jitterScore = (base) => base + noise(rng) * jitterAmount;
  const eyeScored = players.map((p) => ({ p, score: jitterScore(p.ratings.eye + p.ratings.contact) }));
  const leadoff = eyeScored.sort((a, b) => b.score - a.score).slice(0, 2).map((x) => x.p);
  const remaining1 = players.filter((p) => !leadoff.includes(p));
  const powerScored = remaining1.map((p) => ({ p, score: jitterScore(p.ratings.power) }));
  const heart = powerScored.sort((a, b) => b.score - a.score).slice(0, 3).map((x) => x.p);
  const remaining2 = remaining1.filter((p) => !heart.includes(p));
  const restScored = remaining2.map((p) => ({ p, score: jitterScore(p.ratings.contact) }));
  const rest = restScored.sort((a, b) => b.score - a.score).map((x) => x.p);
  return [...leadoff, ...heart, ...rest];
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

  // This is just the preseason-projected order shown on the roster page --
  // the order actually used in a given game is recomputed fresh by sim.js
  // (see orderBattingLineup / LINEUP_JITTER in sim.js).
  const lineupOrder = orderBattingLineup(starters, rng, 13);
  // Defensive position is independent of batting order -- a team's leadoff
  // hitter is just as likely to play center field as to catch. Shuffle the
  // 9 positions separately rather than assigning them by batting-order slot.
  const shuffledPositions = shuffle(POSITIONS, rng);
  const lineup = lineupOrder.map((p, i) => ({
    id: p.id,
    name: p.name,
    class: p.class,
    twoWay: p.twoWay,
    pitcherRole: p.twoWay ? p.pitcherRef.role : null,
    battingOrder: i + 1,
    position: shuffledPositions[i],
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

// Jersey numbers, 0-99. Weighted so lower/more traditionally-common numbers
// get handed out first, but every number in the range is possible.
function weightedNumberPool(rng) {
  const remaining = Array.from({ length: 100 }, (_, i) => i);
  const weights = remaining.map((n) => Math.max(1, 100 - n));
  const pool = [];
  while (remaining.length) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = rng() * total;
    let idx = 0;
    for (; idx < remaining.length - 1; idx++) {
      r -= weights[idx];
      if (r <= 0) break;
    }
    pool.push(remaining[idx]);
    remaining.splice(idx, 1);
    weights.splice(idx, 1);
  }
  return pool;
}

// Two-way players appear as separate object instances in the lineup/bench
// list and the pitching-staff list (same person, same `id`, different
// object) -- give every instance of a given id the same number.
function assignJerseyNumbers(allPlayerInstances, rng) {
  const byId = new Map();
  allPlayerInstances.forEach((p) => {
    if (!byId.has(p.id)) byId.set(p.id, []);
    byId.get(p.id).push(p);
  });
  const pool = weightedNumberPool(rng).slice(0, byId.size);
  let i = 0;
  byId.forEach((instances) => {
    const num = pool[i++];
    instances.forEach((inst) => { inst.number = num; });
  });
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
    assignJerseyNumbers([...lineup, ...bench, ...pitchers], rng);
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

const CLASS_ORDER = ['FR', 'SO', 'JR', 'SR'];
function nextClass(cls) {
  const idx = CLASS_ORDER.indexOf(cls);
  if (idx === -1 || idx >= CLASS_ORDER.length - 1) return null; // graduates
  return CLASS_ORDER[idx + 1];
}

// Advances one team's roster by a year for dynasty mode: seniors graduate,
// everyone else moves up a class, and enough new freshmen are recruited
// (talent tied to the team's historical prestige, same source as initial
// generation) to fill the vacated spots. Returning players keep their id,
// name, ratings, jersey number, and -- if they're still in the lineup --
// their defensive position; only recruits get fresh identities and get
// whatever's left. Pitching staff roles and the batting order are
// re-ranked fresh each year, since who's the ace or who leads off can
// reasonably shift as a roster turns over.
export function advanceRosterOneSeason(roster, team, talents, seed = 1) {
  const rng = mulberry32(seed);
  const usedNames = new Set([...roster.lineup, ...roster.bench, ...roster.pitchers].map((p) => p.name));
  const previousPositions = new Map(roster.lineup.map((p) => [p.id, p.position]));

  // One record per unique real player, merging hitter/pitcher
  // representations (two-way players have both).
  const byId = new Map();
  [...roster.lineup, ...roster.bench].forEach((p) => {
    if (!byId.has(p.id)) byId.set(p.id, { id: p.id, name: p.name, class: p.class, number: p.number });
    byId.get(p.id).hitterRatings = p.ratings;
  });
  roster.pitchers.forEach((p) => {
    if (!byId.has(p.id)) byId.set(p.id, { id: p.id, name: p.name, class: p.class, number: p.number });
    byId.get(p.id).pitcherRatings = p.ratings;
  });

  const returning = [];
  let graduatedHitterSlots = 0;
  let graduatedPitcherSlots = 0;
  byId.forEach((p) => {
    const nc = nextClass(p.class);
    if (nc === null) {
      if (p.pitcherRatings) graduatedPitcherSlots += 1;
      else graduatedHitterSlots += 1;
    } else {
      p.class = nc;
      returning.push(p);
    }
  });

  const recruitedHitters = [];
  for (let i = 0; i < graduatedHitterSlots; i++) {
    recruitedHitters.push({
      id: nextId(team.name), name: randomName(rng, usedNames), class: 'FR',
      hitterRatings: genHitterRatings(talents.batting, rng),
    });
  }
  const recruitedPitchers = [];
  for (let i = 0; i < graduatedPitcherSlots; i++) {
    const p = {
      id: nextId(team.name), name: randomName(rng, usedNames), class: 'FR',
      pitcherRatings: genPitcherRatings(talents.pitching, rng, 'RP'),
    };
    if (rng() < 0.15) p.hitterRatings = genHitterRatings(talents.batting, rng);
    recruitedPitchers.push(p);
  }

  // --- Pitching staff: rank the returning + recruited arms, assign roles fresh ---
  const pitcherPool = [...returning.filter((p) => p.pitcherRatings), ...recruitedPitchers];
  const pitcherComposite = (p) => p.pitcherRatings.stuff * 0.5 + p.pitcherRatings.control * 0.3 + p.pitcherRatings.movement * 0.2;
  const rankedPitchers = [...pitcherPool].sort((a, b) => pitcherComposite(b) - pitcherComposite(a));
  const pitchers = rankedPitchers.map((p, i) => ({
    id: p.id,
    name: p.name,
    class: p.class,
    twoWay: !!p.hitterRatings,
    role: i === 0 ? 'SP1' : i === 1 ? 'SP2' : i === 2 ? 'SP3' : 'RP',
    ratings: p.pitcherRatings,
  }));

  // --- Hitting pool: pure hitters (returning + recruited) plus two-way pitchers ---
  const pureHitterPool = [...returning.filter((p) => p.hitterRatings && !p.pitcherRatings), ...recruitedHitters];
  const twoWayCandidates = pitchers.filter((p) => p.twoWay).map((p) => {
    const source = pitcherPool.find((x) => x.id === p.id);
    return { id: p.id, name: p.name, class: p.class, twoWay: true, pitcherRef: p, ratings: source.hitterRatings };
  });
  const pool = [
    ...pureHitterPool.map((p) => ({ id: p.id, name: p.name, class: p.class, twoWay: false, ratings: p.hitterRatings })),
    ...twoWayCandidates,
  ];

  const composite = (p) => p.ratings.contact * 0.4 + p.ratings.power * 0.35 + p.ratings.eye * 0.25;
  const ranked = [...pool].sort((a, b) => composite(b) - composite(a));
  const starters = ranked.slice(0, 9);
  const benchPool = ranked.slice(9);

  // Positions: returning starters keep last year's spot if they're still in
  // the lineup; anyone new to the lineup takes whatever's left, shuffled.
  const claimed = new Set();
  const withPosition = [];
  const needsPosition = [];
  starters.forEach((p) => {
    const prev = previousPositions.get(p.id);
    if (prev && !claimed.has(prev)) { claimed.add(prev); withPosition.push({ ...p, position: prev }); }
    else needsPosition.push(p);
  });
  const openPositions = shuffle(POSITIONS.filter((pos) => !claimed.has(pos)), rng);
  needsPosition.forEach((p, i) => { p.position = openPositions[i]; });

  const lineupOrder = orderBattingLineup([...withPosition, ...needsPosition], rng, 13);
  const lineup = lineupOrder.map((p, i) => ({
    id: p.id, name: p.name, class: p.class, twoWay: p.twoWay,
    pitcherRole: p.twoWay ? p.pitcherRef.role : null,
    battingOrder: i + 1, position: p.position, ratings: p.ratings,
  }));

  const bench = benchPool.map((p, i) => ({
    id: p.id, name: p.name, class: p.class, twoWay: p.twoWay,
    position: BENCH_POSITIONS[i % BENCH_POSITIONS.length], ratings: p.ratings,
  }));

  // Numbers: returning players keep theirs; recruits get assigned from
  // whatever's left in the weighted (low-numbers-first) pool.
  const numbersById = new Map();
  byId.forEach((p, id) => { if (p.number !== undefined && p.number !== null) numbersById.set(id, p.number); });
  const takenNumbers = new Set(numbersById.values());
  const availablePool = weightedNumberPool(rng).filter((n) => !takenNumbers.has(n));
  let ai = 0;
  [...lineup, ...bench, ...pitchers].forEach((p) => {
    if (!numbersById.has(p.id)) numbersById.set(p.id, availablePool[ai++]);
  });
  [...lineup, ...bench, ...pitchers].forEach((p) => { p.number = numbersById.get(p.id); });

  return { lineup, bench, pitchers };
}
