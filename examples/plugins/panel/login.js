const form = document.getElementById('access-form'), input = document.getElementById('access-key');
const button = document.getElementById('access-submit'), message = document.getElementById('access-message');
input.addEventListener('input', () => {
  input.removeAttribute('aria-invalid'); form.classList.remove('login-error'); message.hidden = true;
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true; input.readOnly = true; message.hidden = true;
  button.setAttribute('aria-busy', 'true'); form.classList.remove('login-error'); input.removeAttribute('aria-invalid');
  try {
    const response = await fetch('/api/auth/session', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: input.value.trim() }) });
    input.value = '';
    if (response.ok) { location.replace('/'); return; }
    message.textContent = response.status === 429 ? '15 分钟后重试' : 'Key 不正确';
    if (response.status === 401) { input.setAttribute('aria-invalid', 'true'); form.classList.add('login-error'); }
    message.hidden = false;
  } catch { message.textContent = '连接失败，请重试'; message.hidden = false; }
  finally { button.disabled = false; input.readOnly = false; button.removeAttribute('aria-busy'); }
});
