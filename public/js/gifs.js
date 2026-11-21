'use strict';
// Giphy picker. The API key stays on the server; this file only talks to /api/gifs.
const gifsDialog = $('gifs-dialog');
let gifConfigured = false, gifSearchId = 0;

async function initGifs() {
  try { gifConfigured = (await fetch('/api/gifs/config',{ cache:'no-store' }).then(response => response.json())).configured === true; }
  catch { gifConfigured = false; }
  $('gif-open').hidden = !gifConfigured;
}
function openGifPicker() {
  if (!user) { openAuth({ name:'gifs' },$('announcement')); return; }
  if (!gifsDialog.open) gifsDialog.showModal();
  if (!$('gif-grid').children.length && !$('gif-search').value) void gifSearch('study');
}
async function gifSearch(query) {
  if (!gifConfigured) { status('gif-search-status','GIF search is not configured.',true); return; }
  const request = ++gifSearchId;
  status('gif-search-status','Searching GIFs…');
  try {
    const { gifs } = await api(`/gifs/search?q=${encodeURIComponent(query)}`);
    if (request !== gifSearchId) return;
    const grid = $('gif-grid'); grid.replaceChildren();
    status('gif-search-status',gifs.length ? '' : 'No GIFs found.');
    for (const gif of gifs) {
      const image = element('img');
      image.src = gif.preview; image.alt = gif.title; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer';
      const tile = button('',() => selectGif(gif),'gif-tile');
      tile.dataset.gifId = gif.id;
      tile.setAttribute('aria-label',gif.title);
      tile.setAttribute('aria-pressed','false');
      tile.append(image);
      grid.append(tile);
    }
    $('gif-selected').hidden = true;
  } catch (error) { if (request === gifSearchId) status('gif-search-status',error.message,true); }
}
function selectGif(gif) {
  for (const tile of $('gif-grid').children) tile.setAttribute('aria-pressed',String(tile.dataset.gifId === gif.id));
  const image = $('gif-selected-img');
  image.src = gif.url; image.alt = gif.title; image.referrerPolicy = 'no-referrer';
  $('gif-selected').hidden = false;
  $('gif-use').dataset.gifId = gif.id;
  $('gif-use').dataset.gifUrl = gif.url;
  $('gif-use').dataset.gifTitle = gif.title;
}
function useGif() {
  const url = $('gif-use').dataset.gifUrl;
  if (!isGifMediaUrl(url)) return;
  selectedGif = { url, title:$('gif-use').dataset.gifTitle || 'GIF' };
  renderGifPreview();
  if (gifsDialog.open) gifsDialog.close();
  $('chat-input').focus();
}
function renderGifPreview() {
  const node = $('gif-preview');
  node.replaceChildren();
  node.hidden = !selectedGif;
  if (!selectedGif) return;
  const inner = element('div','gif-preview-inner');
  const image = element('img');
  image.src = selectedGif.url; image.alt = selectedGif.title; image.referrerPolicy = 'no-referrer';
  inner.append(image,element('span',null,selectedGif.title),button('Remove',() => { selectedGif = null; renderGifPreview(); }));
  node.append(inner);
}
