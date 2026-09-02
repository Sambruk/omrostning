let QID = null;
let QTITLE = 'Resultat';
let LAST = null;            // senaste hämtade resultatet — underlag för bildexporten
let TIMER = null;           // uppdateringsintervallet
let QBY = '';               // avsändare, om skaparen fyllt i en
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
            <a class="btn sm" href="?q=${esc(q.slug || q.id)}">Resultat →</a>
            <a class="btn ghost sm" href=".?q=${esc(q.slug || q.id)}">Rösta</a>
          </div>
        </div>`).join('');
    }
    return;
  }
  QID = wanted;               // slug eller gammalt löpnummer
  let q;
  try { q = await api('api/questions/' + QID, { headers: pollHeaders(QID) }); }
  catch (e) {
    if (e.status === 401) {                        // lösenordsskyddad omröstning
      clearPollToken(QID);
      // Skaparen (och admin) kommer in på sin egen omröstning utan lösenord.
      try { await unlockPoll(QID); return boot(); } catch { /* vanlig besökare */ }
      return showLock();
    }
    document.getElementById('board').classList.add('hidden');
    document.getElementById('nolink').classList.remove('hidden');
    return;
  }
  document.getElementById('lockView').classList.add('hidden');
  document.getElementById('board').classList.remove('hidden');
  QTITLE = q.title;
  document.getElementById('qTitle').textContent = q.title;
  document.getElementById('qDesc').textContent = q.description || '';
  QBY = q.creator_label || '';
  const by = document.getElementById('qBy');
  by.textContent = QBY ? 'Omröstning av ' + QBY : '';
  by.classList.toggle('hidden', !QBY);
  // Keep the "Rösta"-nav link pointing at THIS poll.
  document.getElementById('navRosta').href = '.?q=' + QID;
  document.getElementById('voteLink').href = '.?q=' + QID;
  await refresh();
  clearInterval(TIMER);
  TIMER = setInterval(refresh, 5000);
}

// ---- lösenordsgrind ----
function showLock(msg) {
  clearInterval(TIMER);
  document.getElementById('board').classList.add('hidden');
  document.getElementById('nolink').classList.add('hidden');
  document.getElementById('lockView').classList.remove('hidden');
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
  try { await unlockPoll(QID, password); await boot(); }
  catch (e) { showLock(e.message); }
  finally { btn.disabled = false; }
}

async function refresh() {
  let data;
  try {
    data = await api(`api/questions/${QID}/results`, { headers: pollHeaders(QID) });
  } catch (e) {
    if (e.status === 401) { clearPollToken(QID); return showLock('Lösenordet har gått ut — skriv det igen.'); }
    throw e;
  }
  LAST = data;
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

// ---------------------------------------------------------------------------
// Bildexport: ritar resultatet på en canvas och laddar ner det som PNG. Görs för
// hand i stället för med ett bibliotek — bilden ska se likadan ut oavsett tema
// och skärmstorlek, och ska kunna klistras in i en presentation eller ett mejl.
// ---------------------------------------------------------------------------
const IMG = {
  W: 1400, PAD: 70, SCALE: 2,
  font: '"Segoe UI", Helvetica, Arial, sans-serif',
  bg: '#ffffff', text: '#16210f', muted: '#5c6655',
  barBg: '#e4e9dd', bar1: '#3f7a11', bar2: '#58a618', top: '#3f7a11',
};

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

// Bryter text till rader som får plats inom maxW.
function wrapText(ctx, text, maxW) {
  const out = [];
  String(text || '').split(/\n/).forEach((para) => {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); return; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const test = line + ' ' + words[i];
      if (ctx.measureText(test).width <= maxW) line = test;
      else { out.push(line); line = words[i]; }
    }
    out.push(line);
  });
  return out;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}

async function renderResultCanvas() {
  const { W, PAD, SCALE, font } = IMG;
  const inner = W - PAD * 2;
  const numW = 80;            // rangordningssiffra
  const scoreW = 130;         // poäng till höger
  const textX = PAD + numW;
  const textW = inner - numW - scoreW;

  let logo = null;
  try { logo = await loadImg('assets/duellen-logo.png'); } catch { /* fortsätt utan logga */ }

  // --- Pass 1: mät höjden ---
  const m = document.createElement('canvas').getContext('2d');
  const logoH = logo ? 110 : 0;
  m.font = '700 46px ' + font;
  const titleLines = wrapText(m, QTITLE, inner);
  m.font = '600 30px ' + font;
  const rows = LAST.ideas.map((it) => ({ it, lines: wrapText(m, it.text, textW) }));

  let h = PAD + logoH + (logo ? 26 : 0) + titleLines.length * 58 + 22 + 38 + 40;
  const rowH = (r) => r.lines.length * 40 + 26 + 30 + 34;
  rows.forEach((r) => { h += rowH(r); });
  h += 30 + 46 + PAD;         // avslutande linje + fot

  // --- Pass 2: rita ---
  const c = document.createElement('canvas');
  c.width = W * SCALE; c.height = Math.round(h) * SCALE;
  const ctx = c.getContext('2d');
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = IMG.bg; ctx.fillRect(0, 0, W, h);
  ctx.textBaseline = 'top';

  let y = PAD;
  if (logo) {
    const lw = logo.width * (logoH / logo.height);
    ctx.drawImage(logo, (W - lw) / 2, y, lw, logoH);
    y += logoH + 26;
  }

  ctx.textAlign = 'center';
  ctx.fillStyle = IMG.text;
  ctx.font = '700 46px ' + font;
  titleLines.forEach((line) => { ctx.fillText(line, W / 2, y); y += 58; });

  y += 22;
  ctx.font = '400 26px ' + font;
  ctx.fillStyle = IMG.muted;
  ctx.fillText((QBY ? QBY + ' · ' : '') + `${LAST.totalVotes} röster · ${todayStr()}`, W / 2, y);
  y += 38 + 40;

  ctx.textAlign = 'left';
  rows.forEach((r, i) => {
    const { it, lines } = r;
    const rowTop = y;

    ctx.font = '800 40px ' + font;
    ctx.fillStyle = i < 3 ? IMG.top : IMG.muted;
    ctx.textAlign = 'center';
    ctx.fillText(String(i + 1), PAD + numW / 2 - 10, rowTop + 2);

    ctx.textAlign = 'left';
    ctx.fillStyle = IMG.text;
    ctx.font = '600 30px ' + font;
    let ty = rowTop;
    lines.forEach((line) => { ctx.fillText(line, textX, ty); ty += 40; });

    ctx.textAlign = 'right';
    ctx.font = '800 44px ' + font;
    ctx.fillStyle = IMG.text;
    ctx.fillText(String(it.score), W - PAD, rowTop);
    ctx.textAlign = 'left';

    const barY = ty + 10;
    ctx.fillStyle = IMG.barBg;
    roundRect(ctx, textX, barY, textW, 16, 8);
    const w = Math.max(6, textW * (Number(it.score) / 100));
    const grad = ctx.createLinearGradient(textX, 0, textX + textW, 0);
    grad.addColorStop(0, IMG.bar1); grad.addColorStop(1, IMG.bar2);
    ctx.fillStyle = grad;
    roundRect(ctx, textX, barY, w, 16, 8);

    ctx.fillStyle = IMG.muted;
    ctx.font = '400 22px ' + font;
    ctx.fillText(`${it.votes} röster · ${it.wins} vinster / ${it.losses} förluster`, textX, barY + 26);

    y = rowTop + rowH(r);
  });

  y += 10;
  ctx.strokeStyle = IMG.barBg; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
  y += 20;
  ctx.textAlign = 'center';
  ctx.fillStyle = IMG.muted;
  ctx.font = '400 22px ' + font;
  ctx.fillText('Poängen är chansen att vinna mot ett slumpmässigt annat alternativ · Sambruk Duellen', W / 2, y);

  return c;
}

async function downloadImage() {
  if (!LAST || !LAST.ideas.length) return toast('Det finns inget resultat att spara än');
  try {
    const canvas = await renderResultCanvas();
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `duellen-resultat-${QID}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      toast('Bilden är sparad');
    }, 'image/png');
  } catch (e) {
    console.error(e);
    toast('Kunde inte skapa bilden');
  }
}

boot().catch((e) => { document.getElementById('ranking').innerHTML = `<p class="muted center">${esc(e.message)}</p>`; });
