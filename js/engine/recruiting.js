// Recruiting: generates each year's incoming prospect class and carries it
// through three stages (Initial Interest -> Visits -> Signings) so team
// strength becomes something that's actively built, not just an unchanging
// label. A recruit's interest in a school blends geographic proximity,
// how well that program develops their specialty (hitting/pitching), and
// the program's *current* prestige -- which itself is mostly driven by how
// the team has actually been playing lately, not a fixed historical tier.
// Signed recruits are what the next season's freshmen actually are (see
// roster.js's advanceRosterOneSeason), so a team that recruits well gets
// genuinely better over time, and a team that recruits poorly slides.

import { mulberry32, randomNameForRegion, TALENT_MIN, TALENT_RANGE } from './roster.js';

// --- Geography -------------------------------------------------------
// Seven rough regions covering the league's real-world-inspired locations.
// Distance is a small integer scale (0 = same region, higher = farther);
// it's deliberately coarse -- this is flavor and a soft pull, not a hard
// recruiting-radius rule.
export const TEAM_REGIONS = {
  'Arizona': 'Arizona', 'Arizona State': 'Arizona', 'Grand Canyon': 'Arizona',
  'Nevada': 'Nevada', 'UNLV': 'Nevada',
  'Azusa Pacific': 'SoCal', 'Biola': 'SoCal', 'Cal Baptist': 'SoCal', 'Cal State Dominguez Hills': 'SoCal',
  'Cal State Fullerton': 'SoCal', 'Cal State Northridge': 'SoCal', 'Cal State San Bernardino': 'SoCal',
  'Cal State San Marcos': 'SoCal', 'Concordia': 'SoCal', 'Long Beach State': 'SoCal', 'Loyola Marymount': 'SoCal',
  'San Diego': 'SoCal', 'San Diego State': 'SoCal', 'UC Riverside': 'SoCal', 'UC San Diego': 'SoCal',
  'UC Santa Barbara': 'SoCal', 'UCLA': 'SoCal', 'Vanguard': 'SoCal',
  'California': 'BayArea', 'Cal State East Bay': 'BayArea', 'Cal State Monterey Bay': 'BayArea',
  'Dominican': 'BayArea', 'Menlo': 'BayArea', 'Saint Mary\'s': 'BayArea', 'San Francisco State': 'BayArea',
  'San Jose State': 'BayArea', 'Santa Clara': 'BayArea', 'Stanford': 'BayArea',
  'Bakersfield': 'CentralValley', 'Cal Poly': 'CentralValley', 'Cal Poly Humboldt': 'CentralValley',
  'Chico State': 'CentralValley', 'Fresno State': 'CentralValley', 'Jessup': 'CentralValley',
  'Pacific': 'CentralValley', 'Sacramento State': 'CentralValley', 'Stanislaus State': 'CentralValley',
  'UC Davis': 'CentralValley',
  'Central Washington': 'PacificNW', 'Oregon': 'PacificNW', 'Oregon State': 'PacificNW',
  'Portland State': 'PacificNW', 'Saint Martin\'s': 'PacificNW', 'Seattle': 'PacificNW',
  'Washington': 'PacificNW', 'Western Oregon': 'PacificNW', 'Western Washington': 'PacificNW',
  'Chaminade': 'Hawaii', 'Hawai\'i Pacific': 'Hawaii', 'Hawai\'i-Hilo': 'Hawaii', 'Hawaii': 'Hawaii',
};

const REGION_DISTANCE = {
  SoCal: { SoCal: 0, CentralValley: 1, BayArea: 2, Arizona: 1, Nevada: 2, PacificNW: 4, Hawaii: 4 },
  BayArea: { SoCal: 2, CentralValley: 1, BayArea: 0, Arizona: 3, Nevada: 2, PacificNW: 2, Hawaii: 4 },
  CentralValley: { SoCal: 1, CentralValley: 0, BayArea: 1, Arizona: 2, Nevada: 1, PacificNW: 3, Hawaii: 4 },
  Arizona: { SoCal: 1, CentralValley: 2, BayArea: 3, Arizona: 0, Nevada: 1, PacificNW: 4, Hawaii: 4 },
  Nevada: { SoCal: 2, CentralValley: 1, BayArea: 2, Arizona: 1, Nevada: 0, PacificNW: 3, Hawaii: 4 },
  PacificNW: { SoCal: 4, CentralValley: 3, BayArea: 2, Arizona: 4, Nevada: 3, PacificNW: 0, Hawaii: 4 },
  Hawaii: { SoCal: 4, CentralValley: 4, BayArea: 4, Arizona: 4, Nevada: 4, PacificNW: 4, Hawaii: 0 },
};

export function regionDistance(a, b) {
  return REGION_DISTANCE[a]?.[b] ?? 3;
}

const REGIONS = Object.keys(REGION_DISTANCE);

// --- Recruit generation ------------------------------------------------
// Star rating drives talent: how far above/below league-average the
// recruit's eventual ratings will be centered (see roster.js's
// starsToTalent, used when they actually sign and join a roster).
function rollStars(rng) {
  const r = rng();
  if (r < 0.04) return 5;
  if (r < 0.18) return 4;
  if (r < 0.55) return 3;
  if (r < 0.85) return 2;
  return 1;
}

export function generateRecruitClass(teams, seed, count) {
  const rng = mulberry32(seed);
  const usedNames = new Set();
  const recruits = [];
  for (let i = 0; i < count; i++) {
    const region = REGIONS[Math.floor(rng() * REGIONS.length)];
    const roll = rng();
    const specialty = roll < 0.42 ? 'hitting' : roll < 0.84 ? 'pitching' : 'twoWay';
    recruits.push({
      id: `recruit-${seed}-${i}`,
      name: randomNameForRegion(rng, usedNames, region),
      region,
      specialty,
      stars: rollStars(rng),
      interest: [], // top 5 schools after Initial Interest
      visits: [], // narrowed to 2-3 after Visits
      signedWith: null,
    });
  }
  // Best prospects first makes downstream signing order (and the
  // recruiting board's default sort) read naturally.
  recruits.sort((a, b) => b.stars - a.stars);
  return recruits;
}

// --- Interest scoring ----------------------------------------------------
// Higher is more interested. Blends proximity, fit for the recruit's
// specialty, and the program's current prestige -- weighted more heavily
// toward prestige for elite recruits (a 5-star has options and chases the
// best program that wants them; a 2-star is happy to be wanted nearby).
function interestScore(recruit, teamName, teamRegion, prestige, specialtyFit, rng) {
  const dist = regionDistance(recruit.region, teamRegion);
  const proximityScore = Math.pow(1 - dist / 4, 1.5); // steep falloff -- staying close matters a lot more than being one region over
  const prestigeWeight = 0.20 + (recruit.stars - 1) * 0.12; // 0.20 (1-star) .. 0.68 (5-star)
  const proximityWeight = 0.55 - (recruit.stars - 1) * 0.08; // 0.55 (1-star) .. 0.23 (5-star) -- most recruits stay close, elite prospects travel for the right program
  const fitWeight = 1 - prestigeWeight - proximityWeight;
  const noise = (rng() - 0.5) * 0.15; // recruiting has real unpredictability, but shouldn't drown out the other factors
  return prestigeWeight * prestige + proximityWeight * proximityScore + fitWeight * specialtyFit + noise;
}

// specialtyFit: how well a program suits this recruit's specialty, 0..1.
// talentsByTeam entries are on the 28-72 talent scale (see
// computeTeamTalents), so normalize back to 0..1 here.
function specialtyFitFor(recruit, talents) {
  const battingPct = (talents.batting - TALENT_MIN) / TALENT_RANGE;
  const pitchingPct = (talents.pitching - TALENT_MIN) / TALENT_RANGE;
  if (recruit.specialty === 'hitting') return battingPct;
  if (recruit.specialty === 'pitching') return pitchingPct;
  return (battingPct + pitchingPct) / 2;
}

// Stage 1: every recruit ranks all 56 programs and keeps the top 5 as their
// "interested in" list.
export function runInitialInterest(recruits, teams, prestigeByTeam, talentsByTeam, seed) {
  const rng = mulberry32(seed);
  recruits.forEach((r) => {
    const scored = teams.map((t) => ({
      name: t.name,
      score: interestScore(r, t.name, TEAM_REGIONS[t.name] || 'CentralValley', prestigeByTeam[t.name] ?? 0.5, specialtyFitFor(r, talentsByTeam[t.name]), rng),
    }));
    scored.sort((a, b) => b.score - a.score);
    r.interest = scored.slice(0, 5).map((s) => s.name);
  });
}

// Stage 2: narrow the 5 interested schools down to 2-3 visits. Re-scored
// with fresh noise (a recruiting visit can reorder things) and a slight
// extra bump for whichever school is playing best right now, mid-season.
export function runVisits(recruits, teams, prestigeByTeam, talentsByTeam, inSeasonFormByTeam, seed) {
  const rng = mulberry32(seed);
  const teamsByName = Object.fromEntries(teams.map((t) => [t.name, t]));
  recruits.forEach((r) => {
    const rescored = r.interest.map((name) => {
      const t = teamsByName[name];
      const base = interestScore(r, name, TEAM_REGIONS[name] || 'CentralValley', prestigeByTeam[name] ?? 0.5, specialtyFitFor(r, talentsByTeam[name]), rng);
      const formBump = (inSeasonFormByTeam[name] ?? 0.5) * 0.15;
      return { name: t.name, score: base + formBump };
    });
    rescored.sort((a, b) => b.score - a.score);
    const visitCount = r.stars >= 4 ? 3 : 2;
    r.visits = rescored.slice(0, visitCount).map((s) => s.name);
  });
}

// Stage 3: signings. Best prospects commit first (they have the leverage
// and the most competing interest), each picking their favorite remaining
// school from their visit list that still has room for their specialty.
// A recruit with no viable visit-list school left simply goes unsigned --
// not every prospect needs to land somewhere, same as real recruiting.
export function runSignings(recruits, teams, prestigeByTeam, talentsByTeam, rosterNeedsByTeam, seed) {
  const rng = mulberry32(seed);
  const teamsByName = Object.fromEntries(teams.map((t) => [t.name, t]));
  const remainingNeeds = {};
  teams.forEach((t) => {
    remainingNeeds[t.name] = { ...rosterNeedsByTeam[t.name] };
  });
  // Note: a signed two-way recruit is always placed by advanceRosterOneSeason
  // as a PITCHER-slot filler (who also happens to hit) -- never as a
  // hitter-slot filler. So for supply/demand purposes here, 'twoWay' has to
  // draw against the pitcher need too, or a team can end up "signing" more
  // players than actually get placed on the roster (their extra hitter-need
  // slots silently backfilled by random generation instead of the recruit
  // who supposedly signed for them).
  const needsSpecialty = (name, specialty) => {
    const n = remainingNeeds[name];
    if (!n) return false;
    if (specialty === 'hitting') return n.hitters > 0;
    return n.pitchers > 0; // 'pitching' and 'twoWay' both draw from the pitcher need
  };
  const fillSpecialty = (name, specialty) => {
    const n = remainingNeeds[name];
    if (specialty === 'hitting') { n.hitters -= 1; return; }
    n.pitchers -= 1; // 'pitching' and 'twoWay' both fill a pitcher slot
  };

  const order = [...recruits].sort((a, b) => b.stars - a.stars || rng() - 0.5);

  // Round 1: try the recruit's narrowed visit list first.
  order.forEach((r) => {
    const rescored = r.visits.map((name) => {
      const base = interestScore(r, name, TEAM_REGIONS[name] || 'CentralValley', prestigeByTeam[name] ?? 0.5, specialtyFitFor(r, talentsByTeam[name]), rng);
      return { name: teamsByName[name].name, score: base };
    });
    rescored.sort((a, b) => b.score - a.score);
    const pick = rescored.find((s) => needsSpecialty(s.name, r.specialty));
    if (pick) {
      r.signedWith = pick.name;
      fillSpecialty(pick.name, r.specialty);
    }
  });

  // Round 2: real recruiting doesn't end when a prospect misses their top
  // choices -- once the schools on their short list fill up, they still
  // sign somewhere. Anyone left unsigned looks at every program still
  // needing their specialty (not just their original visit list) and picks
  // the best-scoring option, so supply and demand actually clear.
  order.filter((r) => !r.signedWith).forEach((r) => {
    const openTeams = teams.filter((t) => needsSpecialty(t.name, r.specialty));
    if (openTeams.length === 0) return; // league-wide, nobody needs this specialty anymore
    const rescored = openTeams.map((t) => ({
      name: t.name,
      score: interestScore(r, t.name, TEAM_REGIONS[t.name] || 'CentralValley', prestigeByTeam[t.name] ?? 0.5, specialtyFitFor(r, talentsByTeam[t.name]), rng),
    }));
    rescored.sort((a, b) => b.score - a.score);
    r.signedWith = rescored[0].name;
    fillSpecialty(rescored[0].name, r.specialty);
  });
}
