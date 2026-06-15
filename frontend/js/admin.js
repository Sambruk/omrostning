let TOKEN = localStorage.getItem('adminToken') || '';
const ideaTextCache = {}; // id -> raw text, so edit forms avoid HTML-escaping issues

function authHeaders() { return { Authorization: 'Bearer ' + TOKEN }; }

// Authenticated API call; bounces to login on 401.
async function aapi(path, opts = {}) {
  try {
    return await api(path, { ...opts, headers: { ...authHeaders(), ...(opts.headers || {}) } });
  } catch (e) {
    if (e.status === 401) { logout(); }
    throw e;
  }
}

function gate() {
  const authed = !!TOKEN;
  document.getElementById('loginView').classList.toggle('hidden', authed);
  document.getElementById('dash').classList.toggle('hidden', !authed);
  document.getElementById('logoutBtn').classList.toggle('hidden', !authed);
  if (authed) loadDash();
}

async function doLogin() {
  const password = document.getElementById('pw').value;
  try {
    const { token } = await api('api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    TOKEN = token; localStorage.setItem('adminToken', token);
    document.getElementById('pw').value = '';
    gate();
  } catch (e) { toast(e.message); }
}

function logout() {
  TOKEN = ''; localStorage.removeItem('adminToken'); gate();
}

async function createQuestion() {
  const titleEl = document.getElementById('newTitle');
  const title = titleEl.value.trim();
  if (!title) {
    toast('Fyll i det översta fältet "Fråga" innan du sparar');
    titleEl.focus();
    titleEl.style.borderColor = 'var(--danger)';
    setTimeout(() => { titleEl.style.borderColor = ''; }, 2500);
    return;
  }
  const body = {
    title,
    description: document.getElementById('newDesc').value.trim(),
    allow_suggestions: document.getElementById('newAllow').checked,
    seeds: document.getElementById('newSeeds').value,
  };
  try {
    await aapi('api/admin/questions', { method: 'POST', body: JSON.stringify(body) });
    document.getElementById('newTitle').value = '';
    document.getElementById('newDesc').value = '';
    document.getElementById('newSeeds').value = '';
    toast('Omröstning skapad');
    loadDash();
  } catch (e) { toast(e.message); }
}

async function loadDash() {
  const qs = await aapi('api/admin/questions');
  const el = document.getElementById('questions');
  if (!qs.length) { el.innerHTML = '<p class="muted">Inga omröstningar än.</p>'; return; }
  el.innerHTML = qs.map(renderQuestion).join('');
}

function statusPill(s) {
  const map = { active: ['green', 'aktiv'], draft: ['amber', 'utkast'], closed: ['gray', 'stängd'] };
  const [c, t] = map[s] || ['gray', s];
  return `<span class="pill ${c}">${t}</span>`;
}

function renderQuestion(q) {
  const pending = Number(q.pending_count);
  return `
  <div class="card" data-q="${q.id}">
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div style="flex:1;min-width:200px">
        <div style="font-weight:800;font-size:1.05rem">${esc(q.title)} ${statusPill(q.status)}</div>
        <div class="muted" style="font-size:.85rem;margin-top:3px">${esc(q.description || '')}</div>
      </div>
      ${pending ? `<span class="pill amber">${pending} väntar på granskning</span>` : ''}
    </div>

    <div class="stat-grid" style="margin:14px 0">
      <div class="stat"><div class="n">${q.approved_count}</div><div class="l">godkända alternativ</div></div>
      <div class="stat"><div class="n">${q.vote_count}</div><div class="l">röster</div></div>
      <div class="stat"><div class="n">${pending}</div><div class="l">i kö</div></div>
    </div>

    <div class="row">
      ${pending ? `<button class="btn warn sm" onclick="toggle(${q.id},'mod')">Granska kö (${pending})</button>` : ''}
      <button class="btn sm" onclick="toggle(${q.id},'ideas')">Hantera alternativ</button>
      <button class="btn ghost sm" onclick="toggle(${q.id},'settings')">Inställningar</button>
      <a class="btn ghost sm" href="api/admin/questions/${q.id}/export?format=csv" onclick="return dl(event,${q.id})">Exportera CSV</a>
      <a class="btn ghost sm" href="results?q=${q.id}" target="_blank">Öppna resultat ↗</a>
      <a class="btn ghost sm" href="share?q=${q.id}" target="_blank">QR / dela ↗</a>
      <button class="btn warn sm" onclick="resetVotes(${q.id})">Nollställ röster</button>
      <button class="btn danger sm" onclick="delQuestion(${q.id})">Radera</button>
    </div>

    <div id="panel-${q.id}" class="panel hidden" style="margin-top:14px"></div>
  </div>`;
}

const openPanels = {};
async function toggle(qid, kind) {
  const panel = document.getElementById('panel-' + qid);
  if (openPanels[qid] === kind && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden'); openPanels[qid] = null; return;
  }
  openPanels[qid] = kind;
  panel.classList.remove('hidden');
  panel.innerHTML = '<p class="muted">Laddar…</p>';
  if (kind === 'mod') return renderMod(qid, panel);
  if (kind === 'ideas') return renderIdeas(qid, panel);
  if (kind === 'settings') return renderSettings(qid, panel);
}

async function renderMod(qid, panel) {
  const list = await aapi(`api/admin/questions/${qid}/ideas?status=pending`);
  if (!list.length) { panel.innerHTML = '<p class="muted">Inget i kön. 🎉</p>'; return; }
  list.forEach((i) => { ideaTextCache[i.id] = i.text; });
  panel.innerHTML = `<h2 style="font-size:1rem;margin-bottom:8px">Förslag att granska</h2>` + list.map((i) => `
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
  const list = await aapi(`api/admin/questions/${qid}/ideas`);
  const approved = list.filter((i) => i.status === 'approved');
  approved.forEach((i) => { ideaTextCache[i.id] = i.text; });
  panel.innerHTML = `
    <h2 style="font-size:1rem;margin-bottom:8px">Lägg till alternativ — separera varje med en tom rad (får gå över flera rader)</h2>
    <textarea id="seed-${qid}" rows="6" placeholder="Ett förslag som&#10;går över flera rader&#10;&#10;Nästa förslag"></textarea>
    <div class="spacer"></div>
    <button class="btn accent sm" onclick="addSeeds(${qid})">Lägg till</button>
    <h2 style="font-size:1rem;margin:16px 0 8px">Godkända alternativ (${approved.length})</h2>
    ${approved.map((i) => `
      <div class="qlist-item" id="idearow-${i.id}">
        <div style="flex:1;white-space:pre-line">${esc(i.text)} <span class="muted" style="font-size:.78rem">(poäng ${i.score}, ${i.votes} röster)</span></div>
        <div class="row">
          <button class="btn ghost sm" onclick="editIdea(${qid},${i.id})">Redigera</button>
          <button class="btn danger sm" onclick="delIdea(${i.id},${qid})">Ta bort</button>
        </div>
      </div>`).join('') || '<p class="muted">Inga ännu.</p>'}`;
}

// Reload whichever panel (moderation queue or idea list) is currently open.
function reloadPanel(qid) {
  const p = document.getElementById('panel-' + qid);
  if (!p) return;
  if (openPanels[qid] === 'mod') renderMod(qid, p);
  else renderIdeas(qid, p);
}

// Inline edit of an alternative's text (multi-line allowed).
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
  const ta = document.getElementById('edit-' + id);
  ta.value = ideaTextCache[id] || '';
  ta.focus();
}

async function saveIdea(qid, id) {
  const text = document.getElementById('edit-' + id).value.trim();
  if (!text) return toast('Texten kan inte vara tom');
  try {
    await aapi('api/admin/ideas/' + id, { method: 'PATCH', body: JSON.stringify({ text }) });
    ideaTextCache[id] = text;
    toast('Sparat');
    reloadPanel(qid);
  } catch (e) { toast(e.message); }
}

async function renderSettings(qid, panel) {
  const q = await api('api/questions/' + qid);
  panel.innerHTML = `
    <h2 style="font-size:1rem;margin-bottom:8px">Inställningar</h2>
    <label>Fråga</label><input type="text" id="set-title-${qid}" value="${esc(q.title)}">
    <label>Beskrivning</label><input type="text" id="set-desc-${qid}" value="${esc(q.description || '')}">
    <label>Status</label>
    <select id="set-status-${qid}">
      <option value="active" ${q.status === 'active' ? 'selected' : ''}>Aktiv (öppen för röstning)</option>
      <option value="draft"  ${q.status === 'draft' ? 'selected' : ''}>Utkast (dold)</option>
      <option value="closed" ${q.status === 'closed' ? 'selected' : ''}>Stängd (visa bara resultat)</option>
    </select>
    <label class="switch" style="margin-top:12px"><input type="checkbox" id="set-allow-${qid}" ${q.allow_suggestions ? 'checked' : ''}> Tillåt deltagarförslag</label>
    <div class="spacer"></div>
    <button class="btn sm" onclick="saveSettings(${qid})">Spara</button>`;
}

async function saveSettings(qid) {
  const body = {
    title: document.getElementById('set-title-' + qid).value.trim(),
    description: document.getElementById('set-desc-' + qid).value.trim(),
    status: document.getElementById('set-status-' + qid).value,
    allow_suggestions: document.getElementById('set-allow-' + qid).checked,
  };
  try { await aapi('api/admin/questions/' + qid, { method: 'PATCH', body: JSON.stringify(body) }); toast('Sparat'); loadDash(); }
  catch (e) { toast(e.message); }
}

async function addSeeds(qid) {
  const texts = document.getElementById('seed-' + qid).value;
  if (!texts.trim()) return;
  try { await aapi(`api/admin/questions/${qid}/ideas`, { method: 'POST', body: JSON.stringify({ texts }) }); toast('Tillagt'); loadDash(); }
  catch (e) { toast(e.message); }
}

async function setIdea(id, status, qid) {
  try { await aapi('api/admin/ideas/' + id, { method: 'PATCH', body: JSON.stringify({ status }) }); toast(status === 'approved' ? 'Godkänt' : 'Avslaget'); loadDash(); }
  catch (e) { toast(e.message); }
}

async function delIdea(id, qid) {
  if (!confirm('Ta bort alternativet?')) return;
  try { await aapi('api/admin/ideas/' + id, { method: 'DELETE' }); loadDash(); } catch (e) { toast(e.message); }
}

async function resetVotes(qid) {
  if (!confirm('Nollställ ALLA röster och poäng för den här omröstningen? Alternativen behålls. Detta går inte att ångra.')) return;
  try {
    const r = await aapi('api/admin/questions/' + qid + '/reset', { method: 'POST' });
    toast(`Nollställt — ${r.clearedVotes} röster rensade`);
    loadDash();
  } catch (e) { toast(e.message); }
}

async function delQuestion(qid) {
  if (!confirm('Radera hela omröstningen med alla röster? Detta går inte att ångra.')) return;
  try { await aapi('api/admin/questions/' + qid, { method: 'DELETE' }); toast('Raderad'); loadDash(); } catch (e) { toast(e.message); }
}

// CSV export needs the auth header, so fetch as blob instead of a plain link.
async function dl(ev, qid) {
  ev.preventDefault();
  try {
    const res = await fetch(`api/admin/questions/${qid}/export?format=csv`, { headers: authHeaders() });
    if (!res.ok) throw new Error('Export misslyckades');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `resultat-${qid}.csv`; a.click();
    URL.revokeObjectURL(url);
  } catch (e) { toast(e.message); }
  return false;
}

gate();
