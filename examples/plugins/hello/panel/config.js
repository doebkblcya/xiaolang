/** The same plugin-owned editor can mount in a detail dialog or an independent page. */
export async function mount({ root, plugin, api, signal }) {
  const path = `/api/plugins/${encodeURIComponent(plugin.id)}`;
  let detail = await api.get(path);
  const form = document.createElement('form'); form.className = 'panel settings-form';
  const label = document.createElement('label'); label.className = 'field'; label.append('问候语');
  const input = document.createElement('input'); input.name = 'greeting'; input.maxLength = 100; input.value = detail.config.greeting ?? '你好'; label.append(input);
  const footer = document.createElement('div'); footer.className = 'form-footer';
  const message = document.createElement('p'); message.className = 'muted'; message.setAttribute('role', 'status');
  const button = document.createElement('button'); button.className = 'primary'; button.type = 'submit'; button.textContent = '保存';
  footer.append(message, button); form.append(label, footer); root.append(form);
  form.addEventListener('submit', async event => {
    event.preventDefault(); button.disabled = true;
    try {
      const result = await api.request(path, { revision: detail.revision, config: { greeting: input.value } });
      detail = result.plugin; message.textContent = '已保存，待应用';
    } catch (error) { message.textContent = error.message; }
    finally { button.disabled = false; }
  }, { signal });
}
