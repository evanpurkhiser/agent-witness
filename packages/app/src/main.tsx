import './styles.css';

import {StrictMode} from 'react';

import {createRoot} from 'react-dom/client';

import {App} from './app/App';
import {initializeThemeMode} from './app/theme';

initializeThemeMode();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
