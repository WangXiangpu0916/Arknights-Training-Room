const initialTheme = new URLSearchParams(window.location.search).get('theme');
document.documentElement.dataset.theme = initialTheme === 'light' || initialTheme === 'black'
  ? initialTheme
  : 'system';
