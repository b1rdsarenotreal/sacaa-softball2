import { generateSchedule } from './engine/schedule.js';
import { computeLeagueAverages, simulateGame } from './engine/sim.js';
import { generateRosters, buildGameRoster, pickStarterForGame, computeProgramTiers, computeProgramPrestige } from './engine/roster.js';
import { computeStandings, standingsByConference, overallStandings } from './engine/standings.js';
import { computeRankings, top25, computeCoachesPoll, top15 } from './engine/rankings.js';
import { runConferenceTournament, selectField, runRegionals, runWorldSeries, roundLabel } from './engine/postseason.js';

const STORAGE_KEY = 'sacaa-season-v2'; // bumped from v1: roster shape changed from stat-based to ratings-based
const SCHEMA_VERSION = 2;
const LOGO_STORAGE_KEY = 'sacaa-custom-logos-v1';

// --- IndexedDB ---------------------------------------------------------
// IndexedDB instead of localStorage: its practical quota is tied to
// available disk space (effectively hundreds of MB+) rather than
// localStorage's fixed ~5-10MB per-origin cap, and it stores structured
// data directly (no JSON.stringify/parse round-trip needed). The API is
// async, so every read/write path below awaits it.
const DB_NAME = 'sacaa-db';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error('This browser does not support IndexedDB.')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const req = tx.objectStore(STORE_NAME).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// One-time migration: anything already saved under localStorage (from
// before the IndexedDB switch) gets copied over, then the old copy is
// cleared out so it stops counting against the localStorage quota.
async function migrateFromLocalStorage() {
  try {
    const oldSeason = localStorage.getItem(STORAGE_KEY);
    if (oldSeason) {
      await idbSet(STORAGE_KEY, JSON.parse(oldSeason));
      localStorage.removeItem(STORAGE_KEY);
    }
    localStorage.removeItem('sacaa-season-v1'); // even older format, no longer usable

    const oldLogos = localStorage.getItem(LOGO_STORAGE_KEY);
    if (oldLogos) {
      await idbSet(LOGO_STORAGE_KEY, JSON.parse(oldLogos));
      localStorage.removeItem(LOGO_STORAGE_KEY);
    }
  } catch (err) {
    console.error('localStorage -> IndexedDB migration failed (continuing without it):', err);
  }
}

let TEAMS = [];
let TEAMS_BY_NAME = {};
let CONFERENCES = {};
let PROGRAM_TIERS = {};
let PROGRAM_PRESTIGE = {};
let LEAGUE = null;
let state = null;
let customLogos = {};
let pendingLogoTeam = null;

async function loadCustomLogos() {
  try {
    customLogos = (await idbGet(LOGO_STORAGE_KEY)) || {};
  } catch (err) {
    console.error('Failed to load custom logos:', err);
    customLogos = {};
  }
}

async function saveCustomLogos() {
  try {
    await idbSet(LOGO_STORAGE_KEY, customLogos);
  } catch (err) {
    console.error('Failed to save logo:', err);
    alert(`Couldn't save that logo: ${(err && err.message) || err}`);
  }
}

// Reads an uploaded image file, crops it to a centered square, downsizes it
// (logos don't need to be huge), and hands back a compact PNG data URL.
function resizeImageFile(file, maxSize, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = maxSize;
      canvas.height = maxSize;
      const ctx = canvas.getContext('2d');
      const scale = Math.max(maxSize / img.width, maxSize / img.height);
      const sw = maxSize / scale;
      const sh = maxSize / scale;
      const sx = (img.width - sw) / 2;
      const sy = (img.height - sh) / 2;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, maxSize, maxSize);
      callback(canvas.toDataURL('image/png'));
    };
    img.onerror = () => alert("Couldn't read that image file.");
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function setCustomLogo(teamName, dataUrl) {
  customLogos[teamName] = dataUrl;
  await saveCustomLogos();
}

async function clearCustomLogo(teamName) {
  delete customLogos[teamName];
  await saveCustomLogos();
}

// Any already-rendered view showing badges needs a refresh after a logo
// changes (Teams grid is otherwise only rendered once for performance).
function refreshAfterLogoChange(teamName) {
  document.getElementById('teamsGrid').innerHTML = '';
  renderTeams();
  renderStandings();
  renderSchedule();
  if (document.getElementById('teamModalOverlay').classList.contains('open')) {
    openTeamModal(teamName);
  }
}

function wireLogoUpload() {
  const fileInput = document.getElementById('logoFileInput');
  document.addEventListener('click', async (e) => {
    const uploadBtn = e.target.closest('[data-upload-team]');
    if (uploadBtn) {
      pendingLogoTeam = uploadBtn.dataset.uploadTeam;
      fileInput.click();
      return;
    }
    const resetBtn = e.target.closest('[data-reset-logo-team]');
    if (resetBtn) {
      await clearCustomLogo(resetBtn.dataset.resetLogoTeam);
      refreshAfterLogoChange(resetBtn.dataset.resetLogoTeam);
    }
  });
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    fileInput.value = '';
    if (!file || !pendingLogoTeam) return;
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
    resizeImageFile(file, 160, async (dataUrl) => {
      await setCustomLogo(pendingLogoTeam, dataUrl);
      refreshAfterLogoChange(pendingLogoTeam);
    });
  });
}

async function loadTeams() {
  const [teamsRes, confRes] = await Promise.all([
    fetch('js/data/teams.json'),
    fetch('js/data/conferences.json'),
  ]);
  TEAMS = await teamsRes.json();
  CONFERENCES = await confRes.json();
  TEAMS_BY_NAME = Object.fromEntries(TEAMS.map((t) => [t.name, t]));
  PROGRAM_TIERS = computeProgramTiers(TEAMS);
  PROGRAM_PRESTIGE = computeProgramPrestige(TEAMS);
  LEAGUE = computeLeagueAverages(TEAMS);
}

function freshState(seed) {
  const schedule = generateSchedule(TEAMS, seed);
  return {
    schemaVersion: SCHEMA_VERSION,
    seed,
    totalWeeks: schedule.totalWeeks,
    currentWeek: 1,
    games: schedule.games,
    rosters: generateRosters(TEAMS, seed + 500000),
    regularSeasonComplete: false,
    postseason: null,
  };
}

// Match/bracket objects from postseason.js embed full roster + team objects
// on every participant (needed internally for simulation) plus a full box
// score per game -- none of which the UI ever reads (it only uses `.name`).
// Left in place, this duplicates a team's entire 25-player roster across
// every match it appears in, which is by far the largest thing in a saved
// season (megabytes, not the low hundreds of KB it should be) and was
// pushing some users over the browser's storage quota. Strip it before it
// ever gets rendered or saved.
function stripHeavyFieldsDeep(obj, seen = new Set()) {
  if (obj && typeof obj === 'object' && seen.has(obj)) return;
  if (Array.isArray(obj)) {
    obj.forEach((x) => stripHeavyFieldsDeep(x, seen));
  } else if (obj && typeof obj === 'object') {
    seen.add(obj);
    delete obj.roster;
    delete obj.team;
    delete obj.boxscore;
    Object.values(obj).forEach((v) => stripHeavyFieldsDeep(v, seen));
  }
}

async function saveState() {
  try {
    await idbSet(STORAGE_KEY, state);
  } catch (err) {
    console.error('Failed to save season:', err);
    throw new Error(`Failed to save: ${(err && err.message) || err}`);
  }
}

// If a saved season predates the current data shape (e.g. an older version
// of the roster/player format), silently loading it would crash the sim the
// first time it touches a field that no longer exists. Rather than let that
// happen, treat a schema mismatch the same as "no save" and start fresh.
async function loadState() {
  try {
    const parsed = await idbGet(STORAGE_KEY);
    if (!parsed) return null;
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    // A save from before the postseason-bloat fix may still be carrying full
    // roster/team/boxscore copies on every match; strip them on load too so
    // re-saving (which happens right after load) actually shrinks it.
    if (parsed.postseason) stripHeavyFieldsDeep(parsed.postseason);
    return parsed;
  } catch (err) {
    console.error('Failed to load saved season:', err);
    return null;
  }
}

async function newSeason() {
  try {
    state = freshState(Date.now() % 1000000);
    postseasonFullCache = null;
    await saveState();
    renderAll();
    setMessage('New season generated: 56 teams, 13-week schedule.');
  } catch (err) {
    console.error('New Season failed:', err);
    setMessage(`Couldn't start a new season: ${(err && err.message) || err}`);
  }
}

function gameRosterFor(teamName, gameOfSeries) {
  const roster = state.rosters[teamName];
  const team = TEAMS_BY_NAME[teamName];
  const starter = pickStarterForGame(roster, gameOfSeries - 1);
  return buildGameRoster(teamName, roster, team, starter);
}

// Regular-season box scores are NOT persisted (they'd add a lot of bulk --
// ~1,200 games x ~24 player lines each). Since the sim is fully seeded and
// deterministic, we just re-run the exact same game on demand whenever a box
// score is actually needed (e.g. opening the box score modal, or building a
// team's season stat totals). Re-simulating one game takes well under a
// millisecond, so this is effectively free.
function seasonProgressForWeek(week) {
  if (state.totalWeeks <= 1) return 1;
  return (week - 1) / (state.totalWeeks - 1);
}

function regenerateGameResult(game) {
  const homeGR = gameRosterFor(game.home, game.gameOfSeries);
  const awayGR = gameRosterFor(game.away, game.gameOfSeries);
  return simulateGame(awayGR, homeGR, LEAGUE, game.id * 7919 + state.seed, seasonProgressForWeek(game.week));
}

async function simWeek() {
  if (state.regularSeasonComplete) return;
  try {
    const week = state.currentWeek;
    const weekGames = state.games.filter((g) => g.week === week && !g.played);
    const progress = seasonProgressForWeek(week);
    weekGames.forEach((g) => {
      const homeGR = gameRosterFor(g.home, g.gameOfSeries);
      const awayGR = gameRosterFor(g.away, g.gameOfSeries);
      const r = simulateGame(awayGR, homeGR, LEAGUE, g.id * 7919 + state.seed, progress);
      g.played = true;
      g.result = { homeScore: r.homeScore, awayScore: r.awayScore, innings: r.innings, awayLine: r.awayLine, homeLine: r.homeLine, mercyRule: r.mercyRule };
    });
    if (week >= state.totalWeeks) {
      state.regularSeasonComplete = true;
    } else {
      state.currentWeek = week + 1;
    }
    await saveState();
    renderAll();
    setMessage(`Week ${week} simulated (${weekGames.length} games).`);
  } catch (err) {
    console.error('Week simulation failed:', err);
    setMessage(`Week simulation failed: ${(err && err.message) || err} — try "New Season" to reset, or check the console (F12) for details.`);
  }
}

async function simToEnd() {
  try {
    let guard = 0;
    while (!state.regularSeasonComplete && guard < 20) {
      simWeekQuiet();
      guard += 1;
    }
    await saveState();
    renderAll();
    setMessage('Regular season complete.');
  } catch (err) {
    console.error('Season simulation failed:', err);
    setMessage(`Season simulation failed: ${(err && err.message) || err} — try "New Season" to reset, or check the console (F12) for details.`);
  }
}

function simWeekQuiet() {
  const week = state.currentWeek;
  const weekGames = state.games.filter((g) => g.week === week && !g.played);
  const progress = seasonProgressForWeek(week);
  weekGames.forEach((g) => {
    const homeGR = gameRosterFor(g.home, g.gameOfSeries);
    const awayGR = gameRosterFor(g.away, g.gameOfSeries);
    const r = simulateGame(awayGR, homeGR, LEAGUE, g.id * 7919 + state.seed, progress);
    g.played = true;
    g.result = { homeScore: r.homeScore, awayScore: r.awayScore, innings: r.innings, awayLine: r.awayLine, homeLine: r.homeLine, mercyRule: r.mercyRule };
  });
  if (week >= state.totalWeeks) state.regularSeasonComplete = true;
  else state.currentWeek = week + 1;
}

function computePostseasonResult() {
  const standings = computeStandings(TEAMS, state.games);
  const byConf = standingsByConference(standings);
  const rankings = computeRankings(TEAMS, state.games);

  const conferenceTournaments = Object.entries(byConf).map(([conf, rows], i) =>
    runConferenceTournament(rows, TEAMS_BY_NAME, state.rosters, LEAGUE, state.seed + i * 17 + 3)
  );

  const field = selectField(conferenceTournaments, rankings, 16);
  const regionals = runRegionals(field, TEAMS_BY_NAME, state.rosters, LEAGUE, state.seed + 101);
  const winners = regionals.map((m) => m.winner);
  const worldSeries = runWorldSeries(winners, LEAGUE, state.seed + 202);

  return { conferenceTournaments, field, regionals, worldSeries };
}

// The full postseason (with box scores, rosters, everything) is never
// persisted -- it's fully deterministic from state.seed and state.games, and
// re-simulating the WHOLE postseason takes well under a millisecond, so we
// just regenerate it on demand whenever a box score needs to be shown and
// cache it in memory for the rest of the session. Invalidated whenever the
// postseason is (re-)simulated or a new season starts.
let postseasonFullCache = null;
function getPostseasonFull() {
  if (!postseasonFullCache) postseasonFullCache = computePostseasonResult();
  return postseasonFullCache;
}

// Flattens every actually-played postseason game (conference tournaments,
// regional series, World Series including the losers' bracket and grand
// final) into the same {home, away, result: {homeScore, awayScore,
// boxscore}, played} shape state.games uses, so standings/stats functions
// that already know how to read that shape can include the postseason
// without needing their own special case. Pulled from the full (unstripped)
// postseason -- see getPostseasonFull -- since box scores are needed.
function flattenPostseasonGames() {
  if (!state.postseason) return [];
  const full = getPostseasonFull();
  const games = [];

  const addSingle = (m) => {
    if (!m || !m.a || !m.b || !m.boxscore) return; // bye or TBD, nothing played
    games.push({
      home: m.homeTeam.name, away: m.awayTeam.name,
      result: { homeScore: m.homeScore, awayScore: m.awayScore, boxscore: m.boxscore },
      played: true, conferenceGame: false,
    });
  };

  full.conferenceTournaments.forEach((ct) => {
    ct.rounds.forEach((round) => round.forEach(addSingle));
  });
  full.regionals.forEach((m) => {
    if (!m.games) return;
    m.games.forEach((g) => {
      const homeNm = g.aIsHome ? m.a.name : m.b.name;
      const awayNm = g.aIsHome ? m.b.name : m.a.name;
      games.push({
        home: homeNm, away: awayNm,
        result: { homeScore: g.homeScore, awayScore: g.awayScore, boxscore: g.boxscore },
        played: true, conferenceGame: false,
      });
    });
  });
  const ws = full.worldSeries;
  ws.winnersBracket.forEach((round) => round.forEach(addSingle));
  ws.losersBracket.forEach((round) => round.forEach(addSingle));
  addSingle(ws.grandFinal.game1);
  addSingle(ws.grandFinal.game2);

  return games;
}

// state.games (regular season) plus every postseason game played so far, in
// the same shape -- the one list to use anywhere a team's full-season
// record or stats should include the postseason (standings, leaderboards,
// a team's own season stats). Rankings/Coaches Poll intentionally do NOT
// use this -- those represent the selection-time picture, same as in
// real life a team's postseason run doesn't rewrite its RPI.
function allCountedGames() {
  return state.postseason ? [...state.games, ...flattenPostseasonGames()] : state.games;
}

async function simPostseason() {
  if (!state.regularSeasonComplete) return;
  try {
    postseasonFullCache = computePostseasonResult();
    const champion = postseasonFullCache.worldSeries.champion.name;

    const postseason = JSON.parse(JSON.stringify(postseasonFullCache, (key, value) => {
      if (key === 'roster' || key === 'team' || key === 'boxscore') return undefined;
      return value;
    }));
    state.postseason = postseason;
    await saveState();
    renderAll();
    setMessage(`National Champion: ${champion}!`);
  } catch (err) {
    console.error('Postseason simulation failed:', err);
    setMessage(`Postseason simulation failed: ${(err && err.message) || err} — try "New Season" to reset, or check the console (F12) for details.`);
  }
}

function outsToIp(outs) {
  return `${Math.floor(outs / 3)}.${outs % 3}`;
}

// Aggregates a team's individual player stats across every game played so
// far, by re-simulating each game (see regenerateGameResult) and summing box
// scores. Cheap: even a full 45-game season re-simulates in a few ms.
function computeSeasonStatsForTeam(teamName) {
  const battingTotals = {};
  const pitchingTotals = {};
  allCountedGames()
    .filter((g) => g.played && (g.home === teamName || g.away === teamName))
    .forEach((g) => {
      const result = g.result.boxscore ? g.result : regenerateGameResult(g);
      const side = g.home === teamName ? 'home' : 'away';
      result.boxscore[side].batting.forEach((b) => {
        if (!battingTotals[b.playerId]) {
          battingTotals[b.playerId] = {
            name: b.name, number: b.number, class: b.class, position: b.position, twoWay: b.twoWay,
            ab: 0, h: 0, r: 0, rbi: 0, bb: 0, k: 0, doubles: 0, triples: 0, hr: 0,
          };
        }
        const t = battingTotals[b.playerId];
        t.ab += b.ab; t.h += b.h; t.r += b.r; t.rbi += b.rbi; t.bb += b.bb; t.k += b.k;
        t.doubles += b.doubles; t.triples += b.triples; t.hr += b.hr;
      });
      result.boxscore[side].pitching.forEach((p) => {
        if (!pitchingTotals[p.playerId]) {
          pitchingTotals[p.playerId] = { name: p.name, number: p.number, class: p.class, role: p.role, twoWay: p.twoWay, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, w: 0, l: 0, sv: 0 };
        }
        const t = pitchingTotals[p.playerId];
        t.outs += p.outs; t.h += p.h; t.r += p.r; t.er += p.er; t.bb += p.bb; t.k += p.k;
        if (p.decision === 'W') t.w += 1;
        if (p.decision === 'L') t.l += 1;
        if (p.decision === 'SV') t.sv += 1;
      });
    });

  const batting = Object.values(battingTotals).sort((a, b) => b.ab - a.ab);
  const pitching = Object.values(pitchingTotals).sort((a, b) => b.outs - a.outs);
  return { batting, pitching };
}

// Rolls a team's per-player season stats (from computeSeasonStatsForTeam) up
// into team-level rate stats -- actual simulated performance, distinct from
// the "Historically: Elite/Strong" tags which reflect the source program's
// real-world reputation rather than this season's results.
function teamTotalsFromSeasonStats(seasonStats) {
  const bat = seasonStats.batting.reduce((acc, b) => {
    acc.ab += b.ab; acc.h += b.h; acc.bb += b.bb; acc.r += b.r; acc.rbi += b.rbi;
    acc.hr += b.hr; acc.doubles += b.doubles; acc.triples += b.triples;
    return acc;
  }, { ab: 0, h: 0, bb: 0, r: 0, rbi: 0, hr: 0, doubles: 0, triples: 0 });
  const pitch = seasonStats.pitching.reduce((acc, p) => {
    acc.outs += p.outs; acc.h += p.h; acc.er += p.er; acc.bb += p.bb; acc.k += p.k; acc.r += p.r;
    return acc;
  }, { outs: 0, h: 0, er: 0, bb: 0, k: 0, r: 0 });

  const totalBases = bat.h + bat.doubles + 2 * bat.triples + 3 * bat.hr;
  return {
    avg: bat.ab > 0 ? bat.h / bat.ab : 0,
    obp: (bat.ab + bat.bb) > 0 ? (bat.h + bat.bb) / (bat.ab + bat.bb) : 0,
    slg: bat.ab > 0 ? totalBases / bat.ab : 0,
    hr: bat.hr,
    runs: bat.r,
    rbi: bat.rbi,
    era: pitch.outs > 0 ? (pitch.er * 21) / pitch.outs : 0,
    whip: pitch.outs > 0 ? (pitch.bb + pitch.h) / (pitch.outs / 3) : 0,
    k: pitch.k,
    runsAllowed: pitch.r,
  };
}

// One pass over every played game in the season, building both team-level
// totals (all 56 teams) and individual player totals league-wide. This is
// what powers the Leaders tab. ~60ms for a full season -- cheap enough to
// just recompute whenever the tab is rendered rather than caching it.
function computeLeagueStats() {
  const teamTotals = {};
  TEAMS.forEach((t) => {
    teamTotals[t.name] = {
      name: t.name, conference: t.conference, ab: 0, h: 0, bb: 0, r: 0, rbi: 0, hr: 0, doubles: 0, triples: 0,
      outs: 0, pH: 0, er: 0, pBB: 0, pK: 0, pR: 0, wins: 0, losses: 0,
    };
  });
  const playerBatting = {};
  const playerPitching = {};

  allCountedGames().filter((g) => g.played).forEach((g) => {
    const result = g.result.boxscore ? g.result : regenerateGameResult(g);
    [['away', g.away], ['home', g.home]].forEach(([side, teamName]) => {
      const tt = teamTotals[teamName];
      result.boxscore[side].batting.forEach((b) => {
        tt.ab += b.ab; tt.h += b.h; tt.bb += b.bb; tt.r += b.r; tt.rbi += b.rbi;
        tt.hr += b.hr; tt.doubles += b.doubles; tt.triples += b.triples;
        if (!playerBatting[b.playerId]) {
          playerBatting[b.playerId] = {
            name: b.name, number: b.number, team: teamName, conference: TEAMS_BY_NAME[teamName].conference, class: b.class, position: b.position, twoWay: b.twoWay,
            ab: 0, h: 0, bb: 0, r: 0, rbi: 0, hr: 0, doubles: 0, triples: 0, k: 0,
          };
        }
        const pb = playerBatting[b.playerId];
        pb.ab += b.ab; pb.h += b.h; pb.bb += b.bb; pb.r += b.r; pb.rbi += b.rbi;
        pb.hr += b.hr; pb.doubles += b.doubles; pb.triples += b.triples; pb.k += b.k;
      });
      result.boxscore[side].pitching.forEach((p) => {
        tt.outs += p.outs; tt.pH += p.h; tt.er += p.er; tt.pBB += p.bb; tt.pK += p.k; tt.pR += p.r;
        if (!playerPitching[p.playerId]) {
          playerPitching[p.playerId] = {
            name: p.name, number: p.number, team: teamName, conference: TEAMS_BY_NAME[teamName].conference, class: p.class, role: p.role, twoWay: p.twoWay,
            outs: 0, h: 0, er: 0, bb: 0, k: 0, w: 0, l: 0, sv: 0,
          };
        }
        const pp = playerPitching[p.playerId];
        pp.outs += p.outs; pp.h += p.h; pp.er += p.er; pp.bb += p.bb; pp.k += p.k;
        if (p.decision === 'W') pp.w += 1;
        if (p.decision === 'L') pp.l += 1;
        if (p.decision === 'SV') pp.sv += 1;
      });
    });
    const homeWon = g.result.homeScore > g.result.awayScore;
    if (homeWon) { teamTotals[g.home].wins += 1; teamTotals[g.away].losses += 1; }
    else { teamTotals[g.away].wins += 1; teamTotals[g.home].losses += 1; }
  });

  Object.values(teamTotals).forEach((t) => {
    const totalBases = t.h + t.doubles + 2 * t.triples + 3 * t.hr;
    t.avg = t.ab > 0 ? t.h / t.ab : 0;
    t.obp = (t.ab + t.bb) > 0 ? (t.h + t.bb) / (t.ab + t.bb) : 0;
    t.slg = t.ab > 0 ? totalBases / t.ab : 0;
    t.era = t.outs > 0 ? (t.er * 21) / t.outs : 0;
    t.whip = t.outs > 0 ? (t.pBB + t.pH) / (t.outs / 3) : 0;
  });

  return { teamTotals: Object.values(teamTotals), playerBatting: Object.values(playerBatting), playerPitching: Object.values(playerPitching) };
}

function teamLeaderCard(title, rows, valueLabel, valueFn, count = 10) {
  const bodyRows = rows.slice(0, count).map((r, i) => `
    <tr><td class="lb-rank">${i + 1}</td><td>${teamLink(r.name)}</td><td>${valueFn(r)}</td></tr>
  `).join('');
  return `
    <div class="leaderboard-card">
      <h4>${title}</h4>
      <table class="standings-table tp-mini-table">
        <thead><tr><th></th><th>Team</th><th>${valueLabel}</th></tr></thead>
        <tbody>${bodyRows || `<tr><td colspan="3" class="view-note">Not enough games played yet</td></tr>`}</tbody>
      </table>
    </div>`;
}

function playerLeaderCard(title, rows, valueLabel, valueFn, count = 10) {
  const bodyRows = rows.slice(0, count).map((r, i) => `
    <tr>
      <td class="lb-rank">${i + 1}</td>
      <td>#${r.number} ${r.name}${r.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td>
      <td><span class="team-link" data-team="${r.team}">${teamBadge(r.team, 18)}</span></td>
      <td>${valueFn(r)}</td>
    </tr>`).join('');
  return `
    <div class="leaderboard-card">
      <h4>${title}</h4>
      <table class="standings-table tp-mini-table">
        <thead><tr><th></th><th>Player</th><th></th><th>${valueLabel}</th></tr></thead>
        <tbody>${bodyRows || `<tr><td colspan="4" class="view-note">No qualifiers yet</td></tr>`}</tbody>
      </table>
    </div>`;
}

function renderLeaders() {
  const container = document.getElementById('leadersContent');
  container.innerHTML = '';
  const played = state.games.some((g) => g.played);
  if (!played) {
    container.innerHTML = '<p class="view-note">Simulate a week to generate league leaders.</p>';
    return;
  }

  const filterSelect = document.getElementById('leaderConfFilter');
  if (filterSelect.options.length <= 1) {
    [...CONFERENCES ? Object.keys(CONFERENCES) : []].sort().forEach((conf) => {
      const opt = document.createElement('option');
      opt.value = conf;
      opt.textContent = conf;
      filterSelect.appendChild(opt);
    });
  }
  const confFilter = filterSelect.value || 'all';

  const { teamTotals: allTeamTotals, playerBatting: allPlayerBatting, playerPitching: allPlayerPitching } = computeLeagueStats();
  const teamTotals = confFilter === 'all' ? allTeamTotals : allTeamTotals.filter((t) => t.conference === confFilter);
  const playerBatting = confFilter === 'all' ? allPlayerBatting : allPlayerBatting.filter((p) => p.conference === confFilter);
  const playerPitching = confFilter === 'all' ? allPlayerPitching : allPlayerPitching.filter((p) => p.conference === confFilter);

  const teamSection = document.createElement('div');
  teamSection.className = 'bracket-section';
  teamSection.innerHTML = `
    <h3>Team Leaders</h3>
    <div class="leaderboard-grid">
      ${teamLeaderCard('Batting AVG', [...teamTotals].sort((a, b) => b.avg - a.avg), 'AVG', (t) => t.avg.toFixed(3).replace(/^0/, ''))}
      ${teamLeaderCard('Slugging (SLG)', [...teamTotals].sort((a, b) => b.slg - a.slg), 'SLG', (t) => t.slg.toFixed(3).replace(/^0/, ''))}
      ${teamLeaderCard('Home Runs', [...teamTotals].sort((a, b) => b.hr - a.hr), 'HR', (t) => t.hr)}
      ${teamLeaderCard('ERA', [...teamTotals].sort((a, b) => a.era - b.era), 'ERA', (t) => t.era.toFixed(2))}
      ${teamLeaderCard('WHIP', [...teamTotals].sort((a, b) => a.whip - b.whip), 'WHIP', (t) => t.whip.toFixed(2))}
      ${teamLeaderCard('Strikeouts (pitching)', [...teamTotals].sort((a, b) => b.pK - a.pK), 'K', (t) => t.pK)}
    </div>
  `;
  container.appendChild(teamSection);

  const MIN_AB = 40;
  const MIN_OUTS = 60; // 20 innings
  const qualifiedBatters = playerBatting.filter((p) => p.ab >= MIN_AB);
  const qualifiedPitchers = playerPitching.filter((p) => p.outs >= MIN_OUTS);

  const playerSection = document.createElement('div');
  playerSection.className = 'bracket-section';
  playerSection.innerHTML = `
    <h3>Player Leaders</h3>
    <p class="view-note">Includes postseason games played. Batting rate stats require ${MIN_AB}+ at-bats; pitching rate stats require ${Math.floor(MIN_OUTS / 3)}+ innings. Counting stats (HR, RBI, K, etc.) have no minimum.</p>
    <div class="leaderboard-grid">
      ${playerLeaderCard('Batting AVG', [...qualifiedBatters].sort((a, b) => (b.h / b.ab) - (a.h / a.ab)), 'AVG', (p) => (p.h / p.ab).toFixed(3).replace(/^0/, ''))}
      ${playerLeaderCard('Home Runs', [...playerBatting].sort((a, b) => b.hr - a.hr), 'HR', (p) => p.hr)}
      ${playerLeaderCard('RBI', [...playerBatting].sort((a, b) => b.rbi - a.rbi), 'RBI', (p) => p.rbi)}
      ${playerLeaderCard('Hits', [...playerBatting].sort((a, b) => b.h - a.h), 'H', (p) => p.h)}
      ${playerLeaderCard('ERA', [...qualifiedPitchers].sort((a, b) => ((a.er * 21) / a.outs) - ((b.er * 21) / b.outs)), 'ERA', (p) => ((p.er * 21) / p.outs).toFixed(2))}
      ${playerLeaderCard('Strikeouts (pitching)', [...playerPitching].sort((a, b) => b.k - a.k), 'K', (p) => p.k)}
      ${playerLeaderCard('Wins', [...playerPitching].sort((a, b) => b.w - a.w), 'W', (p) => p.w)}
    </div>
  `;
  container.appendChild(playerSection);
}

function setMessage(msg) {
  document.getElementById('simMessage').textContent = msg;
}

/* ---------------- Rendering ---------------- */

function renderAll() {
  renderStatus();
  renderControls();
  renderSchedule();
  renderStandings();
  renderRankings();
  renderLeaders();
  renderPostseason();
  renderTeams();
}

function renderStatus() {
  const el = document.getElementById('weekIndicator');
  if (state.postseason) el.textContent = 'Postseason complete';
  else if (state.regularSeasonComplete) el.textContent = 'Regular season complete';
  else el.textContent = `${state.currentWeek} of ${state.totalWeeks}`;
}

function renderControls() {
  document.getElementById('btnSimWeek').disabled = state.regularSeasonComplete;
  document.getElementById('btnSimToEnd').disabled = state.regularSeasonComplete;
  document.getElementById('btnSimPostseason').disabled = !state.regularSeasonComplete || !!state.postseason;
}

function teamRecordThrough(games, teamName, uptoWeek) {
  let w = 0, l = 0;
  games.forEach((g) => {
    if (!g.played || g.week > uptoWeek) return;
    if (g.home !== teamName && g.away !== teamName) return;
    const isHome = g.home === teamName;
    const won = isHome ? g.result.homeScore > g.result.awayScore : g.result.awayScore > g.result.homeScore;
    if (won) w += 1; else l += 1;
  });
  return `${w}-${l}`;
}

function renderSchedule() {
  const select = document.getElementById('weekSelect');
  if (select.options.length !== state.totalWeeks) {
    select.innerHTML = '';
    for (let w = 1; w <= state.totalWeeks; w++) {
      const opt = document.createElement('option');
      opt.value = w;
      opt.textContent = `Week ${w}`;
      select.appendChild(opt);
    }
  }
  const selectedWeek = Number(select.value) || Math.min(state.currentWeek, state.totalWeeks);
  select.value = selectedWeek;

  const list = document.getElementById('scheduleList');
  list.innerHTML = '';
  const weekGames = state.games
    .filter((g) => g.week === selectedWeek)
    .sort((a, b) => a.home.localeCompare(b.home) || a.gameOfSeries - b.gameOfSeries);

  if (weekGames.length === 0) {
    list.innerHTML = '<p class="view-note">No games scheduled.</p>';
    return;
  }

  weekGames.forEach((g) => {
    const row = document.createElement('div');
    row.className = 'game-row' + (g.played ? ' played' : '') + (g.conferenceGame ? ' conference-game' : '');
    if (g.played) {
      row.classList.add('game-row-clickable');
      row.dataset.boxscoreGame = g.id;
    }

    const awayWon = g.played && g.result.awayScore > g.result.homeScore;
    const homeWon = g.played && g.result.homeScore > g.result.awayScore;

    const awayDiv = document.createElement('div');
    awayDiv.className = 'game-team' + (awayWon ? ' winner' : '');
    awayDiv.innerHTML = `${teamLink(g.away)}<span class="game-score">${g.played ? g.result.awayScore : ''}</span>`;

    const vs = document.createElement('div');
    vs.className = 'game-vs';
    vs.textContent = `G${g.gameOfSeries} · wk ${g.week}`;

    const homeDiv = document.createElement('div');
    homeDiv.className = 'game-team' + (homeWon ? ' winner' : '');
    homeDiv.innerHTML = `${teamLink(g.home)}<span class="game-score">${g.played ? g.result.homeScore : ''}</span>`;

    const tag = document.createElement('div');
    tag.className = 'game-tag';
    const mercyTag = g.played && g.result.mercyRule ? ' · mercy' : '';
    tag.textContent = g.played ? `final${mercyTag}${g.conferenceGame ? ' · conf' : ''}` : (g.conferenceGame ? 'conf' : 'non-conf');

    row.append(awayDiv, vs, homeDiv, tag);
    list.appendChild(row);
  });

  const playing = new Set();
  weekGames.forEach((g) => { playing.add(g.home); playing.add(g.away); });
  const byeTeams = TEAMS.map((t) => t.name).filter((n) => !playing.has(n)).sort();
  if (byeTeams.length > 0) {
    const byeNote = document.createElement('p');
    byeNote.className = 'view-note bye-note';
    byeNote.textContent = `On bye this week: ${byeTeams.join(', ')}`;
    list.appendChild(byeNote);
  }
}

function renderStandings() {
  const grid = document.getElementById('standingsGrid');
  grid.innerHTML = '';
  const standings = computeStandings(TEAMS, state.games);
  const byConf = standingsByConference(standings);

  Object.entries(byConf)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([conf, rows]) => {
      const card = document.createElement('div');
      card.className = 'standings-card';
      const h3 = document.createElement('h3');
      h3.textContent = conf;
      h3.dataset.conf = conf;
      h3.classList.add('conf-header-link');
      const confColor = CONFERENCES[conf]?.color;
      if (confColor) card.style.setProperty('--conf-color', confColor);
      card.appendChild(h3);

      const table = document.createElement('table');
      table.className = 'standings-table';
      table.innerHTML = `<thead><tr><th>Team</th><th>Conf</th><th>Overall</th><th>RD</th></tr></thead>`;
      const tbody = document.createElement('tbody');
      rows.forEach((r) => {
        const tr = document.createElement('tr');
        const rd = r.runDiff > 0 ? `+${r.runDiff}` : `${r.runDiff}`;
        tr.innerHTML = `<td>${teamLink(r.name)}</td><td>${r.confWins}-${r.confLosses}</td><td>${r.wins}-${r.losses}</td><td>${rd}</td>`;
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      card.appendChild(table);
      grid.appendChild(card);
    });
}

function renderRankings() {
  const rpiList = document.getElementById('rankingsList');
  const pollList = document.getElementById('coachesPollList');
  rpiList.innerHTML = '';
  pollList.innerHTML = '';
  const played = state.games.some((g) => g.played);
  if (!played) {
    const note = '<p class="view-note">Simulate a week to generate the first poll.</p>';
    rpiList.innerHTML = note;
    pollList.innerHTML = note;
    return;
  }

  const rankings = computeRankings(TEAMS, state.games);
  top25(rankings).forEach((r) => {
    const li = document.createElement('li');
    li.className = 'rank-row';
    li.innerHTML = `
      <span class="rank-num">${r.rank}</span>
      <span class="rank-team">${teamLink(r.name)}<span class="rank-conf">${conferenceLink(r.conference)}</span></span>
      <span class="rank-record">${r.record}</span>
      <span class="rank-rpi">${r.rpi.toFixed(3)}</span>
    `;
    rpiList.appendChild(li);
  });

  const standings = computeStandings(TEAMS, state.games);
  const poll = computeCoachesPoll(standings, PROGRAM_PRESTIGE, state.seed);
  top15(poll).forEach((r) => {
    const li = document.createElement('li');
    li.className = 'rank-row';
    li.innerHTML = `
      <span class="rank-num">${r.rank}</span>
      <span class="rank-team">${teamLink(r.name)}<span class="rank-conf">${conferenceLink(r.conference)}</span></span>
      <span class="rank-record">${r.record}</span>
      <span class="rank-rpi"></span>
    `;
    pollList.appendChild(li);
  });
}

// Renders one match row for any bracket shape: byes, best-of-N series
// (winsA/winsB present), or single games (homeScore/awayScore present).
// `prefix` optionally labels the row (used for Grand Final Game 1/2).
// Builds the inner content of one bracket match card: two team rows stacked
// vertically (the standard bracket convention), winner bolded, score
// right-aligned. Used both for tree-style brackets and flat match grids.
function matchCardHTML(m, prefix) {
  if (!m.a || !m.b) {
    const solo = m.a || m.b;
    return `<div class="bmatch-prefix">${prefix || ''}</div><div class="bmatch-row bmatch-bye">${solo ? `${teamBadge(solo.name, 18)}${teamLink(solo.name, { noBadge: true })}` : 'TBD'}<span class="bmatch-bye-tag">${solo ? 'bye' : ''}</span></div>`;
  }
  const aWin = m.winner?.name === m.a.name;
  let aScore = '';
  let bScore = '';
  if (m.winsA !== undefined) {
    aScore = m.winsA; bScore = m.winsB;
  } else if (m.homeScore !== undefined) {
    const isAHome = m.homeTeam?.name === m.a.name;
    aScore = isAHome ? m.homeScore : m.awayScore;
    bScore = isAHome ? m.awayScore : m.homeScore;
  }
  return `
    ${prefix ? `<div class="bmatch-prefix">${prefix}</div>` : ''}
    <div class="bmatch-row ${aWin ? 'winner' : ''}">${teamBadge(m.a.name, 18)}<span class="bmatch-name">${teamLink(m.a.name, { noBadge: true })}</span><span class="bmatch-score">${aScore}</span></div>
    <div class="bmatch-row ${!aWin ? 'winner' : ''}">${teamBadge(m.b.name, 18)}<span class="bmatch-name">${teamLink(m.b.name, { noBadge: true })}</span><span class="bmatch-score">${bScore}</span></div>
  `;
}

// Builds one match card, wiring it up to reopen its box score (regenerated
// on demand -- see getPostseasonFull) if it's a real, playable match.
function buildMatchCard(m, path, prefix) {
  const card = document.createElement('div');
  card.className = 'bmatch';
  card.innerHTML = matchCardHTML(m, prefix);
  if (m.a && m.b) {
    card.classList.add('bmatch-clickable');
    card.dataset.psPath = JSON.stringify(path);
  }
  return card;
}

// Renders a full tree: one column per round, connector lines between
// rounds, each round's matches vertically centered against their feeders
// via flexbox. Works for any bracket whose round sizes halve each step
// (which every bracket in this app does). `pathPrefix` locates this set of
// rounds within state.postseason, e.g. ['conferenceTournaments', 3, 'rounds'].
function renderBracketTree(rounds, roundLabels, pathPrefix) {
  const tree = document.createElement('div');
  tree.className = 'bracket-tree';
  rounds.forEach((round, i) => {
    const col = document.createElement('div');
    col.className = 'bracket-col';
    const label = document.createElement('div');
    label.className = 'bracket-col-label';
    label.textContent = roundLabels ? (roundLabels[i] || `Round ${i + 1}`) : roundLabel(i, rounds.length);
    col.appendChild(label);

    const matchesWrap = document.createElement('div');
    matchesWrap.className = 'bracket-col-matches';
    round.forEach((m, j) => {
      matchesWrap.appendChild(buildMatchCard(m, [...pathPrefix, i, j]));
    });
    col.appendChild(matchesWrap);
    tree.appendChild(col);
  });
  return tree;
}

function renderPostseason() {
  const container = document.getElementById('postseasonContent');
  container.innerHTML = '';

  if (!state.regularSeasonComplete) {
    container.innerHTML = '<p class="view-note">Finish the regular season to unlock conference tournaments and the NCAA bracket.</p>';
    return;
  }
  if (!state.postseason) {
    container.innerHTML = '<p class="view-note">Regular season complete. Click "Sim Postseason" to run conference tournaments through the World Series.</p>';
    return;
  }

  const { conferenceTournaments, field, regionals, worldSeries } = state.postseason;

  const banner = document.createElement('div');
  banner.className = 'champion-banner';
  banner.innerHTML = `${teamBadge(worldSeries.champion.name, 40)}<span>National Champion: ${worldSeries.champion.name}</span>`;
  container.appendChild(banner);

  // Conference tournaments -- one visual bracket tree per conference
  const confSection = document.createElement('div');
  confSection.className = 'bracket-section';
  confSection.innerHTML = '<h3>Conference Tournaments <span class="view-note">click any match for its box score</span></h3>';
  conferenceTournaments.forEach((ct, ci) => {
    const confWrap = document.createElement('div');
    confWrap.className = 'conf-tourney-block';
    confWrap.innerHTML = `<div class="conf-champ-line"><strong>${ct.conference}</strong> champion: <span class="winner">${teamLink(ct.champion.name)}</span></div>`;
    confWrap.appendChild(renderBracketTree(ct.rounds, null, ['conferenceTournaments', ci, 'rounds']));
    confSection.appendChild(confWrap);
  });
  container.appendChild(confSection);

  // NCAA field
  const fieldSection = document.createElement('div');
  fieldSection.className = 'bracket-section';
  fieldSection.innerHTML = '<h3>NCAA Field (Seeded 1–16)</h3>';
  const table = document.createElement('table');
  table.className = 'standings-table';
  table.style.width = '100%';
  table.innerHTML = '<thead><tr><th>Seed</th><th>Team</th><th>Berth</th><th>RPI</th></tr></thead>';
  const tbody = document.createElement('tbody');
  field.forEach((f) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${f.seed}</td><td>${teamLink(f.name)}</td><td>${f.berth}</td><td>${f.rpi.toFixed(3)}</td>`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  fieldSection.appendChild(table);
  container.appendChild(fieldSection);

  // Regionals -- one round of best-of-3s; a card grid rather than a tree
  // since there's nothing upstream to connect them to yet.
  const regSection = document.createElement('div');
  regSection.className = 'bracket-section';
  regSection.innerHTML = '<h3>Regionals (Best-of-3) <span class="view-note">click for the series\' box scores</span></h3>';
  const regGrid = document.createElement('div');
  regGrid.className = 'bracket-grid';
  regionals.forEach((m, i) => {
    regGrid.appendChild(buildMatchCard(m, ['regionals', i]));
  });
  regSection.appendChild(regGrid);
  container.appendChild(regSection);

  // World Series -- true double elimination: winners' bracket tree, losers'
  // bracket tree, then the grand final (with an "if necessary" decider).
  const wsSection = document.createElement('div');
  wsSection.className = 'bracket-section';
  wsSection.innerHTML = '<h3>World Series <span class="view-note">(double elimination) — click any match for its box score</span></h3>';

  const wbLabel = document.createElement('div');
  wbLabel.className = 'ws-bracket-label';
  wbLabel.textContent = "Winners' Bracket";
  wsSection.appendChild(wbLabel);
  wsSection.appendChild(renderBracketTree(worldSeries.winnersBracket, ['Round 1', 'Semifinal', "Winners' Final"], ['worldSeries', 'winnersBracket']));

  const lbLabel = document.createElement('div');
  lbLabel.className = 'ws-bracket-label';
  lbLabel.textContent = "Losers' Bracket";
  wsSection.appendChild(lbLabel);
  wsSection.appendChild(renderBracketTree(worldSeries.losersBracket, ['Round 1', 'Round 2', 'Round 3', "Losers' Final"], ['worldSeries', 'losersBracket']));

  const gfLabel = document.createElement('div');
  gfLabel.className = 'ws-bracket-label';
  gfLabel.textContent = "Grand Final (winners' bracket champion must lose twice)";
  wsSection.appendChild(gfLabel);
  const gfGrid = document.createElement('div');
  gfGrid.className = 'bracket-grid';
  gfGrid.appendChild(buildMatchCard(worldSeries.grandFinal.game1, ['worldSeries', 'grandFinal', 'game1'], 'Game 1'));
  if (worldSeries.grandFinal.game2) {
    gfGrid.appendChild(buildMatchCard(worldSeries.grandFinal.game2, ['worldSeries', 'grandFinal', 'game2'], 'Game 2 (if necessary)'));
  }
  wsSection.appendChild(gfGrid);
  container.appendChild(wsSection);
}

function renderTeams() {
  const grid = document.getElementById('teamsGrid');
  if (grid.childElementCount > 0) return; // static, only needs to render once
  grid.innerHTML = '';
  TEAMS.slice().sort((a, b) => a.name.localeCompare(b.name)).forEach((t) => {
    const card = document.createElement('div');
    card.className = 'team-card';
    if (t.colors) card.style.setProperty('--team-primary', t.colors.primary);
    const tiers = PROGRAM_TIERS[t.name] || {};
    card.innerHTML = `
      ${teamBadge(t.name, 40)}
      <div class="team-card-body">
        <h4>${teamLink(t.name, { noBadge: true })}</h4>
        <p>${conferenceLink(t.conference)} · ${t.coach}</p>
        <div class="stat-line">Historically: <strong>${tiers.battingTier || '—'}</strong> hitting, <strong>${tiers.pitchingTier || '—'}</strong> pitching</div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function teamBadge(name, size = 20, extraClass = '') {
  const width = Math.round(size * 1.4);
  const customLogo = customLogos[name];
  if (customLogo) {
    return `<img class="team-badge ${extraClass}" width="${width}" height="${size}" src="${customLogo}" alt="${name} logo">`;
  }
  const team = TEAMS_BY_NAME[name];
  if (!team) return '';
  const colors = team.colors || { primary: '#0F3324', secondary: '#D7E600' };
  const initials = (team.abbr || name.slice(0, 3)).slice(0, 3);
  const fontSize = initials.length >= 3 ? 40 : 52;
  return `<svg class="team-badge ${extraClass}" width="${width}" height="${size}" viewBox="0 0 140 100" aria-hidden="true">
    <rect x="4" y="4" width="132" height="92" rx="14" fill="${colors.primary}" stroke="${colors.secondary}" stroke-width="7"/>
    <text x="70" y="53" text-anchor="middle" dominant-baseline="middle" font-family="'Space Grotesk', sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff">${initials}</text>
  </svg>`;
}

function teamLink(name, opts = {}) {
  const size = opts.size || 20;
  const badge = opts.noBadge ? '' : teamBadge(name, size);
  return `<span class="team-link" data-team="${name}">${badge}<span class="team-link-name">${name}</span></span>`;
}

function conferenceLink(confName) {
  const color = CONFERENCES[confName]?.color || 'var(--field-green)';
  return `<span class="conf-link" data-conf="${confName}" style="--conf-link-color:${color}">${confName}</span>`;
}

function openConferenceModal(confName) {
  const confTeams = TEAMS.filter((t) => t.conference === confName);
  if (confTeams.length === 0) return;
  const color = CONFERENCES[confName]?.color || '#0F3324';

  const standings = computeStandings(TEAMS, state.games);
  const confStandings = (standingsByConference(standings)[confName] || []);

  const standingsRows = confStandings.map((r) => {
    const rd = r.runDiff > 0 ? `+${r.runDiff}` : `${r.runDiff}`;
    return `<tr><td>${teamLink(r.name)}</td><td>${r.confWins}-${r.confLosses}</td><td>${r.wins}-${r.losses}</td><td>${rd}</td></tr>`;
  }).join('');

  let champLine = '';
  if (state.postseason) {
    const ct = state.postseason.conferenceTournaments.find((c) => c.conference === confName);
    if (ct) champLine = `<p class="tp-sub tp-tiers">Tournament champion: ${teamLink(ct.champion.name)}</p>`;
  }

  const teamChips = confTeams
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `<div class="conf-team-chip">${teamLink(t.name)}</div>`).join('');

  document.getElementById('modalContent').innerHTML = `
    <div class="tp-header">
      <div class="conf-badge" style="background:${color}">${confName}</div>
      <div>
        <h2>${confName}</h2>
        <p class="tp-sub">${confTeams.length} teams</p>
        ${champLine}
      </div>
    </div>

    <div class="tp-schedule-title">Standings</div>
    <table class="standings-table tp-mini-table">
      <thead><tr><th>Team</th><th>Conf</th><th>Overall</th><th>RD</th></tr></thead>
      <tbody>${standingsRows}</tbody>
    </table>

    <div class="tp-schedule-title">Teams</div>
    <div class="conf-team-grid">${teamChips}</div>
  `;

  document.getElementById('teamModalOverlay').classList.add('open');
}

function openTeamModal(name) {
  const team = TEAMS_BY_NAME[name];
  if (!team) return;

  const standings = computeStandings(TEAMS, allCountedGames());
  const row = standings.find((r) => r.name === name) || {
    wins: 0, losses: 0, confWins: 0, confLosses: 0, runDiff: 0,
  };

  const games = state.games
    .filter((g) => g.home === name || g.away === name)
    .sort((a, b) => a.week - b.week || a.gameOfSeries - b.gameOfSeries);

  const gameRows = games.map((g) => {
    const isHome = g.home === name;
    const opponent = isHome ? g.away : g.home;
    const atVs = isHome ? 'vs' : '@';
    if (!g.played) {
      return `
        <div class="tp-game-row">
          <span class="tp-wk">wk ${g.week}</span>
          <span>${atVs} ${teamLink(opponent)}</span>
          <span class="tp-score">—</span>
          <span class="tp-tag">${g.conferenceGame ? 'conf' : 'non-conf'}</span>
        </div>`;
    }
    const ownScore = isHome ? g.result.homeScore : g.result.awayScore;
    const oppScore = isHome ? g.result.awayScore : g.result.homeScore;
    const won = ownScore > oppScore;
    return `
      <div class="tp-game-row tp-game-row-clickable" data-boxscore-game="${g.id}">
        <span class="tp-wk">wk ${g.week}</span>
        <span>${atVs} ${teamLink(opponent)}</span>
        <span class="tp-score"><span class="${won ? 'tp-result-w' : 'tp-result-l'}">${won ? 'W' : 'L'}</span> ${ownScore}-${oppScore}</span>
        <span class="tp-tag">${g.conferenceGame ? 'conf' : 'non-conf'}${g.result.mercyRule ? ' · mercy' : ''}</span>
      </div>`;
  }).join('');

  const rd = row.runDiff > 0 ? `+${row.runDiff}` : `${row.runDiff}`;
  const seasonStats = computeSeasonStatsForTeam(name);
  const teamTotals = teamTotalsFromSeasonStats(seasonStats);
  const roster = state.rosters[name];

  const battingRows = seasonStats.batting.map((b) => {
    const avg = b.ab > 0 ? b.h / b.ab : 0;
    const obp = (b.ab + b.bb) > 0 ? (b.h + b.bb) / (b.ab + b.bb) : 0;
    const totalBases = b.h + b.doubles + 2 * b.triples + 3 * b.hr;
    const slg = b.ab > 0 ? totalBases / b.ab : 0;
    const fmt = (x) => x.toFixed(3).replace(/^0/, '');
    return `
    <tr>
      <td>#${b.number}</td><td>${b.name}${b.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${b.class}</td><td>${b.position}</td>
      <td>${b.ab}</td><td>${b.h}</td><td>${b.r}</td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td><td>${b.hr}</td>
      <td>${fmt(avg)}</td><td>${fmt(obp)}</td><td>${fmt(slg)}</td><td>${fmt(obp + slg)}</td>
    </tr>`;
  }).join('');

  const pitchingRows = seasonStats.pitching.map((p) => {
    const ip = outsToIp(p.outs);
    const era = p.outs > 0 ? ((p.er * 21) / p.outs).toFixed(2) : '0.00';
    const whip = p.outs > 0 ? ((p.bb + p.h) / (p.outs / 3)).toFixed(2) : '0.00';
    const kPer7 = p.outs > 0 ? ((p.k * 21) / p.outs).toFixed(1) : '0.0';
    const oba = (p.outs + p.h) > 0 ? (p.h / (p.outs + p.h)).toFixed(3).replace(/^0/, '') : '.000';
    return `
    <tr>
      <td>#${p.number}</td><td>${p.role} ${p.name}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.w}-${p.l}${p.sv ? `, ${p.sv}sv` : ''}</td>
      <td>${ip}</td><td>${p.h}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td><td>${era}</td><td>${whip}</td><td>${kPer7}</td><td>${oba}</td>
    </tr>`;
  }).join('');

  // Full 25-man roster (independent of whether they've recorded a stat line
  // yet) -- lineup + bench hitters, then the full pitching staff.
  const rosterHitterRows = [...roster.lineup, ...roster.bench].map((p) => `
    <tr>
      <td>#${p.number}</td><td>${p.name}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.position}</td>
      <td>${p.ratings.contact}</td><td>${p.ratings.power}</td><td>${p.ratings.eye}</td>
    </tr>`).join('');
  const rosterPitcherRows = roster.pitchers.map((p) => `
    <tr>
      <td>#${p.number}</td><td>${p.name}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.role}</td>
      <td>${p.ratings.stuff}</td><td>${p.ratings.control}</td><td>${p.ratings.movement}</td>
    </tr>`).join('');

  const rosterUniqueCount = new Set([
    ...roster.lineup.map((p) => p.id),
    ...roster.bench.map((p) => p.id),
    ...roster.pitchers.map((p) => p.id),
  ]).size;

  document.getElementById('modalContent').innerHTML = `
    <div class="tp-header">
      <div class="tp-badge-wrap">
        ${teamBadge(team.name, 56, 'team-badge-lg')}
        <button class="badge-upload-btn" data-upload-team="${team.name}" title="Upload a logo for ${team.name}">⤒</button>
      </div>
      <div>
        <h2>${team.name}</h2>
        <p class="tp-sub">${conferenceLink(team.conference)} · Head Coach ${team.coach}</p>
        <p class="tp-sub tp-tiers">Historically: ${PROGRAM_TIERS[team.name]?.battingTier || '—'} hitting · ${PROGRAM_TIERS[team.name]?.pitchingTier || '—'} pitching</p>
        <p class="tp-logo-actions">
          <button class="link-btn" data-upload-team="${team.name}">Upload logo</button>
          ${customLogos[team.name] ? `· <button class="link-btn" data-reset-logo-team="${team.name}">Reset to default</button>` : ''}
        </p>
      </div>
    </div>
    <div class="tp-records">
      <div class="tp-record-box"><span class="num">${row.wins}-${row.losses}</span><span class="label">overall</span></div>
      <div class="tp-record-box"><span class="num">${row.confWins}-${row.confLosses}</span><span class="label">conference</span></div>
      <div class="tp-record-box"><span class="num">${rd}</span><span class="label">run diff</span></div>
    </div>
    ${games.some((g) => g.played) ? `<p class="tp-team-totals">Season: AVG ${teamTotals.avg.toFixed(3).replace(/^0/, '')} · OBP ${teamTotals.obp.toFixed(3).replace(/^0/, '')} · SLG ${teamTotals.slg.toFixed(3).replace(/^0/, '')} &nbsp;|&nbsp; ERA ${teamTotals.era.toFixed(2)} · WHIP ${teamTotals.whip.toFixed(2)}</p>` : ''}

    <div class="tp-schedule-title">Roster (${rosterUniqueCount}) <span class="view-note">ratings on a 20-80 scale, 50 = league average</span></div>
    <div class="tp-roster-tables">
      <table class="standings-table tp-mini-table">
        <thead><tr><th>#</th><th>Hitter</th><th>Cl</th><th>Pos</th><th>Contact</th><th>Power</th><th>Eye</th></tr></thead>
        <tbody>${rosterHitterRows}</tbody>
      </table>
      <table class="standings-table tp-mini-table">
        <thead><tr><th>#</th><th>Pitcher</th><th>Cl</th><th>Role</th><th>Stuff</th><th>Control</th><th>Movement</th></tr></thead>
        <tbody>${rosterPitcherRows}</tbody>
      </table>
    </div>

    ${games.some((g) => g.played) ? `
    <div class="tp-schedule-title">Season Stats <span class="view-note">includes postseason games played</span></div>
    <div class="tp-stacked-tables">
      <table class="standings-table tp-mini-table">
        <thead><tr><th>#</th><th>Batter</th><th>Cl</th><th>Pos</th><th>AB</th><th>H</th><th>R</th><th>RBI</th><th>BB</th><th>K</th><th>HR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
        <tbody>${battingRows}</tbody>
      </table>
      <table class="standings-table tp-mini-table">
        <thead><tr><th>#</th><th>Pitcher</th><th>Cl</th><th>W-L</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>ERA</th><th>WHIP</th><th>K/7</th><th>OBA</th></tr></thead>
        <tbody>${pitchingRows}</tbody>
      </table>
    </div>
    ` : ''}

    <div class="tp-schedule-title">Schedule (${games.length} games)</div>
    <div class="tp-game-list">${gameRows || '<p class="view-note">No games scheduled.</p>'}</div>
  `;

  document.getElementById('teamModalOverlay').classList.add('open');
}

// Shared by the regular-season and postseason box score modals: linescore
// (with R/H/E) plus batting/pitching tables for both sides of one game.
function boxScoreSectionHTML(result, awayName, homeName) {
  function battingTable(side, teamName) {
    const rows = result.boxscore[side].batting.map((b) => `
      <tr>
        <td>#${b.number}</td><td>${b.battingOrder}. ${b.name}${b.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${b.class}</td><td>${b.position}</td>
        <td>${b.ab}</td><td>${b.h}</td><td>${b.r}</td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td>
      </tr>`).join('');
    return `
      <div>
        <div class="bs-team-title">${teamLink(teamName)}</div>
        <table class="standings-table tp-mini-table">
          <thead><tr><th>#</th><th>Batter</th><th>Cl</th><th>Pos</th><th>AB</th><th>H</th><th>R</th><th>RBI</th><th>BB</th><th>K</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function pitchingTable(side) {
    const rows = result.boxscore[side].pitching.map((p) => `
      <tr>
        <td>#${p.number}</td><td>${p.role} ${p.name}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.ip}</td><td>${p.h}</td><td>${p.r}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td>
        <td>${p.decision}</td>
      </tr>`).join('');
    return `
      <table class="standings-table tp-mini-table">
        <thead><tr><th>#</th><th>Pitcher</th><th>Cl</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  const lineHeader = result.awayLine.map((_, i) => `<th>${i + 1}</th>`).join('') + '<th class="bs-rhe">R</th><th class="bs-rhe">H</th><th class="bs-rhe">E</th>';
  const awayLineRow = result.awayLine.map((r) => `<td>${r === null ? '' : r}</td>`).join('')
    + `<td class="bs-rhe"><strong>${result.lineScore.away.r}</strong></td><td class="bs-rhe">${result.lineScore.away.h}</td><td class="bs-rhe">${result.lineScore.away.e}</td>`;
  const homeLineRow = result.homeLine.map((r) => `<td>${r === null ? '' : r}</td>`).join('')
    + `<td class="bs-rhe"><strong>${result.lineScore.home.r}</strong></td><td class="bs-rhe">${result.lineScore.home.h}</td><td class="bs-rhe">${result.lineScore.home.e}</td>`;

  return `
    <table class="standings-table tp-mini-table bs-linescore">
      <thead><tr><th></th>${lineHeader}</tr></thead>
      <tbody>
        <tr><td>${teamLink(awayName)}</td>${awayLineRow}</tr>
        <tr><td>${teamLink(homeName)}</td>${homeLineRow}</tr>
      </tbody>
    </table>

    <div class="tp-schedule-title">Batting</div>
    <div class="tp-roster-tables">
      ${battingTable('away', awayName)}
      ${battingTable('home', homeName)}
    </div>

    <div class="tp-schedule-title">Pitching</div>
    <div class="tp-roster-tables">
      ${pitchingTable('away')}
      ${pitchingTable('home')}
    </div>
  `;
}

function openBoxScoreModal(gameId) {
  const game = state.games.find((g) => g.id === Number(gameId));
  if (!game || !game.played) return;
  const result = regenerateGameResult(game);

  document.getElementById('modalContent').innerHTML = `
    <div class="tp-header">
      <div class="bs-header-badges">${teamBadge(game.away, 40)}${teamBadge(game.home, 40)}</div>
      <div>
        <h2>${game.away} @ ${game.home}</h2>
        <p class="tp-sub">Week ${game.week} · Game ${game.gameOfSeries} of ${game.seriesLength ?? 3} · ${game.conferenceGame ? 'Conference' : 'Non-conference'}${result.mercyRule ? ` · <strong>Final (mercy rule, ${result.innings} inn.)</strong>` : ''}</p>
      </div>
    </div>
    ${boxScoreSectionHTML(result, game.away, game.home)}
  `;

  document.getElementById('teamModalOverlay').classList.add('open');
}

function findPostseasonNode(root, path) {
  let node = root;
  for (const key of path) {
    if (node == null) return null;
    node = node[key];
  }
  return node;
}

// Postseason box scores are never stored -- see getPostseasonFull(). This
// regenerates the exact same postseason run (deterministic from the same
// seed) and pulls out the one match the user clicked on.
function openPostseasonBoxScoreModal(pathJson) {
  let path;
  try { path = JSON.parse(pathJson); } catch { return; }
  const fresh = getPostseasonFull();
  const match = findPostseasonNode(fresh, path);
  if (!match || !match.a || !match.b) return;

  let subtitle;
  let bodyHTML;
  if (match.games && match.games.length) {
    // Best-of-3 series (regionals): show every game played.
    subtitle = `Regional series · ${match.winner.name} wins ${match.winsA}-${match.winsB}`;
    bodyHTML = match.games.map((g, i) => {
      const awayNm = g.aIsHome ? match.b.name : match.a.name;
      const homeNm = g.aIsHome ? match.a.name : match.b.name;
      return `
        <div class="tp-schedule-title">Game ${i + 1}${g.mercyRule ? ' (mercy rule)' : ''}</div>
        ${boxScoreSectionHTML(g, awayNm, homeNm)}
      `;
    }).join('');
  } else {
    subtitle = match.mercyRule ? `Final (mercy rule, ${match.innings} inn.)` : 'Final';
    bodyHTML = boxScoreSectionHTML(match, match.awayTeam.name, match.homeTeam.name);
  }

  document.getElementById('modalContent').innerHTML = `
    <div class="tp-header">
      <div class="bs-header-badges">${teamBadge(match.a.name, 40)}${teamBadge(match.b.name, 40)}</div>
      <div>
        <h2>${match.a.name} vs ${match.b.name}</h2>
        <p class="tp-sub">${subtitle}</p>
      </div>
    </div>
    ${bodyHTML}
  `;

  document.getElementById('teamModalOverlay').classList.add('open');
}

function closeTeamModal() {
  document.getElementById('teamModalOverlay').classList.remove('open');
}

function wireTeamModal() {
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.team-link');
    if (link) { openTeamModal(link.dataset.team); return; }
    const confLink = e.target.closest('[data-conf]');
    if (confLink) { openConferenceModal(confLink.dataset.conf); return; }
    const boxLink = e.target.closest('[data-boxscore-game]');
    if (boxLink) { openBoxScoreModal(boxLink.dataset.boxscoreGame); return; }
    const psLink = e.target.closest('[data-ps-path]');
    if (psLink) { openPostseasonBoxScoreModal(psLink.dataset.psPath); return; }
    if (e.target.id === 'teamModalOverlay') closeTeamModal();
  });
  document.getElementById('modalClose').addEventListener('click', closeTeamModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeTeamModal();
  });
}

/* ---------------- Wiring ---------------- */

function wireTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`view-${tab.dataset.tab}`).classList.add('active');
    });
  });
}

function wireControls() {
  document.getElementById('btnSimWeek').addEventListener('click', simWeek);
  document.getElementById('btnSimToEnd').addEventListener('click', simToEnd);
  document.getElementById('btnSimPostseason').addEventListener('click', simPostseason);
  document.getElementById('leaderConfFilter').addEventListener('change', renderLeaders);
  document.getElementById('btnReset').addEventListener('click', () => {
    if (confirm('Start a brand new season? This clears all current results.')) newSeason();
  });
  document.getElementById('weekSelect').addEventListener('change', renderSchedule);
  document.getElementById('weekPrev').addEventListener('click', () => {
    const sel = document.getElementById('weekSelect');
    sel.value = Math.max(1, Number(sel.value) - 1);
    renderSchedule();
  });
  document.getElementById('weekNext').addEventListener('click', () => {
    const sel = document.getElementById('weekSelect');
    sel.value = Math.min(state.totalWeeks, Number(sel.value) + 1);
    renderSchedule();
  });
}

function showFatalBanner(message) {
  if (document.getElementById('fatalBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'fatalBanner';
  banner.className = 'fatal-banner';
  banner.innerHTML = `<strong>Something went wrong:</strong> ${message} — try a hard refresh (Ctrl/Cmd+Shift+R), or check the console (F12) for details.`;
  document.body.prepend(banner);
}

window.addEventListener('error', (e) => {
  console.error('Uncaught error:', e.error || e.message);
  showFatalBanner((e.error && e.error.message) || e.message || 'an unknown error occurred');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('Unhandled promise rejection:', e.reason);
  showFatalBanner((e.reason && e.reason.message) || String(e.reason));
});

async function init() {
  try {
    await migrateFromLocalStorage();
    await loadTeams();
    await loadCustomLogos();
    state = (await loadState()) || freshState(Date.now() % 1000000);
    await saveState();
    wireTabs();
    wireControls();
    wireTeamModal();
    wireLogoUpload();
    renderAll();
  } catch (err) {
    console.error('App failed to start:', err);
    document.getElementById('app').innerHTML = `
      <div class="fatal-error">
        <h2>The app couldn't start</h2>
        <p><strong>${(err && err.message) || err}</strong></p>
        <p>This usually means the browser loaded an incomplete or mismatched
        set of files. Things to try, in order:</p>
        <ol>
          <li>Hard refresh this page (Ctrl/Cmd+Shift+R), which bypasses the
          browser's cache.</li>
          <li>If that doesn't help, clear this site's storage: open dev
          tools (F12) → Application (Chrome) or Storage (Firefox) → Local
          Storage → delete everything for this site, then reload.</li>
          <li>If you're hosting this yourself, confirm every file from the
          zip was actually uploaded, especially anything under
          <code>js/engine/</code> and <code>js/data/</code> — a stale or
          missing file there is the most common cause of this.</li>
        </ol>
        <p>Open the browser console (F12 → Console tab) for the full error
        and stack trace if you need to dig further.</p>
      </div>`;
  }
}

init();
