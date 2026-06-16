let QID = null;
document.getElementById('dateChip').textContent = todayStr();

async function boot() {
  const wanted = new URLSearchParams(location.search).get('q');
  if (!wanted) {                                   // no link → landing (own polls if logged in)
    document.getElementById('board').classList.add('hidden');
    document.getElementById('nolink').classList.remove('hidden');
    const polls = await ownPolls();
    if (polls && polls.length) {
      document.getElementById('noLinkMsg').classList.add('hidden');
      document.getElementById('ownPolls').classList.remove('hidden');
      document.getElementById('ownList').innerHTML = polls.map((q) => `
        <div class="qlist-item">
          <div style="flex:1">
            <div style="font-weight:700">${esc(q.title)}</div>
            <div class="meta">${q.approved_count} alternativ · ${q.vote_count} röster</div>
          </div>
          <div class="row">
            <a class="btn sm" href="?q=${q.id}">Resultat →</a>
            <a class="btn ghost sm" href=".?q=${q.id}">Rösta</a>
          </div>
        </div>`).join('');
    }
    return;
  }
  QID = Number(wanted);
  let q;
  try { q = await api('api/questions/' + QID); }
  catch (e) {
    document.getElementById('board').classList.add('hidden');
    document.getElementById('nolink').classList.remove('hidden');
    return;
  }
  document.getElementById('qTitle').textContent = q.title;
  document.getElementById('qDesc').textContent = q.description || '';
  // Keep the "Rösta"-nav link pointing at THIS poll.
  document.getElementById('navRosta').href = '.?q=' + QID;
  await refresh();
  setInterval(refresh, 5000);
}

async function refresh() {
  const data = await api(`api/questions/${QID}/results`);
  document.getElementById('totalVotes').textContent = data.totalVotes;
  if (!data.ideas.length) {
    document.getElementById('ranking').innerHTML = '<p class="muted center">Inga alternativ ännu.</p>';
    return;
  }
  document.getElementById('ranking').innerHTML = data.ideas.map((it, i) => `
    <div class="rank-item">
      <div class="rank-num ${i < 3 ? 'top' : ''}">${i + 1}</div>
      <div>
        <div class="rank-text">${esc(it.text)}</div>
        <div class="bar"><span style="width:${it.score}%"></span></div>
        <div class="rank-meta">${it.votes} röster · ${it.wins}V / ${it.losses}F</div>
      </div>
      <div class="score-badge">${it.score}</div>
    </div>`).join('');
}

boot().catch((e) => { document.getElementById('ranking').innerHTML = `<p class="muted center">${esc(e.message)}</p>`; });
