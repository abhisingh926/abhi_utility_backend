// Web account deletion (required by Google Play / App Store for apps with sign-up).
(() => {
  const form = document.getElementById('delete-form');
  const message = document.getElementById('message');

  function show(text, good) {
    message.textContent = text;
    message.className = `message ${good ? 'good' : 'bad'}`;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const email = form.email.value;
    const password = form.password.value;
    if (!confirm('Delete your account permanently? This cannot be undone.')) return;
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      const login = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, device: 'web-delete' }),
      });
      const session = await login.json();
      if (!login.ok) throw new Error(session.error?.message || 'Wrong email or password');

      const del = await fetch('/api/v1/me', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` },
        body: JSON.stringify({ password }),
      });
      const result = await del.json();
      if (!del.ok) throw new Error(result.error?.message || 'Could not delete the account');
      form.reset();
      show('Your account has been deleted.', true);
    } catch (e) {
      show(e.message, false);
    } finally {
      button.disabled = false;
    }
  });
})();
