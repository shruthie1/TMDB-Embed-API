'use client';
import ErrorScreen from '../components/ErrorScreen';

// Last-resort boundary for a throw in the root layout itself. It replaces the
// layout, so it must render its own <html> and <body>.
export default function GlobalError({ error, reset }) {
  return (
    <html lang="en">
      <body style={{ background: '#000', color: '#fff', margin: 0 }}>
        <ErrorScreen error={error} onRetry={reset} />
      </body>
    </html>
  );
}
