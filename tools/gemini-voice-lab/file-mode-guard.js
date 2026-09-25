if (window.location.protocol === 'file:') {
  document.body.classList.add('file-mode');
  document.querySelector('#file-mode-notice')?.classList.remove('hidden');
  for (const control of document.querySelectorAll('button, input, select, textarea')) {
    control.disabled = true;
  }
} else {
  import('./app.js').catch(() => {
    const notice = document.querySelector('#boot-error-notice');
    notice?.classList.remove('hidden');
  });
}

