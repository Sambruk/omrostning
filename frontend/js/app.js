let QID = null;
let question = null;
let current = null;       // { left:{id,text}, right:{id,text} }
let votes = 0;
let busy = false;

document.getElementById('dateChip').textContent = todayStr();

async function boot() {
  const wanted = new URLSearchParams(location.search).get('q');
  if (!wanted) { showLanding(); return; }   // no link → landing (own polls if logged in)
  QID = wanted;               // slug eller gammalt löpnummer
  startSurvey();
}

// Landing with no ?q: a link is required — but logged-in creators see their OWN polls.
async function showLanding() {
  show('nolink');
  const polls = await ownPolls();
  if (!polls || !polls.length) return;             // not logged in / none → generic message
  document.getElementById('noLinkMsg').classList.add('hidden');
  document.getElementById('ownPolls').classList.remove('hidden');
  document.getElementById('ownList').innerHTML = polls.map((q) => `
    <div class="qlist-item">
      <div style="flex:1">
        <div style="font-weight:700">${esc(q.title)}</div>
        <div class="meta">${q.approved_count} alternativ · ${q.vote_count} röster</div>
      </div>
      <div class="row">
        <a class="btn sm" href="?q=${esc(q.slug || q.id)}">Rösta →</a>
        <a class="btn ghost sm" href="results?q=${esc(q.slug || q.id)}">Resultat</a>
      </div>
    </div>`).join('');
}

function show(id) {
  ['nolink', 'lockView', 'captchaView', 'surveyView', 'empty'].forEach((x) =>
    document.getElementById(x).classList.toggle('hidden', x !== id));
}

// ---- password gate (polls the creator has protected) ----
function showLock(msg) {
  show('lockView');
  document.getElementById('lockMsg').textContent = msg || '';
  const inp = document.getElementById('lockInput');
  inp.value = '';
  setTimeout(() => inp.focus(), 50);
}

async function submitPassword() {
  const password = document.getElementById('lockInput').value;
  if (!password) return;
  const btn = document.getElementById('lockBtn');
  btn.disabled = true;
  try {
    await unlockPoll(QID, password);
    startSurvey();
  } catch (e) { showLock(e.message); }
  finally { btn.disabled = false; }
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

// Grinden: en bildkod ska klaras innan första rösten. Frågan hämtas dock först,
// så att deltagaren ser VILKEN omröstning hen hamnat i redan i captcha-vyn.
async function startSurvey() {
  try {
    question = await api('api/questions/' + QID, { headers: pollHeaders(QID) });
  } catch (e) {
    if (e.status !== 401) return show('nolink');   // okänd/ogiltig omröstning
    clearPollToken(QID);
    // Skaparen (och admin) släpps in på sin egen omröstning utan att skriva lösenordet.
    try { await unlockPoll(QID); return startSurvey(); } catch { /* vanlig deltagare */ }
    return showLock();
  }
  renderQuestionHeader();
  if (humanToken()) return loadSurvey();
  document.getElementById('captchaQ').textContent = question.title;
  showCaptcha(loadSurvey);
}

// Avsändaren visas bara när skaparen valt att fylla i den.
function showCreator(labelText) {
  const el = document.getElementById('qBy');
  if (!el) return;
  el.textContent = labelText ? 'Omröstning av ' + labelText : '';
  el.classList.toggle('hidden', !labelText);
}

// Rubrik, beskrivning och länkar som pekar på DENNA omröstning.
function renderQuestionHeader() {
  document.getElementById('qTitle').textContent = question.title;
  document.getElementById('qDesc').textContent = question.description || '';
  showCreator(question.creator_label);
  document.getElementById('suggestBtn').classList.toggle('hidden', !question.allow_suggestions);
  const rh = 'results?q=' + QID;
  const rl = document.getElementById('resultsLink'); if (rl) rl.href = rh;
  const nr = document.getElementById('navResults'); if (nr) nr.href = rh;
}

async function loadSurvey() {
  if (!question) return startSurvey();
  renderQuestionHeader();
  show('surveyView');
  await nextPair();
}

async function nextPair() {
  busy = true;
  let data;
  try {
    data = await api(`api/questions/${QID}/pair?voter=${encodeURIComponent(voterId())}`,
      { headers: pollHeaders(QID) });
  } catch (e) {
    busy = false;
    if (e.status === 401) { clearPollToken(QID); return showLock('Lösenordet har gått ut — skriv det igen.'); }
    throw e;
  }
  if (!data.pair) {
    const resultsHref = 'results' + (QID ? ('?q=' + QID) : '');
    const msg = data.closed
      ? `Omröstningen är stängd — det går inte längre att rösta. <a href="${resultsHref}">Se resultatet →</a>`
      : data.exhausted
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
  setChoiceTexts(l, r, current.left.text, current.right.text);
  document.getElementById('versus').classList.remove('fade-in');
  void document.getElementById('versus').offsetWidth;
  document.getElementById('versus').classList.add('fade-in');
  busy = false;
}

// Texten skalas efter längd så att både "Hund" och ett helt stycke ser bra ut.
// Båda korten får SAMMA storlek (längsta texten styr) så paret ser balanserat ut.
function setChoiceTexts(l, r, leftText, rightText) {
  const n = Math.max((leftText || '').length, (rightText || '').length);
  const cls = n <= 40 ? 't-s' : n <= 110 ? 't-m' : n <= 240 ? 't-l' : 't-xl';
  [[l, leftText], [r, rightText]].forEach(([el, text]) => {
    el.querySelector('span').textContent = text;
    el.classList.remove('t-s', 't-m', 't-l', 't-xl');
    el.classList.add(cls);
  });
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
      headers: pollHeaders(QID),
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
    if (e.status === 401) { busy = false; clearPollToken(QID); return showLock('Lösenordet har gått ut — skriv det igen.'); }
    if (e.status === 403) { busy = false; toast(e.message); return nextPair(); }  // hann stängas
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
      headers: pollHeaders(QID),
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
    await api(`api/questions/${QID}/ideas`, { method: 'POST', headers: pollHeaders(QID), body: JSON.stringify({ text, human: humanToken() }) });
    closeSuggest();
    toast('Tack! Ditt förslag väntar på granskning.');
  } catch (e) {
    if (e.status === 428) { localStorage.removeItem('humanToken'); return showCaptcha(() => { show('surveyView'); }); }
    toast(e.message);
  }
}

boot().catch((e) => { console.error(e); show('empty'); });
