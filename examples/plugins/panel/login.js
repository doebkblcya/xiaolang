const form = document.getElementById('access-form'), input = document.getElementById('access-key');
const button = document.getElementById('access-submit'), message = document.getElementById('access-message');
form.addEventListener('submit', async event => {
  event.preventDefault(); button.disabled = true;
  try {
    const response = await fetch('/api/auth/session', { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: input.value.trim() }) });
    input.value = '';
    if (response.ok) { location.replace('/'); return; }
    message.textContent = response.status === 429 ? '尝试次数过多，请 15 分钟后再试。' : 'Key 不正确，请检查后重试。';
  } catch { message.textContent = '暂时无法连接面板，请稍后重试。'; }
  finally { button.disabled = false; }
});
