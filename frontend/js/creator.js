let UTOKEN = localStorage.getItem('userToken') || '';
const ideaTextCache = {};
const openPanels = {};

function uauth() { return { Authorization: 'Bearer ' + UTOKEN }; }
async function uapi(path, opts = {}) {
  try { return await api(path, { ...opts, headers: { ...uauth(), ...(opts.headers || {}) } }); }
  catch (e) { if (e.status === 401) logoutUser(); throw e; }
}

function showView(id) {
  ['verifyView', 'introView', 'sentView', 'dash'].forEach((x) =>
    document.getElementById(x).classList.toggle('hidden', x !== id));
  document.getElementById('logoutBtn').classList.toggle('hidden', id !== 'dash');
}

function showIntro() { showView('intro'.concat('View')); }

// ---- boot ----
(async function boot() {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (token) {
    showView('verifyView');
    try {
      const d = await api('api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) });
      UTOKEN = d.token; localStorage.setItem('userToken', UTOKEN);
      history.replaceState({}, '', 'skapa');           // strip token from URL
      enterDashboard();
    } catch (e) { toast(e.message); showView('introView'); }
    return;
  }
  if (UTOKEN) { enterDashboard(); } else { showView('introView'); }
})();

// intro: enable send button only after acknowledgement
document.getElementById('introAck').addEventListener('change', (e) => {
  document.getElementById('sendLinkBtn').disabled = !e.target.checked;
});

async function requestLink() {
  if (!document.getElementById('introAck').checked) return toast('Bekräfta att du läst informationen ovan');
  const email = document.getElementById('email').value.trim();
  if (!email) return toast('Ange din e-postadress');
  try {
    await api('api/auth/request', { method: 'POST', body: JSON.stringify({ email }) });
    document.getElementById('sentEmail').textContent = email;
    showView('sentView');
  } catch (e) { toast(e.message); }
}

function logoutUser() {
  UTOKEN = ''; localStorage.removeItem('userToken'); showView('introView');
}

async function enterDashboard() {
  try {
    const me = await uapi('api/auth/me');
    document.getElementById('meEmail').textContent = me.email;
    showView('dash');
    loadDash();
  } catch (e) { logoutUser(); }
}

async function createQuestion() {
  const titleEl = document.getElementById('newTitle');
  const title = titleEl.value.trim();
  if (!title) { toast('Fyll i fältet "Fråga"'); titleEl.focus(); return; }
  const body = {
    title,
    description: document.getElementById('newDesc').value.trim(),
    creator_label: document.getElementById('newBy').value.trim(),
    allow_suggestions: document.getElementById('newAllow').checked,
    seeds: document.getElementById('newSeeds').value,
    password: document.getElementById('newPassword').value,
  };
  try {
    await uapi('api/user/questions', { method: 'POST', body: JSON.stringify(body) });
    titleEl.value = ''; document.getElementById('newDesc').value = ''; document.getElementById('newSeeds').value = '';
    document.getElementById('newPassword').value = '';
    document.getElementById('newBy').value = '';
    toast('Omröstning skapad'); loadDash();
  } catch (e) { toast(e.message); }
}

async function loadDash() {
  const qs = await uapi('api/user/questions');
  const el = document.getElementById('questions');
  el.innerHTML = qs.length ? qs.map(renderQuestion).join('')
    : '<p class="muted">Du har inga omröstningar än. Skapa din första ovan!</p>';
}

function statusPill(s) {
  const m = { active: ['green', 'aktiv'], draft: ['amber', 'utkast'], closed: ['gray', 'stängd'] };
  const [c, t] = m[s] || ['gray', s];
  return `<span class="pill ${c}">${t}</span>`;
}

// Delningslänken använder omröstningens slug — en svårgissad nyckel, så att
// ingen kan bläddra sig fram till andras omröstningar genom att räkna upp id:n.
function shareKey(q) { return q.slug || q.id; }
function publicLink(key) {
  const base = new URL('.', location.href).href.replace(/\/$/, '');
  return `${base}/?q=${key}`;
}

function renderQuestion(q) {
  const pending = Number(q.pending_count);
  return `
  <div class="card" data-q="${q.id}">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div style="flex:1;min-width:200px">
        <div style="font-weight:800;font-size:1.05rem">${esc(q.title)} ${statusPill(q.status)} ${q.has_password ? '<span class="pill gray">🔒 lösenord</span>' : ''}</div>
        <div class="muted" style="font-size:.85rem;margin-top:3px">${esc(q.description || '')}</div>
      </div>
      ${pending ? `<span class="pill amber">${pending} väntar på granskning</span>` : ''}
    </div>
    <div class="stat-grid" style="margin:14px 0">
      <div class="stat"><div class="n">${q.approved_count}</div><div class="l">alternativ</div></div>
      <div class="stat"><div class="n">${q.vote_count}</div><div class="l">röster</div></div>
      <div class="stat"><div class="n">${pending}</div><div class="l">i kö</div></div>
    </div>
    <div class="card" style="background:var(--card-2);margin-bottom:12px">
      <div class="sub" style="margin:0 0 6px">Dela denna länk för att samla röster:</div>
      <div class="row" style="align-items:center">
        <input type="text" readonly value="${publicLink(shareKey(q))}" onclick="this.select()" style="flex:1;min-width:200px">
        <button class="btn sm" onclick="copyLink('${esc(shareKey(q))}')">Kopiera</button>
        <a class="btn ghost sm" href="share?q=${esc(shareKey(q))}" target="_blank">QR ↗</a>
      </div>
    </div>
    <div class="row">
      ${pending ? `<button class="btn warn sm" onclick="toggle(${q.id},'mod')">Granska kö (${pending})</button>` : ''}
      <button class="btn sm" onclick="toggle(${q.id},'ideas')">Hantera alternativ</button>
      <button class="btn ghost sm" onclick="toggle(${q.id},'settings')">Inställningar</button>
      <a class="btn ghost sm" href="results?q=${esc(shareKey(q))}" target="_blank">Resultat ↗</a>
      <a class="btn ghost sm" href="api/user/questions/${q.id}/export?format=csv" onclick="return dl(event,${q.id})">CSV</a>
      <button class="btn quiet-danger sm" onclick="resetVotes(${q.id})">Nollställ röster</button>
      <button class="btn quiet-danger sm" onclick="delQuestion(${q.id})">Radera</button>
    </div>
    <div id="panel-${q.id}" class="hidden" style="margin-top:14px"></div>
  </div>`;
}

function copyLink(key) { navigator.clipboard.writeText(publicLink(key)).then(() => toast('Länk kopierad')); }

async function toggle(qid, kind) {
  const panel = document.getElementById('panel-' + qid);
  if (openPanels[qid] === kind && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden'); openPanels[qid] = null; return;
  }
  openPanels[qid] = kind; panel.classList.remove('hidden'); panel.innerHTML = '<p class="muted">Laddar…</p>';
  if (kind === 'mod') return renderMod(qid, panel);
  if (kind === 'ideas') return renderIdeas(qid, panel);
  if (kind === 'settings') return renderSettings(qid, panel);
}

function reloadPanel(qid) {
  const p = document.getElementById('panel-' + qid);
  if (!p) return;
  if (openPanels[qid] === 'mod') renderMod(qid, p); else renderIdeas(qid, p);
}

async function renderMod(qid, panel) {
  const list = await uapi(`api/user/questions/${qid}/ideas?status=pending`);
  if (!list.length) { panel.innerHTML = '<p class="muted">Inget i kön. 🎉</p>'; return; }
  list.forEach((i) => { ideaTextCache[i.id] = i.text; });
  panel.innerHTML = '<h2 style="font-size:1rem;margin-bottom:8px">Förslag att granska</h2>' + list.map((i) => `
    <div class="qlist-item" id="idearow-${i.id}">
      <div style="flex:1;white-space:pre-line">${esc(i.text)} <span class="pill gray">${esc(i.source)}</span></div>
      <div class="row">
        <button class="btn ghost sm" onclick="editIdea(${qid},${i.id})">Redigera</button>
        <button class="btn accent sm" onclick="setIdea(${i.id},'approved',${qid})">Godkänn</button>
        <button class="btn danger sm" onclick="setIdea(${i.id},'rejected',${qid})">Avslå</button>
      </div>
    </div>`).join('');
}

async function renderIdeas(qid, panel) {
  const list = await uapi(`api/user/questions/${qid}/ideas`);
  const approved = list.filter((i) => i.status === 'approved');
  approved.forEach((i) => { ideaTextCache[i.id] = i.text; });
  panel.innerHTML = `
    <h2 style="font-size:1rem;margin-bottom:10px">Lägg till alternativ <button type="button" class="hint-btn" aria-label="Så matar du in alternativ" data-tip="Skriv ett alternativ i taget och skilj dem åt med en tom rad (tryck retur två gånger). Ett alternativ får gärna gå över flera rader.">?</button></h2>
    <textarea id="seed-${qid}" rows="5" placeholder="Ett alternativ&#10;&#10;Nästa alternativ"></textarea>
    <div class="spacer"></div>
    <button class="btn accent sm" onclick="addSeeds(${qid})">Lägg till</button>
    <h2 style="font-size:1rem;margin:16px 0 8px">Alternativ (${approved.length})</h2>
    ${approved.map((i) => `
      <div class="qlist-item" id="idearow-${i.id}">
        <div style="flex:1;white-space:pre-line">${esc(i.text)} <span class="muted" style="font-size:.78rem">(poäng ${i.score}, ${i.votes} röster)</span></div>
        <div class="row">
          <button class="btn ghost sm" onclick="editIdea(${qid},${i.id})">Redigera</button>
          <button class="btn quiet-danger sm" onclick="delIdea(${i.id},${qid})">Ta bort</button>
        </div>
      </div>`).join('') || '<p class="muted">Inga ännu.</p>'}`;
}

async function renderSettings(qid, panel) {
  const q = await uapi('api/user/questions/' + qid);
  panel.innerHTML = `
    <h2 style="font-size:1rem;margin-bottom:8px">Inställningar</h2>
    <label>Fråga</label><input type="text" id="set-title-${qid}" value="${esc(q.title)}">
    <label>Beskrivning</label><input type="text" id="set-desc-${qid}" value="${esc(q.description || '')}">
    <label>Avsändare (visas för deltagarna) <button type="button" class="hint-btn" aria-label="Om avsändare" data-tip="Fritext som visas för deltagarna under frågan, t.ex. ditt namn, din förvaltning eller din kommun. Lämna tomt om du vill vara anonym.">?</button></label>
    <input type="text" id="set-by-${qid}" maxlength="80" value="${esc(q.creator_label || '')}" placeholder="t.ex. Sambruk eller Kiruna kommun">
    <label>Status</label>
    <select id="set-status-${qid}">
      <option value="active" ${q.status === 'active' ? 'selected' : ''}>Aktiv (öppen för röstning)</option>
      <option value="draft"  ${q.status === 'draft' ? 'selected' : ''}>Utkast (dold)</option>
      <option value="closed" ${q.status === 'closed' ? 'selected' : ''}>Stängd (visa bara resultat)</option>
    </select>
    <label class="switch" style="margin-top:12px"><input type="checkbox" id="set-allow-${qid}" ${q.allow_suggestions ? 'checked' : ''}> Tillåt deltagarförslag</label>

    <h2 style="font-size:1rem;margin:20px 0 4px">Lösenord <button type="button" class="hint-btn" aria-label="Om lösenordet" data-tip="Med lösenord måste deltagarna skriva in det för att kunna rösta och för att se resultatet. Dela lösenordet separat från länken. Du själv kommer in utan att skriva det, så länge du är inloggad.">?</button></h2>
    <p class="muted" style="margin:0 0 8px;font-size:.95rem">${q.has_password
      ? 'Omröstningen är <strong>lösenordsskyddad</strong> — både röstning och resultat kräver lösenordet.'
      : 'Omröstningen är <strong>öppen</strong> för alla som har länken.'}</p>
    <input type="password" id="set-pw-${qid}" autocomplete="new-password"
           placeholder="${q.has_password ? 'Nytt lösenord (lämna tomt = behåll nuvarande)' : 'Sätt ett lösenord (lämna tomt = ingen)'}">
    ${q.has_password ? `<label class="switch" style="margin-top:10px"><input type="checkbox" id="set-pw-clear-${qid}"> Ta bort lösenordet (öppna för alla med länken)</label>` : ''}
    <div class="spacer"></div>
    <button class="btn sm" onclick="saveSettings(${qid})">Spara</button>`;
}

async function saveSettings(qid) {
  const body = {
    title: document.getElementById('set-title-' + qid).value.trim(),
    description: document.getElementById('set-desc-' + qid).value.trim(),
    status: document.getElementById('set-status-' + qid).value,
    allow_suggestions: document.getElementById('set-allow-' + qid).checked,
    creator_label: document.getElementById('set-by-' + qid).value.trim(),
  };
  // Lösenordet ändras bara när något faktiskt fyllts i (eller "ta bort" kryssats).
  const pw = document.getElementById('set-pw-' + qid);
  const clear = document.getElementById('set-pw-clear-' + qid);
  if (clear && clear.checked) body.password = '';
  else if (pw && pw.value) body.password = pw.value;
  try { await uapi('api/user/questions/' + qid, { method: 'PATCH', body: JSON.stringify(body) }); toast('Sparat'); loadDash(); }
  catch (e) { toast(e.message); }
}

async function addSeeds(qid) {
  const texts = document.getElementById('seed-' + qid).value;
  if (!texts.trim()) return;
  try { await uapi(`api/user/questions/${qid}/ideas`, { method: 'POST', body: JSON.stringify({ texts }) }); toast('Tillagt'); loadDash(); }
  catch (e) { toast(e.message); }
}

function editIdea(qid, id) {
  const row = document.getElementById('idearow-' + id);
  if (!row) return;
  row.innerHTML = `
    <div style="flex:1">
      <textarea id="edit-${id}" rows="3"></textarea>
      <div class="row" style="margin-top:8px">
        <button class="btn accent sm" onclick="saveIdea(${qid},${id})">Spara</button>
        <button class="btn ghost sm" onclick="reloadPanel(${qid})">Avbryt</button>
      </div>
    </div>`;
  const ta = document.getElementById('edit-' + id); ta.value = ideaTextCache[id] || ''; ta.focus();
}

async function saveIdea(qid, id) {
  const text = document.getElementById('edit-' + id).value.trim();
  if (!text) return toast('Texten kan inte vara tom');
  try { await uapi('api/user/ideas/' + id, { method: 'PATCH', body: JSON.stringify({ text }) }); ideaTextCache[id] = text; toast('Sparat'); reloadPanel(qid); }
  catch (e) { toast(e.message); }
}

async function setIdea(id, status, qid) {
  try { await uapi('api/user/ideas/' + id, { method: 'PATCH', body: JSON.stringify({ status }) }); toast(status === 'approved' ? 'Godkänt' : 'Avslaget'); loadDash(); }
  catch (e) { toast(e.message); }
}

async function delIdea(id, qid) {
  if (!confirm('Ta bort alternativet?')) return;
  try { await uapi('api/user/ideas/' + id, { method: 'DELETE' }); loadDash(); } catch (e) { toast(e.message); }
}

async function resetVotes(qid) {
  if (!confirm('Nollställ ALLA röster och poäng? Alternativen behålls. Går inte att ångra.')) return;
  try { const r = await uapi('api/user/questions/' + qid + '/reset', { method: 'POST' }); toast(`Nollställt — ${r.clearedVotes} röster rensade`); loadDash(); }
  catch (e) { toast(e.message); }
}

async function delQuestion(qid) {
  if (!confirm('Radera hela omröstningen med alla röster? Går inte att ångra.')) return;
  try { await uapi('api/user/questions/' + qid, { method: 'DELETE' }); toast('Raderad'); loadDash(); } catch (e) { toast(e.message); }
}

async function dl(ev, qid) {
  ev.preventDefault();
  try {
    const res = await fetch(`api/user/questions/${qid}/export?format=csv`, { headers: uauth() });
    if (!res.ok) throw new Error('Export misslyckades');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = `resultat-${qid}.csv`; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message); }
  return false;
}
