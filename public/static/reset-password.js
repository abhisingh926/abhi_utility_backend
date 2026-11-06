// Forgot password on the web: email -> 6-digit code -> new password.
(() => {
  const requestForm = document.getElementById('request-form');
  const resetForm = document.getElementById('reset-form');
  const message = document.getElementById('message');
  let email = '';

  function show(text, good) {
    message.textContent = text;
    message.className = `message ${good ? 'good' : 'bad'}`;
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error?.message || 'Something went wrong');
    return data;
  }

  async function requestCode() {
    const data = await post('/api/v1/auth/forgot-password', { email });
    requestForm.classList.add('hidden');
    resetForm.classList.remove('hidden');
    document.getElementById('sent-to').textContent = data.message;
    show('', true);
  }

  requestForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    email = requestForm.email.value.trim();
    try {
      await requestCode();
    } catch (e) {
      show(e.message, false);
    }
  });

  document.getElementById('resend').addEventListener('click', async () => {
    try {
      await requestCode();
      show('A new code has been sent.', true);
    } catch (e) {
      show(e.message, false);
    }
  });

  resetForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (resetForm.password.value !== resetForm.password2.value) {
      show('The two passwords are different.', false);
      return;
    }
    try {
      await post('/api/v1/auth/reset-password', {
        email,
        code: resetForm.code.value,
        newPassword: resetForm.password.value,
      });
      resetForm.classList.add('hidden');
      show('Your password has been changed. Log in to the app with the new password.', true);
    } catch (e) {
      show(e.message, false);
    }
  });
})();
