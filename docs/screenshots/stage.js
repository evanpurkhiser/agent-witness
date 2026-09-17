(async () => {
  await document.fonts.ready;
  const card = document.querySelector('article').cloneNode(true);
  // Chrome rasterizes blurred shadows when printing.
  card.style.boxShadow = 'none';
  card.querySelector('h2').textContent = 'Publish the v0.2.1 release';
  card.querySelector('code').textContent = 'git push origin v0.2.1';
  const list = card.querySelector('ol');
  list.lastElementChild.remove();
  const row = list.firstElementChild;
  row.querySelector('code').textContent = 'github';
  const times = row.querySelectorAll('time');
  times[0].textContent = '14:32:07';
  times[1].textContent = '87s';
  times[0].nextElementSibling.textContent = '3 seconds ago';
  card.querySelectorAll('*').forEach(element => {
    element.style.animation = 'none';
    element.style.transition = 'none';
  });
  const frame = document.createElement('main');
  frame.id = 'readme-capture';
  frame.className = 'bg-canvas text-foreground font-mono';
  frame.style.cssText = 'width:440px;padding:16px;';
  frame.append(card);
  document.body.replaceChildren(frame);
  const height = Math.ceil(frame.getBoundingClientRect().height);
  const style = document.createElement('style');
  style.textContent = `@page { size:440px ${height}px; margin:0; } html, body { margin:0; width:440px; min-height:0; height:${height}px; } * { print-color-adjust:exact !important; -webkit-print-color-adjust:exact !important; }`;
  document.head.append(style);
  return {width: 440, height};
})();
