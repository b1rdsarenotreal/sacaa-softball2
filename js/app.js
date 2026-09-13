import { generateSchedule } from './engine/schedule.js';
import { computeLeagueAverages, simulateGame } from './engine/sim.js';
import { generateRosters, buildGameRoster, pickStarterForGame, computeProgramTiers, computeProgramPrestige, computeTeamTalents, advanceRosterOneSeason } from './engine/roster.js';
import { computeStandings, standingsByConference, overallStandings } from './engine/standings.js';
import { computeRankings, top25, computeCoachesPoll, top15 } from './engine/rankings.js';
import { runConferenceTournament, selectField, runRegionals, runWorldSeries, previewWorldSeriesRound1, roundLabel } from './engine/postseason.js';

const STORAGE_KEY = 'sacaa-season-v2';
const SCHEMA_VERSION = 4; // bumped from 3: added currentSeasonLog for weekly archive snapshots
const LOGO_STORAGE_KEY = 'sacaa-custom-logos-v1';
const CONF_LOGO_STORAGE_KEY = 'sacaa-custom-conf-logos-v1';

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
let customConfLogos = {};
let pendingLogoUpload = null; // { kind: 'team' | 'conference', name }

const LOGO_TARGET_SIZE = 200; // square, px -- upload anything this ratio (or close) for a pixel-perfect fit

async function loadCustomLogos() {
  try {
    customLogos = (await idbGet(LOGO_STORAGE_KEY)) || {};
  } catch (err) {
    console.error('Failed to load custom team logos:', err);
    customLogos = {};
  }
  try {
    customConfLogos = (await idbGet(CONF_LOGO_STORAGE_KEY)) || {};
  } catch (err) {
    console.error('Failed to load custom conference logos:', err);
    customConfLogos = {};
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

async function saveCustomConfLogos() {
  try {
    await idbSet(CONF_LOGO_STORAGE_KEY, customConfLogos);
  } catch (err) {
    console.error('Failed to save conference logo:', err);
    alert(`Couldn't save that logo: ${(err && err.message) || err}`);
  }
}

// Reads an uploaded image file and fits it into a square (contain, not
// crop), so the whole logo stays visible -- nothing gets chopped off the
// way a cover-crop would. An image that's already square (any resolution)
// fills the badge with zero padding; anything else gets letterboxed rather
// than cropped.
function resizeImageFile(file, targetSize, callback) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = targetSize;
      canvas.height = targetSize;
      const ctx = canvas.getContext('2d');
      const scale = Math.min(targetSize / img.width, targetSize / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      const dx = (targetSize - dw) / 2;
      const dy = (targetSize - dh) / 2;
      ctx.clearRect(0, 0, targetSize, targetSize);
      ctx.drawImage(img, 0, 0, img.width, img.height, dx, dy, dw, dh);
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

async function setCustomConfLogo(confName, dataUrl) {
  customConfLogos[confName] = dataUrl;
  await saveCustomConfLogos();
}

async function clearCustomConfLogo(confName) {
  delete customConfLogos[confName];
  await saveCustomConfLogos();
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

function refreshAfterConfLogoChange(confName) {
  document.getElementById('teamsGrid').innerHTML = '';
  renderTeams();
  renderStandings();
  if (document.getElementById('teamModalOverlay').classList.contains('open')) {
    openConferenceModal(confName);
  }
}

function wireLogoUpload() {
  const fileInput = document.getElementById('logoFileInput');
  document.addEventListener('click', async (e) => {
    const uploadBtn = e.target.closest('[data-upload-team]');
    if (uploadBtn) {
      pendingLogoUpload = { kind: 'team', name: uploadBtn.dataset.uploadTeam };
      fileInput.click();
      return;
    }
    const uploadConfBtn = e.target.closest('[data-upload-conf]');
    if (uploadConfBtn) {
      pendingLogoUpload = { kind: 'conference', name: uploadConfBtn.dataset.uploadConf };
      fileInput.click();
      return;
    }
    const resetBtn = e.target.closest('[data-reset-logo-team]');
    if (resetBtn) {
      await clearCustomLogo(resetBtn.dataset.resetLogoTeam);
      refreshAfterLogoChange(resetBtn.dataset.resetLogoTeam);
      return;
    }
    const resetConfBtn = e.target.closest('[data-reset-logo-conf]');
    if (resetConfBtn) {
      await clearCustomConfLogo(resetConfBtn.dataset.resetLogoConf);
      refreshAfterConfLogoChange(resetConfBtn.dataset.resetLogoConf);
    }
  });
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    fileInput.value = '';
    if (!file || !pendingLogoUpload) return;
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
    const upload = pendingLogoUpload;
    resizeImageFile(file, LOGO_TARGET_SIZE, async (dataUrl) => {
      if (upload.kind === 'team') {
        await setCustomLogo(upload.name, dataUrl);
        refreshAfterLogoChange(upload.name);
      } else {
        await setCustomConfLogo(upload.name, dataUrl);
        refreshAfterConfLogoChange(upload.name);
      }
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
    dynastyYear: 2013,
    history: [],
    lastHomeMap: schedule.homeMap,
    currentSeasonLog: { weeks: [] },
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

// Snapshots RPI, Coaches Poll, standings, and every leaderboard category as
// of right now, keyed to the current week -- this is what lets a past
// week/year actually be browsed later instead of only ever seeing the
// latest state. Computed the same way the live tabs compute it, just
// stored. The leaderboard pass (computeLeagueStats) is the expensive part
// (~60ms for a full season), so this adds real but bounded time to each
// week of simulation.
function snapshotWeek(week) {
  const rankings = computeRankings(TEAMS, state.games);
  const rpi = top25(rankings).map((r) => ({ rank: r.rank, name: r.name, conference: r.conference, record: r.record, rpi: r.rpi }));

  const standingsRows = computeStandings(TEAMS, state.games);
  const poll = computeCoachesPoll(standingsRows, PROGRAM_PRESTIGE, state.seed);
  const coachesPoll = top15(poll).map((r) => ({ rank: r.rank, name: r.name, conference: r.conference, record: r.record }));

  const standings = standingsRows.map((r) => ({
    name: r.name, conference: r.conference, wins: r.wins, losses: r.losses, confWins: r.confWins, confLosses: r.confLosses, runDiff: r.runDiff,
    pct: r.pct, confPct: r.confPct,
  }));

  const { teamTotals, playerBatting, playerPitching } = computeLeagueStats();
  const MIN_AB = 40;
  const MIN_OUTS = 60;
  const qualifiedBatters = playerBatting.filter((p) => p.ab >= MIN_AB);
  const qualifiedPitchers = playerPitching.filter((p) => p.outs >= MIN_OUTS);
  const top = (arr, n = 10) => arr.slice(0, n);
  const teamRow = (t, value) => ({ name: t.name, conference: t.conference, value });
  const playerRow = (p, value) => ({ playerId: p.playerId, name: p.name, number: p.number, team: p.team, conference: p.conference, twoWay: p.twoWay, value });

  const teamLeaders = {
    avg: top([...teamTotals].sort((a, b) => b.avg - a.avg)).map((t) => teamRow(t, t.avg)),
    slg: top([...teamTotals].sort((a, b) => b.slg - a.slg)).map((t) => teamRow(t, t.slg)),
    hr: top([...teamTotals].sort((a, b) => b.hr - a.hr)).map((t) => teamRow(t, t.hr)),
    era: top([...teamTotals].sort((a, b) => a.era - b.era)).map((t) => teamRow(t, t.era)),
    whip: top([...teamTotals].sort((a, b) => a.whip - b.whip)).map((t) => teamRow(t, t.whip)),
    k: top([...teamTotals].sort((a, b) => b.pK - a.pK)).map((t) => teamRow(t, t.pK)),
  };
  const playerLeaders = {
    avg: top([...qualifiedBatters].sort((a, b) => (b.h / b.ab) - (a.h / a.ab))).map((p) => playerRow(p, p.h / p.ab)),
    hr: top([...playerBatting].sort((a, b) => b.hr - a.hr)).map((p) => playerRow(p, p.hr)),
    rbi: top([...playerBatting].sort((a, b) => b.rbi - a.rbi)).map((p) => playerRow(p, p.rbi)),
    hits: top([...playerBatting].sort((a, b) => b.h - a.h)).map((p) => playerRow(p, p.h)),
    era: top([...qualifiedPitchers].sort((a, b) => ((a.er * 21) / a.outs) - ((b.er * 21) / b.outs))).map((p) => playerRow(p, (p.er * 21) / p.outs)),
    k: top([...playerPitching].sort((a, b) => b.k - a.k)).map((p) => playerRow(p, p.k)),
    wins: top([...playerPitching].sort((a, b) => b.w - a.w)).map((p) => playerRow(p, p.w)),
  };

  state.currentSeasonLog.weeks.push({ week, rpi, coachesPoll, standings, teamLeaders, playerLeaders });
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
    snapshotWeek(week);
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
  snapshotWeek(week);
}

function computePostseasonResult() {
  const standings = computeStandings(TEAMS, state.games);
  const byConf = standingsByConference(standings);
  const rankings = computeRankings(TEAMS, state.games);

  const conferenceTournaments = Object.entries(byConf).map(([conf, rows], i) =>
    runConferenceTournament(rows, TEAMS_BY_NAME, state.rosters, LEAGUE, state.seed + i * 17 + 3)
  );

  const field = selectField(conferenceTournaments, rankings, state.games, 16);
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

// --- Archive browsing (year/week filter) -----------------------------
// Lets Standings/Rankings/Leaders/Postseason show a stored snapshot from
// any past week or dynasty year instead of the live current state.
// { year: 'current' | <year number>, week: 'latest' | 'postseason' | <week number> }
let archiveFilter = { year: 'current', week: 'latest' };

function getWeeksArrayForYear(year) {
  if (year === 'current') return state.currentSeasonLog.weeks;
  const h = state.history.find((x) => x.year === year);
  return h ? h.weeks : [];
}

function yearHasPostseason(year) {
  if (year === 'current') return !!(state.postseason && state.postseason.stage === 'complete');
  const h = state.history.find((x) => x.year === year);
  return !!(h && h.postseasonBracket);
}

function populateArchiveBar() {
  const yearSelect = document.getElementById('archiveYear');
  const pastYears = state.history.map((h) => h.year).sort((a, b) => b - a);
  yearSelect.innerHTML = `<option value="current">${state.dynastyYear} (current)</option>`
    + pastYears.map((y) => `<option value="${y}">${y}</option>`).join('');
  yearSelect.value = archiveFilter.year === 'current' ? 'current' : String(archiveFilter.year);
  if (yearSelect.value === '') { archiveFilter.year = 'current'; yearSelect.value = 'current'; }
  populateArchiveWeekOptions();
}

function populateArchiveWeekOptions() {
  const weekSelect = document.getElementById('archiveWeek');
  const year = archiveFilter.year;
  const weeks = getWeeksArrayForYear(year);
  const hasPostseason = yearHasPostseason(year);

  let options = '';
  if (year === 'current') options += '<option value="latest">Latest</option>';
  weeks.forEach((w) => { options += `<option value="${w.week}">Week ${w.week}</option>`; });
  if (hasPostseason) options += '<option value="postseason">Postseason (Final)</option>';
  weekSelect.innerHTML = options;

  const desired = String(archiveFilter.week);
  if ([...weekSelect.options].some((o) => o.value === desired)) {
    weekSelect.value = desired;
  } else {
    weekSelect.value = year === 'current' ? 'latest' : (hasPostseason ? 'postseason' : (weeks.length ? String(weeks[weeks.length - 1].week) : 'latest'));
    archiveFilter.week = weekSelect.value === 'postseason' || weekSelect.value === 'latest' ? weekSelect.value : Number(weekSelect.value);
  }

  const note = document.getElementById('archiveBarNote');
  note.textContent = (archiveFilter.year === 'current' && archiveFilter.week === 'latest')
    ? ''
    : 'Showing archived data for the selected year/week -- not the live current state.';
}

// Returns the stored weekly snapshot to show, or null if the filter is set
// to "live current" (in which case callers should compute live data as
// normal). Doesn't cover postseason brackets -- see getArchivePostseasonBracket.
function getArchiveSnapshot() {
  if (archiveFilter.year === 'current' && archiveFilter.week === 'latest') return null;
  const weeks = getWeeksArrayForYear(archiveFilter.year);
  if (archiveFilter.week === 'postseason') return weeks[weeks.length - 1] || null;
  return weeks.find((w) => w.week === archiveFilter.week) || null;
}

// The postseason tab only varies by year (a past year's postseason is
// always its final, completed bracket regardless of which week is picked).
function getArchivePostseasonBracket() {
  if (archiveFilter.year === 'current') return state.postseason;
  const h = state.history.find((x) => x.year === archiveFilter.year);
  return h ? h.postseasonBracket : null;
}

function wireArchiveBar() {
  document.getElementById('archiveYear').addEventListener('change', (e) => {
    archiveFilter = { year: e.target.value === 'current' ? 'current' : Number(e.target.value), week: 'latest' };
    populateArchiveWeekOptions();
    renderStandings(); renderRankings(); renderLeaders(); renderPostseason();
  });
  document.getElementById('archiveWeek').addEventListener('change', (e) => {
    archiveFilter.week = e.target.value === 'postseason' || e.target.value === 'latest' ? e.target.value : Number(e.target.value);
    populateArchiveWeekOptions();
    renderStandings(); renderRankings(); renderLeaders(); renderPostseason();
  });
}

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

  // Only fold in whichever stages have actually been revealed so far --
  // records/stats/leaderboards/awards should reflect the postseason
  // progressively as it's played, not all at once at the very end.
  if (state.postseason.conferenceTournaments) {
    full.conferenceTournaments.forEach((ct) => {
      ct.rounds.forEach((round) => round.forEach(addSingle));
    });
  }
  if (state.postseason.regionals) {
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
  }
  if (state.postseason.worldSeries) {
    const ws = full.worldSeries;
    ws.winnersBracket.forEach((round) => round.forEach(addSingle));
    ws.losersBracket.forEach((round) => round.forEach(addSingle));
    addSingle(ws.grandFinal.game1);
    addSingle(ws.grandFinal.game2);
  }

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

function findPlayerInstances(teamName, playerId) {
  const roster = state.rosters[teamName];
  if (!roster) return [];
  return [...roster.lineup, ...roster.bench, ...roster.pitchers].filter((p) => p.id === playerId);
}

// Every game a specific player appeared in (batting and/or pitching), across
// the regular season and postseason, in chronological-ish order (regular
// season by week, postseason appended in tournament order).
function computePlayerGameLog(teamName, playerId) {
  const regular = state.games
    .filter((g) => g.played && (g.home === teamName || g.away === teamName))
    .sort((a, b) => a.id - b.id)
    .map((g) => ({ ...g, isPostseason: false }));
  const postseason = state.postseason
    ? flattenPostseasonGames().filter((g) => g.home === teamName || g.away === teamName).map((g) => ({ ...g, isPostseason: true }))
    : [];

  const battingLog = [];
  const pitchingLog = [];
  [...regular, ...postseason].forEach((g) => {
    const result = g.result.boxscore ? g.result : regenerateGameResult(g);
    const side = g.home === teamName ? 'home' : 'away';
    const opponent = side === 'home' ? g.away : g.home;
    const b = result.boxscore[side].batting.find((x) => x.playerId === playerId);
    if (b && (b.ab > 0 || b.bb > 0)) battingLog.push({ opponent, week: g.week, isPostseason: g.isPostseason, ...b });
    const p = result.boxscore[side].pitching.find((x) => x.playerId === playerId);
    if (p) pitchingLog.push({ opponent, week: g.week, isPostseason: g.isPostseason, ...p });
  });
  return { battingLog, pitchingLog };
}

function stripForStorage(obj) {
  return JSON.parse(JSON.stringify(obj, (key, value) => {
    if (key === 'roster' || key === 'team' || key === 'boxscore') return undefined;
    return value;
  }));
}

// The postseason is broken into five reveal/sim steps rather than one big
// button: sim conference tournaments, reveal the NCAA field/seeding, sim
// regionals, reveal the World Series bracket, sim the World Series. The
// underlying simulation is still fully deterministic from state.seed, so
// under the hood each step just re-derives the same computePostseasonResult
// (cheap, see getPostseasonFull) and reveals the next slice of it -- what's
// persisted in state.postseason is only whatever's been revealed so far, so
// reloading mid-reveal resumes at the same step instead of jumping ahead.
async function simConferenceTournaments() {
  if (!state.regularSeasonComplete || state.postseason) return;
  try {
    postseasonFullCache = computePostseasonResult();
    state.postseason = {
      stage: 'conferenceTournaments',
      conferenceTournaments: stripForStorage(postseasonFullCache.conferenceTournaments),
    };
    await saveState();
    renderAll();
    setMessage('Conference tournaments complete.');
  } catch (err) {
    console.error('Conference tournament simulation failed:', err);
    setMessage(`Conference tournament simulation failed: ${(err && err.message) || err} — try "New Season" to reset, or check the console (F12) for details.`);
  }
}

async function revealNCAAField() {
  if (!state.postseason || state.postseason.stage !== 'conferenceTournaments') return;
  try {
    const full = getPostseasonFull();
    state.postseason.stage = 'fieldRevealed';
    state.postseason.field = stripForStorage(full.field);
    await saveState();
    renderAll();
    setMessage('NCAA Field revealed.');
  } catch (err) {
    console.error('Revealing the NCAA field failed:', err);
    setMessage(`Couldn't reveal the NCAA field: ${(err && err.message) || err}`);
  }
}

async function simRegionals() {
  if (!state.postseason || state.postseason.stage !== 'fieldRevealed') return;
  try {
    const full = getPostseasonFull();
    state.postseason.stage = 'regionals';
    state.postseason.regionals = stripForStorage(full.regionals);
    await saveState();
    renderAll();
    setMessage('Regionals complete.');
  } catch (err) {
    console.error('Regional simulation failed:', err);
    setMessage(`Regional simulation failed: ${(err && err.message) || err} — try "New Season" to reset, or check the console (F12) for details.`);
  }
}

async function revealWorldSeriesBracket() {
  if (!state.postseason || state.postseason.stage !== 'regionals') return;
  try {
    const full = getPostseasonFull();
    const winners = full.regionals.map((m) => m.winner);
    const preview = previewWorldSeriesRound1(winners);
    state.postseason.stage = 'worldSeriesRevealed';
    state.postseason.worldSeriesPreview = stripForStorage(preview);
    await saveState();
    renderAll();
    setMessage('World Series bracket set.');
  } catch (err) {
    console.error('Revealing the World Series bracket failed:', err);
    setMessage(`Couldn't reveal the World Series bracket: ${(err && err.message) || err}`);
  }
}

async function simWorldSeries() {
  if (!state.postseason || state.postseason.stage !== 'worldSeriesRevealed') return;
  try {
    const full = getPostseasonFull();
    state.postseason.stage = 'complete';
    state.postseason.worldSeries = stripForStorage(full.worldSeries);
    delete state.postseason.worldSeriesPreview;
    await saveState();
    renderAll();
    setMessage(`National Champion: ${full.worldSeries.champion.name}!`);
  } catch (err) {
    console.error('World Series simulation failed:', err);
    setMessage(`World Series simulation failed: ${(err && err.message) || err} — try "New Season" to reset, or check the console (F12) for details.`);
  }
}

// Routes the single postseason button to whichever step comes next.
async function advancePostseasonStage() {
  if (!state.regularSeasonComplete) return;
  const stage = state.postseason && state.postseason.stage;
  if (!state.postseason) await simConferenceTournaments();
  else if (stage === 'conferenceTournaments') await revealNCAAField();
  else if (stage === 'fieldRevealed') await simRegionals();
  else if (stage === 'regionals') await revealWorldSeriesBracket();
  else if (stage === 'worldSeriesRevealed') await simWorldSeries();
}

function postseasonButtonLabel() {
  if (!state.postseason) return 'Sim Conference Tournaments';
  switch (state.postseason.stage) {
    case 'conferenceTournaments': return 'Reveal NCAA Field';
    case 'fieldRevealed': return 'Sim Regionals';
    case 'regionals': return 'Reveal World Series Bracket';
    case 'worldSeriesRevealed': return 'Sim World Series';
    default: return 'Postseason Complete';
  }
}

// Snapshots the just-finished season into state.history: team records, team
// rate stats, every player's stat line, and postseason results. This has to
// happen BEFORE rosters/games get replaced by the next season, since once
// that happens there's no regenerating this season's box scores anymore --
// this compact archive is what team/player profiles read for career history.
function archiveSeason() {
  const { teamTotals, playerBatting, playerPitching } = computeLeagueStats();
  const standings = computeStandings(TEAMS, allCountedGames());

  const teamRecords = {};
  standings.forEach((r) => {
    teamRecords[r.name] = { wins: r.wins, losses: r.losses, confWins: r.confWins, confLosses: r.confLosses, conference: r.conference };
  });

  const teamStats = {};
  teamTotals.forEach((t) => {
    teamStats[t.name] = { avg: t.avg, obp: t.obp, slg: t.slg, era: t.era, whip: t.whip, hr: t.hr };
  });

  const playerStats = {};
  playerBatting.forEach((p) => {
    if (!playerStats[p.playerId]) playerStats[p.playerId] = { name: p.name, number: p.number, team: p.team, class: p.class };
    playerStats[p.playerId].batting = {
      ab: p.ab, h: p.h, bb: p.bb, r: p.r, rbi: p.rbi, hr: p.hr, doubles: p.doubles, triples: p.triples, k: p.k,
    };
  });
  playerPitching.forEach((p) => {
    if (!playerStats[p.playerId]) playerStats[p.playerId] = { name: p.name, number: p.number, team: p.team, class: p.class };
    playerStats[p.playerId].pitching = { outs: p.outs, h: p.h, er: p.er, bb: p.bb, k: p.k, w: p.w, l: p.l, sv: p.sv };
  });

  let conferenceChamps = {};
  let nationalChampion = null;
  if (state.postseason) {
    conferenceChamps = Object.fromEntries(state.postseason.conferenceTournaments.map((ct) => [ct.conference, ct.champion.name]));
    nationalChampion = state.postseason.worldSeries.champion.name;
  }

  state.history.push({
    year: state.dynastyYear,
    teamRecords, teamStats, playerStats, conferenceChamps, nationalChampion,
    postseasonBracket: state.postseason,
    weeks: state.currentSeasonLog.weeks,
    awards: computeAwards(),
  });
}

// The dynasty-continuation action: archive the just-finished season, age
// every roster forward a year (graduation + recruiting -- see
// advanceRosterOneSeason), generate next year's schedule (flipping
// conference home/away from this year where possible), and reset for a new
// regular season under a new year number. Distinct from "New Season", which
// starts a brand new independent dynasty and wipes history.
async function advanceToNextSeason() {
  if (!state.postseason || state.postseason.stage !== 'complete') return;
  try {
    archiveSeason();

    const talents = computeTeamTalents(TEAMS);
    const newRosters = {};
    TEAMS.forEach((t, i) => {
      newRosters[t.name] = advanceRosterOneSeason(
        state.rosters[t.name], t, talents[t.name],
        state.seed + state.dynastyYear * 7919 + i * 131
      );
    });

    const newSeed = (state.seed + state.dynastyYear * 10007) % 100000000;
    const schedule = generateSchedule(TEAMS, newSeed, state.lastHomeMap || {});

    state.dynastyYear += 1;
    state.seed = newSeed;
    state.rosters = newRosters;
    state.games = schedule.games;
    state.totalWeeks = schedule.totalWeeks;
    state.lastHomeMap = schedule.homeMap;
    state.currentWeek = 1;
    state.regularSeasonComplete = false;
    state.postseason = null;
    postseasonFullCache = null;
    state.currentSeasonLog = { weeks: [] };

    await saveState();
    renderAll();
    setMessage(`Advanced to Year ${state.dynastyYear}: seniors graduated, new recruits signed, schedule regenerated.`);
  } catch (err) {
    console.error('Advance to Next Season failed:', err);
    setMessage(`Couldn't advance to next season: ${(err && err.message) || err}`);
  }
}

const AWARD_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF', 'DP'];

// Awards are WAR-based: for each position, whoever posted the best WAR
// while primarily playing there; for the marquee awards, whoever posted
// the best WAR overall (in their category). Uses the same qualification
// minimums as the leaderboards so a two-at-bat outlier can't win an award.
function computeAwards() {
  const { playerBatting, playerPitching } = computeLeagueStats();
  const MIN_AB = 40;
  const MIN_OUTS = 60;
  const qualifiedBatters = playerBatting.filter((p) => p.ab >= MIN_AB);
  const qualifiedPitchers = playerPitching.filter((p) => p.outs >= MIN_OUTS);

  const bestAtPosition = (pool, position) => {
    const atPos = pool.filter((p) => p.position === position);
    return atPos.length > 0 ? [...atPos].sort((a, b) => b.war - a.war)[0] : null;
  };
  const bestOverall = (pool) => (pool.length > 0 ? [...pool].sort((a, b) => b.war - a.war)[0] : null);
  const bestFreshman = (batPool, pitchPool) => {
    const combined = [...batPool.filter((p) => p.class === 'FR'), ...pitchPool.filter((p) => p.class === 'FR')];
    return combined.length > 0 ? [...combined].sort((a, b) => b.war - a.war)[0] : null;
  };
  const buildTeam = (batPool, pitchPool) => {
    const team = {};
    AWARD_POSITIONS.forEach((pos) => { team[pos] = bestAtPosition(batPool, pos); });
    team.P = bestOverall(pitchPool);
    return team;
  };

  const national = {
    playerOfYear: bestOverall(qualifiedBatters),
    pitcherOfYear: bestOverall(qualifiedPitchers),
    freshmanOfYear: bestFreshman(qualifiedBatters, qualifiedPitchers),
    team: buildTeam(qualifiedBatters, qualifiedPitchers),
  };

  const conferences = {};
  Object.keys(CONFERENCES).forEach((conf) => {
    const confBatters = qualifiedBatters.filter((p) => p.conference === conf);
    const confPitchers = qualifiedPitchers.filter((p) => p.conference === conf);
    conferences[conf] = {
      playerOfYear: bestOverall(confBatters),
      pitcherOfYear: bestOverall(confPitchers),
      freshmanOfYear: bestFreshman(confBatters, confPitchers),
      team: buildTeam(confBatters, confPitchers),
    };
  });

  return { national, conferences };
}

// Scans one season's awards (national + every conference) for every honor
// a specific player won, for the badge row on their profile. Works for both
// a past season's archived awards and the current season's live ones,
// since both come out of computeAwards() in the same shape.
function findPlayerAwardsInSeason(awards, playerId, year) {
  if (!awards) return [];
  const badges = [];
  const ALL_SLOTS = [...AWARD_POSITIONS, 'P'];
  if (awards.national.playerOfYear?.playerId === playerId) badges.push({ year, label: 'National Player of the Year' });
  if (awards.national.pitcherOfYear?.playerId === playerId) badges.push({ year, label: 'National Pitcher of the Year' });
  if (awards.national.freshmanOfYear?.playerId === playerId) badges.push({ year, label: 'National Freshman of the Year' });
  ALL_SLOTS.forEach((slot) => {
    if (awards.national.team[slot]?.playerId === playerId) badges.push({ year, label: `All-American (${slot})` });
  });
  Object.entries(awards.conferences).forEach(([conf, data]) => {
    if (data.playerOfYear?.playerId === playerId) badges.push({ year, label: `${conf} Player of the Year` });
    if (data.pitcherOfYear?.playerId === playerId) badges.push({ year, label: `${conf} Pitcher of the Year` });
    if (data.freshmanOfYear?.playerId === playerId) badges.push({ year, label: `${conf} Freshman of the Year` });
    ALL_SLOTS.forEach((slot) => {
      if (data.team[slot]?.playerId === playerId) badges.push({ year, label: `All-${conf} (${slot})` });
    });
  });
  return badges;
}

// Every award badge across a player's whole career: past seasons come from
// the archived state.history entries; the current season (if any awards
// are live yet) is passed in already-computed so callers that already need
// computeAwards() for something else don't pay for it twice.
function getPlayerAwardBadges(playerId, currentSeasonAwards) {
  const badges = [];
  state.history.forEach((h) => { badges.push(...findPlayerAwardsInSeason(h.awards, playerId, h.year)); });
  if (currentSeasonAwards) badges.push(...findPlayerAwardsInSeason(currentSeasonAwards, playerId, state.dynastyYear));
  return badges.sort((a, b) => b.year - a.year);
}

function awardCardHTML(title, player) {
  if (!player) {
    return `<div class="leaderboard-card"><h4>${title}</h4><p class="view-note">No qualified players yet.</p></div>`;
  }
  return `
    <div class="leaderboard-card">
      <h4>${title}</h4>
      <div class="award-winner">
        ${teamBadge(player.team, 32)}
        <div>
          <div class="award-winner-name">#${player.number} ${playerLink(player.team, player.playerId, player.name)}${player.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</div>
          <div class="award-winner-sub">${teamLink(player.team)} · ${player.war.toFixed(1)} WAR</div>
        </div>
      </div>
    </div>`;
}

function teamAwardTableHTML(team) {
  const row = (label, p) => (p
    ? `<tr><td>${label}</td><td>#${p.number} ${playerLink(p.team, p.playerId, p.name)}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${teamLink(p.team)}</td><td>${p.war.toFixed(1)}</td></tr>`
    : `<tr><td>${label}</td><td colspan="3" class="view-note">No qualified player</td></tr>`);
  const rows = AWARD_POSITIONS.map((pos) => row(pos, team[pos])).join('') + row('P', team.P);
  return `
    <table class="standings-table tp-mini-table">
      <thead><tr><th>Pos</th><th>Player</th><th>Team</th><th>WAR</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderAwards() {
  const container = document.getElementById('awardsContent');
  container.innerHTML = '';
  const played = state.games.some((g) => g.played);
  if (!played) {
    container.innerHTML = '<p class="view-note">Simulate a week to generate awards races.</p>';
    return;
  }

  const scopeSelect = document.getElementById('awardsScope');
  if (scopeSelect.options.length <= 1) {
    Object.keys(CONFERENCES).sort().forEach((conf) => {
      const opt = document.createElement('option');
      opt.value = conf;
      opt.textContent = conf;
      scopeSelect.appendChild(opt);
    });
  }
  const scope = scopeSelect.value || 'national';

  const awards = computeAwards();
  const data = scope === 'national' ? awards.national : awards.conferences[scope];
  const label = scope === 'national' ? 'National' : scope;
  const teamLabel = scope === 'national' ? 'All-American Team' : `All-${scope} Team`;

  const awardsSection = document.createElement('div');
  awardsSection.className = 'bracket-section';
  awardsSection.innerHTML = `
    <h3>${label} Awards <span class="view-note">based on WAR, includes postseason games played</span></h3>
    <div class="leaderboard-grid">
      ${awardCardHTML('Player of the Year', data.playerOfYear)}
      ${awardCardHTML('Pitcher of the Year', data.pitcherOfYear)}
      ${awardCardHTML('Freshman of the Year', data.freshmanOfYear)}
    </div>
  `;
  container.appendChild(awardsSection);

  const teamSection = document.createElement('div');
  teamSection.className = 'bracket-section';
  teamSection.innerHTML = `<h3>${teamLabel} <span class="view-note">best WAR at each position (min. 40 AB or 20 IP)</span></h3>`;
  const teamTableWrap = document.createElement('div');
  teamTableWrap.innerHTML = teamAwardTableHTML(data.team);
  teamSection.appendChild(teamTableWrap);
  container.appendChild(teamSection);
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
            playerId: b.playerId, name: b.name, number: b.number, class: b.class, position: b.position, twoWay: b.twoWay,
            ab: 0, h: 0, r: 0, rbi: 0, bb: 0, k: 0, doubles: 0, triples: 0, hr: 0,
          };
        }
        const t = battingTotals[b.playerId];
        t.ab += b.ab; t.h += b.h; t.r += b.r; t.rbi += b.rbi; t.bb += b.bb; t.k += b.k;
        t.doubles += b.doubles; t.triples += b.triples; t.hr += b.hr;
      });
      result.boxscore[side].pitching.forEach((p) => {
        if (!pitchingTotals[p.playerId]) {
          pitchingTotals[p.playerId] = { playerId: p.playerId, name: p.name, number: p.number, class: p.class, role: p.role, twoWay: p.twoWay, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, w: 0, l: 0, sv: 0 };
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
            playerId: b.playerId, name: b.name, number: b.number, team: teamName, conference: TEAMS_BY_NAME[teamName].conference, class: b.class, twoWay: b.twoWay,
            ab: 0, h: 0, bb: 0, r: 0, rbi: 0, hr: 0, doubles: 0, triples: 0, k: 0, positionCounts: {},
          };
        }
        const pb = playerBatting[b.playerId];
        pb.ab += b.ab; pb.h += b.h; pb.bb += b.bb; pb.r += b.r; pb.rbi += b.rbi;
        pb.hr += b.hr; pb.doubles += b.doubles; pb.triples += b.triples; pb.k += b.k;
        pb.positionCounts[b.position] = (pb.positionCounts[b.position] || 0) + 1;
      });
      result.boxscore[side].pitching.forEach((p) => {
        tt.outs += p.outs; tt.pH += p.h; tt.er += p.er; tt.pBB += p.bb; tt.pK += p.k; tt.pR += p.r;
        if (!playerPitching[p.playerId]) {
          playerPitching[p.playerId] = {
            playerId: p.playerId, name: p.name, number: p.number, team: teamName, conference: TEAMS_BY_NAME[teamName].conference, class: p.class, role: p.role, twoWay: p.twoWay,
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

  const playerBattingArr = Object.values(playerBatting);
  const playerPitchingArr = Object.values(playerPitching);
  // A player's "primary position" for awards/display purposes is whichever
  // defensive spot they played most this season, not just wherever they
  // happened to start their first game (bench substitution game to game
  // means this can genuinely vary).
  playerBattingArr.forEach((p) => {
    const entries = Object.entries(p.positionCounts);
    p.position = entries.length > 0 ? entries.sort((a, b) => b[1] - a[1])[0][0] : 'UTIL';
    delete p.positionCounts;
  });
  computeWAR(playerBattingArr, playerPitchingArr);
  return { teamTotals: Object.values(teamTotals), playerBatting: playerBattingArr, playerPitching: playerPitchingArr };
}

// A simplified WAR (Wins Above Replacement): a single number combining a
// player's offensive and/or pitching contribution into "wins added versus
// a freely-available replacement-level player." This is NOT a rigorous
// sabermetric WAR -- there's no defense, baserunning, or park factor in
// this sim, so it's built entirely from the batting/pitching events we do
// track. It's meant as a reasonable single-stat way to compare a slugger to
// an ace to a lockdown reliever, not a precise research-grade metric.
//
// Batting side uses linear-weights-style run values (approximate, borrowed
// from published wOBA-style constants) to get runs above the league
// average per plate appearance, then adds a fixed replacement-level
// allowance before converting runs to wins.
// Pitching side compares a pitcher's ERA to the league average and to a
// replacement-level baseline (assumed noticeably worse than average),
// scaled by innings pitched.
function computeWAR(playerBatting, playerPitching) {
  const RUNS_PER_WIN = 10; // standard sabermetric rule-of-thumb constant
  const REPLACEMENT_RUNS_PER_PA = 0.03; // a replacement bat costs ~18 runs/600 PA vs. average
  const W = { BB: 0.69, H1: 0.89, H2: 1.27, H3: 1.62, HR: 2.10 }; // approximate linear weights

  let totalPA = 0;
  let totalWeighted = 0;
  playerBatting.forEach((p) => {
    const pa = p.ab + p.bb;
    const singles = p.h - p.doubles - p.triples - p.hr;
    p._pa = pa;
    p._weighted = W.BB * p.bb + W.H1 * singles + W.H2 * p.doubles + W.H3 * p.triples + W.HR * p.hr;
    totalPA += pa;
    totalWeighted += p._weighted;
  });
  const leagueRatePerPA = totalPA > 0 ? totalWeighted / totalPA : 0;

  playerBatting.forEach((p) => {
    if (p._pa > 0) {
      const runsAboveAvg = p._weighted - leagueRatePerPA * p._pa;
      const runsAboveReplacement = runsAboveAvg + REPLACEMENT_RUNS_PER_PA * p._pa;
      p.war = runsAboveReplacement / RUNS_PER_WIN;
    } else {
      p.war = 0;
    }
    delete p._pa;
    delete p._weighted;
  });

  let totalOuts = 0;
  let totalER = 0;
  playerPitching.forEach((p) => { totalOuts += p.outs; totalER += p.er; });
  const leagueERA = totalOuts > 0 ? (totalER * 21) / totalOuts : 4.0;
  const replacementERA = leagueERA * 1.20; // a replacement arm runs notably hotter than league average

  playerPitching.forEach((p) => {
    if (p.outs > 0) {
      const ip = p.outs / 3;
      const runsSavedVsReplacement = (replacementERA - (p.er * 9) / ip) * (ip / 9);
      p.war = runsSavedVsReplacement / RUNS_PER_WIN;
    } else {
      p.war = 0;
    }
  });
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
      <td>#${r.number} ${playerLink(r.team, r.playerId, r.name)}${r.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td>
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
  const snapshot = getArchiveSnapshot();

  let teamCards;
  let playerCards;
  let archivedNote = '';

  if (snapshot) {
    // Archived snapshots already store the top 10 for each category
    // globally -- filtering to one conference after the fact can come up
    // short of 10 (or empty) if that conference wasn't well represented at
    // the time, since we don't keep the full league list for every past week.
    const filt = (rows) => (confFilter === 'all' ? rows : rows.filter((r) => r.conference === confFilter));
    const fmtPct = (v) => v.toFixed(3).replace(/^0/, '');
    teamCards = {
      avg: teamLeaderCard('Batting AVG', filt(snapshot.teamLeaders.avg), 'AVG', (r) => fmtPct(r.value)),
      slg: teamLeaderCard('Slugging (SLG)', filt(snapshot.teamLeaders.slg), 'SLG', (r) => fmtPct(r.value)),
      hr: teamLeaderCard('Home Runs', filt(snapshot.teamLeaders.hr), 'HR', (r) => r.value),
      era: teamLeaderCard('ERA', filt(snapshot.teamLeaders.era), 'ERA', (r) => r.value.toFixed(2)),
      whip: teamLeaderCard('WHIP', filt(snapshot.teamLeaders.whip), 'WHIP', (r) => r.value.toFixed(2)),
      k: teamLeaderCard('Strikeouts (pitching)', filt(snapshot.teamLeaders.k), 'K', (r) => r.value),
    };
    playerCards = {
      avg: playerLeaderCard('Batting AVG', filt(snapshot.playerLeaders.avg), 'AVG', (r) => fmtPct(r.value)),
      hr: playerLeaderCard('Home Runs', filt(snapshot.playerLeaders.hr), 'HR', (r) => r.value),
      rbi: playerLeaderCard('RBI', filt(snapshot.playerLeaders.rbi), 'RBI', (r) => r.value),
      hits: playerLeaderCard('Hits', filt(snapshot.playerLeaders.hits), 'H', (r) => r.value),
      era: playerLeaderCard('ERA', filt(snapshot.playerLeaders.era), 'ERA', (r) => r.value.toFixed(2)),
      k: playerLeaderCard('Strikeouts (pitching)', filt(snapshot.playerLeaders.k), 'K', (r) => r.value),
      wins: playerLeaderCard('Wins', filt(snapshot.playerLeaders.wins), 'W', (r) => r.value),
    };
    archivedNote = ' Archived snapshots store the top 10 leaguewide, so filtering to one conference may show fewer than 10 (or none) if that conference wasn\'t well represented at the time.';
  } else {
    const played = state.games.some((g) => g.played);
    if (!played) {
      container.innerHTML = '<p class="view-note">Simulate a week to generate league leaders.</p>';
      return;
    }
    const { teamTotals: allTeamTotals, playerBatting: allPlayerBatting, playerPitching: allPlayerPitching } = computeLeagueStats();
    const teamTotals = confFilter === 'all' ? allTeamTotals : allTeamTotals.filter((t) => t.conference === confFilter);
    const playerBatting = confFilter === 'all' ? allPlayerBatting : allPlayerBatting.filter((p) => p.conference === confFilter);
    const playerPitching = confFilter === 'all' ? allPlayerPitching : allPlayerPitching.filter((p) => p.conference === confFilter);

    teamCards = {
      avg: teamLeaderCard('Batting AVG', [...teamTotals].sort((a, b) => b.avg - a.avg), 'AVG', (t) => t.avg.toFixed(3).replace(/^0/, '')),
      slg: teamLeaderCard('Slugging (SLG)', [...teamTotals].sort((a, b) => b.slg - a.slg), 'SLG', (t) => t.slg.toFixed(3).replace(/^0/, '')),
      hr: teamLeaderCard('Home Runs', [...teamTotals].sort((a, b) => b.hr - a.hr), 'HR', (t) => t.hr),
      era: teamLeaderCard('ERA', [...teamTotals].sort((a, b) => a.era - b.era), 'ERA', (t) => t.era.toFixed(2)),
      whip: teamLeaderCard('WHIP', [...teamTotals].sort((a, b) => a.whip - b.whip), 'WHIP', (t) => t.whip.toFixed(2)),
      k: teamLeaderCard('Strikeouts (pitching)', [...teamTotals].sort((a, b) => b.pK - a.pK), 'K', (t) => t.pK),
    };

    const MIN_AB = 40;
    const MIN_OUTS = 60; // 20 innings
    const qualifiedBatters = playerBatting.filter((p) => p.ab >= MIN_AB);
    const qualifiedPitchers = playerPitching.filter((p) => p.outs >= MIN_OUTS);

    // Combined WAR: a two-way player's batting and pitching WAR both count
    // toward one total, same person either way.
    const warByPlayer = {};
    const warInfoById = {};
    playerBatting.forEach((p) => { warByPlayer[p.playerId] = (warByPlayer[p.playerId] || 0) + p.war; warInfoById[p.playerId] = p; });
    playerPitching.forEach((p) => { warByPlayer[p.playerId] = (warByPlayer[p.playerId] || 0) + p.war; if (!warInfoById[p.playerId]) warInfoById[p.playerId] = p; });
    const warRows = Object.keys(warByPlayer).map((id) => ({ ...warInfoById[id], playerId: id, war: warByPlayer[id] }));

    playerCards = {
      war: playerLeaderCard('WAR', [...warRows].sort((a, b) => b.war - a.war), 'WAR', (p) => p.war.toFixed(1)),
      avg: playerLeaderCard('Batting AVG', [...qualifiedBatters].sort((a, b) => (b.h / b.ab) - (a.h / a.ab)), 'AVG', (p) => (p.h / p.ab).toFixed(3).replace(/^0/, '')),
      hr: playerLeaderCard('Home Runs', [...playerBatting].sort((a, b) => b.hr - a.hr), 'HR', (p) => p.hr),
      rbi: playerLeaderCard('RBI', [...playerBatting].sort((a, b) => b.rbi - a.rbi), 'RBI', (p) => p.rbi),
      hits: playerLeaderCard('Hits', [...playerBatting].sort((a, b) => b.h - a.h), 'H', (p) => p.h),
      era: playerLeaderCard('ERA', [...qualifiedPitchers].sort((a, b) => ((a.er * 21) / a.outs) - ((b.er * 21) / b.outs)), 'ERA', (p) => ((p.er * 21) / p.outs).toFixed(2)),
      k: playerLeaderCard('Strikeouts (pitching)', [...playerPitching].sort((a, b) => b.k - a.k), 'K', (p) => p.k),
      wins: playerLeaderCard('Wins', [...playerPitching].sort((a, b) => b.w - a.w), 'W', (p) => p.w),
    };
    archivedNote = ` WAR is a simplified estimate (no defense/baserunning data in this sim) combining batting and pitching value into one number -- treat it as a rough overall-value comparison, not a precise sabermetric figure. Includes postseason games played. Batting rate stats require ${MIN_AB}+ at-bats; pitching rate stats require ${Math.floor(MIN_OUTS / 3)}+ innings. Counting stats (HR, RBI, K, etc.) have no minimum.`;
  }

  const teamSection = document.createElement('div');
  teamSection.className = 'bracket-section';
  teamSection.innerHTML = `
    <h3>Team Leaders</h3>
    <div class="leaderboard-grid">
      ${teamCards.avg}${teamCards.slg}${teamCards.hr}${teamCards.era}${teamCards.whip}${teamCards.k}
    </div>
  `;
  container.appendChild(teamSection);

  const playerSection = document.createElement('div');
  playerSection.className = 'bracket-section';
  playerSection.innerHTML = `
    <h3>Player Leaders</h3>
    <p class="view-note">${archivedNote}</p>
    <div class="leaderboard-grid">
      ${playerCards.war || ''}${playerCards.avg}${playerCards.hr}${playerCards.rbi}${playerCards.hits}${playerCards.era}${playerCards.k}${playerCards.wins}
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
  populateArchiveBar();
  renderSchedule();
  renderStandings();
  renderRankings();
  renderLeaders();
  renderAwards();
  renderPostseason();
  renderTeams();
}

function renderStatus() {
  const el = document.getElementById('weekIndicator');
  const yearPrefix = `Year ${state.dynastyYear} — `;
  if (state.postseason) el.textContent = yearPrefix + 'Postseason complete';
  else if (state.regularSeasonComplete) el.textContent = yearPrefix + 'Regular season complete';
  else el.textContent = yearPrefix + `${state.currentWeek} of ${state.totalWeeks}`;
}

function renderControls() {
  document.getElementById('btnSimWeek').disabled = state.regularSeasonComplete;
  document.getElementById('btnSimToEnd').disabled = state.regularSeasonComplete;
  const postseasonComplete = !!(state.postseason && state.postseason.stage === 'complete');
  const btnPostseason = document.getElementById('btnSimPostseason');
  btnPostseason.disabled = !state.regularSeasonComplete || postseasonComplete;
  btnPostseason.textContent = postseasonComplete ? 'Postseason Complete' : postseasonButtonLabel();
  document.getElementById('btnAdvanceYear').disabled = !postseasonComplete;
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
  const snapshot = getArchiveSnapshot();
  const standings = snapshot ? snapshot.standings : computeStandings(TEAMS, state.games);
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

  const snapshot = getArchiveSnapshot();
  let rpiRows;
  let pollRows;
  if (snapshot) {
    rpiRows = snapshot.rpi;
    pollRows = snapshot.coachesPoll;
  } else {
    const played = state.games.some((g) => g.played);
    if (!played) {
      const note = '<p class="view-note">Simulate a week to generate the first poll.</p>';
      rpiList.innerHTML = note;
      pollList.innerHTML = note;
      return;
    }
    rpiRows = top25(computeRankings(TEAMS, state.games));
    pollRows = top15(computeCoachesPoll(computeStandings(TEAMS, state.games), PROGRAM_PRESTIGE, state.seed));
  }

  rpiRows.forEach((r) => {
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

  pollRows.forEach((r) => {
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
function buildMatchCard(m, path, prefix, clickable = true) {
  const card = document.createElement('div');
  card.className = 'bmatch';
  card.innerHTML = matchCardHTML(m, prefix);
  if (m.a && m.b && clickable) {
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
// `clickable` is false when browsing a past dynasty year's archived
// bracket -- box scores for those aren't regenerable (see the comment on
// getArchivePostseasonBracket), so those matches are shown but inert.
function renderBracketTree(rounds, roundLabels, pathPrefix, clickable = true) {
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
      matchesWrap.appendChild(buildMatchCard(m, [...pathPrefix, i, j], null, clickable));
    });
    col.appendChild(matchesWrap);
    tree.appendChild(col);
  });
  return tree;
}

function renderPostseason() {
  const container = document.getElementById('postseasonContent');
  container.innerHTML = '';

  if (!state.regularSeasonComplete && archiveFilter.year === 'current') {
    container.innerHTML = '<p class="view-note">Finish the regular season to unlock conference tournaments and the NCAA bracket.</p>';
    return;
  }
  const postseason = getArchivePostseasonBracket();
  if (!postseason) {
    container.innerHTML = archiveFilter.year === 'current'
      ? '<p class="view-note">Regular season complete. Click "Sim Conference Tournaments" to get started.</p>'
      : '<p class="view-note">No postseason recorded for that year.</p>';
    return;
  }
  // A past archived year is always fully complete; only the current year's
  // postseason can be mid-reveal, and only the current year's completed
  // matches have working box scores (see renderBracketTree's `clickable`).
  const isCurrent = archiveFilter.year === 'current';
  const clickable = isCurrent;

  const { conferenceTournaments, field, regionals, worldSeriesPreview, worldSeries } = postseason;

  if (worldSeries) {
    const banner = document.createElement('div');
    banner.className = 'champion-banner';
    banner.innerHTML = `${teamBadge(worldSeries.champion.name, 40)}<span>National Champion: ${worldSeries.champion.name}</span>`;
    container.appendChild(banner);
  } else if (isCurrent) {
    const banner = document.createElement('div');
    banner.className = 'champion-banner';
    banner.innerHTML = `<span>Postseason in progress — click "${postseasonButtonLabel()}" above to continue</span>`;
    container.appendChild(banner);
  }

  if (conferenceTournaments) {
    const confSection = document.createElement('div');
    confSection.className = 'bracket-section';
    confSection.innerHTML = `<h3>Conference Tournaments ${clickable ? '<span class="view-note">click any match for its box score</span>' : ''}</h3>`;
    conferenceTournaments.forEach((ct, ci) => {
      const confWrap = document.createElement('div');
      confWrap.className = 'conf-tourney-block';
      confWrap.innerHTML = `<div class="conf-champ-line"><strong>${ct.conference}</strong> champion: <span class="winner">${teamLink(ct.champion.name)}</span></div>`;
      confWrap.appendChild(renderBracketTree(ct.rounds, null, ['conferenceTournaments', ci, 'rounds'], clickable));
      confSection.appendChild(confWrap);
    });
    container.appendChild(confSection);
  }

  if (field) {
    const fieldSection = document.createElement('div');
    fieldSection.className = 'bracket-section';
    fieldSection.innerHTML = '<h3>NCAA Field (Seeded 1–16) <span class="view-note">seeding blends RPI, top-10 wins, conference tournament result, strength of schedule, and head-to-head</span></h3>';
    const table = document.createElement('table');
    table.className = 'standings-table';
    table.style.width = '100%';
    table.innerHTML = '<thead><tr><th>Seed</th><th>Team</th><th>Berth</th><th>RPI</th><th>Top-10 Wins</th><th>SOS (OWP)</th></tr></thead>';
    const tbody = document.createElement('tbody');
    field.forEach((f) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${f.seed}</td><td>${teamLink(f.name)}</td><td>${f.berth}</td><td>${f.rpi.toFixed(3)}</td><td>${f.top10Wins}</td><td>${f.owp.toFixed(3)}</td>`;
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    fieldSection.appendChild(table);
    container.appendChild(fieldSection);
  }

  if (regionals) {
    const regSection = document.createElement('div');
    regSection.className = 'bracket-section';
    regSection.innerHTML = `<h3>Regionals (Best-of-3) ${clickable ? '<span class="view-note">click for the series\' box scores</span>' : ''}</h3>`;
    const regGrid = document.createElement('div');
    regGrid.className = 'bracket-grid';
    regionals.forEach((m, i) => {
      regGrid.appendChild(buildMatchCard(m, ['regionals', i], null, clickable));
    });
    regSection.appendChild(regGrid);
    container.appendChild(regSection);
  }

  // World Series: either just the revealed Round 1 bracket (no results
  // yet), or -- once simulated -- the full double-elimination bracket with
  // winners' bracket, losers' bracket, and grand final.
  if (worldSeriesPreview && !worldSeries) {
    const previewSection = document.createElement('div');
    previewSection.className = 'bracket-section';
    previewSection.innerHTML = '<h3>World Series Bracket <span class="view-note">set — click "Sim World Series" above to play it out</span></h3>';
    const previewGrid = document.createElement('div');
    previewGrid.className = 'bracket-grid';
    worldSeriesPreview.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'bmatch';
      card.innerHTML = matchCardHTML(m);
      previewGrid.appendChild(card);
    });
    previewSection.appendChild(previewGrid);
    container.appendChild(previewSection);
  }

  if (worldSeries) {
    const wsSection = document.createElement('div');
    wsSection.className = 'bracket-section';
    wsSection.innerHTML = `<h3>World Series <span class="view-note">(double elimination)${clickable ? ' — click any match for its box score' : ''}</span></h3>`;

    const wbLabel = document.createElement('div');
    wbLabel.className = 'ws-bracket-label';
    wbLabel.textContent = "Winners' Bracket";
    wsSection.appendChild(wbLabel);
    wsSection.appendChild(renderBracketTree(worldSeries.winnersBracket, ['Round 1', 'Semifinal', "Winners' Final"], ['worldSeries', 'winnersBracket'], clickable));

    const lbLabel = document.createElement('div');
    lbLabel.className = 'ws-bracket-label';
    lbLabel.textContent = "Losers' Bracket";
    wsSection.appendChild(lbLabel);
    wsSection.appendChild(renderBracketTree(worldSeries.losersBracket, ['Round 1', 'Round 2', 'Round 3', "Losers' Final"], ['worldSeries', 'losersBracket'], clickable));

    const gfLabel = document.createElement('div');
    gfLabel.className = 'ws-bracket-label';
    gfLabel.textContent = "Grand Final (winners' bracket champion must lose twice)";
    wsSection.appendChild(gfLabel);
    const gfGrid = document.createElement('div');
    gfGrid.className = 'bracket-grid';
    gfGrid.appendChild(buildMatchCard(worldSeries.grandFinal.game1, ['worldSeries', 'grandFinal', 'game1'], 'Game 1', clickable));
    if (worldSeries.grandFinal.game2) {
      gfGrid.appendChild(buildMatchCard(worldSeries.grandFinal.game2, ['worldSeries', 'grandFinal', 'game2'], 'Game 2 (if necessary)', clickable));
    }
    wsSection.appendChild(gfGrid);
    container.appendChild(wsSection);
  }
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

// Shared badge renderer: an uploaded logo (rendered exactly as stored, no
// further cropping -- see resizeImageFile for how it got fit into a square)
// or a generated colored square with initials. Used by both teamBadge and
// confBadge.
function buildBadgeHTML(customLogo, colors, initials, size, extraClass, altText) {
  if (customLogo) {
    return `<img class="team-badge ${extraClass}" width="${size}" height="${size}" src="${customLogo}" alt="${altText}">`;
  }
  const fontSize = initials.length >= 3 ? 34 : 46;
  return `<svg class="team-badge ${extraClass}" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <rect x="4" y="4" width="92" height="92" rx="14" fill="${colors.primary}" stroke="${colors.secondary}" stroke-width="7"/>
    <text x="50" y="53" text-anchor="middle" dominant-baseline="middle" font-family="'Space Grotesk', sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff">${initials}</text>
  </svg>`;
}

function teamBadge(name, size = 20, extraClass = '') {
  const customLogo = customLogos[name];
  const team = TEAMS_BY_NAME[name];
  if (!customLogo && !team) return '';
  const colors = (team && team.colors) || { primary: '#0F3324', secondary: '#D7E600' };
  const initials = (team && (team.abbr || name.slice(0, 3)).slice(0, 3)) || name.slice(0, 3);
  return buildBadgeHTML(customLogo, colors, initials, size, extraClass, `${name} logo`);
}

function confBadge(confName, size = 20, extraClass = '') {
  const customLogo = customConfLogos[confName];
  const color = CONFERENCES[confName]?.color || '#0F3324';
  return buildBadgeHTML(customLogo, { primary: color, secondary: '#ffffff' }, confName.slice(0, 4), size, extraClass, `${confName} logo`);
}

function teamLink(name, opts = {}) {
  const size = opts.size || 20;
  const badge = opts.noBadge ? '' : teamBadge(name, size);
  return `<span class="team-link" data-team="${name}">${badge}<span class="team-link-name">${name}</span></span>`;
}

function playerLink(teamName, playerId, displayName) {
  return `<span class="player-link" data-player-team="${teamName}" data-player-id="${playerId}">${displayName}</span>`;
}

function openPlayerModal(teamName, playerId) {
  const instances = findPlayerInstances(teamName, playerId);
  if (instances.length === 0) return;
  const team = TEAMS_BY_NAME[teamName];
  const hitterInfo = instances.find((p) => p.ratings && p.ratings.contact !== undefined);
  const pitcherInfo = instances.find((p) => p.ratings && p.ratings.stuff !== undefined);
  const primary = hitterInfo || pitcherInfo;
  const isTwoWay = !!(hitterInfo && pitcherInfo);

  const { battingLog, pitchingLog } = computePlayerGameLog(teamName, playerId);

  const roleLabel = isTwoWay
    ? `Two-Way — ${hitterInfo.position} / ${pitcherInfo.role}`
    : pitcherInfo ? pitcherInfo.role : hitterInfo.position;

  // Current-season WAR needs league-wide context, so it's computed via the
  // same league pass the Leaders tab uses, then looked up for this player.
  const leagueStatsForWar = computeLeagueStats();
  const playerWar = leagueStatsForWar.playerBatting.filter((p) => p.playerId === playerId).reduce((s, p) => s + p.war, 0)
    + leagueStatsForWar.playerPitching.filter((p) => p.playerId === playerId).reduce((s, p) => s + p.war, 0);

  // Award badges: current season's awards only need computing if the
  // season has actually generated any (games played); past seasons come
  // straight from the archive.
  const currentSeasonAwards = state.games.some((g) => g.played) ? computeAwards() : null;
  const awardBadges = getPlayerAwardBadges(playerId, currentSeasonAwards);
  const awardBadgesHTML = awardBadges.length > 0
    ? `<div class="award-badges">${awardBadges.map((a) => `<span class="award-badge" title="${a.year}">🏆 ${a.label} (${a.year})</span>`).join('')}</div>`
    : '';

  // Season totals, rolled up from the game log.
  const bt = battingLog.reduce((acc, b) => {
    acc.ab += b.ab; acc.h += b.h; acc.bb += b.bb; acc.r += b.r; acc.rbi += b.rbi;
    acc.hr += b.hr; acc.doubles += b.doubles; acc.triples += b.triples; acc.k += b.k;
    return acc;
  }, { ab: 0, h: 0, bb: 0, r: 0, rbi: 0, hr: 0, doubles: 0, triples: 0, k: 0 });
  const pt = pitchingLog.reduce((acc, p) => {
    acc.outs += p.outs; acc.h += p.h; acc.er += p.er; acc.bb += p.bb; acc.k += p.k;
    if (p.decision === 'W') acc.w += 1;
    if (p.decision === 'L') acc.l += 1;
    if (p.decision === 'SV') acc.sv += 1;
    return acc;
  }, { outs: 0, h: 0, er: 0, bb: 0, k: 0, w: 0, l: 0, sv: 0 });

  const fmt3 = (x) => x.toFixed(3).replace(/^0/, '');
  const battingSummary = battingLog.length > 0 ? (() => {
    const avg = bt.ab > 0 ? bt.h / bt.ab : 0;
    const obp = (bt.ab + bt.bb) > 0 ? (bt.h + bt.bb) / (bt.ab + bt.bb) : 0;
    const tb = bt.h + bt.doubles + 2 * bt.triples + 3 * bt.hr;
    const slg = bt.ab > 0 ? tb / bt.ab : 0;
    return `AVG ${fmt3(avg)} · OBP ${fmt3(obp)} · SLG ${fmt3(slg)} · OPS ${fmt3(obp + slg)} · ${bt.hr} HR · ${bt.rbi} RBI`;
  })() : '';
  const pitchingSummary = pitchingLog.length > 0 ? (() => {
    const era = pt.outs > 0 ? ((pt.er * 21) / pt.outs).toFixed(2) : '0.00';
    const whip = pt.outs > 0 ? ((pt.bb + pt.h) / (pt.outs / 3)).toFixed(2) : '0.00';
    const kPer7 = pt.outs > 0 ? ((pt.k * 21) / pt.outs).toFixed(1) : '0.0';
    return `${pt.w}-${pt.l}${pt.sv ? `, ${pt.sv}sv` : ''} · ERA ${era} · WHIP ${whip} · K/7 ${kPer7} · ${outsToIp(pt.outs)} IP`;
  })() : '';

  // Career: one row per year this player recorded stats, in the same
  // column format as the team's season-stats table, so a player's full
  // body of work reads like a normal stat sheet rather than a summary
  // blurb. Past years come from state.history; the in-progress year is
  // rolled up from the live game log above.
  const battingLine = (year, cls, b) => {
    const avg = b.ab > 0 ? b.h / b.ab : 0;
    const obp = (b.ab + b.bb) > 0 ? (b.h + b.bb) / (b.ab + b.bb) : 0;
    const tb = b.h + b.doubles + 2 * b.triples + 3 * b.hr;
    const slg = b.ab > 0 ? tb / b.ab : 0;
    return `<tr><td>${year}</td><td>${cls}</td><td>${b.ab}</td><td>${b.h}</td><td>${b.r}</td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td><td>${b.hr}</td><td>${fmt3(avg)}</td><td>${fmt3(obp)}</td><td>${fmt3(slg)}</td><td>${fmt3(obp + slg)}</td></tr>`;
  };
  const pitchingLine = (year, cls, p) => {
    const era = ((p.er * 21) / p.outs).toFixed(2);
    const whip = ((p.bb + p.h) / (p.outs / 3)).toFixed(2);
    const kPer7 = ((p.k * 21) / p.outs).toFixed(1);
    const oba = (p.outs + p.h) > 0 ? (p.h / (p.outs + p.h)).toFixed(3).replace(/^0/, '') : '.000';
    return `<tr><td>${year}</td><td>${cls}</td><td>${p.w}-${p.l}</td><td>${outsToIp(p.outs)}</td><td>${p.h}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td><td>${era}</td><td>${whip}</td><td>${kPer7}</td><td>${oba}</td></tr>`;
  };

  const careerBattingSeasons = [];
  const careerPitchingSeasons = [];
  state.history.forEach((h) => {
    const s = h.playerStats[playerId];
    if (!s) return;
    if (s.batting && s.batting.ab > 0) careerBattingSeasons.push(s.batting);
    if (s.pitching && s.pitching.outs > 0) careerPitchingSeasons.push(s.pitching);
  });
  if (bt.ab > 0) careerBattingSeasons.push(bt);
  if (pt.outs > 0) careerPitchingSeasons.push(pt);

  const careerBattingRows = [];
  const careerPitchingRows = [];
  state.history.forEach((h) => {
    const s = h.playerStats[playerId];
    if (!s) return;
    if (s.batting && s.batting.ab > 0) careerBattingRows.push(battingLine(h.year, s.class, s.batting));
    if (s.pitching && s.pitching.outs > 0) careerPitchingRows.push(pitchingLine(h.year, s.class, s.pitching));
  });
  if (bt.ab > 0) careerBattingRows.push(battingLine(state.dynastyYear, primary.class, bt));
  if (pt.outs > 0) careerPitchingRows.push(pitchingLine(state.dynastyYear, primary.class, pt));

  // A totals row at the bottom, same as a real career stat sheet -- only
  // worth showing once there's more than one season to actually total up.
  const sumSeasons = (seasons, keys) => {
    const total = {};
    keys.forEach((k) => { total[k] = 0; });
    seasons.forEach((s) => keys.forEach((k) => { total[k] += s[k] || 0; }));
    return total;
  };
  if (careerBattingSeasons.length > 1) {
    const total = sumSeasons(careerBattingSeasons, ['ab', 'h', 'bb', 'r', 'rbi', 'hr', 'doubles', 'triples', 'k']);
    careerBattingRows.push(battingLine('Career', `${careerBattingSeasons.length} yrs`, total).replace('<tr>', '<tr class="career-total-row">'));
  }
  if (careerPitchingSeasons.length > 1) {
    const total = sumSeasons(careerPitchingSeasons, ['outs', 'h', 'er', 'bb', 'k', 'w', 'l', 'sv']);
    careerPitchingRows.push(pitchingLine('Career', `${careerPitchingSeasons.length} yrs`, total).replace('<tr>', '<tr class="career-total-row">'));
  }

  const gameTag = (g) => (g.isPostseason ? 'Postseason' : `wk ${g.week}`);
  const battingLogRows = battingLog.map((b) => `
    <tr>
      <td>${gameTag(b)}</td><td>vs ${teamLink(b.opponent)}</td>
      <td>${b.ab}</td><td>${b.h}</td><td>${b.r}</td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td><td>${b.hr}</td>
    </tr>`).join('');
  const pitchingLogRows = pitchingLog.map((p) => `
    <tr>
      <td>${gameTag(p)}</td><td>vs ${teamLink(p.opponent)}</td>
      <td>${p.ip}</td><td>${p.h}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td><td>${p.decision || ''}</td>
    </tr>`).join('');

  document.getElementById('modalContent').innerHTML = `
    <div class="tp-header">
      ${teamBadge(teamName, 56, 'team-badge-lg')}
      <div>
        <h2>#${primary.number} ${primary.name}${isTwoWay ? ' <span class="two-way-tag">TW</span>' : ''}</h2>
        <p class="tp-sub">${primary.class} · ${roleLabel} · ${teamLink(teamName)}</p>
        <p class="tp-sub tp-tiers">${playerWar.toFixed(1)} WAR this season <span class="view-note">(simplified estimate)</span></p>
        ${awardBadgesHTML}
      </div>
    </div>

    <div class="tp-schedule-title">Ratings <span class="view-note">20-80 scale, 50 = league average</span></div>
    <div class="tp-roster-tables">
      ${hitterInfo ? `
      <table class="standings-table tp-mini-table">
        <thead><tr><th>Contact</th><th>Power</th><th>Eye</th></tr></thead>
        <tbody><tr><td>${hitterInfo.ratings.contact}</td><td>${hitterInfo.ratings.power}</td><td>${hitterInfo.ratings.eye}</td></tr></tbody>
      </table>` : ''}
      ${pitcherInfo ? `
      <table class="standings-table tp-mini-table">
        <thead><tr><th>Stuff</th><th>Control</th><th>Movement</th></tr></thead>
        <tbody><tr><td>${pitcherInfo.ratings.stuff}</td><td>${pitcherInfo.ratings.control}</td><td>${pitcherInfo.ratings.movement}</td></tr></tbody>
      </table>` : ''}
    </div>

    ${careerBattingRows.length > 0 || careerPitchingRows.length > 0 ? `
    <div class="tp-schedule-title">Career</div>
    <div class="tp-stacked-tables">
      ${careerBattingRows.length > 0 ? `
      <table class="standings-table tp-mini-table">
        <thead><tr><th>Year</th><th>Cl</th><th>AB</th><th>H</th><th>R</th><th>RBI</th><th>BB</th><th>K</th><th>HR</th><th>AVG</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
        <tbody>${careerBattingRows.join('')}</tbody>
      </table>` : ''}
      ${careerPitchingRows.length > 0 ? `
      <table class="standings-table tp-mini-table">
        <thead><tr><th>Year</th><th>Cl</th><th>W-L</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>ERA</th><th>WHIP</th><th>K/7</th><th>OBA</th></tr></thead>
        <tbody>${careerPitchingRows.join('')}</tbody>
      </table>` : ''}
    </div>
    ` : ''}

    ${careerBattingRows.length === 0 && careerPitchingRows.length === 0 ? '<p class="view-note">No games played yet.</p>' : ''}

    <div class="tp-stacked-tables">
      ${battingLog.length > 0 ? `
      <div>
        <div class="tp-schedule-title">Batting Log (${battingLog.length})</div>
        <table class="standings-table tp-mini-table">
          <thead><tr><th></th><th>Opp</th><th>AB</th><th>H</th><th>R</th><th>RBI</th><th>BB</th><th>K</th><th>HR</th></tr></thead>
          <tbody>${battingLogRows}</tbody>
        </table>
      </div>` : ''}
      ${pitchingLog.length > 0 ? `
      <div>
        <div class="tp-schedule-title">Pitching Log (${pitchingLog.length})</div>
        <table class="standings-table tp-mini-table">
          <thead><tr><th></th><th>Opp</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th></th></tr></thead>
          <tbody>${pitchingLogRows}</tbody>
        </table>
      </div>` : ''}
    </div>
  `;

  document.getElementById('teamModalOverlay').classList.add('open');
}

function conferenceLink(confName) {
  const color = CONFERENCES[confName]?.color || 'var(--field-green)';
  return `<span class="conf-link" data-conf="${confName}" style="--conf-link-color:${color}">${confName}</span>`;
}

function openConferenceModal(confName) {
  const confTeams = TEAMS.filter((t) => t.conference === confName);
  if (confTeams.length === 0) return;

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
      <div class="tp-badge-wrap">
        ${confBadge(confName, 56, 'team-badge-lg')}
        <button class="badge-upload-btn" data-upload-conf="${confName}" title="Upload a logo for ${confName}">⤒</button>
      </div>
      <div>
        <h2>${confName}</h2>
        <p class="tp-sub">${confTeams.length} teams</p>
        <p class="tp-logo-actions">
          <button class="link-btn" data-upload-conf="${confName}">Upload logo</button>
          ${customConfLogos[confName] ? `· <button class="link-btn" data-reset-logo-conf="${confName}">Reset to default</button>` : ''}
        </p>
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

  // Dynasty history: past seasons' records for this team, and the coach's
  // cumulative record across the whole dynasty (including the season in
  // progress).
  const teamHistory = state.history
    .map((h) => ({
      year: h.year,
      record: h.teamRecords[name],
      confChamp: h.conferenceChamps[team.conference] === name,
      natChamp: h.nationalChampion === name,
    }))
    .filter((h) => h.record);
  const coachWins = teamHistory.reduce((sum, h) => sum + h.record.wins, 0) + row.wins;
  const coachLosses = teamHistory.reduce((sum, h) => sum + h.record.losses, 0) + row.losses;
  const seasonsCoached = teamHistory.length + 1;
  const historyRows = teamHistory.slice().reverse().map((h) => {
    const postseasonNote = h.natChamp ? 'National Champion' : h.confChamp ? 'Conf. Tournament Champion' : '';
    return `<tr><td>Year ${h.year}</td><td>${h.record.wins}-${h.record.losses}</td><td>${h.record.confWins}-${h.record.confLosses}</td><td>${postseasonNote}</td></tr>`;
  }).join('');

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
      <td>#${b.number}</td><td>${playerLink(name, b.playerId, b.name)}${b.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${b.class}</td><td>${b.position}</td>
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
      <td>#${p.number}</td><td>${p.role} ${playerLink(name, p.playerId, p.name)}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.w}-${p.l}${p.sv ? `, ${p.sv}sv` : ''}</td>
      <td>${ip}</td><td>${p.h}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td><td>${era}</td><td>${whip}</td><td>${kPer7}</td><td>${oba}</td>
    </tr>`;
  }).join('');

  // Full 25-man roster (independent of whether they've recorded a stat line
  // yet) -- lineup + bench hitters, then the full pitching staff.
  const rosterHitterRows = [...roster.lineup, ...roster.bench].map((p) => `
    <tr>
      <td>#${p.number}</td><td>${playerLink(name, p.id, p.name)}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.position}</td>
      <td>${p.ratings.contact}</td><td>${p.ratings.power}</td><td>${p.ratings.eye}</td>
    </tr>`).join('');
  const rosterPitcherRows = roster.pitchers.map((p) => `
    <tr>
      <td>#${p.number}</td><td>${playerLink(name, p.id, p.name)}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.role}</td>
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
        <p class="tp-sub">${conferenceLink(team.conference)} · Head Coach ${team.coach} (${coachWins}-${coachLosses}, ${seasonsCoached} season${seasonsCoached > 1 ? 's' : ''})</p>
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

    ${teamHistory.length > 0 ? `
    <div class="tp-schedule-title">Dynasty History</div>
    <table class="standings-table tp-mini-table">
      <thead><tr><th>Year</th><th>Record</th><th>Conf</th><th>Postseason</th></tr></thead>
      <tbody>${historyRows}</tbody>
    </table>
    ` : ''}

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
        <td>#${b.number}</td><td>${b.battingOrder}. ${playerLink(teamName, b.playerId, b.name)}${b.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${b.class}</td><td>${b.position}</td>
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

  function pitchingTable(side, teamName) {
    const rows = result.boxscore[side].pitching.map((p) => `
      <tr>
        <td>#${p.number}</td><td>${p.role} ${playerLink(teamName, p.playerId, p.name)}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.ip}</td><td>${p.h}</td><td>${p.r}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td>
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
      ${pitchingTable('away', awayName)}
      ${pitchingTable('home', homeName)}
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
    const playerEl = e.target.closest('[data-player-id]');
    if (playerEl) { openPlayerModal(playerEl.dataset.playerTeam, playerEl.dataset.playerId); return; }
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
  document.getElementById('btnSimPostseason').addEventListener('click', advancePostseasonStage);
  document.getElementById('btnAdvanceYear').addEventListener('click', advanceToNextSeason);
  document.getElementById('leaderConfFilter').addEventListener('change', renderLeaders);
  document.getElementById('awardsScope').addEventListener('change', renderAwards);
  document.getElementById('btnReset').addEventListener('click', () => {
    if (confirm('Start a brand new dynasty? This clears all current results AND all dynasty history (past seasons, career stats). If you just want next season, use "Advance to Next Season" instead.')) newSeason();
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
    wireArchiveBar();
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
