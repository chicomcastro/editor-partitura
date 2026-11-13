import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { boot } from './app';

boot();

// service worker: deixa tudo em cache pro uso offline (avião)
registerSW({
  immediate: true,
  onOfflineReady() {
    const t = document.getElementById('toast');
    if (t) {
      t.textContent = 'Pronto pra usar offline ✈️';
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 3000);
    }
  },
});
