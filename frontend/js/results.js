let QID = null;
document.getElementById('dateChip').textContent = todayStr();

async function boot() {
  const wanted = new URLSearchParams(location.search).get('q');
  const questions = await api('api/questions');
  if (!questions.length) {
    document.getElementById('ranking').innerHTML = '<p class="muted center">Inga aktiva omröstningar.</p>';
    return;
  }
  if (wanted) QID = Number(wanted);
  else if (questions.length === 1) QID = questions[0].id;
  else { renderPicker(questions); document.getElementById('picker').classList.remove('hidden'); document.getElementById('board').classList.add('hidden'); return; }

  const q = questions.find((x) => x.id === QID) || await api('api/questions/' + QID);
  document.getElementById('qTitle').textContent = q.title;
  document.getElementById('qDesc').textContent = q.description || '';
  await refresh();
  setInterval(refresh, 5000);
}

function renderPicker(questions) {
  document.getElementById('pickerList').innerHTML = questions.map((q) => `
    <div class="qlist-item">
      <div><div style="font-weight:700">${esc(q.title)}</div><div class="meta">${q.idea_count} alternativ</div></div>
      <a class="btn sm" href="?q=${q.id}">Visa →</a>
    </div>`).join('');
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
