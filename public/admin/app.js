// Abhi Utility admin panel (no build step). Talks to /api/v1/*.
(() => {
  const $ = (sel) => document.querySelector(sel);
  const store = sessionStorage; // logged out when the browser tab closes

  const state = { page: 1, total: 0, pageSize: 25, current: null, me: null, plans: [], editingPlan: null };

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
    t.classList.add('hidden');
    void t.offsetWidth; // restart the enter animation
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

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    const use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  }

  function initials(name, email) {
    const src = (name || '').trim() || (email || '').split('@')[0];
    const parts = src.split(/[\s._-]+/).filter(Boolean);
    return ((parts[0]?.[0] || '?') + (parts[1]?.[0] || '')).toUpperCase();
  }
  function avatarClass(seed) {
    let h = 0;
    for (const ch of String(seed)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const c = h % 5;
    return c ? `c${c}` : '';
  }
  const avatar = (name, email, extra = '') => el('span', { class: `avatar ${avatarClass(email)} ${extra}` }, initials(name, email));

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
      $('#me-avatar').textContent = initials(me.user.name, me.user.email);
      $('#login-view').classList.add('hidden');
      $('#app-view').classList.remove('hidden');
      await Promise.all([loadStats(), loadUsers(), loadPlans()]);
      showView(location.hash === '#plans' ? 'plans' : 'users');
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
      ['Total users', s.users, 'users', ''],
      ['Pro now', s.pro, 'star', 'green'],
      ['On free trial', s.onTrial, 'clock', 'teal'],
      ['Paying (store)', s.paying, 'card', 'green'],
      ['New this week', s.newThisWeek, 'trend', 'amber'],
      ['Disabled', s.disabled, 'ban', 'red'],
    ];
    $('#stats').replaceChildren(
      ...items.map(([label, value, ic, tone]) =>
        el(
          'div',
          { class: 'stat' },
          el('div', { class: 'stat-top' }, el('div', { class: 'label' }, label), el('span', { class: `stat-icon ${tone}` }, icon(ic))),
          el('div', { class: 'value' }, Number(value ?? 0).toLocaleString()),
        ),
      ),
    );
  }

  const statusEl = (status) =>
    el('span', { class: `status ${status === 'active' ? '' : 'off'}` }, el('span', { class: 'dot' }), status === 'active' ? 'Active' : 'Disabled');

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
        el(
          'td',
          {},
          el(
            'div',
            { class: 'user-cell' },
            avatar(u.name, u.email),
            el('div', { class: 'who' }, el('strong', {}, u.name || u.email.split('@')[0]), el('span', {}, u.email)),
          ),
        ),
        el('td', {}, u.isPro ? badge('Pro', 'pro') : u.onTrial ? badge('Trial', 'trial') : badge('Free')),
        el('td', {}, u.role === 'admin' ? badge('Admin', 'admin') : 'User'),
        el('td', {}, statusEl(u.status)),
        el('td', { class: 'dim' }, fmtDay(u.createdAt)),
        el('td', { class: 'dim' }, fmtDate(u.lastLoginAt)),
      ),
    );
    $('#users').replaceChildren(...(rows.length ? rows : [el('tr', {}, el('td', { class: 'empty', colspan: '6' }, 'No users match your search'))]));
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    const from = state.total ? (state.page - 1) * state.pageSize + 1 : 0;
    const to = Math.min(state.page * state.pageSize, state.total);
    $('#page-info').textContent = `Showing ${from}–${to} of ${state.total.toLocaleString()} users`;
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
    $('#u-title').textContent = user.name ? `${user.name}` : user.email;
    const av = $('#u-avatar');
    av.className = `avatar lg ${avatarClass(user.email)}`;
    av.textContent = initials(user.name, user.email);
    $('#u-tags').replaceChildren(
      ...[
        user.name ? el('span', { class: 'muted' }, user.email) : null,
        entitlement.isPro ? (entitlement.isTrial ? badge('Trial', 'trial') : badge('Pro', 'pro')) : badge('Free'),
        user.role === 'admin' ? badge('Admin', 'admin') : null,
        user.status !== 'active' ? badge('Disabled', 'disabled') : null,
      ].filter(Boolean),
    );

    const dl = el('dl', { class: 'summary' });
    const add = (k, v, cls) => dl.append(el('dt', {}, k), el('dd', cls ? { class: cls } : {}, v));
    add('Name', user.name || '—');
    add('Plan', entitlementText(entitlement));
    add('Created', `${fmtDate(user.createdAt)}${user.createdByAdmin ? ' (by admin)' : ''}`);
    add('Last login', fmtDate(user.lastLoginAt));
    add('Account token', user.accountToken, 'mono');
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
              el('td', {}, planLabel(s.product_id)),
              el('td', {}, badge(s.status, s.status === 'active' ? 'pro' : '')),
              el('td', {}, s.expires_at ? fmtDate(s.expires_at) : 'never'),
              el('td', {}, s.note || ''),
              el(
                'td',
                {},
                (s.source === 'admin' || s.source === 'trial') && s.status === 'active'
                  ? el('button', { class: 'ghost danger-text sm', type: 'button', onclick: () => revoke(s.id, s.source) }, s.source === 'trial' ? 'End trial' : 'Revoke')
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
        ? actions.map((a) =>
            el(
              'li',
              {},
              el('span', { class: 'when' }, fmtDate(a.created_at)),
              `${a.action.replaceAll('_', ' ')} · by ${a.admin_email || 'deleted admin'}`,
            ),
          )
        : [el('li', { class: 'none' }, 'No admin changes yet')]),
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

  // ---- Views ------------------------------------------------------------------------

  function showView(name) {
    for (const v of ['users', 'plans']) {
      $(`#${v}-view`).classList.toggle('hidden', v !== name);
      const link = document.querySelector(`.nav a[data-view="${v}"]`);
      link.classList.toggle('active', v === name);
      if (v === name) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    if (name === 'plans') loadPlans().catch((e) => toast(e.message, true));
  }
  document.querySelectorAll('.nav a[data-view]').forEach((a) =>
    a.addEventListener('click', (ev) => {
      ev.preventDefault();
      history.replaceState(null, '', `#${a.dataset.view}`);
      showView(a.dataset.view);
    }),
  );

  // ---- Plans ------------------------------------------------------------------------

  const PERIODS = { week: 'Every week', month: 'Every month', quarter: 'Every 3 months', half_year: 'Every 6 months', year: 'Every year' };

  function money(amount, currency) {
    if (amount === null || amount === undefined) return '—';
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
    } catch {
      return `${currency} ${Number(amount).toFixed(2)}`;
    }
  }

  /** "₹1,200 + $40" for totals in several currencies. */
  const moneyTotals = (totals, key) => {
    const parts = Object.entries(totals).map(([cur, t]) => money(t[key], cur));
    return parts.length ? parts.join(' + ') : money(0, 'INR');
  };

  /** Plan name for a subscription's product id (admin grants / trials keep their id). */
  function planLabel(productId) {
    const p = state.plans.find((x) => x.productId === productId);
    if (!p) return productId;
    return el('span', {}, `${p.name} · ${money(p.price, p.currency)}`, el('span', { class: 'sub mono' }, productId));
  }

  async function loadPlans() {
    const [data, hist] = await Promise.all([api('/admin/plans'), api('/admin/plans/history')]);
    state.plans = data.plans;
    renderPlanStats(data);
    renderPlans(data);
    renderPlanHistory(hist.history);
  }

  function renderPlanStats({ plans, totals }) {
    const shown = plans.filter((p) => p.active).length;
    const paying = plans.reduce((n, p) => n + p.subscribers.active, 0);
    const renewing = plans.reduce((n, p) => n + p.subscribers.renewing, 0);
    const noPrice = plans.filter((p) => p.price === null && p.subscribers.active > 0).length;
    const items = [
      ['Plans in the app', `${shown}`, `${plans.length} in total`, 'tag', ''],
      ['Paying subscribers', paying.toLocaleString(), `${renewing.toLocaleString()} will renew`, 'card', 'green'],
      ['Revenue / month (est.)', moneyTotals(totals, 'monthly'), noPrice ? `${noPrice} plan(s) have no amount` : 'from active subscriptions', 'wallet', 'teal'],
      ['Revenue / year (est.)', moneyTotals(totals, 'yearly'), 'if everyone stays subscribed', 'trend', 'amber'],
    ];
    $('#plan-stats').replaceChildren(
      ...items.map(([label, value, sub, ic, tone]) =>
        el(
          'div',
          { class: 'stat' },
          el('div', { class: 'stat-top' }, el('div', { class: 'label' }, label), el('span', { class: `stat-icon ${tone}` }, icon(ic))),
          el('div', { class: 'value money' }, value),
          el('div', { class: 'sub' }, sub),
        ),
      ),
    );
  }

  function renderPlans({ plans, unknownProducts }) {
    const rows = plans.map((p) =>
      el(
        'tr',
        { class: 'clickable', onclick: () => openPlan(p) },
        el('td', { class: 'wrap' }, el('strong', {}, p.name), p.badge ? ' ' : '', p.badge ? badge(p.badge, 'trial') : '',
          p.description ? el('span', { class: 'sub' }, p.description) : ''),
        el('td', { class: 'mono' }, p.productId),
        el('td', {}, PERIODS[p.period] || p.period),
        el('td', { class: 'num' }, p.price === null ? badge('Not set', 'warn') : money(p.price, p.currency)),
        el('td', {}, p.active ? badge('Shown', 'pro') : badge('Hidden')),
        el('td', { class: 'num' }, `${p.subscribers.active}`, el('span', { class: 'sub' }, `${p.subscribers.ever} ever`)),
        el('td', { class: 'num' }, p.revenuePerMonth === null ? '—' : money(p.revenuePerMonth, p.currency)),
      ),
    );
    $('#plans').replaceChildren(
      ...(rows.length ? rows : [el('tr', {}, el('td', { class: 'empty', colspan: '7' }, 'No plans yet — the app shows no plans to buy'))]),
    );
    const unknown = $('#unknown-products');
    unknown.classList.toggle('hidden', !unknownProducts.length);
    unknown.textContent = unknownProducts.length
      ? `Store subscriptions for products that aren't in this list: ${unknownProducts
          .map((u) => `${u.productId} (${u.active} active, ${u.ever} ever)`)
          .join(', ')}. Add a plan with that product ID to include them in revenue.`
      : '';
  }

  function describeChange(a) {
    const d = typeof a.details === 'string' ? JSON.parse(a.details) : a.details || {};
    if (a.action === 'create_plan') return `created ${d.name} (${d.productId}) · ${money(d.price, d.currency)}`;
    if (a.action === 'delete_plan') return `deleted ${d.name} (${d.productId})`;
    const what = Object.entries(d.changed || {})
      .map(([k, c]) => `${k}: ${c.from ?? '—'} → ${c.to ?? '—'}`)
      .join(', ');
    return `changed ${d.productId}${what ? ` · ${what}` : ''}`;
  }

  function renderPlanHistory(history) {
    $('#plan-history').replaceChildren(
      ...(history.length
        ? history.map((a) =>
            el('li', {}, el('span', { class: 'when' }, `${fmtDate(a.created_at)} · ${a.admin_email || 'deleted admin'}`), describeChange(a)),
          )
        : [el('li', { class: 'none' }, 'No changes yet')]),
    );
  }

  function openPlan(plan) {
    state.editingPlan = plan;
    const f = $('#plan-form');
    f.reset();
    $('#plan-error').textContent = '';
    $('#plan-title').textContent = plan ? `Edit ${plan.name}` : 'New plan';
    f.elements.name.value = plan?.name ?? '';
    f.productId.value = plan?.productId ?? '';
    f.productId.disabled = !!plan;
    f.period.value = plan?.period ?? 'month';
    f.price.value = plan?.price ?? '';
    f.currency.value = plan?.currency ?? 'INR';
    f.badge.value = plan?.badge ?? '';
    f.sortOrder.value = plan?.sortOrder ?? (state.plans.reduce((m, p) => Math.max(m, p.sortOrder), 0) + 1);
    f.description.value = plan?.description ?? '';
    f.active.checked = plan ? plan.active : true;
    $('#plan-locked-hint').textContent = plan
      ? "The product ID can't change (subscriptions are linked to it). To use another ID, create a new plan and hide this one."
      : '';
    const del = $('#plan-delete');
    del.classList.toggle('hidden', !plan);
    del.disabled = !!plan && plan.subscribers.ever > 0;
    del.title = del.disabled ? 'People bought this plan: hide it instead' : '';
    $('#plan-dialog').showModal();
  }

  $('#new-plan').addEventListener('click', () => openPlan(null));

  $('#plan-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const body = {
      name: f.elements.name.value,
      period: f.period.value,
      price: f.price.value === '' ? null : Number(f.price.value),
      currency: f.currency.value.trim().toUpperCase(),
      badge: f.badge.value,
      description: f.description.value,
      sortOrder: Number(f.sortOrder.value || 0),
      active: f.active.checked,
    };
    const editing = state.editingPlan;
    try {
      if (editing) await api(`/admin/plans/${editing.id}`, { method: 'PATCH', body });
      else await api('/admin/plans', { method: 'POST', body: { ...body, productId: f.productId.value.trim() } });
      $('#plan-dialog').close();
      toast(editing ? 'Plan saved — the app shows it on the next refresh' : 'Plan created — add the same product ID in Play Console');
      await loadPlans();
    } catch (e) {
      $('#plan-error').textContent = e.message;
    }
  });

  $('#plan-delete').addEventListener('click', async () => {
    const p = state.editingPlan;
    if (!p || !confirm(`Delete the plan ${p.name} (${p.productId})?`)) return;
    try {
      await api(`/admin/plans/${p.id}`, { method: 'DELETE' });
      $('#plan-dialog').close();
      toast('Plan deleted');
      await loadPlans();
    } catch (e) {
      $('#plan-error').textContent = e.message;
    }
  });

  // ---- Start ------------------------------------------------------------------------
  if (store.getItem('accessToken')) showApp();
  else showLogin();
})();
