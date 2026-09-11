// standings.js
// Computes overall and conference win-loss records from a list of played games.

export function computeStandings(teams, games) {
  const table = {};
  teams.forEach((t) => {
    table[t.name] = {
      name: t.name,
      conference: t.conference,
      wins: 0,
      losses: 0,
      confWins: 0,
      confLosses: 0,
      runsFor: 0,
      runsAgainst: 0,
      streak: 0, // positive = win streak, negative = loss streak
      last10: [],
    };
  });

  games
    .filter((g) => g.played)
    .sort((a, b) => a.id - b.id)
    .forEach((g) => {
      const { home, away, result, conferenceGame } = g;
      const homeRow = table[home];
      const awayRow = table[away];
      if (!homeRow || !awayRow) return;

      homeRow.runsFor += result.homeScore;
      homeRow.runsAgainst += result.awayScore;
      awayRow.runsFor += result.awayScore;
      awayRow.runsAgainst += result.homeScore;

      const homeWon = result.homeScore > result.awayScore;
      const winner = homeWon ? homeRow : awayRow;
      const loser = homeWon ? awayRow : homeRow;

      winner.wins += 1;
      loser.losses += 1;
      if (conferenceGame) {
        winner.confWins += 1;
        loser.confLosses += 1;
      }

      winner.streak = winner.streak > 0 ? winner.streak + 1 : 1;
      loser.streak = loser.streak < 0 ? loser.streak - 1 : -1;

      winner.last10.push('W'); if (winner.last10.length > 10) winner.last10.shift();
      loser.last10.push('L'); if (loser.last10.length > 10) loser.last10.shift();
    });

  return Object.values(table).map((row) => ({
    ...row,
    pct: row.wins + row.losses > 0 ? row.wins / (row.wins + row.losses) : 0,
    confPct: row.confWins + row.confLosses > 0 ? row.confWins / (row.confWins + row.confLosses) : 0,
    runDiff: row.runsFor - row.runsAgainst,
  }));
}

export function standingsByConference(standingsRows) {
  const byConf = {};
  standingsRows.forEach((row) => {
    byConf[row.conference] = byConf[row.conference] || [];
    byConf[row.conference].push(row);
  });
  Object.values(byConf).forEach((rows) =>
    rows.sort((a, b) => b.confPct - a.confPct || b.pct - a.pct || b.runDiff - a.runDiff)
  );
  return byConf;
}

export function overallStandings(standingsRows) {
  return [...standingsRows].sort(
    (a, b) => b.pct - a.pct || b.runDiff - a.runDiff
  );
}
