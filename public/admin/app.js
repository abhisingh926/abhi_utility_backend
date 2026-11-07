// Abhi Utility admin panel (no build step). Talks to /api/v1/*.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const store = sessionStorage; // logged out when the browser tab closes

  const state = { page: 1, total: 0, pageSize: 25, current: null, me: null };

  // ---- API ----------------------------------------------------------------------

  async function refreshTokens() {
    const refreshToken = store.getItem('refreshToken');
    if (!refreshToken) return false;
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken, device: 'admin-panel' }),
    });
    if (!res.ok) return false;
    const data = await res.json();
    store.setItem('accessToken', data.accessToken);
    store.setItem('refreshToken', data.refreshToken);
    return true;
  }

  async function api(path, { method = 'GET', body } = {}, retried = false) {
    const res = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${store.getItem('accessToken') || ''}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && !retried && (await refreshTokens())) return api(path, { method, body }, true);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      logout();
      throw new Error('Please log in again');
    }
    if (!res.ok) throw new Error(data.error?.message || `Request failed (${res.status})`);
    return data;
  }

  // ---- Helpers ------------------------------------------------------------------

  function toast(msg, bad = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('bad', bad);
    t.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => t.classList.add('hidden'), 3000);
  }

  const fmtDate = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const fmtDay = (d) => (d ? new Date(d).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) node.append(c instanceof Node ? c : document.createTextNode(c ?? ''));
    return node;
  }

  const badge = (text, cls = '') => el('span', { class: `badge ${cls}` }, text);

  function entitlementText(e) {
    if (!e.isPro) return e.trial && e.trial.used ? `Free · trial ended ${fmtDay(e.trial.endsAt)}` : 'Free';
    if (e.isTrial) return `Free trial · until ${fmtDay(e.expiresAt)}`;
    const until = e.expiresAt ? `until ${fmtDay(e.expiresAt)}` : 'lifetime';
    return `Pro (${e.source}) · ${until}${e.autoRenew ? ' · renews' : ''}`;
  }

  function randomPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  // ---- Login --------------------------------------------------------------------

  function showLogin() {
    $('#app-view').classList.add('hidden');
    $('#login-view').classList.remove('hidden');
  }

  async function showApp() {
    try {
      const me = await api('/me');
      if (me.user.role !== 'admin') throw new Error('This account is not an admin');
      state.me = me.user;
      $('#me-email').textContent = me.user.email;
      $('#login-view').classList.add('hidden');
      $('#app-view').classList.remove('hidden');
      await Promise.all([loadStats(), loadUsers()]);
    } catch (e) {
      logout();
      $('#login-error').textContent = e.message;
    }
  }

  $('#login-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    $('#login-error').textContent = '';
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: f.get('email'), password: f.get('password'), device: 'admin-panel' }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Login failed');
      if (data.user.role !== 'admin') throw new Error('This account is not an admin');
      store.setItem('accessToken', data.accessToken);
      store.setItem('refreshToken', data.refreshToken);
      ev.target.reset();
      showApp();
    } catch (e) {
      $('#login-error').textContent = e.message;
    }
  });

  function logout() {
    const refreshToken = store.getItem('refreshToken');
    if (refreshToken) {
      fetch('/api/v1/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    }
    store.clear();
    showLogin();
  }
  $('#logout').addEventListener('click', logout);

  // ---- Stats & users ------------------------------------------------------------

  async function loadStats() {
    const s = await api('/admin/stats');
    const items = [
      ['Users', s.users],
      ['Pro now', s.pro],
      ['On free trial', s.onTrial],
      ['Paying (store)', s.paying],
      ['New this week', s.newThisWeek],
      ['Disabled', s.disabled],
    ];
    $('#stats').replaceChildren(
      ...items.map(([label, value]) => el('div', { class: 'stat' }, el('div', { class: 'value' }, String(value)), el('div', { class: 'label' }, label))),
    );
  }

  async function loadUsers() {
    const q = encodeURIComponent($('#search').value.trim());
    const filter = $('#filter').value;
    const data = await api(`/admin/users?q=${q}&filter=${filter}&page=${state.page}`);
    state.total = data.total;
    state.pageSize = data.pageSize;
    const rows = data.users.map((u) =>
      el(
        'tr',
        { class: 'clickable', onclick: () => openUser(u.id) },
        el('td', {}, u.email),
        el('td', {}, u.name || '—'),
        el('td', {}, u.isPro ? badge('Pro', 'pro') : u.onTrial ? badge('Trial', 'trial') : badge('Free')),
        el('td', {}, u.role === 'admin' ? badge('Admin', 'admin') : 'User'),
        el('td', {}, u.status === 'active' ? 'Active' : badge('Disabled', 'disabled')),
        el('td', {}, fmtDay(u.createdAt)),
        el('td', {}, fmtDate(u.lastLoginAt)),
      ),
    );
    $('#users').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { class: 'empty', colspan: '7' }, 'No users found'))]));
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    $('#page-info').textContent = `Page ${state.page} of ${pages} · ${state.total} users`;
    $('#prev').disabled = state.page <= 1;
    $('#next').disabled = state.page >= pages;
  }

  let searchTimer;
  $('#search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.page = 1; loadUsers(); }, 300);
  });
  $('#filter').addEventListener('change', () => { state.page = 1; loadUsers(); });
  $('#prev').addEventListener('click', () => { state.page--; loadUsers(); });
  $('#next').addEventListener('click', () => { state.page++; loadUsers(); });

  async function refreshAll() {
    await Promise.all([loadStats(), loadUsers()]);
  }

  // ---- New user -------------------------------------------------------------------

  $('#new-user').addEventListener('click', () => {
    $('#new-user-form').reset();
    $('#new-user-error').textContent = '';
    $('#new-user-form').password.value = randomPassword();
    $('#new-user-dialog').showModal();
  });
  $('#gen-password').addEventListener('click', () => { $('#new-user-form').password.value = randomPassword(); });

  $('#new-user-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const proDays = f.get('proDays');
    try {
      const res = await api('/admin/users', {
        method: 'POST',
        body: {
          email: f.get('email'),
          name: f.get('name'),
          password: f.get('password'),
          role: f.get('role'),
          proDays: proDays === 'lifetime' ? 'lifetime' : proDays ? Number(proDays) : undefined,
        },
      });
      $('#new-user-dialog').close();
      toast(`Created ${res.user.email} — share the password with them: ${f.get('password')}`);
      refreshAll();
    } catch (e) {
      $('#new-user-error').textContent = e.message;
    }
  });

  // ---- User details ---------------------------------------------------------------

  async function openUser(id) {
    try {
      const d = await api(`/admin/users/${id}`);
      state.current = d;
      renderUser();
      if (!$('#user-dialog').open) $('#user-dialog').showModal();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderUser() {
    const { user, entitlement, subscriptions, actions, backup } = state.current;
    const self = user.id === state.me.id;
    $('#u-title').textContent = user.email;

    const dl = el('dl', { class: 'summary' });
    const add = (k, v) => dl.append(el('dt', {}, k), el('dd', {}, v));
    add('Name', user.name || '—');
    add('Plan', entitlementText(entitlement));
    add('Role', user.role);
    add('Status', user.status);
    add('Created', `${fmtDate(user.createdAt)}${user.createdByAdmin ? ' (by admin)' : ''}`);
    add('Last login', fmtDate(user.lastLoginAt));
    add('Account token', user.accountToken);
    const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
    add(
      'Cloud backup',
      backup && backup.backups
        ? `${backup.backups} backups · ${backup.photos} photos · ${mb(backup.backupBytes + backup.photoBytes)} of ${mb(backup.quotaBytes)} · last ${fmtDate(backup.lastBackupAt)}`
        : 'No backups',
    );
    $('#u-summary').replaceChildren(dl);
    $('#u-delete-backups').disabled = !(backup && (backup.backups || backup.photos));

    $('#u-subs').replaceChildren(
      ...(subscriptions.length
        ? subscriptions.map((s) =>
            el(
              'tr',
              {},
              el('td', {}, s.source),
              el('td', {}, s.product_id),
              el('td', {}, s.status),
              el('td', {}, s.expires_at ? fmtDate(s.expires_at) : 'never'),
              el('td', {}, s.note || ''),
              el(
                'td',
                {},
                (s.source === 'admin' || s.source === 'trial') && s.status === 'active'
                  ? el('button', { class: 'ghost', onclick: () => revoke(s.id, s.source) }, s.source === 'trial' ? 'End trial' : 'Revoke')
                  : '',
              ),
            ),
          )
        : [el('tr', {}, el('td', { class: 'empty', colspan: '6' }, 'No subscriptions'))]),
    );

    const statusBtn = $('#u-toggle-status');
    statusBtn.textContent = user.status === 'active' ? 'Disable account' : 'Enable account';
    statusBtn.disabled = self;
    const roleBtn = $('#u-toggle-role');
    roleBtn.textContent = user.role === 'admin' ? 'Remove admin' : 'Make admin';
    roleBtn.disabled = self;
    $('#u-delete').disabled = self;

    $('#u-actions').replaceChildren(
      ...(actions.length
        ? actions.map((a) => el('li', {}, `${fmtDate(a.created_at)} · ${a.action.replace('_', ' ')} · by ${a.admin_email || 'deleted admin'}`))
        : [el('li', {}, 'No admin changes yet')]),
    );
  }

  async function act(fn, okMsg) {
    try {
      await fn();
      toast(okMsg);
      await openUser(state.current.user.id);
      refreshAll();
    } catch (e) {
      toast(e.message, true);
    }
  }

  $('#grant-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    const days = f.get('days');
    const body = days === 'lifetime' ? { lifetime: true } : { days: Number(days) };
    body.note = f.get('note') || undefined;
    act(() => api(`/admin/users/${state.current.user.id}/grant`, { method: 'POST', body }), 'Pro given');
    ev.target.reset();
  });

  function revoke(subId, source) {
    const trial = source === 'trial';
    if (!confirm(trial ? 'End this free trial now? The user will need to subscribe.' : 'End this Pro grant now?')) return;
    act(() => api(`/admin/users/${state.current.user.id}/subscriptions/${subId}/revoke`, { method: 'POST' }),
      trial ? 'Trial ended' : 'Pro removed');
  }

  $('#reset-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const password = new FormData(ev.target).get('password');
    act(
      () => api(`/admin/users/${state.current.user.id}/reset-password`, { method: 'POST', body: { password } }),
      'Password changed — the user is logged out everywhere',
    );
    ev.target.reset();
  });

  $('#u-toggle-status').addEventListener('click', () => {
    const u = state.current.user;
    const status = u.status === 'active' ? 'disabled' : 'active';
    act(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { status } }), status === 'disabled' ? 'Account disabled' : 'Account enabled');
  });

  $('#u-toggle-role').addEventListener('click', () => {
    const u = state.current.user;
    const role = u.role === 'admin' ? 'user' : 'admin';
    if (role === 'admin' && !confirm(`Give ${u.email} full admin access?`)) return;
    act(() => api(`/admin/users/${u.id}`, { method: 'PATCH', body: { role } }), 'Role changed');
  });

  $('#u-delete-backups').addEventListener('click', () => {
    const u = state.current.user;
    if (!confirm(`Delete all cloud backups and backup photos of ${u.email}? They can't be restored afterwards.`)) return;
    act(() => api(`/admin/users/${u.id}/backups`, { method: 'DELETE' }), 'Backups deleted');
  });

  $('#u-delete').addEventListener('click', async () => {
    const u = state.current.user;
    if (!confirm(`Delete ${u.email} and all their data? This cannot be undone.`)) return;
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      $('#user-dialog').close();
      toast('User deleted');
      refreshAll();
    } catch (e) {
      toast(e.message, true);
    }
  });

  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

  // ---- Start ------------------------------------------------------------------------
  if (store.getItem('accessToken')) showApp();
  else showLogin();
})();
