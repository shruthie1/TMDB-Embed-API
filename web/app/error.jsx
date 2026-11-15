'use client';
import ErrorScreen from '../components/ErrorScreen';

// Next.js route-level boundary: a throw while rendering any page lands here
// instead of a blank screen. `reset` re-renders the segment.
export default function Error({ error, reset }) {
  return <ErrorScreen error={error} onRetry={reset} />;
}
