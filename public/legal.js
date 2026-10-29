// подставляет название, владельца и контакты сервиса из настроек сервера
(async () => {
  const set = (sel, fn) => document.querySelectorAll(sel).forEach(fn);
  set('[data-year]', (el) => (el.textContent = new Date().getFullYear()));
  try {
    const c = await (await fetch('/api/config')).json();
    if (c.brand) { set('[data-brand]', (el) => (el.textContent = c.brand)); document.title += ' — ' + c.brand; }
    if (c.owner) set('[data-owner]', (el) => (el.textContent = c.owner));
    if (c.contact) set('[data-contact]', (el) => { el.textContent = ''; const a = document.createElement('a'); a.href = 'mailto:' + c.contact; a.textContent = c.contact; el.appendChild(a); });
    if (c.clipDays) set('[data-days]', (el) => (el.textContent = c.clipDays));
  } catch {}
})();
