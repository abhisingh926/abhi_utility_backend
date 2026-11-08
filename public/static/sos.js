// SOS alert page: /sos/<token>. Shows the location and the video once it is uploaded.
(() => {
  const $ = (id) => document.getElementById(id);
  const token = location.pathname.split('/').filter(Boolean)[1] || '';
  const fmt = (d) => new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  let timer;

  async function load() {
    let data;
    try {
      const res = await fetch(`/api/v1/sos/public/${encodeURIComponent(token)}`, { cache: 'no-store' });
      data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || 'This SOS link does not exist or has expired.');
    } catch (e) {
      $('when').textContent = '';
      $('error').textContent = e.message;
      $('error').classList.remove('hidden');
      $('video-section').classList.add('hidden');
      return;
    }

    $('title').textContent = data.name ? `SOS from ${data.name}` : 'Emergency alert';
    $('when').textContent = `Sent ${fmt(data.createdAt)} · no SOS contact answered their call`;
    $('expires').textContent = fmt(data.expiresAt);

    if (data.location) {
      const { lat, lng, accuracy } = data.location;
      $('coords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)}${accuracy ? ` (within about ${accuracy} m)` : ''}`;
      $('map-link').href = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
      $('location').classList.remove('hidden');
    } else {
      $('no-location').classList.remove('hidden');
    }

    if (data.video) {
      const v = $('video');
      if (!v.getAttribute('src')) v.src = data.video.url;
      v.classList.remove('hidden');
      $('video-download').href = data.video.url;
      $('video-download').classList.remove('hidden');
      $('video-wait').classList.add('hidden');
      clearInterval(timer);
    } else if (!timer) {
      timer = setInterval(load, 15000);
    }
  }

  load();
})();
