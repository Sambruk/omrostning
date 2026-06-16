// Shared helpers across all pages. Uses relative URLs so the app works under any
// reverse-proxy prefix (e.g. /ideas/).

// ---- theme ----
function applyTheme(t) {
  if (t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
}
applyTheme(localStorage.getItem('theme'));
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme');
  const isDark = cur ? cur === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  const next = isDark ? 'light' : 'dark';
  localStorage.setItem('theme', next);
  applyTheme(next);
}

// ---- anonymous voter id ----
function voterId() {
  let v = localStorage.getItem('voter');
  if (!v) { v = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('voter', v); }
  return v;
}

// ---- fetch helpers ----
async function api(path, opts = {}) {
  const { headers, ...rest } = opts;
  const res = await fetch(path, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(headers || {}) },
  });
  if (!res.ok) {
    let msg = 'Fel';
    try { msg = (await res.json()).error || msg; } catch {}
    const err = new Error(msg); err.status = res.status; throw err;
  }
  return res.status === 204 ? null : res.json();
}

// ---- toast ----
let toastT;
function toast(msg) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 2200);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Fetch the logged-in creator's OWN polls (or null if not logged in / failed).
async function ownPolls() {
  const tok = localStorage.getItem('userToken');
  if (!tok) return null;
  try {
    const r = await fetch('api/user/questions', { headers: { Authorization: 'Bearer ' + tok } });
    if (!r.ok) return null;
    return r.json();
  } catch { return null; }
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}
