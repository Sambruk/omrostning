let QID = null;
let question = null;
let current = null;       // { left:{id,text}, right:{id,text} }
let votes = 0;
let busy = false;

document.getElementById('dateChip').textContent = todayStr();

async function boot() {
  const params = new URLSearchParams(location.search);
  const wanted = params.get('q');
  const questions = await api('api/questions');

  if (!questions.length) { show('empty'); return; }

  if (wanted) {
    QID = Number(wanted);
  } else if (questions.length === 1) {
    QID = questions[0].id;
  } else {
    renderPicker(questions);
    show('picker');
    return;
  }
  startSurvey();
}

function show(id) {
  ['picker', 'captchaView', 'surveyView', 'empty'].forEach((x) =>
    document.getElementById(x).classList.toggle('hidden', x !== id));
}

function humanToken() { return localStorage.getItem('humanToken') || ''; }

// ---- CAPTCHA gate ----
let captchaId = null, captchaThen = null;

function showCaptcha(then) {
  captchaThen = then || loadSurvey;
  show('captchaView');
  loadCaptcha();
  setTimeout(() => document.getElementById('captchaInput').focus(), 50);
}

async function loadCaptcha() {
  document.getElementById('captchaInput').value = '';
  try {
    const d = await api('api/captcha');
    captchaId = d.id;
    document.getElementById('captchaImg').innerHTML = d.svg;
  } catch (e) { document.getElementById('captchaImg').textContent = 'Kunde inte ladda bilden'; }
}

async function verifyCaptcha() {
  const answer = document.getElementById('captchaInput').value.trim();
  if (!answer) return;
  try {
    const d = await api('api/captcha/verify', { method: 'POST', body: JSON.stringify({ id: captchaId, answer }) });
    localStorage.setItem('humanToken', d.token);
    const then = captchaThen; captchaThen = null;
    (then || loadSurvey)();
  } catch (e) { toast(e.message); loadCaptcha(); }
}

// Gate: require a CAPTCHA pass before the first vote.
function startSurvey() {
  if (humanToken()) return loadSurvey();
  showCaptcha(loadSurvey);
}

function renderPicker(questions) {
  document.getElementById('pickerList').innerHTML = questions.map((q) => `
    <div class="qlist-item">
      <div>
        <div style="font-weight:700">${esc(q.title)}</div>
        <div class="meta">${q.idea_count} alternativ</div>
      </div>
      <a class="btn sm" href="?q=${q.id}">Rösta →</a>
    </div>`).join('');
}

async function loadSurvey() {
  question = await api('api/questions/' + QID);
  document.getElementById('qTitle').textContent = question.title;
  document.getElementById('qDesc').textContent = question.description || '';
  document.getElementById('suggestBtn').classList.toggle('hidden', !question.allow_suggestions);
  show('surveyView');
  await nextPair();
}

async function nextPair() {
  busy = true;
  const data = await api(`api/questions/${QID}/pair?voter=${encodeURIComponent(voterId())}`);
  if (!data.pair) {
    const resultsHref = 'results' + (QID ? ('?q=' + QID) : '');
    const msg = data.exhausted
      ? `Tack! Du har jämfört alla par. <a href="${resultsHref}">Se resultatet →</a>`
      : 'Det behövs minst två godkända alternativ för att rösta. ' +
        (question.allow_suggestions ? 'Lägg till ett förslag nedan!' : '');
    document.getElementById('versus').innerHTML =
      `<div class="card center" style="grid-column:1/-1">${msg}</div>`;
    busy = false;
    return;
  }
  current = { left: data.pair[0], right: data.pair[1] };
  const l = document.getElementById('left'), r = document.getElementById('right');
  l.classList.remove('picked'); r.classList.remove('picked');
  l.querySelector('span').textContent = current.left.text;
  r.querySelector('span').textContent = current.right.text;
  document.getElementById('versus').classList.remove('fade-in');
  void document.getElementById('versus').offsetWidth;
  document.getElementById('versus').classList.add('fade-in');
  busy = false;
}

async function pick(side) {
  if (busy || !current) return;
  busy = true;
  const winner = side === 'left' ? current.left : current.right;
  const loser  = side === 'left' ? current.right : current.left;
  document.getElementById(side).classList.add('picked');
  try {
    await api(`api/questions/${QID}/vote`, {
      method: 'POST',
      body: JSON.stringify({
        winner_id: winner.id, loser_id: loser.id,
        left_id: current.left.id, right_id: current.right.id,
        voter: voterId(), human: humanToken(),
      }),
    });
    votes++;
    document.getElementById('voteCount').textContent = `Du har röstat ${votes} ${votes === 1 ? 'gång' : 'gånger'} 🎉`;
  } catch (e) {
    document.getElementById(side).classList.remove('picked');
    if (e.status === 428) { busy = false; localStorage.removeItem('humanToken'); return showCaptcha(() => { show('surveyView'); nextPair(); }); }
    if (e.status === 429) { busy = false; toast(e.message); return; }   // rate limited: stay on pair
    if (e.status !== 409) toast(e.message);                              // 409 = duplicate, just advance
  }
  setTimeout(nextPair, 220);
}

async function skip() {
  if (busy || !current) return;
  busy = true;
  try {
    await api(`api/questions/${QID}/vote`, {
      method: 'POST',
      body: JSON.stringify({ skipped: true, left_id: current.left.id, right_id: current.right.id, voter: voterId(), human: humanToken() }),
    });
  } catch (e) {
    if (e.status === 428) { busy = false; localStorage.removeItem('humanToken'); return showCaptcha(() => { show('surveyView'); nextPair(); }); }
    if (e.status === 429) { busy = false; toast(e.message); return; }
  }
  nextPair();
}

document.addEventListener('keydown', (e) => {
  if (document.getElementById('surveyView').classList.contains('hidden')) return;
  if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;
  if (e.key === 'ArrowLeft') pick('left');
  else if (e.key === 'ArrowRight') pick('right');
  else if (e.key === ' ') { e.preventDefault(); skip(); }
});

// ---- suggestions ----
function openSuggest() { document.getElementById('suggestBox').classList.remove('hidden'); document.getElementById('suggestText').focus(); }
function closeSuggest() { document.getElementById('suggestBox').classList.add('hidden'); document.getElementById('suggestText').value = ''; }
async function submitSuggest() {
  const text = document.getElementById('suggestText').value.trim();
  if (!text) return;
  try {
    await api(`api/questions/${QID}/ideas`, { method: 'POST', body: JSON.stringify({ text, human: humanToken() }) });
    closeSuggest();
    toast('Tack! Ditt förslag väntar på granskning.');
  } catch (e) {
    if (e.status === 428) { localStorage.removeItem('humanToken'); return showCaptcha(() => { show('surveyView'); }); }
    toast(e.message);
  }
}

boot().catch((e) => { console.error(e); show('empty'); });
