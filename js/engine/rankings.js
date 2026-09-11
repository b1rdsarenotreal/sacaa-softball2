// rankings.js
// Classic RPI-style composite: 25% own win%, 50% opponents' win% (OWP),
// 25% opponents' opponents' win% (OOWP). This is the same shape formula
// NCAA softball actually used for selection for years, adapted for our world.

function winPctExcluding(games, teamName) {
  let w = 0, l = 0;
  games.forEach((g) => {
    if (!g.played) return;
    if (g.home !== teamName && g.away !== teamName) return;
    const homeWon = g.result.homeScore > g.result.awayScore;
    const isHome = g.home === teamName;
    const won = isHome ? homeWon : !homeWon;
    if (won) w += 1; else l += 1;
  });
  return w + l > 0 ? w / (w + l) : 0;
}

function opponentsOf(games, teamName) {
  const opps = [];
  games.forEach((g) => {
    if (!g.played) return;
    if (g.home === teamName) opps.push(g.away);
    else if (g.away === teamName) opps.push(g.home);
  });
  return opps;
}

export function computeRankings(teams, games) {
  const names = teams.map((t) => t.name);
  const playedGames = games.filter((g) => g.played);

  const wp = {};
  names.forEach((n) => { wp[n] = winPctExcluding(playedGames, n); });

  const owp = {};
  names.forEach((n) => {
    const opps = opponentsOf(playedGames, n);
    if (opps.length === 0) { owp[n] = 0; return; }
    // opponent's win% in games NOT against this team, per standard RPI practice
    const vals = opps.map((opp) => {
      let w = 0, l = 0;
      playedGames.forEach((g) => {
        if (g.home !== opp && g.away !== opp) return;
        if (g.home === n || g.away === n) return; // exclude head-to-head vs n
        const isHome = g.home === opp;
        const won = isHome ? g.result.homeScore > g.result.awayScore : g.result.awayScore > g.result.homeScore;
        if (won) w += 1; else l += 1;
      });
      return w + l > 0 ? w / (w + l) : 0;
    });
    owp[n] = vals.reduce((a, b) => a + b, 0) / vals.length;
  });

  const oowp = {};
  names.forEach((n) => {
    const opps = opponentsOf(playedGames, n);
    if (opps.length === 0) { oowp[n] = 0; return; }
    const vals = opps.map((opp) => owp[opp] || 0);
    oowp[n] = vals.reduce((a, b) => a + b, 0) / vals.length;
  });

  const rpi = {};
  names.forEach((n) => {
    rpi[n] = 0.25 * wp[n] + 0.5 * owp[n] + 0.25 * oowp[n];
  });

  const ranked = teams
    .map((t) => ({
      name: t.name,
      conference: t.conference,
      wp: wp[t.name],
      owp: owp[t.name],
      oowp: oowp[t.name],
      rpi: rpi[t.name],
      record: recordFor(playedGames, t.name),
    }))
    .sort((a, b) => b.rpi - a.rpi);

  ranked.forEach((row, i) => { row.rank = i + 1; });
  return ranked;
}

function recordFor(games, teamName) {
  let w = 0, l = 0;
  games.forEach((g) => {
    if (g.home !== teamName && g.away !== teamName) return;
    const isHome = g.home === teamName;
    const won = isHome ? g.result.homeScore > g.result.awayScore : g.result.awayScore > g.result.homeScore;
    if (won) w += 1; else l += 1;
  });
  return `${w}-${l}`;
}

export function top25(rankings) {
  return rankings.slice(0, 25);
}
