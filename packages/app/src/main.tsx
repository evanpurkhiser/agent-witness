import './styles.css';

import {StrictMode} from 'react';

import * as Sentry from '@sentry/react';
import {createRoot} from 'react-dom/client';

import {App} from './app/App';
import {initializeThemeMode} from './app/theme';

initializeThemeMode();

const runtimeConfig = JSON.parse(
  document.getElementById('agent-witness-config')!.textContent!,
) as {sentryDsn: string | null};
const sentryDsn =
  runtimeConfig.sentryDsn === '__AGENT_WITNESS_SENTRY_DSN__'
    ? null
    : runtimeConfig.sentryDsn;

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    enableLogs: true,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.consoleLoggingIntegration(),
    ],
    tracesSampleRate: 1.0,
  });
}

const reactErrorHandler = sentryDsn ? Sentry.reactErrorHandler() : undefined;

createRoot(document.getElementById('root')!, {
  onCaughtError: reactErrorHandler,
  onRecoverableError: reactErrorHandler,
  onUncaughtError: reactErrorHandler,
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
