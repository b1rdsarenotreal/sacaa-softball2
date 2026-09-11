import { generateSchedule } from './engine/schedule.js';
import { computeLeagueAverages, simulateGame } from './engine/sim.js';
import { generateRosters, buildGameRoster, pickStarterForGame, computeProgramTiers } from './engine/roster.js';
import { computeStandings, standingsByConference, overallStandings } from './engine/standings.js';
import { computeRankings, top25 } from './engine/rankings.js';
import { runConferenceTournament, selectField, runRegionals, runWorldSeries, roundLabel } from './engine/postseason.js';

const STORAGE_KEY = 'sacaa-season-v2'; // bumped from v1: roster shape changed from stat-based to ratings-based
const SCHEMA_VERSION = 2;
const LOGO_STORAGE_KEY = 'sacaa-custom-logos-v1';

let TEAMS = [];
let TEAMS_BY_NAME = {};
let CONFERENCES = {};
let PROGRAM_TIERS = {};
let LEAGUE = null;
let state = null;
let customLogos = {};
let pendingLogoTeam = null;

function loadCustomLogos() {
  try {
    customLogos = JSON.parse(localStorage.getItem(LOGO_STORAGE_KEY) || '{}');
  } catch {
    customLogos = {};
  }
}

function saveCustomLogos() {
  try {
    localStorage.setItem(LOGO_STORAGE_KEY, JSON.stringify(customLogos));
  } catch {
    alert("Couldn't save that logo — it may be too large. Try a smaller image.");
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

function setCustomLogo(teamName, dataUrl) {
  customLogos[teamName] = dataUrl;
  saveCustomLogos();
}

function clearCustomLogo(teamName) {
  delete customLogos[teamName];
  saveCustomLogos();
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
  document.addEventListener('click', (e) => {
    const uploadBtn = e.target.closest('[data-upload-team]');
    if (uploadBtn) {
      pendingLogoTeam = uploadBtn.dataset.uploadTeam;
      fileInput.click();
      return;
    }
    const resetBtn = e.target.closest('[data-reset-logo-team]');
    if (resetBtn) {
      clearCustomLogo(resetBtn.dataset.resetLogoTeam);
      refreshAfterLogoChange(resetBtn.dataset.resetLogoTeam);
    }
  });
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    fileInput.value = '';
    if (!file || !pendingLogoTeam) return;
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
    resizeImageFile(file, 160, (dataUrl) => {
      setCustomLogo(pendingLogoTeam, dataUrl);
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

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Failed to save season:', err);
    throw new Error(
      err && err.name === 'QuotaExceededError'
        ? "Your browser's storage is full. Try clearing old data (see the New Season button's tooltip) or removing some custom logos."
        : `Failed to save: ${(err && err.message) || err}`
    );
  }
}

// A couple of earlier versions of this app used different localStorage key
// names as the save-data shape changed; those old entries never got cleaned
// up and just sit there taking up quota. Clear known-obsolete keys once.
function cleanupLegacyStorage() {
  ['sacaa-season-v1'].forEach((key) => {
    if (key !== STORAGE_KEY) localStorage.removeItem(key);
  });
}

// If a saved season predates the current data shape (e.g. an older version
// of the roster/player format), silently loading it would crash the sim the
// first time it touches a field that no longer exists. Rather than let that
// happen, treat a schema mismatch the same as "no save" and start fresh.
function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.schemaVersion !== SCHEMA_VERSION) return null;
    // A save from before the postseason-bloat fix may still be carrying full
    // roster/team/boxscore copies on every match; strip them on load too so
    // re-saving (which happens right after load) actually shrinks it.
    if (parsed.postseason) stripHeavyFieldsDeep(parsed.postseason);
    return parsed;
  } catch {
    return null;
  }
}

function newSeason() {
  try {
    state = freshState(Date.now() % 1000000);
    saveState();
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

// Regular-season box scores are NOT persisted (they'd bloat localStorage --
// ~1,200 games x ~24 player lines each). Since the sim is fully seeded and
// deterministic, we just re-run the exact same game on demand whenever a box
// score is actually needed (e.g. opening the box score modal, or building a
// team's season stat totals). Re-simulating one game takes well under a
// millisecond, so this is effectively free.
function regenerateGameResult(game) {
  const homeGR = gameRosterFor(game.home, game.gameOfSeries);
  const awayGR = gameRosterFor(game.away, game.gameOfSeries);
  return simulateGame(awayGR, homeGR, LEAGUE, game.id * 7919 + state.seed);
}

function simWeek() {
  if (state.regularSeasonComplete) return;
  try {
    const week = state.currentWeek;
    const weekGames = state.games.filter((g) => g.week === week && !g.played);
    weekGames.forEach((g) => {
      const homeGR = gameRosterFor(g.home, g.gameOfSeries);
      const awayGR = gameRosterFor(g.away, g.gameOfSeries);
      const r = simulateGame(awayGR, homeGR, LEAGUE, g.id * 7919 + state.seed);
      g.played = true;
      g.result = { homeScore: r.homeScore, awayScore: r.awayScore, innings: r.innings, awayLine: r.awayLine, homeLine: r.homeLine, mercyRule: r.mercyRule };
    });
    if (week >= state.totalWeeks) {
      state.regularSeasonComplete = true;
    } else {
      state.currentWeek = week + 1;
    }
    saveState();
    renderAll();
    setMessage(`Week ${week} simulated (${weekGames.length} games).`);
  } catch (err) {
    console.error('Week simulation failed:', err);
    setMessage(`Week simulation failed: ${(err && err.message) || err} — try "New Season" to reset, or check the console (F12) for details.`);
  }
}

function simToEnd() {
  try {
    let guard = 0;
    while (!state.regularSeasonComplete && guard < 20) {
      simWeekQuiet();
      guard += 1;
    }
    saveState();
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
  weekGames.forEach((g) => {
    const homeGR = gameRosterFor(g.home, g.gameOfSeries);
    const awayGR = gameRosterFor(g.away, g.gameOfSeries);
    const r = simulateGame(awayGR, homeGR, LEAGUE, g.id * 7919 + state.seed);
    g.played = true;
    g.result = { homeScore: r.homeScore, awayScore: r.awayScore, innings: r.innings, awayLine: r.awayLine, homeLine: r.homeLine, mercyRule: r.mercyRule };
  });
  if (week >= state.totalWeeks) state.regularSeasonComplete = true;
  else state.currentWeek = week + 1;
}

function simPostseason() {
  if (!state.regularSeasonComplete) return;
  try {
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

    const postseason = { conferenceTournaments, field, regionals, worldSeries };
    stripHeavyFieldsDeep(postseason);
    state.postseason = postseason;
    saveState();
    renderAll();
    setMessage(`National Champion: ${worldSeries.champion.name}!`);
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
  state.games
    .filter((g) => g.played && (g.home === teamName || g.away === teamName))
    .forEach((g) => {
      const result = regenerateGameResult(g);
      const side = g.home === teamName ? 'home' : 'away';
      result.boxscore[side].batting.forEach((b) => {
        if (!battingTotals[b.playerId]) {
          battingTotals[b.playerId] = {
            name: b.name, class: b.class, position: b.position, battingOrder: b.battingOrder, twoWay: b.twoWay,
            ab: 0, h: 0, r: 0, rbi: 0, bb: 0, k: 0, doubles: 0, triples: 0, hr: 0,
          };
        }
        const t = battingTotals[b.playerId];
        t.ab += b.ab; t.h += b.h; t.r += b.r; t.rbi += b.rbi; t.bb += b.bb; t.k += b.k;
        t.doubles += b.doubles; t.triples += b.triples; t.hr += b.hr;
      });
      result.boxscore[side].pitching.forEach((p) => {
        if (!pitchingTotals[p.playerId]) {
          pitchingTotals[p.playerId] = { name: p.name, class: p.class, role: p.role, twoWay: p.twoWay, outs: 0, h: 0, r: 0, er: 0, bb: 0, k: 0, w: 0, l: 0, sv: 0 };
        }
        const t = pitchingTotals[p.playerId];
        t.outs += p.outs; t.h += p.h; t.r += p.r; t.er += p.er; t.bb += p.bb; t.k += p.k;
        if (p.decision === 'W') t.w += 1;
        if (p.decision === 'L') t.l += 1;
        if (p.decision === 'SV') t.sv += 1;
      });
    });

  const batting = Object.values(battingTotals).sort((a, b) => a.battingOrder - b.battingOrder);
  const pitching = Object.values(pitchingTotals).sort((a, b) => b.outs - a.outs);
  return { batting, pitching };
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
  const list = document.getElementById('rankingsList');
  list.innerHTML = '';
  const rankings = computeRankings(TEAMS, state.games);
  const played = state.games.some((g) => g.played);
  if (!played) {
    list.innerHTML = '<p class="view-note">Simulate a week to generate the first poll.</p>';
    return;
  }
  top25(rankings).forEach((r) => {
    const li = document.createElement('li');
    li.className = 'rank-row';
    li.innerHTML = `
      <span class="rank-num">${r.rank}</span>
      <span class="rank-team">${teamLink(r.name)}<span class="rank-conf">${r.conference}</span></span>
      <span class="rank-record">${r.record}</span>
      <span class="rank-rpi">${r.rpi.toFixed(3)}</span>
    `;
    list.appendChild(li);
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

// Renders a full tree: one column per round, connector lines between
// rounds, each round's matches vertically centered against their feeders
// via flexbox. Works for any bracket whose round sizes halve each step
// (which every bracket in this app does).
function renderBracketTree(rounds, roundLabels) {
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
    round.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'bmatch';
      card.innerHTML = matchCardHTML(m);
      matchesWrap.appendChild(card);
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
  confSection.innerHTML = '<h3>Conference Tournaments</h3>';
  conferenceTournaments.forEach((ct) => {
    const confWrap = document.createElement('div');
    confWrap.className = 'conf-tourney-block';
    confWrap.innerHTML = `<div class="conf-champ-line"><strong>${ct.conference}</strong> champion: <span class="winner">${teamLink(ct.champion.name)}</span></div>`;
    confWrap.appendChild(renderBracketTree(ct.rounds));
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
  regSection.innerHTML = '<h3>Regionals (Best-of-3)</h3>';
  const regGrid = document.createElement('div');
  regGrid.className = 'bracket-grid';
  regionals.forEach((m) => {
    const card = document.createElement('div');
    card.className = 'bmatch';
    card.innerHTML = matchCardHTML(m);
    regGrid.appendChild(card);
  });
  regSection.appendChild(regGrid);
  container.appendChild(regSection);

  // World Series -- true double elimination: winners' bracket tree, losers'
  // bracket tree, then the grand final (with an "if necessary" decider).
  const wsSection = document.createElement('div');
  wsSection.className = 'bracket-section';
  wsSection.innerHTML = '<h3>World Series <span class="view-note">(double elimination)</span></h3>';

  const wbLabel = document.createElement('div');
  wbLabel.className = 'ws-bracket-label';
  wbLabel.textContent = "Winners' Bracket";
  wsSection.appendChild(wbLabel);
  wsSection.appendChild(renderBracketTree(worldSeries.winnersBracket, ['Round 1', 'Semifinal', "Winners' Final"]));

  const lbLabel = document.createElement('div');
  lbLabel.className = 'ws-bracket-label';
  lbLabel.textContent = "Losers' Bracket";
  wsSection.appendChild(lbLabel);
  wsSection.appendChild(renderBracketTree(worldSeries.losersBracket, ['Round 1', 'Round 2', 'Round 3', "Losers' Final"]));

  const gfLabel = document.createElement('div');
  gfLabel.className = 'ws-bracket-label';
  gfLabel.textContent = "Grand Final (winners' bracket champion must lose twice)";
  wsSection.appendChild(gfLabel);
  const gfGrid = document.createElement('div');
  gfGrid.className = 'bracket-grid';
  const gf1Card = document.createElement('div');
  gf1Card.className = 'bmatch';
  gf1Card.innerHTML = matchCardHTML(worldSeries.grandFinal.game1, 'Game 1');
  gfGrid.appendChild(gf1Card);
  if (worldSeries.grandFinal.game2) {
    const gf2Card = document.createElement('div');
    gf2Card.className = 'bmatch';
    gf2Card.innerHTML = matchCardHTML(worldSeries.grandFinal.game2, 'Game 2 (if necessary)');
    gfGrid.appendChild(gf2Card);
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
        <p>${t.conference} · ${t.coach}</p>
        <div class="stat-line">Historically: <strong>${tiers.battingTier || '—'}</strong> hitting, <strong>${tiers.pitchingTier || '—'}</strong> pitching</div>
      </div>
    `;
    grid.appendChild(card);
  });
}

function teamBadge(name, size = 20, extraClass = '') {
  const customLogo = customLogos[name];
  if (customLogo) {
    return `<img class="team-badge ${extraClass}" width="${size}" height="${size}" src="${customLogo}" alt="${name} logo">`;
  }
  const team = TEAMS_BY_NAME[name];
  if (!team) return '';
  const colors = team.colors || { primary: '#0F3324', secondary: '#D7E600' };
  const initials = (team.abbr || name.slice(0, 3)).slice(0, 3);
  const fontSize = initials.length >= 3 ? 30 : 40;
  return `<svg class="team-badge ${extraClass}" width="${size}" height="${size}" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="46" fill="${colors.primary}" stroke="${colors.secondary}" stroke-width="7"/>
    <text x="50" y="53" text-anchor="middle" dominant-baseline="middle" font-family="'Space Grotesk', sans-serif" font-weight="700" font-size="${fontSize}" fill="#ffffff">${initials}</text>
  </svg>`;
}

function teamLink(name, opts = {}) {
  const size = opts.size || 20;
  const badge = opts.noBadge ? '' : teamBadge(name, size);
  return `<span class="team-link" data-team="${name}">${badge}<span class="team-link-name">${name}</span></span>`;
}

function openTeamModal(name) {
  const team = TEAMS_BY_NAME[name];
  if (!team) return;

  const standings = computeStandings(TEAMS, state.games);
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
  const roster = state.rosters[name];

  const battingRows = seasonStats.batting.map((b) => `
    <tr>
      <td>${b.battingOrder}. ${b.name}${b.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${b.class}</td><td>${b.position}</td>
      <td>${b.ab}</td><td>${b.h}</td><td>${b.r}</td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td>
      <td>${b.hr}</td><td>${b.ab > 0 ? (b.h / b.ab).toFixed(3).replace(/^0/, '') : '.000'}</td>
    </tr>`).join('');

  const pitchingRows = seasonStats.pitching.map((p) => {
    const ip = outsToIp(p.outs);
    const era = p.outs > 0 ? ((p.er * 21) / p.outs).toFixed(2) : '0.00';
    const whip = p.outs > 0 ? ((p.bb + p.h) / (p.outs / 3)).toFixed(2) : '0.00';
    return `
    <tr>
      <td>${p.role} ${p.name}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.w}-${p.l}${p.sv ? `, ${p.sv}sv` : ''}</td>
      <td>${ip}</td><td>${p.h}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td><td>${era}</td><td>${whip}</td>
    </tr>`;
  }).join('');

  // Full 25-man roster (independent of whether they've recorded a stat line
  // yet) -- lineup + bench hitters, then the full pitching staff.
  const rosterHitterRows = [...roster.lineup, ...roster.bench].map((p) => `
    <tr>
      <td>${p.name}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.position}</td>
      <td>${p.ratings.contact}</td><td>${p.ratings.power}</td><td>${p.ratings.eye}</td>
    </tr>`).join('');
  const rosterPitcherRows = roster.pitchers.map((p) => `
    <tr>
      <td>${p.name}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.role}</td>
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
        <p class="tp-sub">${team.conference} · Head Coach ${team.coach}</p>
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

    <div class="tp-schedule-title">Roster (${rosterUniqueCount}) <span class="view-note">ratings on a 20-80 scale, 50 = league average</span></div>
    <div class="tp-roster-tables">
      <table class="standings-table tp-mini-table">
        <thead><tr><th>Hitter</th><th>Cl</th><th>Pos</th><th>Contact</th><th>Power</th><th>Eye</th></tr></thead>
        <tbody>${rosterHitterRows}</tbody>
      </table>
      <table class="standings-table tp-mini-table">
        <thead><tr><th>Pitcher</th><th>Cl</th><th>Role</th><th>Stuff</th><th>Control</th><th>Movement</th></tr></thead>
        <tbody>${rosterPitcherRows}</tbody>
      </table>
    </div>

    ${games.some((g) => g.played) ? `
    <div class="tp-schedule-title">Season Stats</div>
    <div class="tp-roster-tables">
      <table class="standings-table tp-mini-table">
        <thead><tr><th>Batter</th><th>Cl</th><th>Pos</th><th>AB</th><th>H</th><th>R</th><th>RBI</th><th>BB</th><th>K</th><th>HR</th><th>AVG</th></tr></thead>
        <tbody>${battingRows}</tbody>
      </table>
      <table class="standings-table tp-mini-table">
        <thead><tr><th>Pitcher</th><th>Cl</th><th>W-L</th><th>IP</th><th>H</th><th>ER</th><th>BB</th><th>K</th><th>ERA</th><th>WHIP</th></tr></thead>
        <tbody>${pitchingRows}</tbody>
      </table>
    </div>
    ` : ''}

    <div class="tp-schedule-title">Schedule (${games.length} games)</div>
    <div class="tp-game-list">${gameRows || '<p class="view-note">No games scheduled.</p>'}</div>
  `;

  document.getElementById('teamModalOverlay').classList.add('open');
}

function openBoxScoreModal(gameId) {
  const game = state.games.find((g) => g.id === Number(gameId));
  if (!game || !game.played) return;
  const result = regenerateGameResult(game);
  const { boxscore } = result;

  function battingTable(side, teamName) {
    const rows = boxscore[side].batting.map((b) => `
      <tr>
        <td>${b.battingOrder}. ${b.name}${b.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${b.class}</td><td>${b.position}</td>
        <td>${b.ab}</td><td>${b.h}</td><td>${b.r}</td><td>${b.rbi}</td><td>${b.bb}</td><td>${b.k}</td>
      </tr>`).join('');
    return `
      <div>
        <div class="bs-team-title">${teamLink(teamName)}</div>
        <table class="standings-table tp-mini-table">
          <thead><tr><th>Batter</th><th>Cl</th><th>Pos</th><th>AB</th><th>H</th><th>R</th><th>RBI</th><th>BB</th><th>K</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  }

  function pitchingTable(side) {
    const rows = boxscore[side].pitching.map((p) => `
      <tr>
        <td>${p.role} ${p.name}${p.twoWay ? ' <span class="two-way-tag">TW</span>' : ''}</td><td>${p.class}</td><td>${p.ip}</td><td>${p.h}</td><td>${p.r}</td><td>${p.er}</td><td>${p.bb}</td><td>${p.k}</td>
        <td>${p.decision}</td>
      </tr>`).join('');
    return `
      <table class="standings-table tp-mini-table">
        <thead><tr><th>Pitcher</th><th>Cl</th><th>IP</th><th>H</th><th>R</th><th>ER</th><th>BB</th><th>K</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  const lineHeader = result.awayLine.map((_, i) => `<th>${i + 1}</th>`).join('') + '<th class="bs-rhe">R</th><th class="bs-rhe">H</th><th class="bs-rhe">E</th>';
  const awayLineRow = result.awayLine.map((r) => `<td>${r === null ? '' : r}</td>`).join('')
    + `<td class="bs-rhe"><strong>${result.lineScore.away.r}</strong></td><td class="bs-rhe">${result.lineScore.away.h}</td><td class="bs-rhe">${result.lineScore.away.e}</td>`;
  const homeLineRow = result.homeLine.map((r) => `<td>${r === null ? '' : r}</td>`).join('')
    + `<td class="bs-rhe"><strong>${result.lineScore.home.r}</strong></td><td class="bs-rhe">${result.lineScore.home.h}</td><td class="bs-rhe">${result.lineScore.home.e}</td>`;

  document.getElementById('modalContent').innerHTML = `
    <div class="tp-header">
      <div class="bs-header-badges">${teamBadge(game.away, 40)}${teamBadge(game.home, 40)}</div>
      <div>
        <h2>${game.away} @ ${game.home}</h2>
        <p class="tp-sub">Week ${game.week} · Game ${game.gameOfSeries} of ${game.seriesLength ?? 3} · ${game.conferenceGame ? 'Conference' : 'Non-conference'}${result.mercyRule ? ` · <strong>Final (mercy rule, ${result.innings} inn.)</strong>` : ''}</p>
      </div>
    </div>
    <table class="standings-table tp-mini-table bs-linescore">
      <thead><tr><th></th>${lineHeader}</tr></thead>
      <tbody>
        <tr><td>${teamLink(game.away)}</td>${awayLineRow}</tr>
        <tr><td>${teamLink(game.home)}</td>${homeLineRow}</tr>
      </tbody>
    </table>

    <div class="tp-schedule-title">Batting</div>
    <div class="tp-roster-tables">
      ${battingTable('away', game.away)}
      ${battingTable('home', game.home)}
    </div>

    <div class="tp-schedule-title">Pitching</div>
    <div class="tp-roster-tables">
      ${pitchingTable('away')}
      ${pitchingTable('home')}
    </div>
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
    const boxLink = e.target.closest('[data-boxscore-game]');
    if (boxLink) { openBoxScoreModal(boxLink.dataset.boxscoreGame); return; }
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
    cleanupLegacyStorage();
    await loadTeams();
    loadCustomLogos();
    state = loadState() || freshState(Date.now() % 1000000);
    saveState();
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
